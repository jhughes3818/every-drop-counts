#!/usr/bin/env node
// Balance simulation: bots play thousands of games with the real rules module.
// Bots only show whether the design is lopsided, not how students will behave.
// Usage: node test/sim.js [games=2000] [teams=5]
'use strict';
const R = require('../game/rules');
const L = require('../game/logic');

const GAMES = Number(process.argv[2]) || 2000;
const TEAMS = Number(process.argv[3]) || 5;

function highlandsKeep(state, fc, strategy) {
  // Greedy: send only what the turbines can use and store the rest.
  // Fair: release a normal season's worth and store only the excess.
  const avail = fc.inflow + state.river.dam;
  const target = strategy === 'greedy' || strategy === 'freerider' ? R.REGIONS.highlands.turbineCap : R.CLIMATES.normal.inflow;
  return Math.max(0, Math.min(state.river.damCap, avail - target));
}

function fairShares(state, strategies) {
  const fc = L.forecast(state);
  const avail = fc.inflow + state.river.dam;
  const release = avail - Math.min(highlandsKeep(state, fc, strategies.highlands || 'fair'), state.river.damCap, avail);
  const takers = state.order.filter((id) => R.REGIONS[id].kind === 'take');
  const added = state.order.reduce((a, id) => a + (R.REGIONS[id].adds || 0), 0);
  const losses = state.order.length - 1;
  let budget = Math.max(0, release + added - losses - R.HEALTH.envMin);
  const out = {};
  // drinking water first, then farms in proportion to their limits, then the town's extra
  out.town = Math.min(R.REGIONS.town.essential, budget); budget -= out.town;
  const farms = takers.filter((id) => R.REGIONS[id].farm);
  const maxSum = farms.reduce((a, id) => a + R.REGIONS[id].max, 0);
  let used = 0;
  for (const id of farms) { out[id] = Math.min(R.REGIONS[id].max, Math.floor((budget * R.REGIONS[id].max) / maxSum)); used += out[id]; }
  out.town += Math.min(R.REGIONS.town.max - out.town, budget - used);
  return out;
}

function botPlan(state, id, strategy, strategies) {
  const def = R.REGIONS[id];
  const fc = L.forecast(state);
  const p = L.emptyPlan();
  if (def.kind === 'dam') p.keep = highlandsKeep(state, fc, strategy);
  const greedy = strategy === 'greedy' || strategy === 'freerider';
  if (def.kind === 'take') p.amount = greedy ? def.max : fairShares(state, strategies)[id];
  const pts = state.regions[id].points;
  if ((strategy === 'fair' || strategy === 'pledger') && pts > 12) p.contribute = 1;
  // buy one useful project when rich
  if (strategy !== 'freerider' && pts > 30) {
    const pid = R.PROJECT_IDS.find((x) => L.projectAllowed(id, x) && !state.regions[id].projects.includes(x) && x !== 'levee');
    if (pid && R.PROJECTS[pid].cost + p.contribute <= pts - 10) p.buy.push(pid);
  }
  const r = L.legalDecision(state, id, p);
  return r.ok ? r.plan : L.legalDecision(state, id, Object.assign(L.emptyPlan(), { amount: p.amount, keep: p.keep })).plan;
}

function addPledges(state, strategies) {
  // A pledger pays the take-region directly upstream 3 points to take no more than its fair share.
  const takers = state.order.filter((id) => R.REGIONS[id].kind === 'take' || R.REGIONS[id].kind === 'sea');
  const fair = fairShares(state, strategies);
  for (let i = 1; i < takers.length; i++) {
    const payer = takers[i], subject = takers[i - 1];
    if (strategies[payer] !== 'pledger' || R.REGIONS[subject].kind !== 'take') continue;
    if (state.regions[payer].points - L.commitments(state, payer) < 3 + 2) continue;
    state.pledges.push({ id: state.nextPledgeId++, season: state.season, proposer: payer, responder: subject, subject, payer, kind: 'max-take', amount: fair[subject], payment: 3, status: 'accepted' });
  }
}

function playGame(seed, strategies) {
  let s = L.createState({ code: 'SIM', options: { practice: false, teams: TEAMS, yearLevel: 'y7-8' }, seed });
  let crisisBy6 = false, minHealth = s.river.health;
  for (let season = 1; season <= s.options.seasons; season++) {
    s.season = season;
    addPledges(s, strategies);
    const d = {};
    for (const id of s.order) d[id] = botPlan(s, id, strategies[id] || 'fair', strategies);
    const out = L.resolveSeason(s, d, L.drawHazard(s));
    s = out.state;
    if (season <= 6 && s.river.health < R.HEALTH.crisis) crisisBy6 = true;
    minHealth = Math.min(minHealth, s.river.health);
  }
  s = L.finalize(s);
  return { s, crisisBy6, minHealth };
}

