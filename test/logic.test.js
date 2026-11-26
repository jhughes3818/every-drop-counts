'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../game/rules');
const L = require('../game/logic');

function game(opts = {}, seed = 1) {
  const s = L.createState({ code: 'TEST', options: Object.assign({ practice: false }, opts), seed });
  s.phase = 'plan';
  return s;
}
function randomPlan(state, id, rng) {
  const def = R.REGIONS[id];
  const p = L.emptyPlan();
  if (def.kind === 'dam') p.keep = Math.floor(rng() * 16);
  if (def.kind === 'take') { p.amount = Math.floor(rng() * (def.max + 1)); if (state.settings.pumping) p.extra = Math.floor(rng() * 3); }
  if (def.kind === 'sea' && state.settings.pumping && rng() < 0.3) p.audit = 'cotton';
  const pts = Math.max(0, state.regions[id].points);
  if (pts > 0 && rng() < 0.4) p.contribute = Math.floor(rng() * Math.min(pts, 5));
  const left = pts - L.planCost(p);
  for (const pid of R.PROJECT_IDS) if (L.projectAllowed(id, pid) && !state.regions[id].projects.includes(pid) && R.PROJECTS[pid].cost <= left - L.planCost(p) + p.contribute && rng() < 0.2) p.buy.push(pid);
  const r = L.legalDecision(state, id, p);
  return r.ok ? r.plan : L.legalDecision(state, id, Object.assign(L.emptyPlan(), { amount: p.amount, keep: p.keep, extra: p.extra })).plan;
}

test('worked example 1: everyone takes the maximum', () => {
  const s = game({ teams: 5 });
  s.climates[0] = 'normal';
  const d = { highlands: { keep: 4 }, orchard: { amount: 6 }, cotton: { amount: 10 }, town: { amount: 5 } };
  const { summary, log } = L.resolveSeason(s, d, null);
  assert.strictEqual(summary.release, 26);
  const takes = log.filter((e) => e.type === 'take').map((e) => [e.region, e.got, e.flow]);
  assert.deepStrictEqual(takes, [['orchard', 6, 19], ['cotton', 10, 8], ['town', 5, 2]]);
  assert.strictEqual(summary.sea, 1);
  assert.ok(summary.healthDelta < 0);
});

test('worked example 2: everyone leaves some water', () => {
  const s = game({ teams: 5 });
  s.climates[0] = 'normal';
  const d = { highlands: { keep: 4 }, orchard: { amount: 5 }, cotton: { amount: 7 }, town: { amount: 4 } };
  const { summary, log } = L.resolveSeason(s, d, null);
  const takes = log.filter((e) => e.type === 'take').map((e) => [e.region, e.got, e.flow]);
  assert.deepStrictEqual(takes, [['orchard', 5, 20], ['cotton', 7, 12], ['town', 4, 7]]);
  assert.strictEqual(summary.sea, 6);
  assert.ok(summary.healthDelta > 0);
});

test('water is conserved and values stay legal across thousands of random seasons', () => {
  let checked = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const rng = L.mulberry32(seed * 7919);
    const teams = [4, 5, 6][seed % 3];
    const yearLevel = ['y4-6', 'y7-8', 'y9-12'][seed % 3];
    let s = game({ teams, yearLevel, seasons: 10 }, seed);
    for (let season = 1; season <= s.options.seasons; season++) {
      s.season = season;
      const decisions = {};
      for (const id of s.order) decisions[id] = randomPlan(s, id, rng);
      const hazard = rng() < 0.4 ? R.HAZARD_IDS[Math.floor(rng() * R.HAZARD_IDS.length)] : null;
      const before = L.clone(s);
      const out = L.resolveSeason(s, decisions, hazard);
      const sm = out.summary;
      const taken = Object.values(sm.got).reduce((a, b) => a + b, 0);
      assert.strictEqual(sm.inflow + sm.damStart + sm.added, taken + sm.losses + sm.sea + out.state.river.dam, `conservation seed ${seed} season ${season}`);
      assert.ok(out.state.river.dam >= 0 && out.state.river.dam <= out.state.river.damCap);
      assert.ok(out.state.river.health >= 0 && out.state.river.health <= 100);
      assert.ok(out.state.river.fund >= 0);
      for (const e of out.log) if (e.type === 'take') { assert.ok(e.got <= e.wanted && e.got >= 0 && e.flow >= 0); }
      for (const e of out.log) if (e.flow !== undefined) assert.ok(e.flow >= 0);
      for (const id of s.order) {
        assert.ok(Number.isInteger(out.state.regions[id].points), 'integer points');
        assert.ok(Number.isInteger(out.results[id].total));
        // points change matches the result line
        assert.strictEqual(out.state.regions[id].points - before.regions[id].points, out.results[id].total);
      }
      s = out.state;
      checked++;
    }
  }
  assert.ok(checked > 3000);
});

