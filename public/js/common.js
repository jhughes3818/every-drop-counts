// Shared browser helpers for the board and team pages.
(function () {
  'use strict';
  const ED = {
    offset: 0, // server clock minus local clock

    async post(url, body) {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(j.error || 'Something went wrong.'); e.status = r.status; throw e; }
      return j;
    },
    async get(url) {
      const r = await fetch(url);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(j.error || 'Something went wrong.'); e.status = r.status; throw e; }
      return j;
    },

    // Server-Sent Events with automatic reconnect (EventSource retries by itself).
    stream(url, onView, onReleased) {
      const es = new EventSource(url);
      es.onmessage = (ev) => {
        const v = JSON.parse(ev.data);
        ED.offset = v.serverNow - Date.now();
        onView(v);
      };
      es.addEventListener('released', () => { es.close(); if (onReleased) onReleased(); });
      return es;
    },

    timeLeft(view) {
      const t = view && view.timer;
      if (!t) return null;
      if (t.paused) return t.remaining;
      return Math.max(0, t.endsAt - (Date.now() + ED.offset));
    },
    fmt(ms) {
      if (ms === null || ms === undefined) return '';
      const s = Math.ceil(ms / 1000);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    },
    esc(s) {
      return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
    signed(n) { return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0'; },
    phaseName(p, practice) {
      const names = { lobby: 'Joining', forecast: 'Forecast', plan: 'Plan', release: 'Release', review: 'Review', final: 'Final results' };
      return names[p] || p;
    },
    seasonLabel(v) {
      if (v.phase === 'lobby') return 'Not started';
      if (v.phase === 'final') return 'Game over';
      return v.season === 0 ? 'Practice season' : `Season ${v.season} of ${v.seasons}`;
    },
    regionName(v, id) {
      const r = v.regions.find((x) => x.id === id);
      const name = EDRules.REGIONS[id].name;
      return r && r.teamName ? `${name} (${r.teamName})` : name;
    },
    toast(msg) {
      const el = document.createElement('div');
      el.className = 'toast';
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 3500);
    },
    store: {
      get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
      set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
      del(k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } },
    },
    // Describe a pledge in words.
    pledgeText(v, p) {
      const subj = EDRules.REGIONS[p.subject].name;
      const payer = EDRules.REGIONS[p.payer].name;
      const promise = p.kind === 'min-release' ? `releases at least ${p.amount} units` : `takes no more than ${p.amount} units`;
      return `${subj} ${promise}; ${payer} pays ${p.payment} points`;
    },
  };
  window.ED = ED;
})();
