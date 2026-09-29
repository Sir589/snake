// touch.js — on-screen controls for phones and tablets: a floating joystick (left side),
// drag-to-look (right side) and round action buttons. Everything goes through G.input's virtual
// keys / mouse buttons / look deltas, so the rest of the game treats it like keyboard + mouse.
// Shown only while actually playing (not in menus, pause or open panels). See DESIGN.md §4, §6.
(function () {
  'use strict';
  const G = window.G;
  if (!G) return;

  const BASE_R = 64;          // joystick base radius (px)
  const STICK_R = 54;         // knob travel for full deflection (px)
  const FOLLOW = 1.45;        // base follows the thumb beyond this many STICK_R
  const DEADZONE = 0.14;
  const SPRINT_AT = 0.9;      // deflection that counts as sprint (virtual ShiftLeft)
  const LEFT_ZONE = 0.45;     // joystick zone = left 45 % of the screen
  const LOOK_C = 2000;        // look gain = LOOK_C / longest screen side (mouse px per touch px)
  const HINT_KEY = 'sire-more-touch-hints-v1';

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // ---------------------------------------------------------------------------
  // Public API (exists at load time)
  // ---------------------------------------------------------------------------
  const T = (G.touch = {
    enabled: false,           // controls built (touch mode on)
    visible: false,           // currently shown (playing, not paused, no panel open)
    enable() { enable(); },
    lookGain() { return lookK; },
  });

  // ---------------------------------------------------------------------------
  // Styles (injected so css/ui.css stays ui.js's own)
  // ---------------------------------------------------------------------------
  const CSS = `
.tc-root { position: absolute; inset: 0; pointer-events: none; color: var(--foam, #e9f1ea);
  font-family: var(--font-body, system-ui, sans-serif); -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; transition: opacity .22s ease; }
.tc-root.tc-off { opacity: 0; visibility: hidden; transition: opacity .12s ease, visibility 0s linear .12s; }
.tc-root.tc-off * { pointer-events: none !important; }
.tc-cluster { position: absolute; right: 14px; bottom: 14px; width: 228px; height: 284px; pointer-events: none;
  transform-origin: 100% 100%; }
.tc-btn { position: absolute; box-sizing: border-box; width: var(--sz); height: var(--sz); margin: 0; padding: 0;
  display: grid; place-items: center; border-radius: 50%; pointer-events: auto; touch-action: none; cursor: pointer;
  color: var(--foam, #e9f1ea); font: 800 25px/1 var(--font-body, system-ui, sans-serif);
  background: radial-gradient(circle at 50% 32%, rgba(26, 96, 108, .66), rgba(6, 34, 43, .66) 72%);
  border: 2px solid rgba(230, 207, 159, .45);
  box-shadow: 0 5px 14px rgba(0, 0, 0, .3), inset 0 1px 0 rgba(255, 255, 255, .14), inset 0 -4px 10px rgba(0, 0, 0, .28);
  -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
  transition: transform .08s ease, opacity .2s ease, border-color .15s ease, box-shadow .15s ease;
  outline: none; -webkit-appearance: none; appearance: none; }
.tc-btn::before { content: ''; position: absolute; inset: 4px; border-radius: 50%; pointer-events: none;
  border: 1.5px dashed rgba(230, 207, 159, .3); }
.tc-btn::after { content: ''; position: absolute; inset: -7px; border-radius: 50%; }
.tc-btn svg { width: 46%; height: 46%; fill: none; stroke: currentColor; stroke-width: 2.6; stroke-linecap: round;
  stroke-linejoin: round; pointer-events: none; filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .55)); }
.tc-btn .tc-fill { fill: currentColor; stroke: none; }
.tc-btn .tc-txt { pointer-events: none; text-shadow: 0 1px 2px rgba(0, 0, 0, .6); }
.tc-btn .tc-emo { pointer-events: none; font-size: 26px; line-height: 1; filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .5)); }
.tc-btn.tc-down { transform: scale(.9); color: var(--ink, #041419); border-color: var(--brass, #d9a441);
  background: radial-gradient(circle at 50% 32%, rgba(247, 210, 128, .9), rgba(196, 143, 46, .85) 74%); }
.tc-btn.tc-down::before { border-color: rgba(4, 20, 25, .35); }
.tc-btn.tc-dim { opacity: .5; }
.tc-btn.tc-gone { opacity: 0; transform: scale(.6); pointer-events: none; }
.tc-use { --sz: 80px; right: 0; bottom: 0; border: 3px solid rgba(217, 164, 65, .9); }
.tc-use svg { width: 34%; height: 34%; }
.tc-jump { --sz: 64px; right: 94px; bottom: 0; }
.tc-alt { --sz: 54px; right: 13px; bottom: 94px; }
.tc-act { --sz: 64px; right: 86px; bottom: 80px; }
.tc-rot { --sz: 52px; right: 162px; bottom: 90px; }
.tc-inv { --sz: 54px; right: 13px; bottom: 162px; }
.tc-pause { --sz: 48px; right: 16px; bottom: 230px; }
.tc-pause svg { width: 40%; height: 40%; }
.tc-act.tc-hot { color: var(--ink, #041419); border-color: #f3cf7c;
  background: radial-gradient(circle at 50% 32%, #f7d890, #c48f2e 76%);
  box-shadow: 0 0 0 4px rgba(217, 164, 65, .3), 0 0 22px rgba(217, 164, 65, .6), inset 0 -4px 10px rgba(0, 0, 0, .2);
  animation: tc-pulse 1.1s ease-in-out infinite; }
.tc-act.tc-hot::before { border-color: rgba(4, 20, 25, .35); }
@keyframes tc-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); } }
.tc-badge { position: absolute; right: -5px; top: -5px; width: 30px; height: 30px; border-radius: 50%;
  display: grid; place-items: center; font-size: 17px; line-height: 1; pointer-events: none;
  background: rgba(4, 20, 25, .88); border: 1.5px solid rgba(217, 164, 65, .85); box-shadow: 0 2px 6px rgba(0, 0, 0, .4); }
.tc-badge:empty { display: none; }
.tc-stick { position: absolute; left: 0; top: 0; width: 128px; height: 128px; margin: -64px 0 0 -64px;
  border-radius: 50%; pointer-events: none; will-change: transform; transition: opacity .2s ease;
  background: radial-gradient(circle, rgba(13, 59, 71, .18) 0 45%, rgba(13, 59, 71, .42) 70%, rgba(6, 34, 43, .5));
  border: 2px dashed rgba(230, 207, 159, .55); box-shadow: 0 6px 18px rgba(0, 0, 0, .22), inset 0 0 0 7px rgba(6, 34, 43, .25); }
.tc-stick::after { content: ''; position: absolute; inset: 22px; border-radius: 50%; border: 1px solid rgba(230, 207, 159, .18); }
.tc-knob { position: absolute; left: 50%; top: 50%; width: 58px; height: 58px; margin: -29px 0 0 -29px; border-radius: 50%;
  background: radial-gradient(circle at 38% 30%, #fbe3a8, #d9a441 55%, #9a6a1e);
  border: 2px solid rgba(4, 20, 25, .4); box-shadow: 0 4px 10px rgba(0, 0, 0, .45), inset 0 -4px 7px rgba(0, 0, 0, .22);
  will-change: transform; transition: box-shadow .15s ease; }
.tc-stick.tc-idle { opacity: .42; }
.tc-stick.tc-idle .tc-knob { transition: transform .15s ease-out, box-shadow .15s ease; }
.tc-stick.tc-sprint .tc-knob { box-shadow: 0 0 0 5px rgba(232, 100, 60, .45), 0 0 18px rgba(232, 100, 60, .6), inset 0 -4px 7px rgba(0, 0, 0, .22); }
.tc-label { position: absolute; left: 50%; top: calc(100% + 6px); transform: translateX(-50%); white-space: nowrap;
  font-size: 14px; font-weight: 700; letter-spacing: .02em; color: var(--sand, #e6cf9f);
  text-shadow: 0 1px 3px rgba(0, 0, 0, .9); transition: opacity .3s ease; }
.tc-stick:not(.tc-idle) .tc-label { opacity: 0; }
.tc-hint { position: absolute; left: 50%; top: 42%; transform: translateX(-10%); display: flex; align-items: center; gap: 8px;
  padding: 7px 12px; font-size: 15px; font-weight: 700; color: var(--sand, #e6cf9f); pointer-events: none;
  background: rgba(4, 20, 25, .5); border-radius: 999px; text-shadow: 0 1px 2px rgba(0, 0, 0, .8);
  transition: opacity .6s ease; }
.tc-hint svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.tc-hint.tc-hide, .tc-label.tc-hide { opacity: 0; }
.tc-root.tc-override .tc-stick, .tc-root.tc-override .tc-jump, .tc-root.tc-override .tc-alt,
.tc-root.tc-override .tc-rot, .tc-root.tc-override .tc-hint { opacity: 0; pointer-events: none; }
.tc-probe { position: absolute; visibility: hidden; pointer-events: none; width: 0; height: 0;
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px); }
@media (max-height: 470px) { .tc-cluster { transform: scale(.84); } }
@media (max-height: 380px) { .tc-cluster { transform: scale(.74); } }
@media (prefers-reduced-motion: reduce) {
  .tc-root, .tc-btn, .tc-stick, .tc-knob, .tc-hint, .tc-label { transition: none !important; }
  .tc-act.tc-hot { animation: none; }
}`;

  const ICON = {
    use: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="tc-fill" cx="12" cy="12" r="9"/></svg>',
    jump: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14M12 20V9M7 13.5l5-5 5 5"/></svg>',
    alt: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path class="tc-fill" d="M12 4a8 8 0 0 0 0 16z"/></svg>',
    rot: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4v5h-5"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect class="tc-fill" x="5.5" y="4" width="4.5" height="16" rx="1.2"/><rect class="tc-fill" x="14" y="4" width="4.5" height="16" rx="1.2"/></svg>',
    look: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/></svg>',
  };

  // Buttons. key → virtual key held while touched; mouse → virtual mouse button; tap → one-shot action.
  const BUTTONS = [
    { id: 'use', label: 'Použít', html: ICON.use + '<span class="tc-badge"></span>', mouse: 0, look: true },
    { id: 'jump', label: 'Skok', html: ICON.jump, key: 'Space' },
    { id: 'alt', label: 'Vedlejší akce', html: ICON.alt, mouse: 2 },
    { id: 'act', label: 'Použít věc před sebou (E)', html: '<span class="tc-txt">E</span>', key: 'KeyE' },
    { id: 'rot', label: 'Otočit', html: ICON.rot, key: 'KeyR' },
    { id: 'inv', label: 'Inventář', html: '<span class="tc-emo">🎒</span>', key: 'Tab' },
    { id: 'pause', label: 'Pauza', html: ICON.pause, tap: () => G.setPaused(true) },
  ];

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let enabled = false, root = null, cluster = null, stickEl = null, knobEl = null, labelEl = null, hintEl = null;
  let probe = null, badgeEl = null;
  const btns = [];
  const B = Object.create(null);                  // id -> button record
  const stick = { id: null, cx: 0, cy: 0, sprint: false, used: false };
  const look = { id: null, x: 0, y: 0 };
  const safe = { t: 0, r: 0, b: 0, l: 0 };
  let lookK = 2.2, measureT = 0, lastItem, hotShown = false, overrideShown = false;
  let ghostX = 100, ghostY = 300, hintsSeen = false, lookUsed = false;

  function readHints() {
    try { hintsSeen = localStorage.getItem(HINT_KEY) === '1'; } catch (e) { hintsSeen = false; }
  }
  function markHintsSeen() {
    if (hintsSeen) return;
    hintsSeen = true;
    try { localStorage.setItem(HINT_KEY, '1'); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Build
  // ---------------------------------------------------------------------------
  function enable() {
    if (enabled) return;
    const host = document.getElementById('touch');
    if (!host || !document.body) return;
    enabled = true;
    T.enabled = true;
    readHints();

    if (!document.getElementById('tc-style')) {
      const st = document.createElement('style');
      st.id = 'tc-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    root = document.createElement('div');
    root.className = 'tc-root tc-off';
    root.setAttribute('aria-hidden', 'true');

    probe = document.createElement('div');
    probe.className = 'tc-probe';
    root.appendChild(probe);

    stickEl = document.createElement('div');
    stickEl.className = 'tc-stick tc-idle';
    knobEl = document.createElement('div');
    knobEl.className = 'tc-knob';
    labelEl = document.createElement('div');
    labelEl.className = 'tc-label';
    labelEl.textContent = 'Pohyb';
    stickEl.appendChild(knobEl);
    stickEl.appendChild(labelEl);
    root.appendChild(stickEl);

    hintEl = document.createElement('div');
    hintEl.className = 'tc-hint';
    hintEl.innerHTML = ICON.look + '<span>Táhni prstem a rozhlížej se</span>';
    root.appendChild(hintEl);
    if (hintsSeen) { labelEl.classList.add('tc-hide'); hintEl.classList.add('tc-hide'); }

    cluster = document.createElement('div');
    cluster.className = 'tc-cluster';
    for (const d of BUTTONS) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'tc-btn tc-' + d.id;
      el.tabIndex = -1;
      el.setAttribute('aria-label', d.label);
      el.innerHTML = d.html;
      const b = { def: d, el, ids: new Set(), down: false, lookId: null, lx: 0, ly: 0 };
      el.addEventListener('touchstart', (e) => onBtnStart(e, b), { passive: false });
      // mouse/pen fallback (touch laptops, desktop testing); touch input is handled above
      el.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') { e.preventDefault(); if (T.visible) press(b); } });
      el.addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch') release(b); });
      el.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') release(b); });
      el.addEventListener('contextmenu', (e) => e.preventDefault());
      cluster.appendChild(el);
      btns.push(b);
      B[d.id] = b;
    }
    badgeEl = B.use.el.querySelector('.tc-badge');
    B.rot.el.classList.add('tc-gone');
    root.appendChild(cluster);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    host.appendChild(root);

    window.addEventListener('touchstart', onStart, { passive: false });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd, { passive: false });
    window.addEventListener('touchcancel', onEnd, { passive: false });
    window.addEventListener('blur', releaseAll);
    window.addEventListener('resize', () => { measureT = 0; });
    window.addEventListener('orientationchange', () => { measureT = 0; });
    document.body.classList.add('touch-mode');
    lastItem = undefined;
    measure();
  }

  // ---------------------------------------------------------------------------
  // Buttons
  // ---------------------------------------------------------------------------
  function vib(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* ignore */ }
  }
  function press(b) {
    if (b.down) return;
    b.down = true;
    b.el.classList.add('tc-down');
    const d = b.def, I = G.input;
    if (d.key) I.setVirtualKey(d.key, true);
    else if (d.mouse !== undefined) I.setVirtualMouse(d.mouse, true);
    if (d.id === 'use' || d.id === 'jump' || d.id === 'act') vib(8);
    if (d.tap) { try { d.tap(); } catch (err) { console.error('[touch]', err); } }
  }
  function release(b) {
    b.ids.clear();
    b.lookId = null;
    if (!b.down) return;
    b.down = false;
    b.el.classList.remove('tc-down');
    const d = b.def, I = G.input;
    if (d.key) I.setVirtualKey(d.key, false);
    else if (d.mouse !== undefined) I.setVirtualMouse(d.mouse, false);
  }
  function onBtnStart(e, b) {
    if (e.cancelable) e.preventDefault();          // no emulated mouse / click / double-tap zoom
    if (!T.visible || b.el.classList.contains('tc-gone')) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      b.ids.add(t.identifier);
      if (b.def.look && b.lookId === null) { b.lookId = t.identifier; b.lx = t.clientX; b.ly = t.clientY; }
    }
    press(b);
  }

  // ---------------------------------------------------------------------------
  // Joystick & look
  // ---------------------------------------------------------------------------
  // Only touches that land on the 3D view (not on HUD widgets, which ui.js owns) steer the game.
  function claimable(tgt) {
    if (!tgt || tgt === window || tgt === document) return true;
    const canvas = G.renderer && G.renderer.domElement;
    if (tgt === canvas || tgt === document.body || tgt === document.documentElement) return true;
    if (!tgt.closest) return false;
    if (tgt.closest('#game')) return true;
    if (tgt.closest('.tc-btn')) return false;
    if (tgt.closest('#touch')) return true;
    return false;                                   // anything in #ui that receives touches is interactive
  }

  function placeStick(x, y) {
    stickEl.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)';
  }
  function setKnob(x, y) {
    knobEl.style.transform = x || y ? 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)' : '';
  }
  function startStick(t) {
    stick.id = t.identifier;
    const W = window.innerWidth, H = window.innerHeight;
    stick.cx = clamp(t.clientX, safe.l + BASE_R + 6, W - BASE_R - 6);
    stick.cy = clamp(t.clientY, safe.t + BASE_R + 6, H - safe.b - BASE_R - 6);
    stickEl.classList.remove('tc-idle');
    placeStick(stick.cx, stick.cy);
    moveStick(t);
  }
  function moveStick(t) {
    let dx = t.clientX - stick.cx, dy = t.clientY - stick.cy;
    let dist = Math.hypot(dx, dy);
    const follow = STICK_R * FOLLOW;
    if (dist > follow) {                            // dynamic base: drag it along with the thumb
      const k = (dist - follow) / dist;
      stick.cx += dx * k; stick.cy += dy * k;
      dx -= dx * k; dy -= dy * k;
      dist = follow;
      placeStick(stick.cx, stick.cy);
    }
    const m = Math.min(1, dist / STICK_R);
    const nx = dist > 1e-3 ? dx / dist : 0, ny = dist > 1e-3 ? dy / dist : 0;
    const s = m <= DEADZONE ? 0 : (m - DEADZONE) / (1 - DEADZONE);
    G.input.move.x = nx * s;
    G.input.move.y = -ny * s;                       // screen up = forward
    const kd = Math.min(dist, STICK_R);
    setKnob(nx * kd, ny * kd);
    const sprint = m > SPRINT_AT;
    if (sprint !== stick.sprint) {
      stick.sprint = sprint;
      G.input.setVirtualKey('ShiftLeft', sprint);
      stickEl.classList.toggle('tc-sprint', sprint);
    }
    if (s > 0.3 && !stick.used) { stick.used = true; labelEl.classList.add('tc-hide'); if (lookUsed) markHintsSeen(); }
  }
  function endStick() {
    stick.id = null;
    G.input.move.x = 0; G.input.move.y = 0;
    if (stick.sprint) { stick.sprint = false; G.input.setVirtualKey('ShiftLeft', false); stickEl.classList.remove('tc-sprint'); }
    stickEl.classList.add('tc-idle');
    setKnob(0, 0);
    placeStick(ghostX, ghostY);
  }
  function lookBy(dx, dy) {
    if (!T.visible || (!dx && !dy)) return;
    G.input.addLook(dx * lookK, dy * lookK);
  }

  function onStart(e) {
    if (!enabled || !T.visible || !claimable(e.target)) return;
    let used = false;
    const W = window.innerWidth;
    const ov = overrideShown;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (!ov && stick.id === null && t.clientX < W * LEFT_ZONE) { startStick(t); used = true; }
      else if (look.id === null) { look.id = t.identifier; look.x = t.clientX; look.y = t.clientY; used = true; }
    }
    if (used && e.cancelable) e.preventDefault();
  }
  function onMove(e) {
    if (!enabled) return;
    let used = false;
    const use = B.use;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i], id = t.identifier;
      if (id === stick.id) { moveStick(t); used = true; }
      else if (id === look.id) {
        const dx = t.clientX - look.x, dy = t.clientY - look.y;
        look.x = t.clientX; look.y = t.clientY;
        lookBy(dx, dy);
        if (!lookUsed && Math.abs(dx) + Math.abs(dy) > 2) {
          lookUsed = true; hintEl.classList.add('tc-hide'); if (stick.used) markHintsSeen();
        }
        used = true;
      } else if (use && id === use.lookId) {        // slide on the ● button to aim while holding it
        lookBy(t.clientX - use.lx, t.clientY - use.ly);
        use.lx = t.clientX; use.ly = t.clientY;
        used = true;
      }
    }
    if (used && e.cancelable) e.preventDefault();
  }
  function onEnd(e) {
    if (!enabled) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const id = e.changedTouches[i].identifier;
      if (id === stick.id) endStick();
      if (id === look.id) look.id = null;
      for (let j = 0; j < btns.length; j++) {
        const b = btns[j];
        if (!b.ids.has(id)) continue;
        b.ids.delete(id);
        if (b.lookId === id) b.lookId = null;
        if (b.ids.size === 0) release(b);
      }
    }
    if (e.touches && e.touches.length === 0) releaseAll();   // nothing on the glass: nothing held
  }
  function releaseAll() {
    if (!enabled) return;
    if (stick.id !== null || G.input.move.x || G.input.move.y || stick.sprint) endStick();
    look.id = null;
    for (let j = 0; j < btns.length; j++) release(btns[j]);
  }

  // ---------------------------------------------------------------------------
  // Layout: keep the buttons clear of the HUD hotbar / stat bars, place the idle joystick
  // ---------------------------------------------------------------------------
  function readSafe() {
    if (!probe) return;
    const cs = getComputedStyle(probe);
    safe.t = parseFloat(cs.paddingTop) || 0; safe.r = parseFloat(cs.paddingRight) || 0;
    safe.b = parseFloat(cs.paddingBottom) || 0; safe.l = parseFloat(cs.paddingLeft) || 0;
  }
  function hudRects(out) {
    out.length = 0;
    const sels = ['#hotbar', '#stats'];
    for (let i = 0; i < sels.length; i++) {
      const el = document.querySelector(sels[i]);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) out.push(r);
    }
    return out;
  }
  const _rects = [];
  let raise = 0;
  function measure() {
    if (!enabled) return;
    readSafe();
    const W = window.innerWidth, H = window.innerHeight;
    lookK = clamp(LOOK_C / Math.max(W, H, 1), 1.5, 3.4);
    const baseBottom = 14 + safe.b;
    cluster.style.right = (14 + safe.r) + 'px';
    const huds = hudRects(_rects);
    // how far must the cluster rise so no visible button overlaps a HUD widget?
    let need = 0;
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      if (b.el.classList.contains('tc-gone') && b.def.id !== 'rot') continue;
      const r = b.el.getBoundingClientRect();
      const bottom0 = r.bottom + raise;              // this button's bottom edge with no raise
      for (let j = 0; j < huds.length; j++) {
        const h = huds[j];
        if (r.right <= h.left - 6 || r.left >= h.right + 6) continue;
        if (bottom0 > h.top - 8) need = Math.max(need, bottom0 - (h.top - 8));
      }
    }
    const cr = cluster.getBoundingClientRect();
    const maxRaise = Math.max(0, cr.top + raise - (safe.t + 8));   // never push it off the top
    raise = Math.min(Math.ceil(need), maxRaise);
    cluster.style.bottom = (baseBottom + raise) + 'px';

    // idle joystick ghost: bottom-left, above any HUD widget under it
    let y = H - baseBottom - BASE_R - 12;
    const gx0 = safe.l + 22, gx1 = gx0 + BASE_R * 2;
    for (let j = 0; j < huds.length; j++) {
      const h = huds[j];
      if (h.right <= gx0 || h.left >= gx1) continue;
      y = Math.min(y, h.top - BASE_R - 30);
    }
    ghostX = safe.l + 22 + BASE_R;
    ghostY = Math.max(safe.t + BASE_R + 60, y);
    if (stick.id === null) placeStick(ghostX, ghostY);
  }

  // ---------------------------------------------------------------------------
  // Per-frame: visibility, interact highlight, held item badge / contextual buttons
  // ---------------------------------------------------------------------------
  function setVisible(v) {
    T.visible = v;
    root.classList.toggle('tc-off', !v);
    document.body.classList.toggle('touch-active', v);
    if (!v) releaseAll();
    else measureT = 0;
  }
  function updateHeld(id) {
    const d = id && G.items && typeof G.items.def === 'function' ? G.items.def(id) : null;
    if (badgeEl) badgeEl.textContent = d && d.icon ? d.icon : '';
    const placeable = !!(d && (d.place || d.category === 'placeable'));
    B.rot.el.classList.toggle('tc-gone', !placeable);
    if (!placeable) release(B.rot);
    const tool = d ? (d.tool || (d.place ? 'place' : null)) : null;
    B.alt.el.classList.toggle('tc-dim', !(tool === 'hook' || tool === 'rod' || tool === 'hammer' || tool === 'place'));
  }

  G.register({
    name: 'touch',
    order: 95,
    init() {
      G.events.on('input:touchmode', (on) => { if (on !== false) enable(); });
      G.events.on('boot', () => {
        if (G.input.touchMode) { enable(); return; }
        let coarse = false;
        try { coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { /* ignore */ }
        if (coarse) {
          G.input.touchMode = true;
          G.events.emit('input:touchmode', true);
        }
      });
      G.events.on('ui:blocking', (on) => { if (on) releaseAll(); });
      G.events.on('game:paused', releaseAll);
      G.events.on('game:over', releaseAll);
    },
    reset() {
      releaseAll();
      lastItem = undefined;
      hotShown = false;
      if (enabled && B.act) B.act.el.classList.remove('tc-hot');
    },
    frame(dt) {
      if (!enabled) {
        if (G.input && G.input.touchMode) enable();
        if (!enabled) return;
      }
      const show = G.state === 'playing' && !G.paused && !G.uiBlocking();
      if (show !== T.visible) setVisible(show);
      if (!show) return;

      const hot = !!(G.interaction && G.interaction.current);
      if (hot !== hotShown) { hotShown = hot; B.act.el.classList.toggle('tc-hot', hot); }

      const ov = !!(G.player && G.player.controlOverride);
      if (ov !== overrideShown) {
        overrideShown = ov;
        root.classList.toggle('tc-override', ov);
        if (ov) { endStick(); release(B.jump); release(B.alt); release(B.rot); }
      }

      const slot = G.inventory && typeof G.inventory.getSelected === 'function' ? G.inventory.getSelected() : null;
      const id = slot ? slot.id : null;
      if (id !== lastItem) { lastItem = id; updateHeld(id); measureT = 0; }

      measureT -= dt;
      if (measureT <= 0) { measureT = 0.5; measure(); }
    },
  });
})();