test('an upstream team taking more never gives a downstream team more water', () => {
  for (let seed = 1; seed < 300; seed++) {
    const rng = L.mulberry32(seed);
    const s = game({ teams: 6 });
    const d = {};
    for (const id of s.order) d[id] = randomPlan(s, id, rng);
    const a = L.resolveSeason(s, d, null).summary;
    const more = L.clone(d);
    more.orchard.amount = Math.min(6, more.orchard.amount + 1 + Math.floor(rng() * 3));
    const b = L.resolveSeason(s, more, null).summary;
    assert.ok(b.got.orchard >= a.got.orchard);
    for (const id of ['springs', 'cotton', 'town']) assert.ok(b.got[id] <= a.got[id], `${id} got more`);
    assert.ok(b.sea <= a.sea);
  }
});

test('pledges: a kept pledge pays, a broken one does not and is marked', () => {
  const s = game({ teams: 5 });
  s.regions.town.points = 20;
  s.pledges.push({ id: 1, season: 1, proposer: 'town', responder: 'orchard', subject: 'orchard', payer: 'town', kind: 'max-take', amount: 4, payment: 3, status: 'accepted' });
  const base = { highlands: { keep: 4 }, cotton: { amount: 5 }, town: { amount: 3 } };
  const kept = L.resolveSeason(s, Object.assign({ orchard: { amount: 4 } }, base), null);
  assert.strictEqual(kept.state.pledges[0].status, 'kept');
  assert.strictEqual(kept.results.orchard.transfers, 3);
  assert.strictEqual(kept.results.town.transfers, -3);
  assert.strictEqual(kept.state.regions.orchard.broken, 0);
  const broken = L.resolveSeason(s, Object.assign({ orchard: { amount: 6 } }, base), null);
  assert.strictEqual(broken.state.pledges[0].status, 'broken');
  assert.strictEqual(broken.results.orchard.transfers, 0);
  assert.strictEqual(broken.results.town.transfers, 0);
  assert.strictEqual(broken.state.regions.orchard.broken, 1);
  const total = (st) => Object.values(st.regions).reduce((a, r) => a + r.points, 0);
  // transfers net to zero
  assert.strictEqual(total(kept.state) - total(s), Object.values(kept.results).reduce((a, r) => a + r.earned - r.spent, 0));
});

test('plans are rejected when they cost more points than the team has', () => {
  const s = game();
  s.regions.cotton.points = 5;
  assert.strictEqual(L.legalDecision(s, 'cotton', { amount: 5, buy: ['drip'] }).ok, false);
  assert.strictEqual(L.legalDecision(s, 'cotton', { amount: 50 }).plan.amount, 10);
  assert.deepStrictEqual(L.legalDecision(s, 'cotton', { buy: ['raisedam'] }).plan.buy, []);
});

test('hazards: flood damages teams without levees unless the fund responds', () => {
  const s = game();
  s.regions.town.projects.push('levee');
  const d = { highlands: { keep: 0 }, orchard: { amount: 3 }, cotton: { amount: 3 }, town: { amount: 3 } };
  const a = L.resolveSeason(s, d, 'flood');
  assert.ok(a.results.orchard.lines.some((l) => l.includes('Flood damage')));
  assert.ok(!a.results.town.lines.some((l) => l.includes('Flood damage')));
  s.river.fund = 10;
  const b = L.resolveSeason(s, d, 'flood');
  assert.strictEqual(b.state.river.fund, 0);
  assert.ok(!b.results.orchard.lines.some((l) => l.includes('Flood damage')));
});

test('practice season changes nothing that counts', () => {
  const s = L.createState({ code: 'T', options: { practice: true }, seed: 3 });
  assert.strictEqual(s.season, 0);
  const out = L.resolveSeason(s, { orchard: { amount: 6 }, cotton: { amount: 10 }, town: { amount: 5 } }, null);
  assert.strictEqual(out.state.river.health, s.river.health);
  for (const id of s.order) assert.strictEqual(out.state.regions[id].points, 0);
  assert.strictEqual(out.state.history.length, 0);
  assert.ok(out.results.cotton.total > 0);
});

test('replay: the same seed and decisions give exactly the same game', () => {
  function play(seed) {
    let s = L.createState({ code: 'R', options: { practice: false, yearLevel: 'y9-12' }, seed });
    const rng = L.mulberry32(seed + 1);
    const record = [];
    for (let season = 1; season <= s.options.seasons; season++) {
      s.season = season;
      const d = {};
      for (const id of s.order) d[id] = randomPlan(s, id, rng);
      const out = L.resolveSeason(s, d, L.drawHazard(s));
      record.push({ d, log: out.log });
      s = out.state;
    }
    return { s, record };
  }
  const a = play(42);
  // rebuild from seed + recorded decisions only
  let s = L.createState({ code: 'R', options: { practice: false, yearLevel: 'y9-12' }, seed: 42 });
  for (let i = 0; i < a.record.length; i++) {
    s.season = i + 1;
    const out = L.resolveSeason(s, a.record[i].d, L.drawHazard(s));
    assert.deepStrictEqual(out.log, a.record[i].log);
    s = out.state;
  }
  assert.deepStrictEqual(s, a.s);
});

test('finalize adds the health bonus and shares the fund', () => {
  const s = game();
  s.river.health = 80; s.river.fund = 13;
  const f = L.finalize(s);
  assert.strictEqual(f.final.bonus, 24);
  assert.strictEqual(f.final.share, 2);
  for (const id of L.playableIds(s)) assert.strictEqual(f.regions[id].points, 26);
});
