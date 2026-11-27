// A team's device: join, forecast, plan, release, review. Built for one thumb on a 390 px phone.
(function () {
  'use strict';
  const R = EDRules, L = EDLogic;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let code = (params.get('code') || '').toUpperCase();
  let token = params.get('t') || (code ? ED.store.get(`ed-team-${code}`) : null);
  let view = null, es = null;
  let draft = null, draftKey = null;
  let pledgeForm = { other: '', subject: 'them', amount: 3, payment: 3 };
  let interacting = false, pendingRender = false, saveTimer = null, busy = false;
  let releaseShownFor = null;

  // ---------- joining ----------
  async function showJoin(message) {
    $('head').innerHTML = '';
    $('lockbar').classList.add('hidden');
    const main = $('main');
    if (!code) {
      main.innerHTML = `<section class="card"><h2>Join a game</h2>${message ? `<p class="error">${ED.esc(message)}</p>` : ''}
        <form id="code-form"><label>Game code<input id="code-in" class="code-input" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="ABCD"></label>
        <p><button class="primary big">Next</button></p></form></section>`;
      $('code-form').onsubmit = (e) => { e.preventDefault(); const c = $('code-in').value.trim().toUpperCase(); if (c.length === 4) { code = c; history.replaceState(null, '', `?code=${c}`); showJoin(); } };
      return;
    }
    let info;
    try { info = await ED.get(`/api/g/${code}/info`); }
    catch (e) { code = ''; return showJoin(e.message); }
    const free = info.regions.filter((r) => r.playable);
    main.innerHTML = `<section class="card"><h2>Game ${ED.esc(code)}: pick your region</h2>${message ? `<p class="error">${ED.esc(message)}</p>` : ''}
      <label style="display:grid;gap:.25rem;font-weight:600;margin-bottom:.8rem">Team name (optional)<input id="team-name" maxlength="24" placeholder="e.g. The Water Rats"></label>
      <div class="regions-pick">${free.map((r) => {
        const d = R.REGIONS[r.id];
        return `<button data-region="${r.id}" ${r.free ? '' : 'disabled'} style="border-color:${d.color}"><span class="ri">${d.icon}</span><span>${ED.esc(d.name)}<small>${r.free ? ED.esc(d.role) : 'Taken by another team'}</small></span></button>`;
      }).join('')}</div>
      <p class="muted" style="font-size:.9rem">Only one device per team. The river is fictional and the numbers are not real data.</p></section>`;
    main.querySelectorAll('[data-region]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const res = await ED.post(`/api/g/${code}/join`, { region: b.dataset.region, teamName: $('team-name').value });
        token = res.token;
        ED.store.set(`ed-team-${code}`, token);
        history.replaceState(null, '', `?code=${code}&t=${token}`);
        connect();
      } catch (e) { showJoin(e.message); }
    }));
  }

  function connect() {
    if (es) es.close();
    es = ED.stream(`/api/g/${code}/stream?t=${encodeURIComponent(token)}`, onView, () => {
      ED.store.del(`ed-team-${code}`); token = null;
      history.replaceState(null, '', `?code=${code}`);
      showJoin('Your teacher released this region, so this device is no longer linked to it. Pick a region to join again.');
    });
    es.onerror = async () => {
      // A 401 means the token is no longer valid; EventSource cannot see status codes, so check.
      if (es.readyState === EventSource.CLOSED) {
        try { await ED.get(`/api/g/${code}/info`); } catch (e) { code = ''; return showJoin(e.message); }
        ED.store.del(`ed-team-${code}`); token = null; showJoin('This device is not linked to a region. Pick one to join.');
      }
    };
  }

  // ---------- helpers ----------
  const me = () => view.me;
  const def = () => R.REGIONS[view.me.id];
  const w = () => view.settings.wording;
  function remaining() {
    return Math.max(0, me().points) - me().commitments - L.planCost(draft);
  }
  function projectsWithDraft() { return me().projects.concat(draft.buy); }
  function damCap() { return draft.buy.includes('raisedam') || me().projects.includes('raisedam') ? R.START.raisedDamCap : view.river.damCap; }

  function onView(v) {
    view = v;
    const key = `${v.season}:${v.phase}`;
    if (v.phase === 'plan' && (draftKey !== key || !draft)) { draft = Object.assign(L.emptyPlan(), JSON.parse(JSON.stringify(v.me.plan))); draftKey = key; }
    if (v.phase !== 'plan') draftKey = null;
    const ae = document.activeElement;
    if (interacting || (ae && ae.tagName === 'SELECT')) { pendingRender = true; return; }
    render();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { await ED.post(`/api/g/${code}/team/set-plan`, { token, plan: draft }); }
      catch (e) { ED.toast(e.message); if (view) { draft = Object.assign(L.emptyPlan(), JSON.parse(JSON.stringify(view.me.plan))); render(); } }
    }, 300);
  }
  async function action(name, body) {
    if (busy) return;
    busy = true;
    try { await ED.post(`/api/g/${code}/team/${name}`, Object.assign({ token }, body)); }
    catch (e) { ED.toast(e.message); if (e.status === 401) { ED.store.del(`ed-team-${code}`); token = null; showJoin(e.message); } }
    finally { busy = false; }
  }

  // ---------- header ----------
  function renderHead() {
    const d = def();
    $('head').innerHTML = `<div class="team-head"><span class="icon" style="background:${d.color}">${d.icon}</span>
      <span class="who"><b>${ED.esc(d.name)}</b><small>${ED.esc(me().teamName || d.role)}${me().broken ? ` · <span title="broken pledges">⚠ broke ${me().broken} pledge${me().broken > 1 ? 's' : ''}</span>` : ''}</small></span>
      <span class="pts">${me().points}<small>points</small></span></div>
      <div class="phasebar"><span>${ED.esc(ED.seasonLabel(view))} · ${ED.esc(ED.phaseName(view.phase))}</span><span class="timer" id="timer"></span></div>`;
  }

  // ---------- phases ----------
  function lobbyHTML() {
    const d = def();
    return `<section class="card"><h2>You are ${ED.esc(d.name)} ${d.icon}</h2><p>Waiting for your teacher to start the game.</p>
      <h3>How you score</h3><p>${ED.esc(w() === 'simple' ? d.simple : d.howScore)}</p>${riverOrderHTML()}</section>${rejoinHTML()}`;
  }
  function riverOrderHTML() {
    return `<h3>The river, from the hills to the sea</h3><p class="river-line">${view.order.map((id) => `<span class="r ${id === me().id ? 'me' : ''}">${R.REGIONS[id].icon} ${ED.esc(R.REGIONS[id].name)}</span>`).join('<span class="arrow">→</span>')}<span class="arrow">→</span><span class="r">🌊 Sea</span></p>
      <p class="muted">Water taken upstream is gone for everyone below it.</p>`;
  }
  function rejoinHTML() {
    const url = `${location.origin}/team.html?code=${code}&t=${token}`;
    return `<details class="card" style="margin-top:1rem"><summary><b>Rejoin link</b> (if this device is lost or refreshed)</summary>
      <p class="muted">Open this link on another device to carry on as your region. Keep it within your team.</p>
      <p style="word-break:break-all;font-size:.85rem">${ED.esc(url)}</p><button class="small" id="copy-link">Copy link</button></details>`;
  }
  function meaningLine() {
    const est = view.estimate;
    if (!est) return '';
    const d = def();
    const basis = view.history.length ? 'if other teams take what they did last season' : 'if other teams take their usual amounts';
    if (d.kind === 'take') return `About <b>${est.arriving}</b> units should reach you ${basis}. You can take up to ${d.max}.`;
    if (d.kind === 'dam') return `About <b>${est.available}</b> units will reach the Highlands (the rain plus the ${view.river.dam} already in your dam).`;
    return `About <b>${est.sea}</b> units should reach the sea ${basis}.`;
  }
  function forecastHTML() {
    const c = R.CLIMATES[view.climate];
    const fc = view.forecast;
    return `<section class="card"><div class="row"><span class="climate-icon">${c.icon}</span><div><h2>${c.name} season</h2><p>About ${fc.inflow} units of water are expected.</p></div></div>
      ${fc.notes.map((n) => `<div class="warnbox">⚠ ${ED.esc(n)}</div>`).join('')}
      <div class="estimate"><span class="label">What this means for us (estimate)</span><br>${meaningLine()}</div>
      ${view.practice ? '<div class="goodbox"><b>Practice season:</b> no points count.</div>' : ''}
      <p class="muted">Planning starts soon. Talk with your team about how much to take.</p></section>`;
  }

  function stepper(name, value, min, max, step) {
    return `<span class="stepper"><button type="button" data-step="${name}" data-d="${-step}" ${value <= min ? 'disabled' : ''}>−</button><span>${value}</span><button type="button" data-step="${name}" data-d="${step}" ${value + step > max ? 'disabled' : ''}>+</button></span>`;
  }

  function estimateHTML() {
    const est = view.estimate;
    const d = def();
    const id = me().id;
    const prj = projectsWithDraft();
    if (d.kind === 'take') {
      const want = draft.amount + (view.settings.pumping ? draft.extra : 0);
      const got = Math.min(want, est.arriving);
      const pts = L.takePoints(id, got, prj, est.bushfire && d.town);
      const full = L.takePoints(id, want, prj, est.bushfire && d.town);
      return `<span class="label">Estimate</span><br>About <b>${est.arriving}</b> units may reach you. Taking ${want} you would get about ${got} and score about <b>${pts}</b> points${got < want ? ` (${full} if the river has enough)` : ''}.`;
    }
    if (d.kind === 'dam') {
      const keep = Math.min(draft.keep, damCap(), est.available);
      const release = est.available - keep;
      const turb = Math.min(release, d.turbineCap);
      return `<span class="label">Estimate</span><br>About ${est.available} units arrive. Store <b>${keep}</b>, release <b>${release}</b> downstream: about <b>${turb}</b> points from the turbines${release > turb ? ` (${release - turb} would spill and score nothing)` : ''}.`;
    }
    const pts = L.seaPoints(est.sea, prj);
    return `<span class="label">Estimate</span><br>About <b>${est.sea}</b> units may reach the sea: about <b>${pts}</b> points${est.sea < R.HEALTH.envMin ? `. Below ${R.HEALTH.envMin} the river gets sicker. Pledges can pay upstream teams to take less.` : '.'}`;
  }

  function myPromiseWarning() {
    const mine = view.myPledges.filter((p) => p.status === 'accepted' && p.subject === me().id);
    return mine.map((p) => {
      const ok = p.kind === 'min-release' ? true : draft.amount + draft.extra <= p.amount;
      return `<div class="${ok ? 'goodbox' : 'warnbox'}">${ok ? '🤝' : '⚠'} You promised: ${ED.esc(ED.pledgeText(view, p))}.${ok ? '' : ' Your plan breaks this promise: no payment, and a broken-pledge mark on the board.'}</div>`;
    }).join('');
  }

  function decisionHTML() {
    const d = def();
    let html = '';
    if (d.kind === 'take') {
      html += `<h2>How much water will you take?</h2>
        <div class="slider-row"><input type="range" id="amount" min="0" max="${d.max}" step="1" value="${draft.amount}" aria-label="Water to take"><span class="slider-value" id="amount-val">${draft.amount}</span></div>
        <p class="muted" style="margin:.2rem 0">${ED.esc(w() === 'simple' ? d.simple : d.howScore)}</p>`;
      if (view.settings.pumping) {
        html += `<h3>🤫 Secret extra pumping</h3><div class="row">${stepper('extra', draft.extra, 0, R.LIMITS.pumpExtra, 1)}<span class="muted">Hidden extra units. If the Delta audits you, you lose their value plus ${R.LIMITS.auditPenalty} points.</span></div>`;
      }
    } else if (d.kind === 'dam') {
      html += `<h2>How much will you store in the dam?</h2>
        <div class="slider-row"><input type="range" id="keep" min="0" max="${damCap()}" step="1" value="${Math.min(draft.keep, damCap())}" aria-label="Water to store"><span class="slider-value" id="keep-val">${Math.min(draft.keep, damCap())}</span></div>
        <p class="muted" style="margin:.2rem 0">Everything you don't store is released downstream. ${ED.esc(w() === 'simple' ? d.simple : d.howScore)}</p>`;
    } else {
      html += `<h2>Your region takes no water</h2><p class="muted">${ED.esc(w() === 'simple' ? d.simple : d.howScore)}</p>`;
      if (view.settings.pumping) {
        const targets = view.order.filter((id) => R.REGIONS[id].kind === 'take' && view.regions.find((r) => r.id === id).joined);
        html += `<h3>🔍 Audit a team for illegal pumping (${R.LIMITS.auditCost} points)</h3>
          <select id="audit"><option value="">No audit this season</option>${targets.map((id) => `<option value="${id}" ${draft.audit === id ? 'selected' : ''}>${ED.esc(R.REGIONS[id].name)}</option>`).join('')}</select>
          <p class="muted">If they pumped, they pay you the value of the water plus ${R.LIMITS.auditPenalty}. If not, you lose your ${R.LIMITS.auditCost}.</p>`;
      }
    }
    html += `<div class="estimate" id="estimate">${estimateHTML()}</div>${myPromiseWarning()}`;
    return `<section class="card">${html}</section>`;
  }

  function projectsHTML() {
    const id = me().id;
    const list = R.PROJECT_IDS.filter((pid) => L.projectAllowed(id, pid));
    const left = remaining();
    return `<section class="card"><h2>Projects</h2><p class="muted">Bought once, they last for the rest of the game.</p>${list.map((pid) => {
      const p = R.PROJECTS[pid];
      const owned = me().projects.includes(pid);
      const buying = draft.buy.includes(pid);
      const btn = owned ? '<span class="badge locked">Owned</span>'
        : buying ? `<button type="button" class="small primary" data-buy="${pid}">✓ Buying</button>`
        : `<button type="button" class="small" data-buy="${pid}" ${p.cost > left ? 'disabled' : ''}>Buy ${p.cost}</button>`;
      return `<div class="project"><span class="pi">${p.icon}</span><span><b>${ED.esc(p.name)}</b> · ${p.cost} pts<small>${ED.esc(p.text)}</small></span>${btn}</div>`;
    }).join('')}</section>`;
  }

  function fundHTML() {
    const step = view.settings.fundStep || 1;
    const max = draft.contribute + remaining();
    return `<section class="card"><h2>Catchment Fund (now ${view.river.fund})</h2>
      <p class="muted">The fund pays for hazard responses such as drought relief and flood clean-up. Whatever is left at the end is shared equally by all teams.</p>
      <div class="row"><span>We give:</span>${stepper('contribute', draft.contribute, 0, max, step)}<span>points</span></div></section>`;
  }

  function pledgesHTML() {
    if (!view.settings.pledges) return '';
    const id = me().id;
    const mine = view.myPledges;
    const incoming = mine.filter((p) => p.status === 'pending' && p.responder === id);
    const outgoing = mine.filter((p) => p.status === 'pending' && p.proposer === id);
    const agreed = mine.filter((p) => p.status === 'accepted');
    const declined = mine.filter((p) => p.status === 'declined' && p.proposer === id);
    const others = view.regions.filter((r) => r.playable && r.joined && r.id !== id);
    if (!pledgeForm.other || !others.find((r) => r.id === pledgeForm.other)) pledgeForm.other = others[0] ? others[0].id : '';
    // who can promise: the Delta takes no water, so it can never be the one promising
    const otherDef = pledgeForm.other ? R.REGIONS[pledgeForm.other] : null;
    const canThem = otherDef && otherDef.kind !== 'sea';
    const canMe = def().kind !== 'sea';
    if (pledgeForm.subject === 'them' && !canThem) pledgeForm.subject = 'me';
    if (pledgeForm.subject === 'me' && !canMe) pledgeForm.subject = 'them';
    const subjId = pledgeForm.subject === 'me' ? id : pledgeForm.other;
    const subjDef = subjId ? R.REGIONS[subjId] : null;
    const maxAmount = subjDef ? (subjDef.kind === 'dam' ? 40 : subjDef.max) : 0;
    pledgeForm.amount = Math.min(pledgeForm.amount, maxAmount);
    const preview = subjDef && (canThem || canMe) ? ED.pledgeText(view, {
      subject: subjId, payer: subjId === id ? pledgeForm.other : id, kind: subjDef.kind === 'dam' ? 'min-release' : 'max-take', amount: pledgeForm.amount, payment: pledgeForm.payment,
    }) : '';
    const item = (p, buttons) => `<div class="pledge">${ED.esc(ED.pledgeText(view, p))}${buttons ? `<div class="actions">${buttons}</div>` : ''}</div>`;
    let html = `<section class="card"><h2>🤝 Pledges</h2><p class="muted">A pledge is checked automatically after the water runs. Kept: the payment is made. Broken: no payment, and a mark on the board for the rest of the game.</p>`;
    if (incoming.length) html += `<h3>Waiting for your answer</h3>${incoming.map((p) => item(p, `<button class="small primary" data-accept="${p.id}">Accept</button><button class="small" data-decline="${p.id}">Decline</button>`)).join('')}`;
    if (agreed.length) html += `<h3>Agreed this season</h3>${agreed.map((p) => item(p)).join('')}`;
    if (outgoing.length) html += `<h3>You offered</h3>${outgoing.map((p) => item(p, `<button class="small" data-cancel="${p.id}">Cancel</button>`)).join('')}`;
    if (declined.length) html += `<p class="muted">Declined: ${declined.map((p) => ED.esc(R.REGIONS[p.responder].name)).join(', ')}</p>`;
    if (me().muted) html += '<p class="warnbox">Your teacher has paused your pledge proposals.</p>';
    else if (!others.length) html += '<p class="muted">No other teams have joined yet.</p>';
    else {
      html += `<h3>Propose a pledge</h3><div class="form-grid">
        <label>With<select id="pl-other">${others.map((r) => `<option value="${r.id}" ${r.id === pledgeForm.other ? 'selected' : ''}>${R.REGIONS[r.id].icon} ${ED.esc(R.REGIONS[r.id].name)}</option>`).join('')}</select></label>
        <label>Who makes the promise?<select id="pl-subject">
          <option value="them" ${pledgeForm.subject === 'them' ? 'selected' : ''} ${canThem ? '' : 'disabled'}>They promise, we pay</option>
          <option value="me" ${pledgeForm.subject === 'me' ? 'selected' : ''} ${canMe ? '' : 'disabled'}>We promise, they pay</option></select></label>
        <div class="row"><span>${subjDef && subjDef.kind === 'dam' ? 'Release at least' : 'Take no more than'}</span>${stepper('pl-amount', pledgeForm.amount, 0, maxAmount, 1)}<span>units</span></div>
        <div class="row"><span>Payment</span>${stepper('pl-payment', pledgeForm.payment, 1, R.LIMITS.maxPledgePayment, 1)}<span>points</span></div>
        <p><b>${ED.esc(preview)}</b></p><button type="button" class="primary" id="pl-send" ${preview ? '' : 'disabled'}>Send proposal</button></div>`;
    }
    return html + '</section>';
  }

  function planHTML() {
    const locked = me().locked;
    return `${view.practice ? '<div class="goodbox"><b>Practice season:</b> no points count, so try things out.</div>' : ''}
      <fieldset id="plan-fields" ${locked ? 'disabled' : ''} style="border:0;padding:0;margin:0">${decisionHTML()}${projectsHTML()}${fundHTML()}</fieldset>
      ${pledgesHTML()}${rejoinHTML()}`;
  }

  function lockbarHTML() {
    const spend = L.planCost(draft) + me().commitments;
    const spendText = `This plan spends ${spend} of your ${Math.max(0, me().points)} points${me().commitments ? ` (including ${me().commitments} promised in pledges)` : ''}.`;
    if (me().locked) return `<div class="inner"><div class="spend">🔒 Locked in. You can unlock until the timer ends.</div><button class="big unlock" id="unlock">Unlock to change</button></div>`;
    return `<div class="inner"><div class="spend">${spendText}</div><button class="big lock" id="lock">Lock in our plan</button></div>`;
  }

  function releaseRows() {
    const log = view.last.log;
    const rows = [];
    const dam = log.find((e) => e.type === 'dam');
    rows.push({ id: 'highlands', arrive: dam.available, text: `${dam.available} arrive · released ${dam.release}` });
    for (const id of view.order.slice(1)) {
      const loss = log.find((e) => e.type === 'loss' && e.before === id);
      const trib = log.find((e) => e.type === 'tributary' && e.region === id);
      const take = log.find((e) => e.type === 'take' && e.region === id);
      const arrive = trib ? trib.flow : loss.flow;
      if (take) rows.push({ id, arrive, text: take.got < take.wanted ? `${arrive} arrive · asked ${take.wanted}, got ${take.got}` : `${arrive} arrive · took ${take.got}` });
      else rows.push({ id, arrive, text: `${arrive} reach the sea` });
    }
    return rows;
  }
  function releaseHTML() {
    const rows = releaseRows();
    const max = Math.max(10, ...rows.map((r) => r.arrive));
    const hz = view.last.hazard ? R.HAZARDS[view.last.hazard] : null;
    const ev = view.last.log.find((e) => e.type === 'hazard');
    return `${hz ? `<section class="card"><h2>${hz.icon} Hazard: ${hz.name}</h2><p>${ED.esc(R.word(hz, w()))}</p>${hz.response ? (ev.responded ? `<div class="goodbox">The Catchment Fund paid ${ev.cost} for ${hz.response.name}.</div>` : `<div class="warnbox">The fund could not pay for ${hz.response.name} (needed ${hz.response.cost}).</div>`) : ''}</section>` : ''}
      <section class="card"><h2>🌊 The water runs down the river</h2><div class="mini-river">${rows.map((r, i) => {
        const d = R.REGIONS[r.id];
        return `<div class="mini-row ${r.id === me().id ? 'me' : ''}" data-i="${i}"><span class="micon">${d.icon}</span><span class="mbody"><span class="mtop"><span class="mname">${ED.esc(d.name)}</span><span class="mtext">${ED.esc(r.text)}</span></span><span class="mini-track"><span class="mini-bar" style="width:0%" data-w="${Math.round((r.arrive / max) * 100)}"></span></span></span></div>`;
      }).join('')}</div></section>`;
  }
  function animateRelease(fresh) {
    const rows = [...document.querySelectorAll('.mini-row')];
    rows.forEach((row, i) => {
      const show = () => { row.classList.add('shown'); const b = row.querySelector('.mini-bar'); b.style.width = `${Math.max(b.dataset.w, 3)}%`; };
      if (fresh) setTimeout(show, 800 + i * 900); else show();
    });
  }

  function reviewHTML() {
    const res = view.last.results[me().id];
    const sm = view.last.summary;
    const pledges = sm.pledges.filter((p) => p.subject === me().id || p.payer === me().id);
    return `<section class="card"><p class="result-big">${ED.esc(res.explanation)}</p>
      <ul class="lines">${res.lines.map((l) => `<li>${ED.esc(l)}</li>`).join('')}</ul>
      <p class="result-big">This season: <span class="${res.total >= 0 ? 'plus' : 'minus'}">${ED.signed(res.total)}</span> points</p>
      ${sm.practice ? '<div class="goodbox">Practice season: this did not count.</div>' : `<p>Total: <b>${me().points}</b> points</p>`}
      ${me().autoLocked ? '<div class="warnbox">You did not lock in, so your previous season\'s choice was used.</div>' : ''}
      ${pledges.map((p) => `<div class="${p.kept ? 'goodbox' : 'warnbox'}">${p.kept ? '🤝 Pledge kept' : '⚠ Pledge broken'}: ${ED.esc(ED.pledgeText(view, p))}</div>`).join('')}</section>
      <section class="card"><h2>The river</h2><p>Sea flow ${sm.sea} (minimum ${R.HEALTH.envMin}) ${sm.sea >= R.HEALTH.envMin ? '✅' : '❌'} · River health ${sm.healthBefore} → <b>${sm.health}</b> (${L.healthBand(sm.health)})</p>
      ${sm.crisis ? '<div class="warnbox">River crisis: every team\'s points were halved this season.</div>' : ''}
      <p class="question"><b>Think about it:</b> ${ED.esc(R.word(view.last.question, w()))}</p></section>`;
  }

  function finalHTML() {
    const f = view.final;
    const i = f.standings.findIndex((s) => s.id === me().id);
    const s = f.standings[i];
    return `<section class="card"><h2>🏁 Final results</h2><p class="result-big">You finished ${['1st', '2nd', '3rd', '4th', '5th', '6th'][i]} with ${s.points} points.</p>
      <p>${s.before} points + ${s.bonus} river health bonus + ${s.share} share of the fund.</p>
      <ol>${f.standings.map((x) => `<li>${R.REGIONS[x.id].icon} ${ED.esc(R.REGIONS[x.id].name)}: ${x.points}</li>`).join('')}</ol>
      <p class="muted">Look at the board for the debrief questions.</p></section>`;
  }

  // ---------- render ----------
  function render() {
    pendingRender = false;
    if (!view || !view.me) return;
    renderHead();
    const main = $('main');
    const lockbar = $('lockbar');
    lockbar.classList.add('hidden');
    const scroll = window.scrollY;
    if (view.phase === 'lobby') main.innerHTML = lobbyHTML();
    else if (view.phase === 'forecast') main.innerHTML = forecastHTML();
    else if (view.phase === 'plan') {
      main.innerHTML = planHTML();
      lockbar.innerHTML = lockbarHTML();
      lockbar.classList.remove('hidden');
      window.scrollTo(0, scroll);
    } else if (view.phase === 'release') {
      const tag = `${view.last.season}:${view.last.at}`;
      main.innerHTML = releaseHTML();
      animateRelease(releaseShownFor !== tag && Date.now() + ED.offset - view.last.at < 12000);
      releaseShownFor = tag;
    } else if (view.phase === 'review') main.innerHTML = reviewHTML();
    else if (view.phase === 'final') main.innerHTML = finalHTML();
    tickTimer();
  }

  function tickTimer() {
    const t = $('timer');
    if (!t || !view) return;
    const left = ED.timeLeft(view);
    t.textContent = left === null ? '' : `${ED.fmt(left)}${view.timer && view.timer.paused ? ' ⏸' : ''}`;
  }
  setInterval(tickTimer, 250);

  // ---------- events ----------
  document.addEventListener('pointerdown', (e) => { if (e.target.matches('input[type=range]')) interacting = true; });
  const endInteract = () => { if (interacting) { interacting = false; if (pendingRender) setTimeout(render, 50); } };
  document.addEventListener('pointerup', endInteract);
  document.addEventListener('pointercancel', endInteract);
  document.addEventListener('focusout', () => { if (pendingRender && !interacting) setTimeout(() => { if (pendingRender) render(); }, 50); });

  document.addEventListener('input', (e) => {
    if (!draft) return;
    if (e.target.id === 'amount' || e.target.id === 'keep') {
      draft[e.target.id] = Number(e.target.value);
      $(`${e.target.id}-val`).textContent = e.target.value;
      $('estimate').innerHTML = estimateHTML();
    }
  });
  document.addEventListener('change', (e) => {
    const id = e.target.id;
    if (!draft) return;
    if (id === 'amount' || id === 'keep') { scheduleSave(); render(); }
    if (id === 'audit') { draft.audit = e.target.value || null; scheduleSave(); render(); }
    if (id === 'pl-other') { pledgeForm.other = e.target.value; render(); }
    if (id === 'pl-subject') { pledgeForm.subject = e.target.value; render(); }
  });
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'copy-link') {
      const url = `${location.origin}/team.html?code=${code}&t=${token}`;
      try { await navigator.clipboard.writeText(url); ED.toast('Link copied'); } catch (err) { ED.toast(url); }
      return;
    }
    if (b.id === 'lock') { clearTimeout(saveTimer); return action('lock', { plan: draft }); }
    if (b.id === 'unlock') return action('unlock');
    if (b.dataset.accept) return action('pledge-respond', { id: Number(b.dataset.accept), accept: true });
    if (b.dataset.decline) return action('pledge-respond', { id: Number(b.dataset.decline), accept: false });
    if (b.dataset.cancel) return action('pledge-cancel', { id: Number(b.dataset.cancel) });
    if (b.id === 'pl-send') return action('pledge-offer', { other: pledgeForm.other, subject: pledgeForm.subject, amount: pledgeForm.amount, payment: pledgeForm.payment });
    if (!draft) return;
    if (b.dataset.buy) {
      const pid = b.dataset.buy;
      draft.buy = draft.buy.includes(pid) ? draft.buy.filter((x) => x !== pid) : draft.buy.concat(pid);
      scheduleSave(); render();
    }
    if (b.dataset.step) {
      const d = Number(b.dataset.d);
      const k = b.dataset.step;
      if (k === 'pl-amount') pledgeForm.amount = Math.max(0, pledgeForm.amount + d);
      else if (k === 'pl-payment') pledgeForm.payment = Math.max(1, pledgeForm.payment + d);
      else { draft[k] = Math.max(0, (draft[k] || 0) + d); scheduleSave(); }
      render();
    }
  });

  if (code && token) connect();
  else showJoin();
})();