const ids = L.playableIds(L.createState({ code: 'X', options: { teams: TEAMS }, seed: 1 }));
const all = (strategy) => Object.fromEntries(ids.map((id) => [id, strategy]));
const pct = (n) => `${Math.round((n / GAMES) * 100)}%`;
const median = (a) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

function run(label, stratFn) {
  let crisis = 0, healthy = 0;
  const scores = Object.fromEntries(ids.map((id) => [id, []]));
  const wins = Object.fromEntries(ids.map((id) => [id, 0]));
  for (let g = 0; g < GAMES; g++) {
    const strategies = stratFn(g);
    const { s, crisisBy6 } = playGame(1000 + g, strategies);
    if (crisisBy6) crisis++;
    if (s.final.health >= R.HEALTH.healthy) healthy++;
    for (const id of ids) scores[id].push(s.regions[id].points);
    wins[s.final.standings[0].id]++;
  }
  return { label, crisis, healthy, scores, wins };
}

function report(r) {
  console.log(`\n== ${r.label} ==`);
  console.log(`  crisis by season 6: ${pct(r.crisis)}   final health ≥ 60: ${pct(r.healthy)}`);
  for (const id of ids) console.log(`  ${R.REGIONS[id].name.padEnd(20)} median ${String(median(r.scores[id])).padStart(4)}  wins ${pct(r.wins[id])}`);
}

console.log(`Every Drop Counts balance simulation — ${GAMES} games, ${TEAMS} teams`);
const greedy = run('All Greedy', () => all('greedy'));
const fair = run('All Fair share', () => all('fair'));
const STRATS = ['greedy', 'fair', 'pledger', 'freerider'];
const mixed = run('Mixed', (g) => { const rng = L.mulberry32(g * 31 + 7); return Object.fromEntries(ids.map((id) => [id, STRATS[Math.floor(rng() * STRATS.length)]])); });
[greedy, fair, mixed].forEach(report);

console.log('\n== Single defector (one team Greedy, others Fair share) ==');
const defect = [];
for (const id of ids) {
  if (R.REGIONS[id].kind !== 'take') continue;
  const r = run(`${id} defects`, () => Object.assign(all('fair'), { [id]: 'greedy' }));
  const gain = median(r.scores[id]) / median(fair.scores[id]);
  defect.push({ id, gain });
  console.log(`  ${R.REGIONS[id].name.padEnd(20)} fair ${median(fair.scores[id])} → greedy ${median(r.scores[id])}  (${Math.round((gain - 1) * 100)}% more)`);
}

console.log('\n== Hazard responses (cost vs damage prevented, per season) ==');
const farms = ids.filter((id) => R.REGIONS[id].farm).length;
const below = L.createState({ code: 'X', options: { teams: TEAMS }, seed: 1 }).order.filter((id) => id !== 'highlands').length;
console.log(`  Drought relief ${R.HAZARDS.drought.response.cost} vs ${farms * R.HAZARDS.drought.farmLoss}`);
console.log(`  Flood response ${R.HAZARDS.flood.response.cost} vs up to ${below * R.HAZARDS.flood.damage}`);
console.log(`  Replanting ${R.HAZARDS.bushfire.response.cost} vs ${R.HAZARDS.bushfire.inflowCut} units of water next season + town treatment`);

const lvl = R.YEAR_LEVELS['y7-8'];
const minutes = Math.round(((lvl.seasons + 1) * (R.TIMING.forecast + lvl.planTimer + R.TIMING.release + 60)) / 60);
console.log(`\n== Length ==\n  Practice + ${lvl.seasons} seasons ≈ ${minutes} minutes of play (target: about 36)`);

const medians = ids.map((id) => median(mixed.scores[id]));
const spread = (Math.max(...medians) - Math.min(...medians)) / Math.max(...medians);
const maxWin = Math.max(...ids.map((id) => mixed.wins[id] / GAMES));
console.log('\n== Targets ==');
const check = (ok, text) => console.log(`  ${ok ? 'PASS' : 'MISS'}  ${text}`);
check(greedy.crisis / GAMES >= 0.8, `All Greedy: crisis by season 6 in ≥ 80% (${pct(greedy.crisis)})`);
check(fair.healthy / GAMES >= 0.8, `All Fair: final health ≥ 60 in ≥ 80% (${pct(fair.healthy)})`);
check(maxWin <= 0.35, `Mixed: no region wins more than 35% (${Math.round(maxWin * 100)}%)`);
check(spread <= 0.25, `Mixed: median scores within 25% (${Math.round(spread * 100)}%)`);
check(defect.every((d) => d.gain > 1 && d.gain <= 1.3), `Defector gains more, but not more than ~30% (${defect.map((d) => `${d.id} ${Math.round((d.gain - 1) * 100)}%`).join(', ')})`);
