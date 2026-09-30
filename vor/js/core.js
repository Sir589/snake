// core.js — shared namespace G, renderer, main loop, input, events and registries.
// Every other module is a classic <script> that runs after this one and calls G.register(...).
// See ../DESIGN.md for the full contract between modules.
(function () {
  'use strict';

  const G = (window.G = {});

  G.VERSION = 1;
  G.SAVE_KEY = 'sire-more-save-v1';
  G.SETTINGS_KEY = 'sire-more-settings-v1';

  // ---------------------------------------------------------------------------
  // Constants (metres, seconds)
  // ---------------------------------------------------------------------------
  G.C = {
    TILE: 2,             // raft foundation tile size (m)
    DECK_Y: 0.35,        // deck top height above raft group origin
    WATER_Y: 0,          // mean sea level
    GRAVITY: 22,
    PLAYER_HEIGHT: 1.7,  // eye height above feet
    PLAYER_RADIUS: 0.35,
    INTERACT_RANGE: 3.2,
    DAY_LENGTH: 480,     // seconds of game time per full day/night cycle
  };

  // ---------------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------------
  G.rand = (a = 0, b = 1) => a + Math.random() * (b - a);
  G.randInt = (a, b) => Math.floor(G.rand(a, b + 1));          // inclusive
  G.pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  G.chance = (p) => Math.random() < p;
  G.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  G.lerp = (a, b, t) => a + (b - a) * t;
  G.damp = (a, b, lambda, dt) => G.lerp(a, b, 1 - Math.exp(-lambda * dt));
  G.weighted = (entries) => {                                  // [[value, weight], ...]
    let total = 0;
    for (const e of entries) total += e[1];
    let r = Math.random() * total;
    for (const e of entries) { if ((r -= e[1]) <= 0) return e[0]; }
    return entries[entries.length - 1][0];
  };
  G.tmpV = () => new THREE.Vector3();

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  G.events = {
    _h: Object.create(null),
    on(name, fn) { (this._h[name] || (this._h[name] = [])).push(fn); return fn; },
    off(name, fn) { const l = this._h[name]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } },
    emit(name, data) {
      const l = this._h[name];
      if (!l) return;
      for (const fn of l.slice()) {
        try { fn(data); } catch (err) { console.error('[event ' + name + ']', err); }
      }
    },
  };
  G.notify = (text, kind = 'info') => G.events.emit('notify', { text, kind });
  G.sfx = (name, opts = {}) => G.events.emit('sfx', Object.assign({ name }, opts));

  // Game-wide counters shown on the death screen (saved by core).
  G.stats = {};
  function resetStats() {
    G.stats = { days: 1, piratesSunk: 0, piratesDefeated: 0, sharksKilled: 0, fishCaught: 0,
      tilesBuilt: 0, itemsCrafted: 0, islandsVisited: 0, debrisCollected: 0, gold: 0 };
  }
  resetStats();

  // ---------------------------------------------------------------------------
  // Settings (per-viewer, localStorage)
  // ---------------------------------------------------------------------------
  G.settings = { sensitivity: 1, volume: 0.8, music: 0.5, invertY: false, quality: 'high' };
  let savedSettings = null;
  try {
    savedSettings = JSON.parse(localStorage.getItem(G.SETTINGS_KEY) || 'null');
  } catch (e) { /* storage unavailable */ }
  if (savedSettings && typeof savedSettings === 'object') Object.assign(G.settings, savedSettings);
  else {
    // First run: phones / tablets and small screens start on low quality (fill rate is the cost).
    try {
      const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      const small = Math.min(window.screen ? screen.width : 9999, window.screen ? screen.height : 9999) < 600;
      if (coarse || small) G.settings.quality = 'low';
    } catch (e) { /* ignore */ }
  }
  G.saveSettings = () => {
    try { localStorage.setItem(G.SETTINGS_KEY, JSON.stringify(G.settings)); } catch (e) { /* ignore */ }
    G.events.emit('settings:changed', G.settings);
  };

  // ---------------------------------------------------------------------------
  // Module registry
  // ---------------------------------------------------------------------------
  // G.register({ name, order, init(), reset(), save(), load(data), update(dt), frame(dt) })
  //  - init():   once at boot, sorted by order (lower first)
  //  - reset():  fresh game state (new game, and before load)
  //  - save():   JSON-serialisable data or undefined
  //  - load(d):  restore from save (called after reset)
  //  - update(dt): only while playing and not paused
  //  - frame(dt):  every animation frame in every state (menus, pause) — cosmetic only
  G.modules = [];
  G.register = (mod) => {
    if (typeof mod.order !== 'number') mod.order = 50;
    G.modules.push(mod);
    G.modules.sort((a, b) => a.order - b.order);
    return mod;
  };
  G.mod = (name) => G.modules.find((m) => m.name === name);

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------
  const input = (G.input = {
    keys: Object.create(null),          // physical keys by KeyboardEvent.code
    virtual: Object.create(null),       // touch-driven virtual keys by code
    _pressed: new Set(),
    _released: new Set(),
    mouse: { dx: 0, dy: 0, wheel: 0, buttons: [false, false, false], vbuttons: [false, false, false],
      _pressed: [false, false, false], _released: [false, false, false], x: 0, y: 0 },
    move: { x: 0, y: 0 },               // analog move from touch joystick (-1..1, y = forward)
    pointerLocked: false,
    lockFailed: false,                  // pointer lock refused -> free-look fallback
    touchMode: false,

    down(code) { return !!(this.keys[code] || this.virtual[code]); },
    pressed(code) { return this._pressed.has(code); },
    released(code) { return this._released.has(code); },
    mouseDown(b = 0) { return this.mouse.buttons[b] || this.mouse.vbuttons[b]; },
    mousePressed(b = 0) { return this.mouse._pressed[b]; },
    mouseReleased(b = 0) { return this.mouse._released[b]; },

    // Touch helpers (used by touch.js)
    setVirtualKey(code, isDown) {
      if (!!this.virtual[code] === !!isDown) return;
      this.virtual[code] = !!isDown;
      (isDown ? this._pressed : this._released).add(code);
    },
    setVirtualMouse(b, isDown) {
      if (this.mouse.vbuttons[b] === !!isDown) return;
      this.mouse.vbuttons[b] = !!isDown;
      if (isDown) this.mouse._pressed[b] = true; else this.mouse._released[b] = true;
    },
    addLook(dx, dy) { this.mouse.dx += dx; this.mouse.dy += dy; },

    // Movement axes combining keyboard (WASD / arrows) and touch joystick. y>0 = forward.
    axes() {
      let x = this.move.x, y = this.move.y;
      if (this.down('KeyW') || this.down('ArrowUp')) y += 1;
      if (this.down('KeyS') || this.down('ArrowDown')) y -= 1;
      if (this.down('KeyD') || this.down('ArrowRight')) x += 1;
      if (this.down('KeyA') || this.down('ArrowLeft')) x -= 1;
      const len = Math.hypot(x, y);
      if (len > 1) { x /= len; y /= len; }
      return { x, y };
    },

    requestLock() {
      if (this.touchMode || this.lockFailed || this.pointerLocked) return;
      const el = G.renderer && G.renderer.domElement;
      if (!el || !el.requestPointerLock) { this.lockFailed = true; return; }
      try {
        const p = el.requestPointerLock();
        if (p && p.catch) p.catch(() => { this.lockFailed = true; });
      } catch (e) { this.lockFailed = true; }
    },
    exitLock() {
      if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
    },
    // True while the game should consume mouse-look (locked, or free-look fallback).
    looking() {
      return G.isPlaying() && !G.uiBlocking() && (this.pointerLocked || this.lockFailed || this.touchMode);
    },
    endFrame() {
      this._pressed.clear();
      this._released.clear();
      this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0;
      this.mouse._pressed = [false, false, false];
      this.mouse._released = [false, false, false];
    },
  });

  function isTypingTarget(t) {
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }
  // Keys that would scroll the page or trigger browser behaviour while playing.
  const GAME_KEYS = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) return;
    // In menus / panels let Space and Enter activate the focused button natively.
    const menuButton = e.target && e.target.tagName === 'BUTTON' &&
      (G.state !== 'playing' || G.paused || G.uiBlocking());
    if (GAME_KEYS.has(e.code) && !(menuButton && e.code === 'Space')) e.preventDefault();
    if (!input.keys[e.code]) input._pressed.add(e.code);
    input.keys[e.code] = true;
  });
  window.addEventListener('keyup', (e) => {
    input.keys[e.code] = false;
    input._released.add(e.code);
  });
  window.addEventListener('blur', () => {
    for (const k in input.keys) if (input.keys[k]) { input.keys[k] = false; input._released.add(k); }
    for (let b = 0; b < 3; b++) if (input.mouse.buttons[b]) { input.mouse.buttons[b] = false; input.mouse._released[b] = true; }
  });

  function bindMouse(canvas) {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => {
      if (input.touchMode) return;
      if (G.isPlaying() && !G.uiBlocking() && !input.pointerLocked && !input.lockFailed) {
        input.requestLock();
        return; // the click that grabs the pointer does not also fire the tool
      }
      if (e.button < 3) { input.mouse.buttons[e.button] = true; input.mouse._pressed[e.button] = true; }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button < 3 && input.mouse.buttons[e.button]) {
        input.mouse.buttons[e.button] = false; input.mouse._released[e.button] = true;
      }
    });
    window.addEventListener('mousemove', (e) => {
      input.mouse.x = e.clientX; input.mouse.y = e.clientY;
      if (input.pointerLocked || (input.lockFailed && e.target === canvas)) {
        input.mouse.dx += e.movementX || 0;
        input.mouse.dy += e.movementY || 0;
      }
    });
    canvas.addEventListener('wheel', (e) => {
      if (G.isPlaying() && !G.uiBlocking()) e.preventDefault();
      input.mouse.wheel += Math.sign(e.deltaY);
    }, { passive: false });
    document.addEventListener('pointerlockchange', () => {
      input.pointerLocked = document.pointerLockElement === canvas;
      if (!input.pointerLocked && G.state === 'playing' && !G.paused && !G.uiBlocking() && !G._suppressLockPause) {
        G.setPaused(true);
      }
      G._suppressLockPause = false;
    });
    document.addEventListener('pointerlockerror', () => { input.lockFailed = true; });
    window.addEventListener('touchstart', () => {
      if (!input.touchMode) { input.touchMode = true; G.events.emit('input:touchmode', true); }
    }, { passive: true });
  }

  // ---------------------------------------------------------------------------
  // Game state
  // ---------------------------------------------------------------------------
  G.state = 'boot';   // 'boot' | 'menu' | 'playing' | 'dead'
  G.paused = false;
  G.time = 0;         // seconds of game time played in this run (saved)
  G.isPlaying = () => G.state === 'playing' && !G.paused;

  // UI modules push/pop blocking panels (inventory, crafting, chest, menus).
  // While any is open, the player does not move/look/use tools and the pointer is released.
  const blockers = new Set();
  G.uiBlocking = () => blockers.size > 0;
  G.setUIBlock = (id, on) => {
    const before = blockers.size > 0;
    if (on) blockers.add(id); else blockers.delete(id);
    const after = blockers.size > 0;
    if (before !== after) {
      if (after) { G._suppressLockPause = true; input.exitLock(); }
      else if (G.isPlaying()) input.requestLock();
      G.events.emit('ui:blocking', after);
    }
  };

  G.setPaused = (p) => {
    if (G.state !== 'playing' || G.paused === p) return;
    G.paused = p;
    if (p) { G._suppressLockPause = true; input.exitLock(); G.save.write(); }
    else input.requestLock();
    G.events.emit(p ? 'game:paused' : 'game:resumed');
  };

  function resetAll() {
    G.time = 0;
    resetStats();
    for (const m of G.modules) if (m.reset) {
      try { m.reset(); } catch (err) { console.error('[reset ' + m.name + ']', err); }
    }
  }

  G.newGame = () => {
    resetAll();
    G.state = 'playing';
    G.paused = false;
    G.events.emit('game:start', { fresh: true });
    G.save.write();
    input.requestLock();
  };

  G.continueGame = () => {
    const data = G.save.read();
    if (!data) return G.newGame();
    resetAll();
    const t = Number(data.time);
    G.time = Number.isFinite(t) && t >= 0 ? t : 0;
    const st = data.stats && typeof data.stats === 'object' ? data.stats : {};
    for (const k in G.stats) {
      if (st[k] === undefined) continue;
      const v = Number(st[k]);
      if (Number.isFinite(v) && v >= 0) G.stats[k] = k === 'days' ? Math.max(1, Math.floor(v)) : Math.floor(v);
    }
    for (const m of G.modules) {
      if (m.load && data.modules && data.modules[m.name] !== undefined) {
        try { m.load(data.modules[m.name]); } catch (err) { console.error('[load ' + m.name + ']', err); }
      }
    }
    G.state = 'playing';
    G.paused = false;
    G.events.emit('game:start', { fresh: false });
    input.requestLock();
  };

  G.toMenu = () => {
    if (G.state === 'playing') G.save.write();
    G.state = 'menu';
    G.paused = false;
    input.exitLock();
    G.events.emit('game:menu');
  };

  G.gameOver = (reason) => {
    if (G.state !== 'playing') return;
    G.state = 'dead';
    G.save.clear();
    input.exitLock();
    G.events.emit('game:over', { reason: reason || 'Moře tě přemohlo.', stats: Object.assign({}, G.stats), time: G.time });
  };

  // ---------------------------------------------------------------------------
  // Save / load (localStorage, per viewer)
  // ---------------------------------------------------------------------------
  // The last written save is also kept in memory, so "Pokračovat" works for the rest of the
  // session even when localStorage is unavailable (sandboxed iframe, strict privacy, full quota).
  let memSave = null;
  let failNotified = false;
  G.save = {
    persistent: (function probeStorage() {
      try {
        const k = G.SAVE_KEY + '-probe';
        localStorage.setItem(k, '1');
        localStorage.removeItem(k);
        return true;
      } catch (e) { return false; }
    })(),
    write() {
      if (G.state !== 'playing') return false;
      const data = { version: G.VERSION, time: G.time, stats: G.stats, savedAt: Date.now(), modules: {} };
      for (const m of G.modules) {
        if (!m.save) continue;
        try { const d = m.save(); if (d !== undefined) data.modules[m.name] = d; }
        catch (err) { console.error('[save ' + m.name + ']', err); }
      }
      let json;
      try { json = JSON.stringify(data); } catch (e) { return false; }
      memSave = json;
      try { localStorage.setItem(G.SAVE_KEY, json); return true; }
      catch (e) {
        if (G.save.persistent) G.save.persistent = false;
        G.events.emit('save:failed');
        if (!failNotified) { failNotified = true; G.notify('Hru se nepodařilo uložit.', 'warn'); }
        return false;
      }
    },
    read() {
      let raw = null;
      try { raw = localStorage.getItem(G.SAVE_KEY); } catch (e) { raw = null; }
      if (!raw) raw = memSave;
      try {
        const d = JSON.parse(raw || 'null');
        return d && typeof d === 'object' && d.version === G.VERSION ? d : null;
      } catch (e) { return null; }
    },
    exists() { return !!this.read(); },
    clear() {
      memSave = null;
      try { localStorage.removeItem(G.SAVE_KEY); } catch (e) { /* ignore */ }
    },
  };
  window.addEventListener('pagehide', () => G.save.write());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { G.save.write(); if (G.state === 'playing') G.setPaused(true); }
  });

  // ---------------------------------------------------------------------------
  // Registries shared between modules
  // ---------------------------------------------------------------------------

  // Walkable surfaces. provider = { kind, heightAt(x, z) -> number|null, velocity?: THREE.Vector3 }
  G.ground = {
    providers: [],
    add(p) { this.providers.push(p); return p; },
    remove(p) { const i = this.providers.indexOf(p); if (i >= 0) this.providers.splice(i, 1); },
    // Highest surface under (x,z) whose height is <= maxY. Returns { height, provider } or null.
    sample(x, z, maxY = Infinity) {
      let best = null;
      for (const p of this.providers) {
        const h = p.heightAt(x, z);
        if (h === null || h === undefined || h > maxY) continue;
        if (!best || h > best.height) best = { height: h, provider: p };
      }
      return best;
    },
  };

  // Things the player can use with E.
  // it = { object?: THREE.Object3D, getPosition?(out), label: string|fn, onInteract(), enabled?(),
  //        range?: number, size?: number (m, angular tolerance), key?: 'KeyE' }
  const _camPos = new THREE.Vector3(), _camDir = new THREE.Vector3(), _itPos = new THREE.Vector3();
  G.interaction = {
    items: new Set(),
    current: null,
    blocked: false,          // set by modules that take over controls (e.g. cannon seat)
    add(it) { this.items.add(it); return it; },
    remove(it) { this.items.delete(it); if (this.current === it) this.current = null; },
    labelOf(it) { return typeof it.label === 'function' ? it.label() : it.label; },
    update() {
      this.current = null;
      if (!G.isPlaying() || G.uiBlocking() || this.blocked || (G.player && G.player.alive === false)) return;
      G.camera.getWorldPosition(_camPos);
      G.camera.getWorldDirection(_camDir);
      let best = null, bestScore = Infinity;
      for (const it of this.items) {
        if (it.enabled && !it.enabled()) continue;
        if (it.getPosition) it.getPosition(_itPos);
        else if (it.object) it.object.getWorldPosition(_itPos);
        else continue;
        _itPos.sub(_camPos);
        const dist = _itPos.length();
        if (dist > (it.range || G.C.INTERACT_RANGE) || dist < 1e-4) continue;
        const cos = _itPos.dot(_camDir) / dist;
        const angle = Math.acos(G.clamp(cos, -1, 1));
        const tolerance = Math.atan((it.size || 0.6) / dist) + 0.12;
        if (angle > tolerance) continue;
        const score = angle + dist * 0.02;
        if (score < bestScore) { bestScore = score; best = it; }
      }
      this.current = best;
      if (best && input.pressed(best.key || 'KeyE')) {
        try { best.onInteract(); } catch (err) { console.error('[interact]', err); }
      }
    },
  };

  // Things weapons can hit (sharks, pirates, the pirate ship).
  // t = { getPosition(out), radius, alive(), onHit(damage, dirVec3, source), kind }
  G.combat = {
    targets: new Set(),
    add(t) { this.targets.add(t); return t; },
    remove(t) { this.targets.delete(t); },
    // Nearest live target within `range` of `origin` and within `maxAngle` (rad) of `dir`.
    findInFront(origin, dir, range, maxAngle = 0.5) {
      let best = null, bestD = Infinity;
      const p = new THREE.Vector3();
      for (const t of this.targets) {
        if (t.alive && !t.alive()) continue;
        t.getPosition(p);
        p.sub(origin);
        const d = p.length() - (t.radius || 0.5);
        if (d > range) continue;
        const len = p.length();
        if (len > 1e-4) {
          const ang = Math.acos(G.clamp(p.dot(dir) / len, -1, 1));
          const tol = maxAngle + Math.atan((t.radius || 0.5) / Math.max(len, 0.1));
          if (ang > tol) continue;
        }
        if (d < bestD) { bestD = d; best = t; }
      }
      return best;
    },
  };

  // Held-item behaviours. handler = { onEquip(slot), onUnequip(), update(dt, slot),
  //   primaryDown(slot), primaryUp(slot), secondaryDown(slot), secondaryUp(slot), hint?(slot) -> string }
  G.tools = {
    handlers: Object.create(null),
    register(id, handler) { this.handlers[id] = handler; return handler; },
    get(id) { return this.handlers[id] || null; },
  };

  // HUD channel written by tools/modules and rendered by ui.js.
  G.hud = {
    toolHint: '',          // short instruction for the held tool
    progress: null,        // 0..1 progress ring under the crosshair, or null
    progressLabel: '',
    crosshair: 'dot',      // 'dot' | 'hidden'
    setToolHint(t) { this.toolHint = t || ''; },
    setProgress(v, label) { this.progress = v; this.progressLabel = label || ''; },
  };

  // Debug helpers (modules attach their own, e.g. G.debug.pirates = () => ...)
  G.debug = {};

  // ---------------------------------------------------------------------------
  // Renderer, scene, camera
  // ---------------------------------------------------------------------------
  // Render resolution follows the quality setting (fill rate is the biggest cost: full-screen
  // transparent ocean + sky shaders with MSAA). Called at boot, on resize and on settings change.
  G.applyQuality = () => {
    if (!G.renderer) return;
    const low = G.settings.quality === 'low';
    const pr = Math.min(window.devicePixelRatio || 1, low ? 1 : 1.5);
    if (G.renderer.getPixelRatio() !== pr) G.renderer.setPixelRatio(pr);
    G.renderer.setSize(window.innerWidth, window.innerHeight);
  };
  G.events.on('settings:changed', () => G.applyQuality());

  function createRenderer() {
    const container = document.getElementById('game');
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    G.renderer = renderer;
    G.applyQuality();
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);

    G.scene = new THREE.Scene();
    G.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 1500);
    G.camera.position.set(0, 2, 0);
    G.camera.rotation.order = 'YXZ';
    G.scene.add(G.camera); // so first-person view models parented to the camera render

    window.addEventListener('resize', () => {
      G.camera.aspect = window.innerWidth / window.innerHeight;
      G.camera.updateProjectionMatrix();
      G.applyQuality();
    });
    bindMouse(renderer.domElement);
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------
  let last = 0, autosaveTimer = 0;
  G.fps = 60;
  G.frameMs = 1000 / 60;   // smoothed real milliseconds per frame
  G.clock = 0;             // sum of frame dt since boot (all states)
  G.frameNo = 0;           // animation frames rendered since boot

  // Once per player: if the game keeps stuttering on 'high', drop to 'low' and say so. Skipped
  // under automation (navigator.webdriver), where software rendering is always slow.
  let slowT = 0;
  function autoQuality(raw) {
    if (G.settings.quality === 'low' || G.settings.autoLowered || navigator.webdriver) return;
    slowT = G.fps < 28 ? slowT + Math.min(raw, 0.5) : Math.max(0, slowT - raw * 2);
    if (slowT < 6) return;
    slowT = 0;
    G.settings.quality = 'low';
    G.settings.autoLowered = true;
    G.saveSettings();
    G.notify('Grafika je teď na nízké kvalitě, aby hra běžela plynuleji. Změníš to v Nastavení.', 'info');
  }

  function loop(now) {
    requestAnimationFrame(loop);
    // fps is measured from the raw frame interval (dt itself is capped at 0.05 s).
    const raw = (now - (last || now)) / 1000;
    const dt = Math.min(0.05, Math.max(0, raw));
    last = now;
    G.clock += dt;           // simulated seconds in every state (menus and pause too)
    G.frameNo++;
    if (raw > 0) {
      G.fps = G.lerp(G.fps, 1 / raw, 0.05);
      G.frameMs = G.lerp(G.frameMs, raw * 1000, 0.05);
    }

    const playing = G.isPlaying();
    if (playing && raw > 0) autoQuality(raw);
    if (playing) {
      G.time += dt;
      autosaveTimer += dt;
      if (autosaveTimer > 30) { autosaveTimer = 0; G.save.write(); }
    }
    for (const m of G.modules) {
      try {
        if (playing && m.update) m.update(dt);
        if (m.frame) m.frame(dt);
      } catch (err) {
        console.error('[' + m.name + ']', err);
        if (!m._errored) { m._errored = true; G.events.emit('error', { module: m.name, error: err }); }
      }
    }
    G.interaction.update();
    G.renderer.render(G.scene, G.camera);
    input.endFrame();
  }

  function boot() {
    createRenderer();
    for (const m of G.modules) {
      if (!m.init) continue;
      try { m.init(); } catch (err) { console.error('[init ' + m.name + ']', err); }
    }
    resetAll();
    G.state = 'menu';
    G.events.emit('game:menu');
    G.events.emit('boot');
    requestAnimationFrame(loop);
  }

  G.boot = boot;
  // index.html calls G.boot() after all module scripts have loaded.
})();
