#!/usr/bin/env node
// Browser test: a board and five team phones play a full game; screenshots for a layout check.
// Needs Playwright (not a runtime dependency): `npx playwright install chromium` then `node test/browser.js [outDir]`.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');
const { createApp } = require('../server');

(async () => {
  const out = process.argv[2] || path.join(__dirname, '..', 'screenshots');
  fs.mkdirSync(out, { recursive: true });
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ed-b-')) });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page, name) => {
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('qrcode') && !m.text().includes('ERR_TUNNEL')) errors.push(`${name}: ${m.text()}`); });
  };

  const boardCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const board = await boardCtx.newPage();
  watch(board, 'board');
  await board.goto(base + '/');
  await board.selectOption('#yearLevel', 'y7-8');
  await board.fill('#seasons', '6');
  await board.click('#create-form button[type=submit]');
  await board.waitForURL(/board\.html/);
  const code = new URL(board.url()).searchParams.get('code');
  await board.waitForSelector('.lobby');
  await board.screenshot({ path: `${out}/board-lobby.png` });

  const regions = ['highlands', 'orchard', 'cotton', 'town', 'delta'];
  const teams = {};
  for (const id of regions) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true });
    const p = await ctx.newPage();
    watch(p, id);
    await p.goto(`${base}/team.html?code=${code}`);
    await p.waitForSelector(`[data-region=${id}]`);
    if (id === 'orchard') await p.screenshot({ path: `${out}/phone-join.png` });
    await p.click(`[data-region=${id}]`);
    await p.waitForSelector('.team-head');
    teams[id] = p;
  }
  const g = () => app.games.get(code);
  const advance = async () => { await board.click('#teacher-bar button.primary'); };
  await board.waitForFunction(() => document.querySelectorAll('.lobby .joinurl').length && document.body.innerText.includes('✅'));
  await advance(); // start → forecast
  await teams.town.waitForSelector('.estimate');
  await teams.town.screenshot({ path: `${out}/phone-forecast.png` });
  await board.screenshot({ path: `${out}/board-forecast.png` });

  let season = 0;
  while (g().phase !== 'final') {
    await advance(); // → plan
    await teams.orchard.waitForSelector('#amount');
    // each team sets a slider and locks in
    for (const id of regions) {
      const p = teams[id];
      await p.waitForSelector('#lock');
      if (id === 'orchard' || id === 'cotton' || id === 'town') {
        const max = await p.$eval('#amount', (e) => Number(e.max));
        await p.$eval('#amount', (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, String(Math.max(0, max - 2 - (season % 2))));
      }
      if (id === 'highlands') await p.$eval('#keep', (e) => { e.value = '2'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
      if (season === 2 && id === 'orchard') await p.screenshot({ path: `${out}/phone-plan.png`, fullPage: true });
      if (id !== 'delta' || season % 2 === 0) { await p.waitForTimeout(400); await p.click('#lock'); }
    }
    // a pledge in season 3: town pays orchard to take ≤ 3
    if (season === 3 && g().settings.pledges && g().regions.town.points >= 3) {
      const t = teams.town;
      await t.click('#unlock').catch(() => {});
      await t.waitForSelector('#pl-other');
      await t.selectOption('#pl-other', 'orchard');
      await t.click('#pl-send');
      await teams.orchard.waitForSelector('[data-accept]');
      await teams.orchard.click('#unlock').catch(() => {});
      await teams.orchard.waitForSelector('[data-accept]');
      await teams.orchard.click('[data-accept]');
      await t.waitForSelector('#lock'); await t.click('#lock');
      await teams.orchard.waitForSelector('#lock'); await teams.orchard.click('#lock');
    }
    await board.waitForFunction(() => document.querySelector('#teacher-bar button.primary'));
    if (season === 2) await board.screenshot({ path: `${out}/board-plan.png` });
    await advance(); // → release
    await board.waitForFunction(() => document.querySelector('#river-card svg').dataset.anim === 'done', null, { timeout: 20000 });
    // the board's end state must match the log
    const sm = g().last.summary;
    const seaText = await board.$eval('#river-card svg', (s) => s.textContent);
    if (!seaText.includes(`sea flow ${sm.sea}`)) throw new Error(`board sea flow does not match log (${sm.sea})`);
    if (season === 1) { await board.screenshot({ path: `${out}/board-release.png` }); await teams.cotton.screenshot({ path: `${out}/phone-release.png` }); }
    await advance(); // → review
    await teams.cotton.waitForSelector('.result-big');
    if (season === 1) { await board.screenshot({ path: `${out}/board-review.png` }); await teams.cotton.screenshot({ path: `${out}/phone-review.png`, fullPage: true }); }
    await advance(); // → next forecast or final
    season++;
    await board.waitForFunction((s) => document.body.dataset.phase === 'forecast' || document.body.dataset.phase === 'final', season);
  }
  await board.waitForSelector('.final-overlay:not(.hidden)');
  await board.screenshot({ path: `${out}/board-final.png` });
  await teams.delta.waitForSelector('.result-big');
  await teams.delta.screenshot({ path: `${out}/phone-final.png` });

  // horizontal overflow check on the phone
  const overflow = await teams.orchard.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) errors.push('phone page scrolls horizontally');

  await browser.close();
  await app.close();
  console.log(`Played ${season} seasons (incl. practice) in the browser. Screenshots in ${out}`);
  if (errors.length) { console.error('Errors:\n' + errors.join('\n')); process.exit(1); }
  console.log('No page errors.');
})().catch((e) => { console.error(e); process.exit(1); });
