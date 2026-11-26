// Every Drop Counts — pure rules. No clock, no network, no Math.random.
// All randomness comes from the game's seed. Shared by server, tests and browser (window.EDLogic).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules'));
  else root.EDLogic = factory(root.EDRules);
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  // ---------- seeded randomness ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashSeed(seed, parts) {
    let h = (seed >>> 0) ^ 0x9e3779b9;
    for (const p of parts) {
      const s = String(p);
      for (let i = 0; i < s.length; i++) {
        h = Math.imul(h ^ s.charCodeAt(i), 2654435761);
        h ^= h >>> 13;
      }
      h = Math.imul(h ^ 0x5bd1e995, 0x27d4eb2d);
    }
    return h >>> 0;
  }
  function rngFor(seed, ...parts) { return mulberry32(hashSeed(seed, parts)); }
  function weightedPick(rng, items) {
    const total = items.reduce((a, b) => a + b.weight, 0);
    let r = rng() * total;
    for (const it of items) { r -= it.weight; if (r < 0) return it; }
    return items[items.length - 1];
  }

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function toInt(v, lo, hi) {
    let n = Math.floor(Number(v));
    if (!Number.isFinite(n)) n = lo;
    return clamp(n, lo, hi);
  }

  // ---------- game setup ----------
  function normaliseOptions(input) {
    input = input || {};
    const yearLevel = R.YEAR_LEVELS[input.yearLevel] ? input.yearLevel : 'y7-8';
    const lvl = R.YEAR_LEVELS[yearLevel];
    const teams = [4, 5, 6].includes(Number(input.teams)) ? Number(input.teams) : 5;
    return {
      yearLevel,
      teams,
      seasons: toInt(input.seasons ?? lvl.seasons, R.LIMITS.seasons[0], R.LIMITS.seasons[1]),
      planTimer: toInt(input.planTimer ?? lvl.planTimer, R.LIMITS.planTimer[0], R.LIMITS.planTimer[1]),
      practice: input.practice === undefined ? true : !!input.practice,
    };
  }

  function emptyPlan() { return { amount: 0, keep: 0, contribute: 0, buy: [], extra: 0, audit: null }; }
  function defaultPlan(id) {
    const def = R.REGIONS[id];
    return Object.assign(emptyPlan(), { amount: def.defaultAmount || 0, keep: def.defaultKeep || 0 });
  }

  function createState({ code, options, seed }) {
    const opts = normaliseOptions(options);
    const lvl = R.YEAR_LEVELS[opts.yearLevel];
    const order = R.LAYOUTS[opts.teams].slice();
    const crng = rngFor(seed, 'climate');
    const climateItems = R.CLIMATE_IDS.map((id) => R.CLIMATES[id]);
    const climates = [];
    for (let s = 1; s <= opts.seasons; s++) climates.push(weightedPick(crng, climateItems).id);

    const hrng = rngFor(seed, 'hazard-seasons');
    const [lo, hi] = lvl.hazards;
    const count = lo + Math.floor(hrng() * (hi - lo + 1));
    const candidates = [];
    for (let s = 2; s <= opts.seasons; s++) candidates.push(s);
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(hrng() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const hazardSeasons = candidates.slice(0, Math.min(count, candidates.length)).sort((a, b) => a - b);

    const regions = {};
    for (const id of order) {
      regions[id] = {
        id, token: null, teamName: '', points: R.START.points, projects: [], broken: 0,
        plan: defaultPlan(id), lastPlan: defaultPlan(id), locked: false, autoLocked: false,
      };
    }
    return {
      version: 1, code, seed: seed >>> 0, options: opts,
      settings: { pledges: lvl.pledges, pumping: lvl.pumping, wording: lvl.wording, fundStep: lvl.fundStep },
      order, season: opts.practice ? 0 : 1, phase: 'lobby',
      climates, hazardSeasons, heldSeasons: [], heldHazards: [], forceHazard: null, usedHazards: [],
      regions,
      river: { dam: R.START.dam, damCap: R.START.damCap, health: R.START.health, fund: R.START.fund },
      pending: { drought: false, bushfire: false },
      pledges: [], nextPledgeId: 1, mutes: [], history: [], last: null, final: null,
    };
  }

  // Regions that a team can play (in 4-team games the computer runs the Highlands).
  function playableIds(state) {
    return state.order.filter((id) => !(state.options.teams === 4 && id === 'highlands'));
  }
  function isPlayable(state, id) { return playableIds(state).includes(id); }

  // ---------- small scoring helpers (used by the estimate on devices too) ----------
  function effectiveUnits(id, got, projects) {
    const def = R.REGIONS[id];
    let u = got;
    if (projects && projects.includes('drip')) u = Math.floor(got * R.PROJECTS.drip.factor);
    return Math.min(u, def.yield.length);
  }
  function essentialNeed(id, projects, bushfire) {
    const def = R.REGIONS[id];
    if (!def.essential) return 0;
    let need = projects && projects.includes('recycling') ? def.essentialRecycling : def.essential;
    if (bushfire) need += R.HAZARDS.bushfire.townExtra;
    return need;
  }
  function takePoints(id, got, projects, bushfire) {
    const def = R.REGIONS[id];
    const units = effectiveUnits(id, got, projects);
    let p = 0;
    for (let i = 0; i < units; i++) p += def.yield[i];
    if (def.essential) p -= Math.max(0, essentialNeed(id, projects, bushfire) - got) * def.shortfallPenalty;
    return p;
  }
  function seaPoints(sea, projects) {
    const def = R.REGIONS.delta;
    const per = projects && projects.includes('wetland') ? def.perUnitWetland : def.perUnit;
    return Math.min(sea, def.maxUnits) * per + (sea >= R.HEALTH.envMin ? def.minBonus : 0);
  }
  function healthChange(sea) {
    if (sea >= R.HEALTH.envMin) return R.HEALTH.up;
    if (sea >= R.HEALTH.mildFloor) return R.HEALTH.mildDown;
    return R.HEALTH.badDown;
  }
  function healthBand(h) {
    if (h >= R.HEALTH.healthy) return 'Healthy';
    if (h >= R.HEALTH.crisis) return 'Stressed';
    return 'Crisis';
  }
  function projectAllowed(id, pid) {
    const p = R.PROJECTS[pid];
    if (!p) return false;
    if (p.for === 'below-dam') return id !== 'highlands';
    return p.for.includes(id);
  }

  // ---------- the river ----------
  // Runs water from the dam's release down the river. `wants` are already capped.
  function runRiver(order, release, wants, lossRate) {
    const events = [];
    const got = {};
    let flow = release, losses = 0, added = 0;
    for (let i = 1; i < order.length; i++) {
      const id = order[i];
      const def = R.REGIONS[id];
      const loss = Math.min(lossRate, flow);
      flow -= loss; losses += loss;
      events.push({ type: 'loss', before: id, amount: loss, flow });
      if (def.adds) {
        flow += def.adds; added += def.adds;
        events.push({ type: 'tributary', region: id, amount: def.adds, flow });
      }
      if (def.kind === 'take') {
        const want = wants[id] || 0;
        const g = Math.min(want, flow);
        flow -= g; got[id] = g;
        events.push({ type: 'take', region: id, wanted: want, got: g, flow });
      }
    }
    events.push({ type: 'sea', flow });
    return { events, got, sea: flow, losses, added };
  }

  function seasonClimate(state, season) {
    const s = season === undefined ? state.season : season;
    return s === 0 ? 'normal' : state.climates[s - 1];
  }

  // What the board shows at Forecast. Hazards for this season are not known yet.
  function forecast(state) {
    const c = R.CLIMATES[seasonClimate(state)];
    let inflow = c.inflow;
    const notes = [];
    if (state.pending.bushfire) {
      inflow -= R.HAZARDS.bushfire.inflowCut;
      notes.push(`Last season's bushfire: ${R.HAZARDS.bushfire.inflowCut} fewer units, and River Town needs 1 extra unit.`);
    }
    if (state.pending.drought) {
      inflow = Math.round(inflow * R.HAZARDS.drought.inflowMult);
      notes.push('The drought continues: only 60% of the usual water.');
    }
    return { climate: c.id, inflow: Math.max(0, inflow), notes };
  }

  function hazardEligible(state, id) {
    const h = R.HAZARDS[id];
    if (h.maxHealth !== undefined && state.river.health > h.maxHealth) return false;
    if (h.region && !state.order.includes(h.region)) return false;
    return true;
  }

  // The hazard (if any) for the current season. Deterministic from seed and state.
  function drawHazard(state) {
    if (state.forceHazard) return state.forceHazard;
    const s = state.season;
    if (s === 0) return null;
    if (!state.hazardSeasons.includes(s) || state.heldSeasons.includes(s)) return null;
    return pickHazard(state);
  }
  function pickHazard(state) {
    const rng = rngFor(state.seed, 'hazard', state.season, state.heldHazards.length);
    let pool = R.HAZARD_IDS.filter((id) => hazardEligible(state, id) && !state.usedHazards.includes(id));
    if (!pool.length) pool = R.HAZARD_IDS.filter((id) => hazardEligible(state, id));
    return pool[Math.floor(rng() * pool.length)];
  }

  // ---------- plans ----------
  function planCost(plan) {
    let c = plan.contribute || 0;
    for (const pid of plan.buy || []) c += R.PROJECTS[pid] ? R.PROJECTS[pid].cost : 0;
    if (plan.audit) c += R.LIMITS.auditCost;
    return c;
  }
  // Points already promised as payment in accepted pledges this season.
  function commitments(state, id, excludePledgeId) {
    return state.pledges
      .filter((p) => p.season === state.season && p.status === 'accepted' && p.payer === id && p.id !== excludePledgeId)
      .reduce((a, p) => a + p.payment, 0);
  }
  function available(state, id) { return Math.max(0, state.regions[id].points); }

  // Validate and clean a plan. Returns { ok, plan, error }.
  function legalDecision(state, id, input) {
    input = input || {};
    const def = R.REGIONS[id];
    const reg = state.regions[id];
    const p = emptyPlan();
    if (def.kind === 'dam') p.keep = toInt(input.keep, 0, R.START.raisedDamCap);
    if (def.kind === 'take') {
      p.amount = toInt(input.amount, 0, def.max);
      if (state.settings.pumping) p.extra = toInt(input.extra, 0, R.LIMITS.pumpExtra);
    }
    if (def.kind === 'sea' && state.settings.pumping && input.audit &&
        state.order.includes(input.audit) && R.REGIONS[input.audit].kind === 'take') p.audit = input.audit;
    p.contribute = toInt(input.contribute, 0, 999);
    const buy = Array.isArray(input.buy) ? input.buy : [];
    p.buy = [...new Set(buy)].filter((pid) => projectAllowed(id, pid) && !reg.projects.includes(pid));
    const cost = planCost(p) + commitments(state, id);
    const have = available(state, id);
    if (cost > have) return { ok: false, plan: p, error: `That plan costs ${cost} points but your team has ${have}.` };
    return { ok: true, plan: p };
  }

  // ---------- resolving a season ----------
  // decisions: { regionId: plan } (already legal). hazardId: string or null.
  // Returns { state, log, results }. The board animates from `log`, so animation and scoring never disagree.
  function resolveSeason(state, decisions, hazardId) {
    const s = clone(state);
    const season = s.season;
    const practice = season === 0;
    const order = s.order;
    const log = [];
    const results = {};
    const dec = {};
    for (const id of order) dec[id] = Object.assign(emptyPlan(), decisions[id] || {});
    const earned = {}, spent = {}, transfers = {}, lines = {};
    for (const id of order) { earned[id] = 0; spent[id] = 0; transfers[id] = 0; lines[id] = []; }

    const fc = forecast(state);
    log.push({ type: 'forecast', climate: fc.climate, inflow: fc.inflow, practice });

    // 1. Spending: projects, fund, audits
    for (const id of order) {
      const reg = s.regions[id];
      const d = dec[id];
      const bought = [];
      for (const pid of d.buy) {
        if (reg.projects.includes(pid) || !projectAllowed(id, pid)) continue;
        reg.projects.push(pid); bought.push(pid);
        spent[id] += R.PROJECTS[pid].cost;
        lines[id].push(`Bought ${R.PROJECTS[pid].name}: −${R.PROJECTS[pid].cost}`);
        if (pid === 'raisedam') s.river.damCap = R.START.raisedDamCap;
      }
      if (d.contribute > 0) {
        s.river.fund += d.contribute; spent[id] += d.contribute;
        lines[id].push(`Gave to the Catchment Fund: −${d.contribute}`);
      }
      if (d.audit) { spent[id] += R.LIMITS.auditCost; lines[id].push(`Audit of ${R.REGIONS[d.audit].name}: −${R.LIMITS.auditCost}`); }
      if (bought.length || d.contribute > 0) log.push({ type: 'spend', region: id, projects: bought, contribute: d.contribute });
    }

    // 2. Hazard, paid from the fund automatically if it can afford the response
    const hz = hazardId ? R.HAZARDS[hazardId] : null;
    let responded = false;
    if (hz) {
      if (hz.response && s.river.fund >= hz.response.cost) { s.river.fund -= hz.response.cost; responded = true; }
      log.push({ type: 'hazard', id: hazardId, responded, cost: responded ? hz.response.cost : 0, fund: s.river.fund });
      if (!s.usedHazards.includes(hazardId)) s.usedHazards.push(hazardId);
    }

    // 3. Inflow
    let inflow = fc.inflow;
    if (hz && hz.inflowMult) inflow = Math.round(inflow * hz.inflowMult);
    log.push({ type: 'inflow', amount: inflow });

    // 4. The dam
    const damStart = s.river.dam;
    const avail = inflow + damStart;
    const keep = Math.min(dec.highlands.keep, s.river.damCap, avail);
    const release = avail - keep;
    const turbines = Math.min(release, R.REGIONS.highlands.turbineCap);
    const spill = release - turbines;
    s.river.dam = keep;
    log.push({ type: 'dam', start: damStart, inflow, available: avail, keep, release, turbines, spill, cap: s.river.damCap });

    // 5. Water runs down the river
    const lossRate = hazardId === 'heatwave' ? R.HAZARDS.heatwave.loss : R.START.loss;
    const declared = {}, wants = {};
    for (const id of order) {
      const def = R.REGIONS[id];
      if (def.kind !== 'take') continue;
      let want = dec[id].amount;
      if (hazardId === 'algal' && !responded) want = Math.min(want, R.HAZARDS.algal.cap);
      if (hazardId === 'buyback' && id === R.HAZARDS.buyback.region) want = Math.min(want, R.HAZARDS.buyback.cap);
      declared[id] = want;
      wants[id] = want + (s.settings.pumping ? dec[id].extra : 0);
    }
    const river = runRiver(order, release, wants, lossRate);
    log.push(...river.events);
    const sea = river.sea;

    // 6. Points from water
    const bushfireActive = !!state.pending.bushfire;
    for (const id of order) {
      const def = R.REGIONS[id];
      const reg = s.regions[id];
      if (def.kind === 'dam') {
        earned[id] += turbines;
        lines[id].push(`Turbines: ${turbines} units → +${turbines}`);
        if (spill) lines[id].push(`${spill} units spilled past the turbines (no points)`);
      } else if (def.kind === 'take') {
        const g = river.got[id];
        const pts = takePoints(id, g, reg.projects, bushfireActive && def.town);
        earned[id] += pts;
        lines[id].push(`Took ${g} units → ${pts >= 0 ? '+' : '−'}${Math.abs(pts)}`);
        if (def.town) {
          const need = essentialNeed(id, reg.projects, bushfireActive);
          if (g < need) lines[id].push(`Short of the ${need} essential units: −${(need - g) * def.shortfallPenalty} included`);
        }
      } else if (def.kind === 'sea') {
        const pts = seaPoints(sea, reg.projects);
        earned[id] += pts;
        lines[id].push(`${sea} units reached the sea → +${pts}`);
      }
    }

    // 7. Hazard effects on teams
    if (hz && hazardId === 'drought' && !responded) {
      for (const id of order) if (R.REGIONS[id].farm) { earned[id] -= hz.farmLoss; lines[id].push(`Drought losses: −${hz.farmLoss}`); }
    }
    if (hz && hazardId === 'flood' && !responded) {
      for (const id of order) {
        if (id === 'highlands') continue;
        if (s.regions[id].projects.includes('levee')) { lines[id].push('Your levee kept the flood out'); continue; }
        earned[id] -= hz.damage; lines[id].push(`Flood damage: −${hz.damage}`);
      }
    }
    if (hz && hazardId === 'buyback') {
      const id = hz.region; earned[id] += hz.compensation; lines[id].push(`Buy-back compensation: +${hz.compensation}`);
    }

    // 8. River health
    const healthBefore = s.river.health;
    let dh = healthChange(sea);
    if (s.regions.delta && s.regions.delta.projects.includes('wetland')) dh += R.PROJECTS.wetland.health;
    if (hz && hz.health) dh += hz.health;
    s.river.health = clamp(healthBefore + dh, 0, R.HEALTH.max);
    const crisis = s.river.health < R.HEALTH.crisis;
    if (crisis) {
      for (const id of order) {
        if (earned[id] > 0) {
          const half = Math.floor(earned[id] / 2);
          lines[id].push(`River crisis: points halved (−${earned[id] - half})`);
          earned[id] = half;
        }
      }
    }
    if (hz && hazardId === 'grant' && s.river.health >= hz.minHealth) {
      s.river.fund += hz.amount;
      log.push({ type: 'grant', amount: hz.amount, fund: s.river.fund });
    }

    // 9. Audits (illegal pumping)
    const audits = [];
    for (const id of order) {
      const target = dec[id].audit;
      if (!target) continue;
      const extra = dec[target].extra || 0;
      if (extra > 0) {
        const g = river.got[target];
        const legal = Math.min(g, declared[target]);
        const value = takePoints(target, g, s.regions[target].projects, false) - takePoints(target, legal, s.regions[target].projects, false);
        const penalty = Math.max(0, value) + R.LIMITS.auditPenalty;
        transfers[target] -= penalty; transfers[id] += penalty + R.LIMITS.auditCost;
        lines[target].push(`Caught pumping illegally by the audit: −${penalty}`);
        lines[id].push(`Audit caught ${R.REGIONS[target].name}: +${penalty} and your ${R.LIMITS.auditCost} back`);
        audits.push({ auditor: id, target, caught: true, penalty });
      } else {
        lines[id].push(`${R.REGIONS[target].name} was not pumping: audit fee lost`);
        audits.push({ auditor: id, target, caught: false, penalty: 0 });
      }
    }

    // 10. Pledges
    const pledgeOutcomes = [];
    for (const p of s.pledges) {
      if (p.season !== season) continue;
      if (p.status === 'pending') { p.status = 'expired'; continue; }
      if (p.status !== 'accepted') continue;
      const actual = p.kind === 'min-release' ? release : river.got[p.subject];
      const kept = p.kind === 'min-release' ? actual >= p.amount : actual <= p.amount;
      p.actual = actual;
      if (kept) {
        p.status = 'kept';
        transfers[p.payer] -= p.payment; transfers[p.subject] += p.payment;
        lines[p.payer].push(`Pledge kept by ${R.REGIONS[p.subject].name}: you paid −${p.payment}`);
        lines[p.subject].push(`You kept your pledge: +${p.payment} from ${R.REGIONS[p.payer].name}`);
      } else {
        p.status = 'broken';
        s.regions[p.subject].broken += 1;
        lines[p.subject].push(`You broke your pledge to ${R.REGIONS[p.payer].name}: no payment`);
        lines[p.payer].push(`${R.REGIONS[p.subject].name} broke its pledge: no payment made`);
      }
      pledgeOutcomes.push({ id: p.id, subject: p.subject, payer: p.payer, kind: p.kind, amount: p.amount, payment: p.payment, actual, kept });
    }

    // 11. Totals and explanations
    for (const id of order) {
      const def = R.REGIONS[id];
      const reg = s.regions[id];
      const total = earned[id] - spent[id] + transfers[id];
      reg.points += total;
      let explanation;
      if (def.kind === 'dam') explanation = `You stored ${keep} and released ${release} units${spill ? ` (${spill} spilled)` : ''}.`;
      else if (def.kind === 'take') {
        const asked = dec[id].amount, g = river.got[id];
        const want = wants[id];
        if (declared[id] < asked) explanation = `You asked for ${asked}, but this season's rules allowed only ${declared[id]}` + (g < want ? `, and the river only had ${g}.` : '.');
        else if (g < want) explanation = `You asked for ${want}, the river only had ${g}.`;
        else explanation = `You asked for ${want} and got all ${g}.`;
      } else explanation = `${sea} units reached the sea${sea >= R.HEALTH.envMin ? ', meeting the environmental minimum.' : `, below the minimum of ${R.HEALTH.envMin}.`}`;
      results[id] = {
        asked: def.kind === 'take' ? dec[id].amount : null, extra: dec[id].extra || 0,
        got: def.kind === 'take' ? river.got[id] : null,
        earned: earned[id], spent: spent[id], transfers: transfers[id], total, points: reg.points, lines: lines[id], explanation,
      };
    }

    s.pending = { drought: hazardId === 'drought', bushfire: hazardId === 'bushfire' && !responded };
    s.forceHazard = null;
    const summary = {
      season, practice, climate: fc.climate, hazard: hazardId || null, responded, inflow, damStart, keep, release, turbines, spill,
      losses: river.losses, added: river.added, sea, healthBefore, health: s.river.health, healthDelta: s.river.health - healthBefore,
      crisis, fund: s.river.fund,
      asked: Object.fromEntries(Object.entries(declared)), got: river.got, audits, pledges: pledgeOutcomes,
      totals: Object.fromEntries(order.map((id) => [id, results[id].total])),
    };

    if (practice) {
      // Practice season: show what would have happened, but change nothing that counts.
      const out = clone(state);
      out.pledges = s.pledges;
      out.forceHazard = null;
      for (const id of order) results[id].points = state.regions[id].points;
      return { state: out, log, results, summary };
    }
    s.history.push(summary);
    return { state: s, log, results, summary };
  }

  // A rough estimate for team devices: assumes upstream teams take what they asked for last season.
  function estimate(state, myId) {
    const fc = forecast(state);
    const last = state.history[state.history.length - 1];
    const order = state.order;
    const hl = state.regions.highlands;
    const keepGuess = isPlayable(state, 'highlands') && hl.token ? hl.lastPlan.keep : 0;
    const avail = fc.inflow + state.river.dam;
    const release = avail - Math.min(keepGuess, state.river.damCap, avail);
    const wants = {};
    for (const id of order) {
      if (R.REGIONS[id].kind !== 'take') continue;
      wants[id] = last && last.asked[id] !== undefined ? last.asked[id] : (state.regions[id].token ? state.regions[id].lastPlan.amount : 0);
    }
    let arriving = null;
    if (R.REGIONS[myId].kind === 'take') {
      const w = Object.assign({}, wants, { [myId]: 999 });
      arriving = runRiver(order, release, w, R.START.loss).got[myId];
    }
    const sea = runRiver(order, release, wants, R.START.loss).sea;
    return { inflow: fc.inflow, available: avail, release, arriving, sea, bushfire: !!state.pending.bushfire };
  }

  // End of game: health bonus and the unspent fund shared equally.
  function finalize(state) {
    const s = clone(state);
    const ids = playableIds(s);
    const bonus = Math.min(R.HEALTH.bonusMax, Math.floor(s.river.health * R.HEALTH.bonusRate));
    const share = Math.floor(s.river.fund / ids.length);
    const standings = ids.map((id) => {
      const before = s.regions[id].points;
      s.regions[id].points = before + bonus + share;
      return { id, before, bonus, share, points: s.regions[id].points, broken: s.regions[id].broken };
    }).sort((a, b) => b.points - a.points);
    s.final = { bonus, share, fund: s.river.fund, health: s.river.health, standings };
    s.river.fund = 0;
    s.phase = 'final';
    return s;
  }

  // Pick a class question for the review screen.
  function reviewQuestion(state, summary) {
    const Q = R.QUESTIONS;
    if (summary.pledges && summary.pledges.some((p) => !p.kept)) return Q.broken;
    if (summary.crisis) return Q.crisis;
    if (summary.hazard) return Q.hazard;
    if (summary.sea < R.HEALTH.envMin) return Q.lowSea;
    if (summary.season % 2 === 0) return Q.healthy;
    return Q.general[Math.floor(summary.season / 2) % Q.general.length];
  }

  return {
    mulberry32, rngFor, clone, toInt, normaliseOptions, createState, playableIds, isPlayable, emptyPlan, defaultPlan,
    effectiveUnits, essentialNeed, takePoints, seaPoints, healthChange, healthBand, projectAllowed,
    runRiver, seasonClimate, forecast, drawHazard, pickHazard, hazardEligible, planCost, commitments, legalDecision,
    resolveSeason, estimate, finalize, reviewQuestion,
  };
});
