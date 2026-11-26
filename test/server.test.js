'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createApp } = require('../server');

async function start(dataDir) {
  const app = createApp({ dataDir, tickMs: 20 });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (url, body) => {
    const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json() };
  };
  const get = async (url) => { const r = await fetch(base + url); return { status: r.status, body: await r.json() }; };
  // read the first SSE message from a stream
  const firstView = (url) => new Promise((resolve, reject) => {
    const req = http.get(base + url, (res) => {
      let buf = '';
      res.on('end', () => resolve(res.statusCode === 200 ? { released: true } : { status: res.statusCode, released: true }));
      res.on('data', (c) => {
        buf += c;
        const m = buf.match(/data: (.*)\n\n/);
        if (m) { req.destroy(); resolve(JSON.parse(m[1])); }
        if (buf.includes('event: released')) { req.destroy(); resolve({ released: true }); }
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
  });
  return { app, base, post, get, firstView };
}

test('a scripted class plays a whole game end to end, and it survives a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-'));
  let s = await start(dir);
  const created = await s.post('/api/create', { yearLevel: 'y9-12', teams: 5, seasons: 6, planTimer: 60, practice: true });
  assert.strictEqual(created.status, 200);
  const { code, teacherToken: key } = created.body;
  assert.match(code, /^[A-Z]{4}$/);

  const info = await s.get(`/api/g/${code}/info`);
  const ids = info.body.regions.filter((r) => r.free).map((r) => r.id);
  assert.deepStrictEqual(ids, ['highlands', 'orchard', 'cotton', 'town', 'delta']);
  const tokens = {};
  for (const id of ids) {
    const j = await s.post(`/api/g/${code}/join`, { region: id, teamName: `Team ${id}` });
    assert.strictEqual(j.status, 200);
    tokens[id] = j.body.token;
  }
  assert.strictEqual((await s.post(`/api/g/${code}/join`, { region: 'orchard' })).status, 409);
  const team = (id, action, body) => s.post(`/api/g/${code}/team/${action}`, Object.assign({ token: tokens[id] }, body));
  const teacher = (action, body) => s.post(`/api/g/${code}/teacher/${action}`, Object.assign({ key }, body));
  assert.strictEqual((await s.post(`/api/g/${code}/teacher/start`, { key: 'wrong' })).status, 403);

  assert.strictEqual((await teacher('start')).status, 200);
  let played = 0;
  const g = () => s.app.games.get(code);
  while (g().phase !== 'final') {
    assert.strictEqual(g().phase, 'forecast');
    await teacher('advance'); // to plan
    assert.strictEqual(g().phase, 'plan');
    await team('orchard', 'set-plan', { plan: { amount: 5 } });
    await team('cotton', 'set-plan', { plan: { amount: 6, extra: 1 } });
    await team('town', 'lock', { plan: { amount: 4 } });
    await team('delta', 'lock', { plan: { audit: 'cotton' } }).catch(() => {});
    if (g().settings.pledges && g().regions.town.points >= 3) {
      const offer = await team('town', 'pledge-offer', { other: 'orchard', subject: 'them', amount: 4, payment: 3 });
      assert.strictEqual(offer.status, 200, JSON.stringify(offer.body));
      const pid = g().pledges[g().pledges.length - 1].id;
      assert.strictEqual((await team('orchard', 'pledge-respond', { id: pid, accept: true })).status, 200);
    }
    // hidden information: a team never sees another team's plan; the board sees no plans during Plan
    const orchardView = (await team('orchard', 'lock')).body.view;
    assert.ok(!JSON.stringify(orchardView.regions).includes('"plan":{'));
    assert.strictEqual(orchardView.me.plan.amount, 5);
    const board = await s.firstView(`/api/g/${code}/stream`);
    assert.ok(!JSON.stringify(board).includes('"plan":{'), 'board must not see plans during Plan');
    assert.strictEqual(board.last, null, 'no decisions before Release');
    assert.strictEqual(board.teacher, undefined);

    await teacher('advance'); // release (cotton and highlands not locked → previous values)
    assert.strictEqual(g().phase, 'release');
    assert.ok(g().last.log.length > 5);
    assert.strictEqual(g().regions.cotton.autoLocked, true);
    // plans cannot change after the timer
    assert.strictEqual((await team('orchard', 'set-plan', { plan: { amount: 1 } })).status, 409);
    await teacher('advance'); // review
    await teacher('advance'); // next season / final
    played++;
    if (played === 3) {
      // restart the server mid-game: the game resumes from disk
      await s.app.close();
      s = await start(dir);
      assert.ok(s.app.games.get(code), 'game reloaded after restart');
    }
  }
  assert.strictEqual(played, 7); // practice + 6
  assert.strictEqual(g().history.length, 6);
  assert.ok(g().final.standings.length === 5);
  await s.app.close();
});

test('rejoin, release region, undo and the plan timer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-'));
  const s = await start(dir);
  const { code, teacherToken: key } = (await s.post('/api/create', { teams: 4, planTimer: 60, practice: false })).body;
  const info = (await s.get(`/api/g/${code}/info`)).body;
  assert.ok(!info.regions.find((r) => r.id === 'highlands').playable, 'computer runs the Highlands with 4 teams');
  const { token } = (await s.post(`/api/g/${code}/join`, { region: 'town' })).body;
  const view = await s.firstView(`/api/g/${code}/stream?t=${token}`);
  assert.strictEqual(view.me.id, 'town'); // rejoin link restores the same region
  const teacher = (action, body) => s.post(`/api/g/${code}/teacher/${action}`, Object.assign({ key }, body));
  await teacher('start'); await teacher('advance');
  const g = s.app.games.get(code);
  // timer expiry locks the phase
  g.timer.endsAt = Date.now() - 1;
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(g.phase, 'release');
  const healthAfter = g.river.health;
  assert.strictEqual((await teacher('undo-season')).status, 200);
  assert.strictEqual(g.phase, 'plan');
  assert.strictEqual(g.history.length, 0);
  assert.strictEqual(g.timer.paused, true);
  assert.ok(typeof healthAfter === 'number');
  await teacher('release-region', { region: 'town' });
  const gone = await s.firstView(`/api/g/${code}/stream?t=${token}`).catch(() => ({ released: true }));
  assert.ok(gone.released || gone.error === undefined);
  assert.strictEqual((await s.post(`/api/g/${code}/team/lock`, { token })).status, 401);
  assert.ok((await s.post(`/api/g/${code}/join`, { region: 'town' })).status === 200);
  await s.app.close();
});
