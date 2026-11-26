// The projector board: river, health meter, fund, scoreboard, cards and teacher controls.
(function () {
  'use strict';
  const R = EDRules, L = EDLogic;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const code = (params.get('code') || '').toUpperCase();
  if (!code) { location.href = '/'; return; }
  const hashKey = new URLSearchParams(location.hash.slice(1)).get('key');
  if (hashKey) { ED.store.set(`ed-teacher-${code}`, hashKey); history.replaceState(null, '', location.pathname + location.search); }
  const key = ED.store.get(`ed-teacher-${code}`);
  let view = null;
  let riverKey = null;
  let animatedFor = null;
  let animTimers = [];
  let qrDone = false;

  const SVGNS = 'http://www.w3.org/2000/svg';
  const W = 1000, H = 360, Y = 195;
  function el(tag, attrs, parent, text) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  const width = (flow) => (flow === null ? 14 : flow <= 0 ? 3 : 6 + flow * 1.5);

  // ---------- river drawing ----------
  let river = null;
  function nodeX(i, n) { return 135 + i * (700 / (n - 1)); }
  function segPath(x1, x2) { const m = (x1 + x2) / 2; return `M ${x1} ${Y} C ${m} ${Y - 45}, ${m} ${Y + 45}, ${x2} ${Y}`; }
  function makeSeg(svg, d, labelX, labelY) {
    const g = el('g', {}, svg);
    const bank = el('path', { d, class: 'bank', fill: 'none', stroke: '#1f5f97', 'stroke-linecap': 'round', 'stroke-width': 20 }, g);
    const water = el('path', { d, class: 'water', fill: 'none', stroke: '#5fa8e0', 'stroke-linecap': 'round', 'stroke-width': 14 }, g);
    const flow = el('path', { d, class: 'flowline', fill: 'none', stroke: '#fff', 'stroke-opacity': 0.55, 'stroke-width': 3, 'stroke-dasharray': '6 22' }, g);
    const label = el('text', { x: labelX, y: labelY, 'text-anchor': 'middle', 'font-size': 30, 'font-weight': 800, fill: '#fff', stroke: '#0f2236', 'stroke-width': 6, 'paint-order': 'stroke' }, g, '');
    for (const p of [bank, water, flow]) p.style.transition = 'stroke-width 0.9s ease';
    return {
      set(f, text) {
        bank.setAttribute('stroke-width', width(f) + 6);
        water.setAttribute('stroke-width', width(f));
        flow.style.display = f === 0 ? 'none' : '';
        label.textContent = text !== undefined ? text : f === null ? '?' : String(f);
      },
    };
  }
  function buildRiver(order) {
    const card = $('river-card');
    card.innerHTML = '';
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'The river from the Highlands to the sea', preserveAspectRatio: 'xMidYMid meet' }, card);
    const style = el('style', {}, svg);
    style.textContent = '@keyframes edflow{to{stroke-dashoffset:-56}} .flowline{animation:edflow 1.4s linear infinite}';
    const n = order.length;
    // rain into the Highlands
    el('text', { x: 200, y: 50, 'font-size': 42, 'text-anchor': 'middle' }, svg, '☁️');
    const inflow = makeSeg(svg, `M 135 4 C 135 60, 135 120, 135 ${Y}`, 135, 80);
    const segs = [];
    for (let i = 0; i < n - 1; i++) segs.push(makeSeg(svg, segPath(nodeX(i, n), nodeX(i + 1, n)), (nodeX(i, n) + nodeX(i + 1, n)) / 2, Y + 10));
    const sea = makeSeg(svg, `M ${nodeX(n - 1, n)} ${Y} C 900 ${Y - 25}, 940 ${Y + 25}, 1000 ${Y}`, 935, Y + 10);
    el('text', { x: 995, y: Y - 45, 'font-size': 26, 'font-weight': 800, 'text-anchor': 'end', fill: '#1f5f97' }, svg, '🌊 Sea');
    // dam tank
    const dam = el('g', {}, svg);
    el('text', { x: 50, y: 34, 'font-size': 22, 'font-weight': 700, 'text-anchor': 'middle', fill: '#0f2236' }, dam, 'Dam');
    el('rect', { x: 20, y: 42, width: 60, height: 80, rx: 6, fill: '#fff', stroke: '#0f2236', 'stroke-width': 4 }, dam);
    const damFill = el('rect', { x: 24, y: 118, width: 52, height: 0, fill: '#5fa8e0' }, dam);
    damFill.style.transition = 'all 0.9s ease';
    const damText = el('text', { x: 50, y: 92, 'font-size': 22, 'font-weight': 800, 'text-anchor': 'middle', fill: '#0f2236', stroke: '#fff', 'stroke-width': 4, 'paint-order': 'stroke' }, dam, '');
    el('path', { d: 'M 80 100 L 128 100', stroke: '#0f2236', 'stroke-width': 3, 'stroke-dasharray': '4 4' }, dam);
    // regions
    const nodes = order.map((id, i) => {
      const def = R.REGIONS[id];
      const x = nodeX(i, n);
      const below = i % 2 === 0;
      const g = el('g', {}, svg);
      el('circle', { cx: x, cy: Y, r: 36, fill: def.color, stroke: '#0f2236', 'stroke-width': 4 }, g);
      el('text', { x, y: Y + 12, 'font-size': 36, 'text-anchor': 'middle' }, g, def.icon);
      const ny = below ? Y + 72 : Y - 52;
      const name = el('text', { x, y: ny, 'font-size': 26, 'font-weight': 800, 'text-anchor': 'middle', fill: '#0f2236', stroke: '#fff', 'stroke-width': 6, 'paint-order': 'stroke' }, g, def.name);
      const status = el('text', { x, y: below ? ny + 30 : ny - 30, 'font-size': 23, 'font-weight': 700, 'text-anchor': 'middle', fill: '#4d6175', stroke: '#fff', 'stroke-width': 6, 'paint-order': 'stroke' }, g, '');
      return { id, name, status };
    });
    river = {
      svg, inflow, segs, sea, nodes,
      setDam(stored, cap) {
        damFill.setAttribute('height', Math.round((76 * stored) / cap));
        damFill.setAttribute('y', 118 - Math.round((76 * stored) / cap));
        damText.textContent = `${stored}/${cap}`;
      },
      status(id, text, tone) {
        const nd = nodes.find((x) => x.id === id);
        nd.status.textContent = text;
        nd.status.setAttribute('fill', tone === 'bad' ? '#b3261e' : tone === 'good' ? '#0b6e4f' : '#4d6175');
      },
    };
  }

  // Build animation steps from the season's event log, so the board can never disagree with the scoring.
  function stepsFromLog(log, order) {
    const steps = [];
    const idx = (id) => order.indexOf(id);
    let pendingLoss = {};
    for (const e of log) {
      if (e.type === 'inflow') steps.push(() => river.inflow.set(e.amount));
      else if (e.type === 'dam') {
        steps.push(() => {
          river.setDam(e.keep, e.cap);
          river.segs[0].set(e.release);
          river.status('highlands', `stored ${e.keep} · released ${e.release}${e.spill ? ` (${e.spill} spilled)` : ''}`);
        });
      } else if (e.type === 'loss') pendingLoss[e.before] = e;
      else if (e.type === 'tributary') pendingLoss[e.region + ':trib'] = e;
      else if (e.type === 'take') {
        const loss = pendingLoss[e.region];
        steps.push(() => {
          const i = idx(e.region);
          const short = e.got < e.wanted;
          river.status(e.region, short ? `asked ${e.wanted} · got ${e.got} ⚠` : `took ${e.got}${loss && loss.amount ? ` (−${loss.amount} lost)` : ''}`, short ? 'bad' : null);
          river.segs[i].set(e.flow);
        });
      } else if (e.type === 'sea') {
        steps.push(() => {
          river.sea.set(e.flow);
          const ok = e.flow >= R.HEALTH.envMin;
          river.status('delta', `sea flow ${e.flow} ${ok ? '✓ minimum met' : `✗ below ${R.HEALTH.envMin}`}`, ok ? 'good' : 'bad');
        });
      }
    }
    return steps;
  }

  function clearAnim() { animTimers.forEach(clearTimeout); animTimers = []; }
  function resetRiverFor(v) {
    river.inflow.set(null);
    river.segs.forEach((s) => s.set(null));
    river.sea.set(null);
    river.setDam(v.river.dam, v.river.damCap);
    for (const r of v.regions) {
      const def = R.REGIONS[r.id];
      let text = '';
      if (!r.playable) text = 'run by the computer';
      else if (!r.joined) text = 'no team yet';
      else if (v.phase === 'plan') text = r.locked ? '🔒 Locked' : '✏️ Planning';
      else text = r.teamName || def.role;
      river.status(r.id, text, v.phase === 'plan' && r.locked ? 'good' : null);
    }
  }
  function drawRiver(v) {
    const k = v.order.join(',');
    if (riverKey !== k) { buildRiver(v.order); riverKey = k; animatedFor = null; }
    const last = v.last;
    if ((v.phase === 'release' || v.phase === 'review' || v.phase === 'final') && last) {
      const tag = `${last.season}:${last.at}`;
      if (animatedFor === tag) return;
      clearAnim();
      resetRiverFor(v);
      river.segs.forEach((s) => s.set(0, ''));
      river.sea.set(0, '');
      river.inflow.set(0, '');
      river.setDam(last.summary.damStart, v.river.damCap);
      const steps = stepsFromLog(last.log, v.order);
      animatedFor = tag;
      river.svg.dataset.anim = 'running';
      const fresh = v.phase === 'release' && Date.now() + ED.offset - last.at < 12000;
      if (!fresh) { steps.forEach((s) => s()); river.svg.dataset.anim = 'done'; return; }
      const start = last.hazard ? 2500 : 900;
      steps.forEach((s, i) => animTimers.push(setTimeout(s, start + i * 1100)));
      animTimers.push(setTimeout(() => { river.svg.dataset.anim = 'done'; }, start + steps.length * 1100));
      return;
    }
    clearAnim();
    animatedFor = null;
    river.svg.dataset.anim = 'idle';
    resetRiverFor(v);
    if (v.forecast) river.inflow.set(v.forecast.inflow, `${v.forecast.inflow} expected`);
  }

  // ---------- health gauge and fund jar ----------
  function polar(cx, cy, r, h) { const a = Math.PI * (1 - h / 100); return [cx + r * Math.cos(a), cy - r * Math.sin(a)]; }
  function arc(cx, cy, r, h1, h2) { const [x1, y1] = polar(cx, cy, r, h1); const [x2, y2] = polar(cx, cy, r, h2); return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`; }
  function drawGauge(v) {
    const svg = $('gauge');
    const h = v.river.health;
    const cx = 120, cy = 122, r = 92;
    const band = L.healthBand(h);
    const bands = [[0, R.HEALTH.crisis, '#c8553d', 'Crisis'], [R.HEALTH.crisis, R.HEALTH.healthy, '#e9c46a', 'Stressed'], [R.HEALTH.healthy, 100, '#2a9d8f', 'Healthy']];
    let s = '';
    for (const [a, b, c] of bands) s += `<path d="${arc(cx, cy, r, a, b)}" stroke="${c}" stroke-width="26" fill="none"/>`;
    // band tick labels so colour is never the only signal
    s += `<text x="22" y="138" font-size="15" font-weight="700" fill="#0f2236">0</text><text x="206" y="138" font-size="15" font-weight="700" fill="#0f2236">100</text>`;
    for (const t of [R.HEALTH.crisis, R.HEALTH.healthy]) { const [x1, y1] = polar(cx, cy, r - 15, t); const [x2, y2] = polar(cx, cy, r + 15, t); s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#0f2236" stroke-width="3"/>`; }
    const [nx, ny] = polar(cx, cy, r - 20, h);
    s += `<line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="#0f2236" stroke-width="7" stroke-linecap="round"/><circle cx="${cx}" cy="${cy}" r="9" fill="#0f2236"/>`;
    s += `<text x="${cx}" y="${cy - 30}" font-size="40" font-weight="800" text-anchor="middle" fill="#0f2236">${h}</text>`;
    svg.innerHTML = s;
    let delta = '';
    const sm = v.last && v.last.summary;
    if (sm && (v.phase === 'review' || v.phase === 'release') && !sm.practice) {
      const d = sm.healthDelta;
      delta = ` <span class="gauge-delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${ED.signed(d)}</span>`;
    }
    $('gauge-label').innerHTML = `River health: ${band}${delta}`;
  }
  function drawJar(v) {
    const f = v.river.fund;
    const frac = Math.min(1, f / 40);
    const hgt = Math.round(84 * frac);
    $('jar').innerHTML = `
      <rect x="30" y="4" width="40" height="10" rx="3" fill="#0f2236"/>
      <path d="M 26 14 L 74 14 Q 92 26 90 50 L 90 104 Q 90 116 78 116 L 22 116 Q 10 116 10 104 L 10 50 Q 8 26 26 14 Z" fill="#fff" stroke="#0f2236" stroke-width="4"/>
      <rect x="14" y="${112 - hgt}" width="72" height="${hgt}" rx="6" fill="#e9c46a"/>
      <text x="50" y="76" font-size="30" font-weight="800" text-anchor="middle" fill="#0f2236" stroke="#fff" stroke-width="5" paint-order="stroke">${f}</text>`;
  }

  // ---------- scoreboard ----------
  function drawScores(v) {
    const rows = v.regions.filter((r) => r.playable).slice().sort((a, b) => b.points - a.points);
    const res = v.last && (v.phase === 'review' || v.phase === 'final') ? v.last.results : null;
    $('scores').innerHTML = rows.map((r, i) => {
      const def = R.REGIONS[r.id];
      const projects = r.projects.map((p) => R.PROJECTS[p].icon).join('');
      const broken = r.broken ? ` <span class="broken" title="Broken pledges">⚠×${r.broken}</span>` : '';
      let status = r.teamName ? ED.esc(r.teamName) : (r.joined ? def.role : 'no team');
      if (v.phase === 'plan' && r.joined) status = r.locked ? '🔒 Locked' : '✏️ Planning';
      const season = res && res[r.id] ? `<small class="${res[r.id].total >= 0 ? 'plus' : 'minus'}">${ED.signed(res[r.id].total)}${v.last.practice ? ' (practice)' : ''}</small>` : '';
      return `<div class="score-row"><span class="rank">${i + 1}</span><span>${def.icon}</span>
        <span class="name"><span class="swatch" style="background:${def.color}"></span> ${ED.esc(def.name)}${broken} ${projects}<small>${status}</small></span>
        <span class="pts">${r.points}${season}</span></div>`;
    }).join('');
  }

  // ---------- phase cards ----------
  function wording() { return view.settings.wording; }
  function drawCard(v) {
    const card = $('phase-card');
    const w = wording();
    if (v.phase === 'lobby') {
      const url = `${location.origin}/team.html?code=${v.code}`;
      const joined = v.regions.filter((r) => r.playable);
      card.innerHTML = `<div class="lobby"><div class="qr" id="qr"></div><div>
        <h2>Join the game</h2>
        <p>On a phone, tablet or laptop go to <span class="joinurl">${ED.esc(location.host)}</span> and enter the code <b class="code" style="font-size:1.2em;letter-spacing:.12em">${v.code}</b></p>
        <p style="font-size:.8em">${joined.map((r) => `${R.REGIONS[r.id].icon} ${r.joined ? '✅' : '⬜'} ${ED.esc(R.REGIONS[r.id].name)}`).join(' &nbsp; ')}</p>
        <p class="muted" style="font-size:.6em">The river is fictional and the numbers are not real data.</p></div></div>`;
      if (window.QRCode) { new QRCode($('qr'), { text: url, width: 170, height: 170, correctLevel: QRCode.CorrectLevel.M }); }
      else $('qr').classList.add('hidden');
      return;
    }
    if (v.phase === 'forecast' || v.phase === 'plan') {
      const c = R.CLIMATES[v.climate];
      const fc = v.forecast;
      const practice = v.practice ? '<p><b>Practice season:</b> no points count. Try things out!</p>' : '';
      if (v.phase === 'forecast') {
        card.innerHTML = `<div class="row"><span class="big-icon">${c.icon}</span><div><h2>${c.name} season: about ${fc.inflow} units of water</h2>
          <p>${ED.esc(c.text)}</p>${fc.notes.map((n) => `<p class="warn">⚠ ${ED.esc(n)}</p>`).join('')}${practice}</div></div>`;
      } else {
        const playing = v.regions.filter((r) => r.playable && r.joined);
        const locked = playing.filter((r) => r.locked).length;
        const pledges = v.pledges.filter((p) => p.status === 'accepted');
        card.innerHTML = `<h2>${c.icon} Plan: ${locked} of ${playing.length} teams locked in</h2>
          <p>${w === 'simple' ? 'Choose how much water to take. Remember: what you take is gone for everyone downstream.' : 'Set your intake, buy projects, give to the fund and make pledges. Choices are hidden until the water is released.'}</p>
          ${pledges.length ? `<p><b>Pledges agreed:</b></p><ul class="pledge-list">${pledges.map((p) => `<li>${ED.esc(ED.pledgeText(v, p))}</li>`).join('')}</ul>` : ''}${practice}`;
      }
      return;
    }
    if (v.phase === 'release') {
      const hz = v.last.hazard ? R.HAZARDS[v.last.hazard] : null;
      if (!hz) { card.innerHTML = `<h2>🌊 The water is released</h2><p>No hazard this season. Watch how much reaches each region.</p>`; return; }
      const ev = v.last.log.find((e) => e.type === 'hazard');
      let resp = '';
      if (hz.response) resp = ev.responded ? `<p class="plus"><b>✅ The Catchment Fund paid ${ev.cost} for ${hz.response.name}.</b></p>` : `<p class="minus"><b>✗ The fund could not pay for ${hz.response.name} (it needed ${hz.response.cost}).</b></p>`;
      card.innerHTML = `<div class="row"><span class="big-icon">${hz.icon}</span><div><h2>Hazard: ${hz.name}</h2><p>${ED.esc(R.word(hz, w))}</p>${resp}</div></div>`;
      return;
    }
    if (v.phase === 'review') {
      const sm = v.last.summary;
      const ok = sm.sea >= R.HEALTH.envMin;
      const broken = sm.pledges.filter((p) => !p.kept);
      const caught = sm.audits.filter((a) => a.caught);
      card.innerHTML = `<div class="facts"><span>${ok ? '✅' : '❌'} Sea flow ${sm.sea} (minimum ${R.HEALTH.envMin})</span>
        <span>Health ${sm.healthBefore} → ${sm.health}</span><span>Fund ${sm.fund}</span></div>
        ${sm.crisis ? '<p class="minus"><b>River crisis: every team\'s points were halved this season.</b></p>' : ''}
        ${sm.practice ? '<p><b>Practice season: none of this counted.</b></p>' : ''}
        ${broken.length ? `<p class="broken">⚠ Broken pledges: ${broken.map((p) => ED.esc(R.REGIONS[p.subject].name)).join(', ')}</p>` : ''}
        ${caught.length ? `<p class="broken">🔍 Caught pumping: ${caught.map((a) => ED.esc(R.REGIONS[a.target].name)).join(', ')}</p>` : ''}
        <p class="question">${ED.esc(R.word(v.last.question, w))}</p>`;
    }
  }

  // ---------- final screen ----------
  function healthChart(v) {
    const pts = [{ s: 0, h: R.START.health }].concat(v.history.map((x) => ({ s: x.season, h: x.health })));
    const n = Math.max(1, v.seasons);
    const X = (s) => 50 + (s / n) * 520, Yh = (h) => 20 + (1 - h / 100) * 200;
    let s = `<svg viewBox="0 0 600 260" style="width:100%" role="img" aria-label="River health across the seasons">`;
    s += `<rect x="50" y="${Yh(100)}" width="520" height="${Yh(R.HEALTH.healthy) - Yh(100)}" fill="#2a9d8f" opacity=".18"/>`;
    s += `<rect x="50" y="${Yh(R.HEALTH.healthy)}" width="520" height="${Yh(R.HEALTH.crisis) - Yh(R.HEALTH.healthy)}" fill="#e9c46a" opacity=".22"/>`;
    s += `<rect x="50" y="${Yh(R.HEALTH.crisis)}" width="520" height="${Yh(0) - Yh(R.HEALTH.crisis)}" fill="#c8553d" opacity=".18"/>`;
    s += `<text x="566" y="${Yh(80)}" font-size="14" text-anchor="end" fill="#0f2236">Healthy</text><text x="566" y="${Yh(42)}" font-size="14" text-anchor="end" fill="#0f2236">Stressed</text><text x="566" y="${Yh(10)}" font-size="14" text-anchor="end" fill="#0f2236">Crisis</text>`;
    for (const t of [0, 25, 60, 100]) s += `<text x="42" y="${Yh(t) + 5}" font-size="14" text-anchor="end" fill="#4d6175">${t}</text>`;
    for (let i = 0; i <= n; i++) s += `<text x="${X(i)}" y="244" font-size="14" text-anchor="middle" fill="#4d6175">${i === 0 ? 'Start' : i}</text>`;
    s += `<polyline fill="none" stroke="#1f5f97" stroke-width="4" points="${pts.map((p) => `${X(p.s)},${Yh(p.h)}`).join(' ')}"/>`;
    for (const p of pts) s += `<circle cx="${X(p.s)}" cy="${Yh(p.h)}" r="6" fill="#1f5f97"/><text x="${X(p.s)}" y="${Yh(p.h) - 10}" font-size="13" text-anchor="middle" font-weight="700">${p.h}</text>`;
    return s + '</svg>';
  }
  function drawFinal(v) {
    const box = $('final');
    if (v.phase !== 'final' || !v.final) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const f = v.final;
    box.innerHTML = `<h1>🏁 Final results · Game ${v.code}</h1>
      <div class="final-grid">
        <div class="card">
          <table class="final-table"><thead><tr><th>#</th><th>Team</th><th>Points</th><th>Health bonus</th><th>Fund share</th><th>Total</th></tr></thead><tbody>
          ${f.standings.map((s, i) => `<tr class="${i === 0 ? 'first' : ''}"><td>${i + 1}</td><td>${R.REGIONS[s.id].icon} ${ED.esc(ED.regionName(v, s.id))}${s.broken ? ` <span class="broken">⚠×${s.broken}</span>` : ''}</td><td>${s.before}</td><td>+${s.bonus}</td><td>+${s.share}</td><td><b>${s.points}</b></td></tr>`).join('')}
          </tbody></table>
          <p class="muted">Final river health ${f.health} (${L.healthBand(f.health)}): every team gets +${f.bonus}. The unspent fund of ${f.fund} is shared equally (+${f.share} each).</p>
          <h3>River health across the game</h3>${healthChart(v)}
        </div>
        <div class="card"><h2>Debrief questions</h2><ol class="debrief">${R.DEBRIEF.map((q) => `<li>${ED.esc(q)}</li>`).join('')}</ol></div>
      </div>
      <p class="muted">The river is fictional and the numbers are not real data. Further reading: the Murray–Darling Basin Authority (mdba.gov.au).</p>
      <div class="final-actions row"><button class="primary" onclick="window.print()">Print or save results</button><a href="/"><button>New game</button></a></div>`;
  }

  // ---------- teacher controls ----------
  async function teacher(action, body) {
    try { await ED.post(`/api/g/${code}/teacher/${action}`, Object.assign({ key }, body)); }
    catch (e) { ED.toast(e.message); }
  }
  function drawTeacher(v) {
    const bar = $('teacher-bar');
    if (!v.teacher) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    $('viewer-note').classList.add('hidden');
    const t = v.teacher;
    const isLast = v.season >= v.seasons;
    const next = {
      lobby: 'Start the game ▶', forecast: 'Start planning ▶', plan: 'Lock plans and release the water ▶', release: 'Show the review ▶',
      review: isLast ? 'Final results ▶' : (v.season === 0 ? 'Start season 1 ▶' : 'Next season ▶'), final: null,
    }[v.phase];
    const b = [];
    if (next) b.push(`<button class="primary" data-act="advance">${next}</button>`);
    if (v.timer) {
      b.push(v.timer.paused ? '<button data-act="resume">▶ Resume timer</button>' : '<button data-act="pause">⏸ Pause</button>');
      b.push('<button data-act="add">+30 s</button><button data-act="reset">Reset timer</button>');
    }
    if (['forecast', 'plan'].includes(v.phase)) {
      if (t.hazardScheduled) b.push('<button data-act="hold-hazard" title="A hazard is due this season">Hold back hazard</button>');
      if (t.held && !t.forced) b.push(`<button data-act="trigger-hazard">Trigger held hazard (${t.held})</button>`);
      if (t.forced) b.push('<span class="muted">Held hazard will strike this season</span>');
    }
    if (t.canUndo) b.push('<button data-act="undo-season">↶ Undo season</button>');
    b.push('<span class="spacer"></span><button data-act="teams">Teams…</button>');
    if (v.phase !== 'final') b.push('<button data-act="end">End game</button>');
    bar.innerHTML = b.join('');
  }
  $('teacher-bar').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const a = btn.dataset.act;
    if (a === 'advance') {
      if (view.phase === 'lobby') return teacher('start');
      return teacher('advance');
    }
    if (['pause', 'resume', 'add', 'reset'].includes(a)) return teacher('timer', { op: a });
    if (a === 'undo-season' && !confirm('Undo this season and go back to Plan?')) return;
    if (a === 'end' && !confirm('End the game now and show the final results?')) return;
    if (a === 'teams') return openTeams();
    teacher(a);
  });
  function openTeams() {
    const d = $('teams-dialog');
    const rows = view.regions.filter((r) => r.playable).map((r) => `<tr><td>${R.REGIONS[r.id].icon} ${ED.esc(ED.regionName(view, r.id))}</td>
      <td>${r.joined ? 'connected' : '<span class="muted">free</span>'}</td>
      <td>${r.joined ? `<button class="small" data-rel="${r.id}">Release</button>` : ''}</td>
      <td>${view.settings.pledges ? `<button class="small" data-mute="${r.id}" data-on="${r.muted ? 0 : 1}">${r.muted ? 'Unmute pledges' : 'Mute pledges'}</button>` : ''}</td></tr>`).join('');
    d.innerHTML = `<h2 style="margin-top:0">Teams</h2><p class="muted">Release a region so another device can join it (for example, if a device is lost). The team keeps its points.</p>
      <table>${rows}</table><p><button class="primary" data-close>Close</button></p>`;
    d.showModal();
  }
  $('teams-dialog').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.close !== undefined) return $('teams-dialog').close();
    if (b.dataset.rel) { if (confirm('Release this region? The device using it will be disconnected.')) await teacher('release-region', { region: b.dataset.rel }); }
    if (b.dataset.mute) await teacher('mute', { region: b.dataset.mute, on: b.dataset.on === '1' });
    setTimeout(openTeams, 150);
  });

  // ---------- main ----------
  function render(v) {
    view = v;
    $('code').textContent = v.code;
    $('season').textContent = ED.seasonLabel(v);
    $('phase').textContent = ED.phaseName(v.phase);
    drawRiver(v);
    drawGauge(v);
    drawJar(v);
    drawScores(v);
    drawCard(v);
    drawTeacher(v);
    drawFinal(v);
    if (!v.teacher) $('viewer-note').classList.remove('hidden');
    document.body.dataset.phase = v.phase;
  }
  setInterval(() => {
    if (!view) return;
    const left = ED.timeLeft(view);
    const t = $('timer');
    t.textContent = left === null ? '' : ED.fmt(left);
    t.classList.toggle('low', left !== null && left < 15000);
    t.classList.toggle('paused', !!(view.timer && view.timer.paused));
  }, 250);

  ED.get(`/api/g/${code}/info`).then(() => {
    ED.stream(`/api/g/${code}/stream${key ? `?key=${encodeURIComponent(key)}` : ''}`, render);
  }).catch((e) => {
    document.body.innerHTML = `<main class="landing"><h1>Game not found</h1><p>${ED.esc(e.message)}</p><p>Saved games are lost when the server is redeployed.</p><a href="/"><button class="primary">Back</button></a></main>`;
  });
})();
