'use strict';
// Every Drop Counts — Node 18+, no runtime dependencies.
// JSON file persistence, Server-Sent Events for live updates.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const R = require('./game/rules');
const L = require('./game/logic');

const PUBLIC_DIR = path.join(__dirname, 'public');
const GAME_DIR = path.join(__dirname, 'game');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O
const MAX_AGE_MS = 3 * 24 * 3600 * 1000;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function createApp({ dataDir, now = () => Date.now(), tickMs = 250 } = {}) {
  dataDir = dataDir || path.join(__dirname, 'data');
  const dataFile = path.join(dataDir, 'games.json');
  const games = new Map();
  const streams = new Map(); // code -> Set of clients

  // ---------- persistence ----------
  try {
    const list = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    for (const g of list) if (now() - (g.updatedAt || 0) < MAX_AGE_MS) games.set(g.code, g);
  } catch (e) { /* no saved games yet */ }
  let saveTimer = null;
  function saveNow() {
    clearTimeout(saveTimer); saveTimer = null;
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...games.values()]));
    fs.renameSync(tmp, dataFile);
  }
  function save() { if (!saveTimer) saveTimer = setTimeout(() => { try { saveNow(); } catch (e) { console.error('save failed', e); } }, 150); }

  // ---------- helpers ----------
  const newToken = () => crypto.randomBytes(12).toString('hex');
  function newCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < 4; i++) c += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
      if (!games.has(c)) return c;
    }
  }
  function getGame(code) {
    const g = games.get(String(code || '').toUpperCase());
    if (!g) throw new HttpError(404, 'No game with that code.');
    return g;
  }
  function teamFor(g, token) {
    if (!token) throw new HttpError(401, 'Missing team token.');
    const id = g.order.find((r) => g.regions[r].token === token);
    if (!id) throw new HttpError(401, 'This device is no longer linked to a region. Join again.');
    return id;
  }
  function checkTeacher(g, key) { if (!key || key !== g.teacherToken) throw new HttpError(403, 'Teacher key required.'); }
  function teamRun(g, id) { return L.isPlayable(g, id) && !!g.regions[id].token; }

  // ---------- timers (server owns the clock) ----------
  function setTimer(g, seconds) { g.timer = { endsAt: now() + seconds * 1000, remaining: null, paused: false, duration: seconds * 1000 }; }
  function timerLeft(g) { if (!g.timer) return null; return g.timer.paused ? g.timer.remaining : g.timer.endsAt - now(); }
  function phaseSeconds(g) {
    if (g.phase === 'forecast') return R.TIMING.forecast;
    if (g.phase === 'plan') return g.options.planTimer;
    if (g.phase === 'release') return R.TIMING.release;
    return null;
  }
  function planOpen(g) { return g.phase === 'plan' && (!g.timer || g.timer.paused || timerLeft(g) > 0); }

  // ---------- the state machine ----------
  function toForecast(g) { g.phase = 'forecast'; g.last = null; setTimer(g, R.TIMING.forecast); }
  function toPlan(g) {
    g.phase = 'plan';
    for (const id of g.order) {
      const r = g.regions[id];
      r.locked = false; r.autoLocked = false;
      r.plan = Object.assign(L.emptyPlan(), { amount: r.lastPlan.amount, keep: r.lastPlan.keep });
    }
    setTimer(g, g.options.planTimer);
  }
  function toRelease(g) {
    const snapshot = JSON.parse(JSON.stringify(Object.assign({}, g, { snapshot: null })));
    const decisions = {};
    for (const id of g.order) {
      const r = g.regions[id];
      if (!teamRun(g, id)) { decisions[id] = L.emptyPlan(); continue; } // computer: release everything, take nothing
      if (r.locked) {
        const v = L.legalDecision(g, id, r.plan);
        decisions[id] = v.ok ? v.plan : Object.assign(L.emptyPlan(), { amount: v.plan.amount, keep: v.plan.keep });
      } else {
        // not locked in: previous season's values
        decisions[id] = Object.assign(L.emptyPlan(), { amount: r.lastPlan.amount, keep: r.lastPlan.keep });
        r.autoLocked = true;
      }
      r.locked = true;
    }
    const hazard = L.drawHazard(g);
    const out = L.resolveSeason(g, decisions, hazard);
    const keep = { teacherToken: g.teacherToken, createdAt: g.createdAt, timer: g.timer, mutes: g.mutes };
    for (const k of Object.keys(g)) delete g[k];
    Object.assign(g, out.state, keep);
    for (const id of g.order) {
      const r = g.regions[id];
      r.lastPlan = Object.assign(L.emptyPlan(), { amount: decisions[id].amount, keep: decisions[id].keep });
    }
    g.snapshot = snapshot;
    g.last = {
      season: out.summary.season, practice: out.summary.practice, hazard, log: out.log, results: out.results, summary: out.summary,
      decisions, question: L.reviewQuestion(g, out.summary), at: now(),
    };
    g.phase = 'release';
    setTimer(g, R.TIMING.release);
  }
  function toReview(g) { g.phase = 'review'; g.timer = null; }
  function nextSeason(g) {
    g.snapshot = null;
    if (g.season >= g.options.seasons) return toFinal(g);
    g.season += 1;
    toForecast(g);
  }
  function toFinal(g) {
    const keep = { teacherToken: g.teacherToken, createdAt: g.createdAt, mutes: g.mutes, last: g.last };
    const f = L.finalize(g);
    for (const k of Object.keys(g)) delete g[k];
    Object.assign(g, f, keep);
    g.timer = null; g.snapshot = null; g.phase = 'final';
  }
  function advance(g) {
    switch (g.phase) {
      case 'lobby': toForecast(g); break;
      case 'forecast': toPlan(g); break;
      case 'plan': toRelease(g); break;
      case 'release': toReview(g); break;
      case 'review': nextSeason(g); break;
      default: throw new HttpError(400, 'The game is over.');
    }
  }
  function changed(g) { g.updatedAt = now(); save(); broadcast(g); }

  const ticker = setInterval(() => {
    for (const g of games.values()) {
      if (g.timer && !g.timer.paused && g.timer.endsAt && now() >= g.timer.endsAt && ['forecast', 'plan', 'release'].includes(g.phase)) {
        try { advance(g); changed(g); } catch (e) { console.error('timer advance failed', e); }
      }
    }
  }, tickMs);
  if (ticker.unref) ticker.unref();

  // ---------- views (each role sees only what it should) ----------
  function publicRegions(g) {
    return g.order.map((id) => {
      const r = g.regions[id];
      return {
        id, playable: L.isPlayable(g, id), joined: !!r.token, teamName: r.teamName || '', locked: !!r.locked,
        points: r.points, projects: r.projects, broken: r.broken, muted: g.mutes.includes(id),
      };
    });
  }
  function commonView(g) {
    const showLast = g.phase === 'release' || g.phase === 'review' || g.phase === 'final';
    return {
      code: g.code, options: g.options, settings: g.settings, order: g.order, season: g.season, seasons: g.options.seasons,
      practice: g.season === 0, phase: g.phase,
      timer: g.timer ? { endsAt: g.timer.endsAt, remaining: g.timer.remaining, paused: g.timer.paused, duration: g.timer.duration } : null,
      serverNow: now(), river: g.river, regions: publicRegions(g),
      forecast: ['forecast', 'plan'].includes(g.phase) ? L.forecast(g) : null,
      climate: ['forecast', 'plan', 'release', 'review'].includes(g.phase) ? (showLast && g.last ? g.last.summary.climate : L.seasonClimate(g)) : null,
      last: showLast ? g.last : null,
      history: g.history,
      pledges: g.pledges.filter((p) => p.season === g.season && ['accepted', 'kept', 'broken'].includes(p.status)),
      final: g.final || null,
    };
  }
  function boardView(g, teacher) {
    const v = commonView(g);
    v.role = 'board';
    if (teacher) {
      v.teacher = {
        hazardScheduled: g.season > 0 && g.hazardSeasons.includes(g.season) && !g.heldSeasons.includes(g.season) && !g.forceHazard,
        held: g.heldHazards.length, forced: !!g.forceHazard, canUndo: !!g.snapshot && ['release', 'review'].includes(g.phase),
      };
    }
    return v;
  }
  function teamView(g, id) {
    const v = commonView(g);
    const r = g.regions[id];
    v.role = 'team';
    v.me = {
      id, teamName: r.teamName, points: r.points, projects: r.projects, broken: r.broken, locked: r.locked, autoLocked: r.autoLocked,
      plan: r.plan, lastPlan: r.lastPlan, muted: g.mutes.includes(id), commitments: L.commitments(g, id),
    };
    v.myPledges = g.pledges.filter((p) => p.season === g.season && [p.proposer, p.responder].includes(id));
    v.estimate = ['forecast', 'plan'].includes(g.phase) ? L.estimate(g, id) : null;
    return v;
  }

  // ---------- SSE ----------
  function send(client, g) {
    if (client.role === 'team' && g.regions[client.region].token !== client.token) {
      client.res.write('event: released\ndata: {}\n\n');
      client.res.end();
      return;
    }
    const view = client.role === 'team' ? teamView(g, client.region) : boardView(g, client.teacher);
    client.res.write(`data: ${JSON.stringify(view)}\n\n`);
  }
  function broadcast(g) {
    const set = streams.get(g.code);
    if (!set) return;
    for (const c of [...set]) { try { send(c, g); } catch (e) { set.delete(c); } }
  }
  const heartbeat = setInterval(() => {
    for (const set of streams.values()) for (const c of set) { try { c.res.write(': ping\n\n'); } catch (e) { /* closed */ } }
  }, 20000);
  if (heartbeat.unref) heartbeat.unref();

  // ---------- actions ----------
  function pledgeAffordable(g, payer, payment, excludeId) {
    const r = g.regions[payer];
    const cost = L.planCost(r.plan) + L.commitments(g, payer, excludeId) + payment;
    return cost <= Math.max(0, r.points);
  }

  const teamActions = {
    'set-plan'(g, id, body) {
      if (!planOpen(g)) throw new HttpError(409, 'Plans can only be changed during Plan.');
      const r = g.regions[id];
      if (r.locked) throw new HttpError(409, 'Unlock first to change your plan.');
      const v = L.legalDecision(g, id, body.plan);
      if (!v.ok) throw new HttpError(400, v.error);
      r.plan = v.plan;
    },
    lock(g, id, body) {
      if (!planOpen(g)) throw new HttpError(409, 'You can only lock in during Plan.');
      const r = g.regions[id];
      if (body.plan) {
        const v = L.legalDecision(g, id, body.plan);
        if (!v.ok) throw new HttpError(400, v.error);
        r.plan = v.plan;
      }
      r.locked = true;
    },
    unlock(g, id) {
      if (!planOpen(g)) throw new HttpError(409, 'The timer has ended.');
      g.regions[id].locked = false;
    },
    'pledge-offer'(g, id, body) {
      if (!g.settings.pledges) throw new HttpError(400, 'Pledges are off for this game.');
      if (!planOpen(g)) throw new HttpError(409, 'Pledges can only be made during Plan.');
      if (g.mutes.includes(id)) throw new HttpError(403, 'Your teacher has paused your pledge proposals.');
      const other = body.other;
      if (!other || other === id || !teamRun(g, other)) throw new HttpError(400, 'Choose another team that is playing.');
      const subject = body.subject === 'me' ? id : other;
      const payer = subject === id ? other : id;
      const def = R.REGIONS[subject];
      if (def.kind === 'sea') throw new HttpError(400, 'The Delta takes no water, so it cannot promise to limit its water.');
      const kind = def.kind === 'dam' ? 'min-release' : 'max-take';
      const amount = L.toInt(body.amount, 0, def.kind === 'dam' ? 60 : def.max);
      const payment = L.toInt(body.payment, 1, R.LIMITS.maxPledgePayment);
      const pending = g.pledges.filter((p) => p.season === g.season && p.proposer === id && p.status === 'pending').length;
      if (pending >= R.LIMITS.maxPendingPledges) throw new HttpError(429, `You can have at most ${R.LIMITS.maxPendingPledges} pledges waiting for an answer.`);
      if (payer === id && !pledgeAffordable(g, id, payment)) throw new HttpError(400, 'Your team cannot afford that payment.');
      g.pledges.push({ id: g.nextPledgeId++, season: g.season, proposer: id, responder: other, subject, payer, kind, amount, payment, status: 'pending' });
    },
    'pledge-respond'(g, id, body) {
      const p = g.pledges.find((x) => x.id === Number(body.id));
      if (!p || p.responder !== id || p.status !== 'pending' || p.season !== g.season) throw new HttpError(400, 'That pledge is no longer waiting for you.');
      if (!planOpen(g)) throw new HttpError(409, 'Pledges can only be answered during Plan.');
      if (body.accept) {
        if (!pledgeAffordable(g, p.payer, p.payment)) throw new HttpError(400, `${R.REGIONS[p.payer].name} cannot afford that payment right now.`);
        p.status = 'accepted';
      } else p.status = 'declined';
    },
    'pledge-cancel'(g, id, body) {
      const p = g.pledges.find((x) => x.id === Number(body.id));
      if (!p || p.proposer !== id || p.status !== 'pending') throw new HttpError(400, 'That pledge cannot be cancelled.');
      p.status = 'cancelled';
    },
  };

  const teacherActions = {
    start(g) { if (g.phase !== 'lobby') throw new HttpError(400, 'Already started.'); toForecast(g); },
    advance(g) { advance(g); },
    timer(g, body) {
      if (!g.timer) throw new HttpError(400, 'There is no timer running in this phase.');
      const t = g.timer;
      switch (body.op) {
        case 'pause': if (!t.paused) { t.remaining = Math.max(0, t.endsAt - now()); t.endsAt = null; t.paused = true; } break;
        case 'resume': if (t.paused) { t.endsAt = now() + t.remaining; t.remaining = null; t.paused = false; } break;
        case 'add': if (t.paused) t.remaining += R.TIMING.addSeconds * 1000; else t.endsAt += R.TIMING.addSeconds * 1000; break;
        case 'reset': { const secs = phaseSeconds(g); const paused = t.paused; setTimer(g, secs); if (paused) teacherActions.timer(g, { op: 'pause' }); break; }
        default: throw new HttpError(400, 'Unknown timer action.');
      }
    },
    'hold-hazard'(g) {
      if (!['forecast', 'plan'].includes(g.phase)) throw new HttpError(400, 'Hold the hazard before the water is released.');
      if (!g.hazardSeasons.includes(g.season) || g.heldSeasons.includes(g.season) || g.forceHazard) throw new HttpError(400, 'No hazard is due this season.');
      const id = L.pickHazard(g);
      g.heldSeasons.push(g.season); g.heldHazards.push(id);
    },
    'trigger-hazard'(g) {
      if (!['forecast', 'plan'].includes(g.phase)) throw new HttpError(400, 'Trigger a held hazard before the water is released.');
      if (!g.heldHazards.length || g.forceHazard) throw new HttpError(400, 'No held hazard to trigger.');
      g.forceHazard = g.heldHazards.shift();
    },
    'undo-season'(g) {
      if (!g.snapshot || !['release', 'review'].includes(g.phase)) throw new HttpError(400, 'Undo is only possible before the next season starts.');
      const snap = g.snapshot;
      const keepTokens = Object.fromEntries(g.order.map((id) => [id, { token: g.regions[id].token, teamName: g.regions[id].teamName }]));
      for (const k of Object.keys(g)) delete g[k];
      Object.assign(g, snap);
      for (const id of g.order) { Object.assign(g.regions[id], keepTokens[id]); g.regions[id].locked = false; }
      g.phase = 'plan'; g.snapshot = null; g.last = null;
      setTimer(g, g.options.planTimer); teacherActions.timer(g, { op: 'pause' });
    },
    'release-region'(g, body) {
      const r = g.regions[body.region];
      if (!r) throw new HttpError(400, 'Unknown region.');
      r.token = null; r.teamName = ''; r.locked = false;
    },
    mute(g, body) {
      if (!g.regions[body.region]) throw new HttpError(400, 'Unknown region.');
      g.mutes = g.mutes.filter((x) => x !== body.region);
      if (body.on) g.mutes.push(body.region);
    },
    end(g) { if (g.phase === 'final') throw new HttpError(400, 'Already finished.'); toFinal(g); },
  };

  // ---------- HTTP ----------
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 20000) { reject(new HttpError(413, 'Too large')); req.destroy(); } });
      req.on('end', () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch (e) { reject(new HttpError(400, 'Bad JSON')); } });
      req.on('error', reject);
    });
  }
  function json(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
  function serveFile(res, file) {
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const parts = p.split('/').filter(Boolean);

    if (p === '/healthz') return json(res, 200, { ok: true, games: games.size });

    if (parts[0] === 'api') {
      if (req.method === 'POST' && p === '/api/create') {
        const body = await readBody(req);
        const code = newCode();
        const seed = crypto.randomInt(2 ** 31);
        const g = L.createState({ code, options: body, seed });
        g.teacherToken = newToken(); g.createdAt = now(); g.timer = null; g.snapshot = null;
        games.set(code, g); changed(g);
        return json(res, 200, { code, teacherToken: g.teacherToken, options: g.options });
      }
      if (parts[1] === 'g' && parts[2]) {
        const g = getGame(parts[2]);
        const rest = parts.slice(3);
        if (req.method === 'GET' && rest[0] === 'info') {
          return json(res, 200, {
            code: g.code, options: g.options, phase: g.phase, season: g.season,
            regions: g.order.map((id) => ({ id, playable: L.isPlayable(g, id), free: L.isPlayable(g, id) && !g.regions[id].token })),
          });
        }
        if (req.method === 'POST' && rest[0] === 'join') {
          const body = await readBody(req);
          const id = body.region;
          if (!g.regions[id] || !L.isPlayable(g, id)) throw new HttpError(400, 'Pick one of the regions.');
          if (g.phase === 'final') throw new HttpError(400, 'This game has finished.');
          if (g.regions[id].token) throw new HttpError(409, 'Another device already has that region. Ask your teacher to release it.');
          const token = newToken();
          g.regions[id].token = token;
          g.regions[id].teamName = String(body.teamName || '').replace(/[<>]/g, '').trim().slice(0, 24);
          changed(g);
          return json(res, 200, { token, region: id });
        }
        if (req.method === 'GET' && rest[0] === 'stream') {
          const t = url.searchParams.get('t');
          const key = url.searchParams.get('key');
          let client;
          if (t) client = { role: 'team', region: teamFor(g, t), token: t };
          else client = { role: 'board', teacher: key === g.teacherToken };
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write('retry: 2000\n\n');
          client.res = res;
          if (!streams.has(g.code)) streams.set(g.code, new Set());
          streams.get(g.code).add(client);
          req.on('close', () => { const s = streams.get(g.code); if (s) s.delete(client); });
          send(client, g);
          return;
        }
        if (req.method === 'POST' && rest[0] === 'team' && teamActions[rest[1]]) {
          const body = await readBody(req);
          const id = teamFor(g, body.token);
          teamActions[rest[1]](g, id, body);
          changed(g);
          return json(res, 200, { ok: true, view: teamView(g, id) });
        }
        if (req.method === 'POST' && rest[0] === 'teacher' && teacherActions[rest[1]]) {
          const body = await readBody(req);
          checkTeacher(g, body.key || req.headers['x-teacher-key']);
          teacherActions[rest[1]](g, body);
          changed(g);
          return json(res, 200, { ok: true });
        }
      }
      throw new HttpError(404, 'Unknown API route.');
    }

    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    if (parts[0] === 'game' && ['rules.js', 'logic.js'].includes(parts[1])) return serveFile(res, path.join(GAME_DIR, parts[1]));
    let file = p === '/' ? '/index.html' : p;
    if (!path.extname(file)) file += '.html';
    const full = path.normalize(path.join(PUBLIC_DIR, file));
    if (!full.startsWith(PUBLIC_DIR)) throw new HttpError(403, 'Forbidden');
    return serveFile(res, full);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!(e instanceof HttpError)) console.error(e);
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
      else res.end();
    });
  });
  server.on('close', () => { clearInterval(ticker); clearInterval(heartbeat); });
  function close() {
    for (const set of streams.values()) for (const c of set) { try { c.res.end(); } catch (e) { /* ignore */ } }
    try { saveNow(); } catch (e) { /* ignore */ }
    return new Promise((r) => { server.close(r); if (server.closeAllConnections) server.closeAllConnections(); });
  }
  return { server, games, saveNow, close };
}

if (require.main === module) {
  const app = createApp({ dataDir: process.env.DATA_DIR });
  const port = Number(process.env.PORT) || 3000;
  app.server.listen(port, () => console.log(`Every Drop Counts on http://localhost:${port}`));
  const stop = () => { app.saveNow(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createApp };
