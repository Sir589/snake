// pirates.js — pirate raids: the pirate ship (sails in, circles the raft broadside, fires its
// cannons, sinks), the rowboat with boarders who fight the player on the raft, cannonball
// physics, loot, and the player's own cannon (structure type 'cannon', registered with raft.js)
// with its seated aiming mode.
// Contract: ../DESIGN.md §6 "pirates.js". Registers as module 'pirates' (order 55).
(function () {
  'use strict';

  const G = window.G;
  const PI = Math.PI, TAU = PI * 2, HALF_PI = PI / 2, DEG = PI / 180;

  // ---------------------------------------------------------------------------
  // Tunables
  // ---------------------------------------------------------------------------
  // The first raid also waits for a spear (goal 'ostep' done or one in the inventory).
  const FIRST_RAID = 900, RAID_MIN = 480, RAID_MAX = 720, CHECK_EVERY = 30, MIN_TILES = 8;
  const SPAWN_DIST = 180, CIRCLE_MIN = 35, CIRCLE_MAX = 45;
  const SPEED_APPROACH = 7, SPEED_CIRCLE = 3.4, SPEED_LEAVE = 6.5, TURN_RATE = 0.3;
  const FIRE_MIN = 6, FIRE_MAX = 8, MISS_CHANCE = 0.35;
  const TILE_DMG = 35, BALL_PLAYER_DMG = 25, BALL_PLAYER_RADIUS = 2;
  const BOAT_DELAY = 20, LEAVE_AFTER = 150, LEAVE_AFTER_CREW = 25;   // ship leaves 25 s after its crew is gone
  const BOARD_GIVE_UP = 60;                                           // boarders jump back into the sea after 60 s
  const SHOVE_DMG = 5, SHOVE_PUSH = 5.5, SHOVE_RANGE = 2.3, SHOVE_CD = 0.5;   // unarmed LMB shove
  const SHIP_HP = 300, SHIP_RADIUS = 6, BALL_SHIP_DMG = 60, SINK_TIME = 8.5;
  const BOARDER_HP = 60, MELEE_DMG = 10, MELEE_CD = 1.2, MELEE_RANGE = 1.3;
  const BOARDER_SPEED = 2.5, BOAT_SPEED = 2.6;
  const BALL_V = 30, BALL_G = 12, RELOAD = 2.5, BALL_R = 0.19;
  const YAW_LIMIT = 70 * DEG, PITCH_MIN = -5 * DEG, PITCH_MAX = 35 * DEG;
  const TRUNNION_Y = 0.52, TRUNNION_Z = 0.3, BARREL_LEN = 0.95;
  const LOOK_K = 0.0022;

  // ---------------------------------------------------------------------------
  // Scratch objects (no per-frame allocations)
  // ---------------------------------------------------------------------------
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3();
  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _t = new THREE.Vector3(), _s = new THREE.Vector3();
  const _push = new THREE.Vector3(), _muz = new THREE.Vector3(), _dir = new THREE.Vector3();
  const _q = new THREE.Quaternion(), _qc = new THREE.Quaternion();
  const _e = new THREE.Euler(0, 0, 0, 'YXZ'), _be = new THREE.Euler();
  const _m3 = new THREE.Matrix3();
  const _c = new THREE.Color();
  const _up = new THREE.Vector3(0, 1, 0);
  const _ma = new THREE.Vector3(), _mb = new THREE.Vector3(), _mc = new THREE.Vector3(), _mn = new THREE.Vector3(), _mt = new THREE.Vector3();
  const _sim = { n: 0, hit: '', x: 0, y: 0, z: 0 };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function fx(name, a, b, c) {
    const F = G.fx, f = F && F[name];
    if (typeof f !== 'function') return;
    try { f.call(F, a, b, c); } catch (err) { /* cosmetic only */ }
  }
  function snd(name, pos, volume) {
    const o = {};
    if (pos) o.position = new THREE.Vector3(pos.x, pos.y, pos.z);
    if (volume != null) o.volume = volume;
    G.sfx(name, o);
  }
  function waveH(x, z) {
    const W = G.world;
    if (W && typeof W.waveHeight === 'function') {
      const h = W.waveHeight(x, z);
      return Number.isFinite(h) ? h : 0;
    }
    return 0;
  }
  function deckY() { return G.raft && typeof G.raft.deckY === 'function' ? G.raft.deckY() : G.C.DECK_Y; }
  function raftRadius() { return G.raft && typeof G.raft.radius === 'function' ? G.raft.radius() || 3 : 3; }
  function smooth01(t) { t = G.clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function easeOut(t) { t = G.clamp(t, 0, 1); return 1 - (1 - t) * (1 - t); }
  function wrapAngle(a) { while (a > PI) a -= TAU; while (a < -PI) a += TAU; return a; }
  function angDiff(a, b) { return wrapAngle(b - a); }
  function dampAngle(a, b, k, dt) { return a + angDiff(a, b) * (1 - Math.exp(-k * dt)); }
  function btnL() { return G.input && G.input.touchMode ? '●' : 'Levé tlačítko'; }
  function plural(n, one, few, many) { return n === 1 ? one : n >= 2 && n <= 4 ? few : many; }
  function nightK() {
    const W = G.world;
    if (!W) return 0;
    if (Number.isFinite(W.lightLevel)) return G.clamp((0.82 - W.lightLevel) / 0.42, 0, 1);
    return typeof W.isNight === 'function' && W.isNight() ? 1 : 0;
  }
  function banner(text, kind, sec) {
    if (G.ui && typeof G.ui.banner === 'function') { try { G.ui.banner(text, kind, sec); } catch (err) { /* ignore */ } }
  }
  function player() { return G.player || null; }
  function ammo() { return G.inventory && typeof G.inventory.count === 'function' ? G.inventory.count('koule') : 0; }
  function spearInInventory() { return !!(G.inventory && typeof G.inventory.count === 'function' && G.inventory.count('ostep') > 0); }
  function hasSpear() {
    const g = G.goals && typeof G.goals.get === 'function' ? G.goals.get('ostep') : null;
    return !!(g && g.done) || spearInInventory();
  }

  // Per-raid numbers: the first two raids are gentler, later ones scale with the ships sunk so far.
  let raidNo = 0;                    // raids started in this game (saved)
  let ringTipShown = false;          // one-time "dodge the red ring" banner (saved)
  const tune = { tileDmg: 35, ballDmg: 25, ballR: 2, miss: 0.35, fireMin: 6, fireMax: 8,
    meleeDmg: 10, shipHp: 300, boarders: 2, sunk: 0 };
  function makeTune() {
    const sunk = Math.max(0, Math.floor(Number(G.stats && G.stats.piratesSunk) || 0));
    const early = raidNo <= 2;
    tune.sunk = sunk;
    tune.tileDmg = early ? 25 : TILE_DMG;
    tune.ballDmg = early ? 15 : BALL_PLAYER_DMG;
    tune.ballR = early ? 1.5 : BALL_PLAYER_RADIUS;
    tune.miss = early ? 0.45 : MISS_CHANCE;
    tune.fireMin = Math.max(4, FIRE_MIN - 0.5 * sunk);
    tune.fireMax = Math.max(4, FIRE_MAX - 0.5 * sunk);
    tune.meleeDmg = raidNo === 1 ? 7 : MELEE_DMG;
    tune.shipHp = Math.min(600, SHIP_HP + 100 * sunk);
    tune.boarders = raidNo === 1 ? G.randInt(1, 2) : Math.min(4, G.randInt(2, 3) + Math.floor(sunk / 2));
  }

  // Height of the raft deck under (x, z) via the G.ground registry ('raft' providers only), or null.
  function raftHeight(x, z) {
    const list = G.ground.providers;
    let best = null;
    for (let i = 0; i < list.length; i++) {
      const pr = list[i];
      if (pr.kind !== 'raft') continue;
      let h;
      try { h = pr.heightAt(x, z); } catch (err) { continue; }
      if (h === null || h === undefined || !Number.isFinite(h)) continue;
      if (best === null || h > best) best = h;
    }
    return best;
  }

  // True while the player stands (or jumps) on the raft deck.
  function playerOnRaft() {
    const P = player();
    if (!P || !P.alive || P.inWater) return false;
    if (P.controlOverride && seat.active) return true;
    if (raftHeight(P.position.x, P.position.z) === null) return false;
    return P.position.y > deckY() - 0.6;
  }

  // Islands are read defensively (islands.js owns them). Pushes (x, z) away from any island.
  function islandPos(isl) {
    if (!isl) return null;
    const p = (isl.position && isl.position.isVector3 && isl.position) || (isl.group && isl.group.position) ||
      (isl.object && isl.object.position) || (isl.mesh && isl.mesh.position) || (Number.isFinite(isl.x) ? isl : null);
    return p && Number.isFinite(p.x) && Number.isFinite(p.z) ? p : null;
  }
  function islandPush(x, z, out) {
    out.set(0, 0, 0);
    const I = G.islands, list = I && I.list;
    if (!list || !list.length) return out;
    for (let i = 0; i < list.length; i++) {
      const isl = list[i], p = islandPos(isl);
      if (!p) continue;
      const r = (Number(isl.radius) || 28) + 16;
      const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz);
      if (d < r && d > 0.01) { const k = (r - d) / r; out.x += (dx / d) * k; out.z += (dz / d) * k; }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Geometry merging: many parts → one vertex-coloured BufferGeometry (one draw call)
  // ---------------------------------------------------------------------------
  function Merger() { this.p = []; this.n = []; this.c = []; this.uv = []; }
  Merger.prototype.add = function (geo, matrix, color, uvRect) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const pa = g.attributes.position, na = g.attributes.normal, ua = g.attributes.uv;
    _m3.getNormalMatrix(matrix);
    _c.set(color);
    for (let i = 0; i < pa.count; i++) {
      _ma.fromBufferAttribute(pa, i).applyMatrix4(matrix);
      this.p.push(_ma.x, _ma.y, _ma.z);
      if (na) { _mn.fromBufferAttribute(na, i).applyMatrix3(_m3).normalize(); this.n.push(_mn.x, _mn.y, _mn.z); }
      else this.n.push(0, 1, 0);
      this.c.push(_c.r, _c.g, _c.b);
      if (uvRect && ua) this.uv.push(uvRect[0] + ua.getX(i) * uvRect[2], uvRect[1] + ua.getY(i) * uvRect[3]);
      else this.uv.push(0, 0);
    }
    if (g !== geo) g.dispose();
    geo.dispose();
    return this;
  };
  Merger.prototype.tri = function (a, b, c, color, ta, tb, tc) {
    _ma.set(a[0], a[1], a[2]); _mb.set(b[0], b[1], b[2]); _mc.set(c[0], c[1], c[2]);
    _mn.subVectors(_mb, _ma).cross(_mt.subVectors(_mc, _ma));
    if (_mn.lengthSq() > 1e-12) _mn.normalize(); else _mn.set(0, 1, 0);
    _c.set(color);
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let k = 0; k < 3; k++) { this.n.push(_mn.x, _mn.y, _mn.z); this.c.push(_c.r, _c.g, _c.b); }
    if (ta) this.uv.push(ta[0], ta[1], tb[0], tb[1], tc[0], tc[1]);
    else this.uv.push(0, 0, 0, 0, 0, 0);
  };
  Merger.prototype.quad = function (a, b, c, d, color, ta, tb, tc, td) {
    this.tri(a, b, c, color, ta, tb, tc);
    this.tri(a, c, d, color, ta, tc, td);
  };
  Merger.prototype.geometry = function (withUV) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    if (withUV) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  };

  function mat(x, y, z, rx, ry, rz, sx, sy, sz) {
    const m = new THREE.Matrix4();
    _be.set(rx || 0, ry || 0, rz || 0, 'XYZ');
    const q = new THREE.Quaternion().setFromEuler(_be);
    const s = sx === undefined ? 1 : sx;
    return m.compose(new THREE.Vector3(x || 0, y || 0, z || 0), q,
      new THREE.Vector3(s, sy === undefined ? s : sy, sz === undefined ? s : sz));
  }
  function withBase(base, m) { return base ? new THREE.Matrix4().multiplyMatrices(base, m) : m; }
  function box(M, w, h, d, x, y, z, color, rx, ry, rz, base) {
    M.add(new THREE.BoxGeometry(w, h, d), withBase(base, mat(x, y, z, rx, ry, rz)), color);
  }
  function cyl(M, rt, rb, h, seg, x, y, z, color, rx, ry, rz, base) {
    M.add(new THREE.CylinderGeometry(rt, rb, h, seg), withBase(base, mat(x, y, z, rx, ry, rz)), color);
  }
  function cylBetween(M, a, b, r0, r1, seg, color, base) {
    const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = d.length();
    d.divideScalar(len || 1);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    const m = new THREE.Matrix4().compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), q, new THREE.Vector3(1, 1, 1));
    M.add(new THREE.CylinderGeometry(r1, r0, len, seg), withBase(base, m), color);
  }

  // ---------------------------------------------------------------------------
  // Canvas textures
  // ---------------------------------------------------------------------------
  function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function canvasTex(c, srgb) {
    const t = new THREE.CanvasTexture(c);
    if (srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  function roundRect(x, px, py, w, h, r) {
    x.beginPath();
    x.moveTo(px + r, py);
    x.arcTo(px + w, py, px + w, py + h, r);
    x.arcTo(px + w, py + h, px, py + h, r);
    x.arcTo(px, py + h, px, py, r);
    x.arcTo(px, py, px + w, py, r);
    x.closePath();
  }
  // Skull & crossbones centred at (cx, cy), s = skull radius in pixels.
  function drawSkull(x, cx, cy, s, bone, dark) {
    x.save();
    x.translate(cx, cy);
    x.fillStyle = bone;
    x.strokeStyle = bone;
    x.lineCap = 'round';
    for (const sg of [1, -1]) {
      x.save();
      x.translate(0, s * 0.45);
      x.rotate(sg * 0.6);
      x.lineWidth = s * 0.18;
      x.beginPath(); x.moveTo(-s * 0.98, 0); x.lineTo(s * 0.98, 0); x.stroke();
      for (const ex of [-1, 1]) for (const ey of [-1, 1]) { x.beginPath(); x.arc(ex * s * 1.04, ey * s * 0.1, s * 0.13, 0, TAU); x.fill(); }
      x.restore();
    }
    x.beginPath(); x.ellipse(0, -s * 0.14, s * 0.56, s * 0.5, 0, 0, TAU); x.fill();
    roundRect(x, -s * 0.36, s * 0.08, s * 0.72, s * 0.44, s * 0.13); x.fill();
    x.fillStyle = dark;
    x.strokeStyle = dark;
    for (const sg of [-1, 1]) { x.beginPath(); x.ellipse(sg * s * 0.21, -s * 0.06, s * 0.155, s * 0.17, sg * 0.25, 0, TAU); x.fill(); }
    x.beginPath(); x.moveTo(0, s * 0.1); x.lineTo(-s * 0.08, s * 0.24); x.lineTo(s * 0.08, s * 0.24); x.closePath(); x.fill();
    x.lineWidth = s * 0.035;
    x.beginPath(); x.moveTo(-s * 0.27, s * 0.37); x.lineTo(s * 0.27, s * 0.37); x.stroke();
    for (let i = -2; i <= 2; i++) { x.beginPath(); x.moveTo(i * s * 0.1, s * 0.3); x.lineTo(i * s * 0.1, s * 0.48); x.stroke(); }
    x.lineWidth = s * 0.028;
    x.beginPath(); x.moveTo(s * 0.12, -s * 0.62); x.lineTo(s * 0.2, -s * 0.46); x.lineTo(s * 0.12, -s * 0.36); x.lineTo(s * 0.25, -s * 0.26); x.stroke();
    x.restore();
  }

  function clothBase(x, ox, w, h, base) {
    x.fillStyle = base;
    x.fillRect(ox, 0, w, h);
    const panels = 6, pw = w / panels;
    for (let i = 0; i < panels; i++) {
      x.fillStyle = i % 2 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.1)';
      x.fillRect(ox + i * pw, 0, pw, h);
      x.fillStyle = 'rgba(0,0,0,0.38)';
      x.fillRect(ox + i * pw, 0, 2, h);
    }
    for (let i = 0; i < 700; i++) {
      x.fillStyle = (Math.random() < 0.5 ? 'rgba(255,255,255,' : 'rgba(0,0,0,') + (Math.random() * 0.07).toFixed(3) + ')';
      x.fillRect(ox + Math.random() * w, Math.random() * h, 2, 2);
    }
    // patches with stitches
    for (let i = 0; i < 3; i++) {
      const pw2 = 20 + Math.random() * 30, ph = 16 + Math.random() * 26;
      const px = ox + 10 + Math.random() * (w - pw2 - 20), py = 30 + Math.random() * (h - ph - 60);
      x.fillStyle = Math.random() < 0.5 ? 'rgba(90,70,60,0.35)' : 'rgba(0,0,0,0.25)';
      x.fillRect(px, py, pw2, ph);
      x.strokeStyle = 'rgba(200,180,150,0.35)';
      x.setLineDash([3, 3]);
      x.lineWidth = 1.5;
      x.strokeRect(px + 1, py + 1, pw2 - 2, ph - 2);
      x.setLineDash([]);
    }
    x.fillStyle = 'rgba(0,0,0,0.3)';
    x.fillRect(ox, 16, w, 5);
    x.strokeStyle = '#4b3a28';
    x.lineWidth = 4;
    x.strokeRect(ox + 2, 2, w - 4, h - 4);
  }
  function tatter(x, ox, w, h, notches, holes) {
    x.globalCompositeOperation = 'destination-out';
    x.fillStyle = '#000';
    for (let i = 0; i < notches; i++) {
      const nx = ox + 6 + Math.random() * (w - 12), nw = 6 + Math.random() * 14, nd = 6 + Math.random() * 20;
      x.beginPath(); x.moveTo(nx - nw / 2, h + 1); x.lineTo(nx + (Math.random() - 0.5) * 6, h - nd); x.lineTo(nx + nw / 2, h + 1); x.closePath(); x.fill();
    }
    for (let i = 0; i < holes; i++) {
      x.beginPath();
      x.ellipse(ox + 20 + Math.random() * (w - 40), 40 + Math.random() * (h - 90), 2 + Math.random() * 5, 2 + Math.random() * 4, Math.random() * 3, 0, TAU);
      x.fill();
    }
    x.globalCompositeOperation = 'source-over';
  }
  // Sail atlas: left half = skull sail, right half = plain patched sail.
  function makeSailTex() {
    const c = makeCanvas(512, 256), x = c.getContext('2d');
    clothBase(x, 0, 256, 256, '#221e20');
    clothBase(x, 256, 256, 256, '#252123');
    drawSkull(x, 128, 116, 66, '#ede6d4', '#221e20');
    tatter(x, 0, 256, 256, 9, 2);
    tatter(x, 256, 256, 256, 9, 3);
    const t = canvasTex(c);
    t.anisotropy = 4;
    return t;
  }
  function makeFlagTex() {
    const c = makeCanvas(128, 80), x = c.getContext('2d');
    x.fillStyle = '#151314';
    x.fillRect(0, 0, 128, 80);
    drawSkull(x, 58, 36, 20, '#f2ecdc', '#151314');
    x.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 5; i++) {
      const y = 6 + i * 16 + Math.random() * 6;
      x.beginPath(); x.moveTo(129, y - 5); x.lineTo(112 + Math.random() * 8, y); x.lineTo(129, y + 5); x.closePath(); x.fill();
    }
    x.globalCompositeOperation = 'source-over';
    return canvasTex(c);
  }
  function makeDotTex() {
    const c = makeCanvas(64, 64), x = c.getContext('2d');
    x.fillStyle = 'rgba(20,20,20,0.55)';
    x.beginPath(); x.arc(32, 32, 30, 0, TAU); x.fill();
    x.fillStyle = '#ffffff';
    x.beginPath(); x.arc(32, 32, 21, 0, TAU); x.fill();
    return canvasTex(c);
  }
  function makeGlowTex() {
    const c = makeCanvas(64, 64), x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,236,190,1)');
    g.addColorStop(0.25, 'rgba(255,190,90,0.6)');
    g.addColorStop(1, 'rgba(255,150,40,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    return canvasTex(c);
  }
  function makeMarkTex() {
    const c = makeCanvas(128, 128), x = c.getContext('2d');
    const ring = (lw, col) => {
      x.strokeStyle = col; x.lineWidth = lw;
      x.beginPath(); x.arc(64, 64, 38, 0, TAU); x.stroke();
      for (let i = 0; i < 4; i++) {
        const a = (i * PI) / 2;
        x.beginPath(); x.moveTo(64 + Math.cos(a) * 26, 64 + Math.sin(a) * 26); x.lineTo(64 + Math.cos(a) * 56, 64 + Math.sin(a) * 56); x.stroke();
      }
    };
    ring(14, 'rgba(20,12,4,0.6)');
    ring(7, '#ffffff');
    x.fillStyle = '#ffffff';
    x.beginPath(); x.arc(64, 64, 6, 0, TAU); x.fill();
    return canvasTex(c);
  }
  function makeFoamBandTex() {
    const c = makeCanvas(64, 128), x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 64, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 128);
    x.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 90; i++) {
      x.fillStyle = 'rgba(0,0,0,' + (0.3 + Math.random() * 0.6).toFixed(2) + ')';
      x.beginPath(); x.arc(Math.random() * 64, Math.random() * 128, 1.5 + Math.random() * 5, 0, TAU); x.fill();
    }
    x.globalCompositeOperation = 'source-over';
    const t = canvasTex(c);
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.RepeatWrapping;
    return t;
  }
  function makeFoamTex() {
    const c = makeCanvas(64, 128), x = c.getContext('2d');
    x.clearRect(0, 0, 64, 128);
    for (let i = 0; i < 140; i++) {
      const px = Math.random() * 64, py = Math.random() * 128;
      const edge = Math.min(px, 64 - px) / 32;
      x.fillStyle = 'rgba(255,255,255,' + (0.15 + 0.6 * Math.random() * (1 - edge * 0.6)).toFixed(3) + ')';
      x.fillRect(px, py, 1 + Math.random() * 3, 4 + Math.random() * 14);
    }
    const t = canvasTex(c);
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.RepeatWrapping;
    return t;
  }

  // Speech bubbles: one texture per line of text, cached and shared.
  const bubbleCache = new Map();
  function bubbleTex(text) {
    let e = bubbleCache.get(text);
    if (e) return e;
    const c = makeCanvas(512, 128), x = c.getContext('2d');
    x.font = 'bold 44px "Alegreya Sans", "Segoe UI", sans-serif';
    const tw = Math.min(470, x.measureText(text).width);
    const w = tw + 48, h = 78, px = (512 - w) / 2, py = 8;
    x.fillStyle = 'rgba(0,0,0,0.25)';
    roundRect(x, px + 3, py + 4, w, h, 26); x.fill();
    x.fillStyle = '#fbf6ea';
    roundRect(x, px, py, w, h, 26); x.fill();
    x.beginPath(); x.moveTo(256 - 14, py + h - 2); x.lineTo(256, py + h + 26); x.lineTo(256 + 16, py + h - 2); x.closePath(); x.fill();
    x.strokeStyle = '#3a2a1c';
    x.lineWidth = 4;
    roundRect(x, px, py, w, h, 26); x.stroke();
    x.fillStyle = '#fbf6ea';
    x.fillRect(256 - 12, py + h - 4, 26, 6);
    x.fillStyle = '#2a1c12';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(text, 256, py + h / 2 + 2, 470);
    e = canvasTex(c);
    bubbleCache.set(text, e);
    return e;
  }

  // ---------------------------------------------------------------------------
  // Shared materials & geometries (built in init)
  // ---------------------------------------------------------------------------
  const M = {};
  const GEO = {};
  const TEX = {};

  function assets() {
    TEX.sail = makeSailTex();
    TEX.flag = makeFlagTex();
    TEX.dot = makeDotTex();
    TEX.glow = makeGlowTex();
    TEX.foam = makeFoamTex();
    TEX.foamBand = makeFoamBandTex();
    TEX.mark = makeMarkTex();

    M.vc = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.86, metalness: 0.02, side: THREE.DoubleSide });
    M.fig = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8, metalness: 0.02 });
    M.figHit = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8, emissive: 0xff3a22, emissiveIntensity: 0.55 });
    M.wood = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0.0 });
    M.metal = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.42, metalness: 0.55 });
    M.sail = new THREE.MeshStandardMaterial({ map: TEX.sail, side: THREE.DoubleSide, alphaTest: 0.5, flatShading: true, roughness: 0.95 });
    M.flag = new THREE.MeshStandardMaterial({ map: TEX.flag, side: THREE.DoubleSide, alphaTest: 0.5, roughness: 0.95 });
    M.glass = new THREE.MeshBasicMaterial({ color: 0x5a4322 });
    M.glow = new THREE.SpriteMaterial({ map: TEX.glow, color: 0xffc27a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    M.rope = new THREE.LineBasicMaterial({ color: 0x1b140f, transparent: true, opacity: 0.85 });
    M.ball = new THREE.MeshStandardMaterial({ color: 0x1e1f22, roughness: 0.4, metalness: 0.6, flatShading: true });
    M.wake = new THREE.MeshBasicMaterial({ map: TEX.foam, vertexColors: true, transparent: true, depthWrite: false, opacity: 1 });
    M.skirt = new THREE.MeshBasicMaterial({ map: TEX.foamBand, vertexColors: true, transparent: true, depthWrite: false, opacity: 1 });
    M.dots = new THREE.PointsMaterial({ map: TEX.dot, size: 0.42, sizeAttenuation: true,
      transparent: true, depthWrite: false, color: 0xffffff, alphaTest: 0.05 });
    M.aimRing = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
    M.aimMark = new THREE.SpriteMaterial({ map: TEX.mark, color: 0xffc04a, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false });

    GEO.ball = new THREE.IcosahedronGeometry(BALL_R, 1);
    GEO.ring = new THREE.RingGeometry(0.62, 0.9, 28);
    GEO.ring.rotateX(-HALF_PI);
    GEO.aimRing = new THREE.RingGeometry(0.55, 0.8, 24);
    GEO.aimRing.rotateX(-HALF_PI);
  }

  // ---------------------------------------------------------------------------
  // Pirate figures (static crew on the ship + animated boarders)
  // ---------------------------------------------------------------------------
  const FIG_VARIANTS = [
    { shirt: 0xb8322a, sleeve: 0xefe8da, pants: 0x34425f, band: 0xc0392b, hat: false, beard: 0x3a2616, patch: false, skin: 0xe2a877, hook: false, earring: true },
    { shirt: 0x2b3f73, sleeve: 0x2b3f73, pants: 0x5a4632, band: 0x1f1f1f, hat: true, beard: 0x1e1410, patch: true, skin: 0xc98b5e, hook: false, earring: false },
    { shirt: 0x2a2a2a, sleeve: 0xefe8da, pants: 0x4b5a39, band: 0xd9a441, hat: false, beard: null, patch: false, skin: 0xf0c090, hook: true, earring: false },
    { shirt: 0x3f6b3a, sleeve: 0xefe8da, pants: 0x3b3029, band: 0x2f6fa8, hat: false, beard: 0x8a4a22, patch: true, skin: 0xd9a070, hook: false, earring: true },
  ];
  const BONES = {
    legL: [-0.11, 0.92, 0], legR: [0.11, 0.92, 0], torso: [0, 0.92, 0],
    head: [0, 0.6, 0], armL: [-0.3, 0.55, 0], armR: [0.3, 0.55, 0],       // head/arms relative to torso
  };

  // Emits every part of a figure as sink(bone, geometry, boneLocalMatrix, color).
  function buildFigure(v, sink) {
    const B = (bone, geo, m, color) => sink(bone, geo, m, color);
    const bx = (bone, w, h, d, x, y, z, color, rx, ry, rz) => B(bone, new THREE.BoxGeometry(w, h, d), mat(x, y, z, rx, ry, rz), color);
    // legs
    for (const leg of ['legL', 'legR']) {
      bx(leg, 0.17, 0.6, 0.19, 0, -0.3, 0, v.pants);
      bx(leg, 0.19, 0.3, 0.27, 0, -0.77, 0.03, 0x2a1d14);
      bx(leg, 0.2, 0.05, 0.2, 0, -0.6, 0, 0x2a1d14);
    }
    // torso: striped shirt made of stacked slabs
    const widths = [0.4, 0.42, 0.44, 0.46, 0.47];
    for (let i = 0; i < 5; i++) {
      bx('torso', widths[i], 0.121, 0.25 + i * 0.004, 0, 0.08 + i * 0.12, 0, i % 2 ? 0xefe8da : v.shirt);
    }
    bx('torso', 0.48, 0.09, 0.28, 0, 0.05, 0, 0x4a2e1a);
    bx('torso', 0.09, 0.07, 0.03, 0, 0.05, 0.145, 0xd9a441);
    bx('torso', 0.13, 0.07, 0.13, 0, 0.62, 0, v.skin);
    if (v.hat) {   // captain: red sash across the chest
      bx('torso', 0.1, 0.62, 0.02, 0, 0.36, 0.135, 0x9a2a1f, 0, 0, 0.62);
    }
    // head
    const skinDark = new THREE.Color(v.skin).multiplyScalar(0.82).getHex();
    bx('head', 0.27, 0.29, 0.27, 0, 0.16, 0, v.skin);
    bx('head', 0.05, 0.08, 0.06, 0, 0.13, 0.155, skinDark);
    for (const sg of [-1, 1]) {
      if (!(v.patch && sg < 0)) bx('head', 0.045, 0.045, 0.02, sg * 0.065, 0.19, 0.137, 0x161010);
      bx('head', 0.08, 0.022, 0.02, sg * 0.065, 0.232, 0.138, v.beard || 0x3a2616, 0, 0, sg * -0.15);
    }
    if (v.beard) {
      bx('head', 0.25, 0.12, 0.07, 0, 0.035, 0.12, v.beard);
      bx('head', 0.17, 0.035, 0.035, 0, 0.09, 0.15, v.beard);
    } else {
      bx('head', 0.12, 0.025, 0.02, 0, 0.07, 0.137, 0x7a3a2a);
    }
    if (v.patch) {
      bx('head', 0.085, 0.075, 0.025, -0.065, 0.19, 0.142, 0x0e0e0e);
      bx('head', 0.285, 0.022, 0.285, 0, 0.215, 0, 0x0e0e0e, 0, 0, 0.2);
    }
    if (v.earring) B('head', new THREE.TorusGeometry(0.025, 0.008, 4, 8), mat(0.14, 0.08, 0.01, 0, HALF_PI, 0), 0xe0b040);
    if (v.hat) {
      B('head', new THREE.CylinderGeometry(0.31, 0.33, 0.07, 3), mat(0, 0.33, 0), 0x17130f);
      B('head', new THREE.CylinderGeometry(0.15, 0.165, 0.15, 6), mat(0, 0.41, 0), 0x17130f);
      B('head', new THREE.CylinderGeometry(0.168, 0.168, 0.03, 6), mat(0, 0.35, 0), 0xd9a441);
    } else {
      bx('head', 0.29, 0.1, 0.29, 0, 0.28, 0, v.band);
      bx('head', 0.075, 0.075, 0.05, 0.06, 0.23, -0.16, v.band);
      bx('head', 0.05, 0.15, 0.02, 0.09, 0.14, -0.17, v.band, 0, 0, 0.3);
    }
    // arms
    for (const arm of ['armL', 'armR']) {
      bx(arm, 0.13, 0.32, 0.14, 0, -0.14, 0, v.sleeve);
      bx(arm, 0.115, 0.26, 0.125, 0, -0.42, 0, v.skin);
      if (arm === 'armL' && v.hook) {
        B(arm, new THREE.TorusGeometry(0.055, 0.014, 4, 8, PI * 1.3), mat(0, -0.64, 0.02, 0, HALF_PI, PI * 0.7), 0xc8ccd2);
        bx(arm, 0.1, 0.05, 0.1, 0, -0.56, 0, 0x4a2e1a);
      } else {
        bx(arm, 0.12, 0.11, 0.13, 0, -0.6, 0, v.skin);
      }
    }
    // sabre in the right hand (points forward-down at rest)
    const sb = mat(0, -0.62, 0.02, 0.52, 0, 0);
    const sp = (w, h, d, x, y, z, color, rx) => B('armR', new THREE.BoxGeometry(w, h, d), withBase(sb, mat(x, y, z, rx || 0, 0, 0)), color);
    sp(0.04, 0.04, 0.17, 0, 0, 0.0, 0x4a2e1a);
    sp(0.15, 0.03, 0.035, 0, 0, 0.095, 0xd9a441);
    sp(0.025, 0.09, 0.025, 0.0, -0.045, 0.06, 0xd9a441);
    for (let i = 0; i < 5; i++) {
      sp(0.014, i === 4 ? 0.035 : 0.05, 0.15, 0, 0.004 + 0.011 * i * i, 0.18 + i * 0.132, i === 4 ? 0xbfc6cc : 0xdfe4ea, -0.09 * i);
    }
  }

  // Merges a whole figure into `M` at `base` (static crew on the ship).
  function mergeFigure(M, v, base, pose) {
    const rest = {};
    const tm = (b) => { const o = BONES[b]; return mat(o[0], o[1], o[2]); };
    rest.legL = tm('legL'); rest.legR = tm('legR'); rest.torso = tm('torso');
    rest.head = withBase(rest.torso, tm('head'));
    rest.armL = withBase(rest.torso, withBase(tm('armL'), mat(0, 0, 0, pose && pose.armL || 0, 0, -0.12)));
    rest.armR = withBase(rest.torso, withBase(tm('armR'), mat(0, 0, 0, pose && pose.armR || -0.5, 0, 0.1)));
    buildFigure(v, (bone, geo, m, color) => M.add(geo, withBase(base, withBase(rest[bone], m)), color));
  }

  // Animated boarder model: one mesh per bone, all sharing one vertex-colour material.
  function makeBoarderModel(v) {
    const mergers = { legL: new Merger(), legR: new Merger(), torso: new Merger(), head: new Merger(), armL: new Merger(), armR: new Merger() };
    buildFigure(v, (bone, geo, m, color) => mergers[bone].add(geo, m, color));
    const root = new THREE.Group();
    root.name = 'pirate-boarder';
    const body = new THREE.Group();
    root.add(body);
    const parts = { root, body, meshes: [] };
    const pivot = (name, parent) => {
      const g = new THREE.Group();
      const o = BONES[name];
      g.position.set(o[0], o[1], o[2]);
      const mesh = new THREE.Mesh(mergers[name].geometry(false), M.fig);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
      parent.add(g);
      parts[name] = g;
      parts.meshes.push(mesh);
      return g;
    };
    pivot('legL', body);
    pivot('legR', body);
    const torso = pivot('torso', body);
    pivot('head', torso);
    pivot('armL', torso);
    pivot('armR', torso);
    const bubble = new THREE.Sprite(new THREE.SpriteMaterial({ map: bubbleTex('Arrr!'), transparent: true, depthTest: false, depthWrite: false }));
    bubble.renderOrder = 10;
    bubble.visible = false;
    bubble.position.set(0, 2.25, 0);
    root.add(bubble);
    parts.bubble = bubble;
    root.visible = false;
    return parts;
  }

  // ---------------------------------------------------------------------------
  // Hull lofting (ship & rowboat)
  // ---------------------------------------------------------------------------
  // o = { n, z0, len, w(t), top(t), depth(t), prof: [[frac, yFn(top, depth)]...], colors: [...], transom }
  function loft(Mg, o) {
    const rings = [];
    for (let k = 0; k <= o.n; k++) {
      const t = k / o.n, w = o.w(t), top = o.top(t), dep = o.depth(t), z = o.z0 + t * o.len;
      const ring = [];
      for (const pr of o.prof) ring.push([pr[0] * w, pr[1](top, dep), z]);
      rings.push(ring);
    }
    for (let k = 0; k < o.n; k++) {
      const A = rings[k], Bk = rings[k + 1];
      for (let s = 0; s < A.length - 1; s++) {
        const col = o.colors[Math.min(s, o.colors.length - 1)];
        for (const sg of [1, -1]) {
          Mg.quad([sg * A[s][0], A[s][1], A[s][2]], [sg * Bk[s][0], Bk[s][1], Bk[s][2]],
            [sg * Bk[s + 1][0], Bk[s + 1][1], Bk[s + 1][2]], [sg * A[s + 1][0], A[s + 1][1], A[s + 1][2]], col);
        }
      }
    }
    if (o.transom) {
      const A = rings[0], pts = [];
      for (let s = 0; s < A.length; s++) pts.push([A[s][0], A[s][1], A[s][2]]);
      for (let s = A.length - 2; s >= 0; s--) pts.push([-A[s][0], A[s][1], A[s][2]]);
      let cy = 0;
      for (const p of pts) cy += p[1];
      const c = [0, cy / pts.length, A[0][2]];
      for (let s = 0; s < pts.length - 1; s++) Mg.tri(c, pts[s + 1], pts[s], o.transom);
    }
    return rings;
  }
  // Flat horizontal strip between stations t0..t1 at height y with half-width f*w(t).
  function deckStrip(Mg, o, t0, t1, n, y, f, colA, colB) {
    for (let k = 0; k < n; k++) {
      const ta = t0 + (t1 - t0) * (k / n), tb = t0 + (t1 - t0) * ((k + 1) / n);
      const wa = o.w(ta) * f, wb = o.w(tb) * f, za = o.z0 + ta * o.len, zb = o.z0 + tb * o.len;
      Mg.quad([-wa, y, za], [wa, y, za], [wb, y, zb], [-wb, y, zb], k % 2 ? colA : colB);
    }
  }
  // Vertical side walls following the hull outline from yBot(t) to yTop between stations.
  function sideWalls(Mg, o, t0, t1, n, yBot, yTop, fBot, fTop, color, trimColor) {
    for (let k = 0; k < n; k++) {
      const ta = t0 + (t1 - t0) * (k / n), tb = t0 + (t1 - t0) * ((k + 1) / n);
      const wa = o.w(ta), wb = o.w(tb), za = o.z0 + ta * o.len, zb = o.z0 + tb * o.len;
      const ba = Math.min(yBot(ta), yTop - 0.12), bb = Math.min(yBot(tb), yTop - 0.12);
      if (ba >= yTop - 0.13 && bb >= yTop - 0.13) continue;
      for (const sg of [1, -1]) {
        Mg.quad([sg * wa * fBot, ba, za], [sg * wb * fBot, bb, zb], [sg * wb * fTop, yTop - 0.12, zb], [sg * wa * fTop, yTop - 0.12, za], color);
        if (trimColor != null) {
          Mg.quad([sg * wa * fTop, yTop - 0.12, za], [sg * wb * fTop, yTop - 0.12, zb], [sg * wb * fTop, yTop, zb], [sg * wa * fTop, yTop, za], trimColor);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // The pirate ship model (built once, reused for every raid)
  // ---------------------------------------------------------------------------
  const C = {
    hull: 0x3a2819, hull2: 0x2e1f15, band: 0x7c2b1f, trim: 0xb58c3c, bottom: 0x2b2a24, deck: 0x7d5d3d, deck2: 0x735536,
    castle: 0x43291a, mast: 0x5a3d26, yard: 0x4b3320, iron: 0x2b2d31, lid: 0x8e2c1f, frame: 0x24170f, gold: 0xd9a441,
  };
  const SHIP = {
    n: 18, z0: -8.5, len: 17,
    w(t) {
      if (t < 0.42) return G.lerp(1.95, 2.7, smooth01(t / 0.42));
      const u = (t - 0.42) / 0.58;
      return Math.max(0.05, 2.7 * Math.sqrt(Math.max(0, 1 - u * u)));
    },
    top(t) {
      return 2.35 + (t > 0.55 ? 1.25 * Math.pow((t - 0.55) / 0.45, 1.4) : 0) + (t < 0.22 ? 0.45 * (1 - t / 0.22) : 0);
    },
    depth(t) { return 1.45 * (t > 0.82 ? 1 - 0.7 * ((t - 0.82) / 0.18) : 1); },
  };
  SHIP.prof = [
    [0.9, (top) => top], [0.915, (top) => top - 0.14], [0.97, () => 1.85], [1.0, () => 1.15],
    [0.97, () => 0.3], [0.84, (top, d) => -0.35 * d], [0.52, (top, d) => -0.8 * d], [0.0, (top, d) => -d],
  ];
  SHIP.colors = [C.trim, C.hull, C.band, C.hull2, C.hull2, C.bottom, C.bottom];
  SHIP.transom = C.hull;
  const tAtZ = (z) => (z - SHIP.z0) / SHIP.len;
  const DECK_Y = 1.72, AFT_TOP = 3.85, AFT_DECK = 3.62, FORE_DECK = 2.92, FORE_TOP = 3.2;
  const AFT_T = 0.24, FORE_T0 = 0.71, FORE_T1 = 0.955;
  const PORTS_Z = [-2.7, -0.7, 1.3, 3.2];
  const MASTS = [
    { z: 4.9, base: DECK_Y, top: 15.2, r: 0.17 },
    { z: 0.5, base: DECK_Y, top: 17.8, r: 0.2 },
    { z: -6.7, base: AFT_DECK, top: 12.6, r: 0.14 },
  ];
  // sails: mast index, bottom, top, top width, bottom width, billow, skull?
  const SAILS = [
    { m: 1, yb: 5.2, yt: 10.2, wt: 7.6, wb: 8.4, bl: 0.95, skull: true },
    { m: 1, yb: 10.8, yt: 13.4, wt: 5.4, wb: 6.6, bl: 0.6 },
    { m: 1, yb: 14.1, yt: 16.4, wt: 3.4, wb: 4.6, bl: 0.4 },
    { m: 0, yb: 4.9, yt: 9.5, wt: 6.4, wb: 7.2, bl: 0.85 },
    { m: 0, yb: 10.2, yt: 13.6, wt: 4.4, wb: 5.6, bl: 0.55 },
    { m: 2, yb: 5.6, yt: 10.4, wt: 4.0, wb: 4.8, bl: 0.6 },
  ];
  let shipM = null;

  function buildShip() {
    const Mg = new Merger();
    loft(Mg, Object.assign({}, SHIP, { transom: SHIP.transom }));
    // main deck
    deckStrip(Mg, SHIP, 0.0, 0.985, 18, DECK_Y, 0.93, C.deck, C.deck2);
    // sterncastle: walls, deck, front & aft faces, rails
    sideWalls(Mg, SHIP, 0, AFT_T, 4, SHIP.top, AFT_TOP, 0.9, 0.87, C.castle, C.trim);
    deckStrip(Mg, SHIP, 0, AFT_T, 4, AFT_DECK, 0.87, C.deck, C.deck2);
    const wA = SHIP.w(AFT_T) * 0.87, zA = SHIP.z0 + AFT_T * SHIP.len;
    Mg.quad([-wA, DECK_Y, zA], [wA, DECK_Y, zA], [wA, AFT_TOP, zA], [-wA, AFT_TOP, zA], C.castle);
    box(Mg, 0.75, 1.3, 0.08, 0, DECK_Y + 0.65, zA + 0.03, C.frame);
    box(Mg, 0.08, 0.08, 0.05, 0.22, DECK_Y + 0.6, zA + 0.08, C.gold);
    const w0 = SHIP.w(0) * 0.9, z0 = SHIP.z0, top0 = SHIP.top(0);
    Mg.quad([w0, top0, z0], [-w0, top0, z0], [-w0, AFT_TOP, z0], [w0, AFT_TOP, z0], C.castle);
    box(Mg, w0 * 2 + 0.2, 0.14, 0.3, 0, AFT_TOP + 0.02, z0 - 0.05, C.trim);
    box(Mg, w0 * 2 + 0.3, 0.12, 0.5, 0, top0 - 0.05, z0 - 0.15, C.trim);
    for (let i = 0; i < 4; i++) box(Mg, 0.44, 0.52, 0.06, -1.05 + i * 0.7, 3.25, z0 - 0.03, C.frame);
    // aft rail (balusters) around the sterncastle deck
    for (let i = 0; i <= 6; i++) {
      const tt = (i / 6) * AFT_T, ww = SHIP.w(tt) * 0.86, zz = SHIP.z0 + tt * SHIP.len;
      for (const sg of [1, -1]) box(Mg, 0.08, 0.5, 0.08, sg * ww, AFT_TOP + 0.25, zz, C.castle);
    }
    for (const sg of [1, -1]) {
      const ww = SHIP.w(AFT_T * 0.5) * 0.86;
      box(Mg, 0.1, 0.08, AFT_T * SHIP.len + 0.1, sg * ww, AFT_TOP + 0.52, SHIP.z0 + AFT_T * SHIP.len * 0.5, C.trim, 0, sg * 0.02, 0);
    }
    for (let i = 0; i < 5; i++) box(Mg, 0.08, 0.5, 0.08, -1.5 + i * 0.75, AFT_TOP + 0.25, z0 + 0.05, C.castle);
    box(Mg, w0 * 2, 0.08, 0.1, 0, AFT_TOP + 0.52, z0 + 0.05, C.trim);
    // ship's wheel on the sterncastle
    Mg.add(new THREE.TorusGeometry(0.42, 0.04, 4, 10), mat(0, AFT_DECK + 0.95, -4.95, 0, 0, 0), C.mast);
    box(Mg, 0.14, 0.9, 0.14, 0, AFT_DECK + 0.45, -4.85, C.castle);
    for (let i = 0; i < 4; i++) box(Mg, 0.95, 0.04, 0.04, 0, AFT_DECK + 0.95, -4.95, C.mast, 0, 0, (i * PI) / 4);
    // forecastle
    deckStrip(Mg, SHIP, FORE_T0, FORE_T1, 4, FORE_DECK, 0.9, C.deck, C.deck2);
    sideWalls(Mg, SHIP, FORE_T0, FORE_T1, 4, SHIP.top, FORE_TOP, 0.9, 0.9, C.castle, C.trim);
    const wF = SHIP.w(FORE_T0) * 0.9, zF = SHIP.z0 + FORE_T0 * SHIP.len;
    Mg.quad([wF, DECK_Y, zF], [-wF, DECK_Y, zF], [-wF, FORE_DECK, zF], [wF, FORE_DECK, zF], C.castle);
    box(Mg, wF * 2, 0.1, 0.12, 0, FORE_DECK + 0.05, zF - 0.02, C.trim);
    // gunports, lids and cannons on both sides
    const muzzles = [[], []];
    for (const sg of [1, -1]) {
      for (const pz of PORTS_Z) {
        const t = tAtZ(pz), ww = SHIP.w(t) * 0.99;
        const slope = (SHIP.w(tAtZ(pz + 0.3)) - SHIP.w(tAtZ(pz - 0.3))) / 0.6;
        const ry = -sg * Math.atan(slope);
        box(Mg, 0.08, 0.46, 0.5, sg * (ww + 0.02), 1.5, pz, C.frame, 0, ry, 0);
        box(Mg, 0.05, 0.44, 0.5, sg * (ww + 0.2), 1.9, pz, C.lid, 0, ry, sg * 0.95);
        const cm = mat(sg * (ww + 0.12), 1.47, pz, 0, 0, -sg * HALF_PI);
        Mg.add(new THREE.CylinderGeometry(0.1, 0.13, 0.8, 7), cm, C.iron);
        Mg.add(new THREE.CylinderGeometry(0.135, 0.135, 0.08, 7), withBase(cm, mat(0, 0.36, 0)), C.iron);
        muzzles[sg > 0 ? 0 : 1].push(new THREE.Vector3(sg * (ww + 0.6), 1.47, pz));
      }
    }
    // masts, tops, yards
    for (let mi = 0; mi < MASTS.length; mi++) {
      const m = MASTS[mi], h = m.top - m.base;
      cyl(Mg, m.r * 0.6, m.r, h, 7, 0, m.base + h / 2, m.z, C.mast);
      cyl(Mg, m.r * 1.35, m.r * 1.35, 0.3, 7, 0, m.base + 0.15, m.z, C.yard);
    }
    // crow's nest on the main mast, a smaller top on the foremast
    const nestY = 13.9;
    Mg.add(new THREE.CylinderGeometry(0.78, 0.62, 0.6, 9, 1, true), mat(0, nestY + 0.3, MASTS[1].z), C.yard);
    cyl(Mg, 0.62, 0.62, 0.08, 9, 0, nestY, MASTS[1].z, C.mast);
    cyl(Mg, 0.8, 0.8, 0.06, 9, 0, nestY + 0.62, MASTS[1].z, C.trim);
    cyl(Mg, 0.55, 0.45, 0.1, 8, 0, 9.85, MASTS[0].z, C.yard);
    for (const sl of SAILS) {
      const m = MASTS[sl.m];
      box(Mg, sl.wt + 0.5, 0.13, 0.13, 0, sl.yt + 0.05, m.z + 0.25, C.yard);
    }
    // bowsprit + figurehead-ish beak
    const bsA = [0, 3.0, 7.9], bsB = [0, 5.4, 12.6];
    cylBetween(Mg, bsA, bsB, 0.16, 0.08, 7, C.mast);
    box(Mg, 0.3, 0.5, 1.2, 0, 2.2, 8.7, C.hull, -0.5, 0, 0);
    box(Mg, 0.32, 0.12, 1.3, 0, 2.55, 8.75, C.trim, -0.5, 0, 0);
    // lantern frames (the glowing glass is a separate mesh)
    const LANTERNS = [[0, AFT_TOP + 0.95, SHIP.z0 + 0.05], [1.55, AFT_TOP + 0.8, SHIP.z0 + 0.2], [-1.55, AFT_TOP + 0.8, SHIP.z0 + 0.2], [0, 3.95, 7.9]];
    for (const L of LANTERNS) {
      box(Mg, 0.26, 0.05, 0.26, L[0], L[1] + 0.18, L[2], C.frame);
      box(Mg, 0.3, 0.05, 0.3, L[0], L[1] - 0.18, L[2], C.frame);
      cyl(Mg, 0.02, 0.02, 0.5, 4, L[0], L[1] - 0.45, L[2], C.frame);
      Mg.add(new THREE.ConeGeometry(0.16, 0.16, 4), mat(L[0], L[1] + 0.28, L[2], 0, PI / 4, 0), C.frame);
    }
    // crew on deck (static)
    mergeFigure(Mg, FIG_VARIANTS[1], mat(0, AFT_DECK, -5.55, 0, 0, 0), { armR: -1.25, armL: -1.25 });
    mergeFigure(Mg, FIG_VARIANTS[0], mat(1.3, DECK_Y, -1.6, 0, HALF_PI - 0.3, 0), { armR: -2.4, armL: -0.3 });
    mergeFigure(Mg, FIG_VARIANTS[2], mat(-1.2, DECK_Y, 2.4, 0, -HALF_PI + 0.4, 0), { armR: -0.8 });
    mergeFigure(Mg, FIG_VARIANTS[0], mat(-1.4, DECK_Y, -1.9, 0, -HALF_PI, 0), { armR: -1.6 });
    mergeFigure(Mg, FIG_VARIANTS[2], mat(0.2, nestY - 0.55, MASTS[1].z + 0.1, 0, 0.6, 0), { armR: -2.9, armL: -0.4 });
    // barrels & crates on deck
    cyl(Mg, 0.3, 0.3, 0.7, 8, 0.9, DECK_Y + 0.35, 3.6, 0x6b4a2f);
    cyl(Mg, 0.31, 0.31, 0.05, 8, 0.9, DECK_Y + 0.55, 3.6, C.iron);
    box(Mg, 0.6, 0.5, 0.6, -0.9, DECK_Y + 0.25, -3.2, 0x7a5a38, 0, 0.3, 0);

    const hull = new THREE.Mesh(Mg.geometry(false), M.vc);
    hull.castShadow = true;
    hull.receiveShadow = true;

    // sails (atlas UVs: left half skull, right half plain)
    const Ms = new Merger();
    const addSail = (zc, yb, yt, wt, wb, bl, skull) => {
      const nx = 6, ny = 4, u0 = skull ? 0 : 0.5;
      const P = (i, j) => {
        const u = i / nx, v = j / ny, w = G.lerp(wb, wt, v), xn = u * 2 - 1;
        const f = G.clamp((1 - v) * (0.6 + 1.6 * v) / 0.76, 0, 1);
        return [(u - 0.5) * w, G.lerp(yb, yt, v), zc + bl * (1 - xn * xn) * f];
      };
      const T = (i, j) => [u0 + (i / nx) * 0.5, j / ny];
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          Ms.quad(P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1), 0xffffff, T(i, j), T(i + 1, j), T(i + 1, j + 1), T(i, j + 1));
        }
      }
    };
    for (const sl of SAILS) addSail(MASTS[sl.m].z + 0.3, sl.yb, sl.yt, sl.wt, sl.wb, sl.bl, !!sl.skull);
    // jib (triangle) from the bowsprit to the foremast
    Ms.tri([0, 3.3, 8.0], [0, 5.25, 12.3], [0, 12.2, MASTS[0].z + 0.2], 0xffffff, [0.55, 0.05], [0.95, 0.05], [0.75, 0.95]);
    const sails = new THREE.Mesh(Ms.geometry(true), M.sail);
    sails.castShadow = true;

    // lantern glass + stern windows (glow at night)
    const Mw = new Merger();
    for (const L of LANTERNS) box(Mw, 0.2, 0.3, 0.2, L[0], L[1], L[2], 0xffffff);
    for (let i = 0; i < 4; i++) box(Mw, 0.34, 0.4, 0.04, -1.05 + i * 0.7, 3.25, z0 - 0.07, 0xffffff);
    const glass = new THREE.Mesh(Mw.geometry(false), M.glass);

    // rigging lines
    const lp = [];
    const line = (a, b) => lp.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    for (const m of MASTS) {
      const hy = m.base + (m.top - m.base) * 0.8;
      for (const dz of [-0.9, 0, 0.9]) {
        const t = tAtZ(m.z + dz), ww = SHIP.w(t) * 0.92, ty = m === MASTS[2] ? AFT_TOP : SHIP.top(t);
        line([0, hy, m.z], [ww, ty, m.z + dz]);
        line([0, hy, m.z], [-ww, ty, m.z + dz]);
      }
    }
    line([0, MASTS[1].top - 0.3, MASTS[1].z], [0, 10.5, MASTS[0].z]);
    line([0, MASTS[0].top - 0.3, MASTS[0].z], [0, 5.4, 12.6]);
    line([0, MASTS[2].top - 0.3, MASTS[2].z], [0, 9.5, MASTS[1].z]);
    line([0, MASTS[1].top - 0.5, MASTS[1].z], [0, AFT_TOP + 0.5, SHIP.z0 + 0.2]);
    line([0, 12.2, MASTS[0].z + 0.2], [0, 5.25, 12.3]);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    const rigging = new THREE.LineSegments(lg, M.rope);

    // Jolly Roger on the main mast (vertex-animated)
    const fg = new THREE.PlaneGeometry(1.9, 1.15, 8, 3);
    fg.translate(0.95, 0, 0);
    fg.rotateY(-HALF_PI);
    const flag = new THREE.Mesh(fg, M.flag);
    flag.position.set(0, MASTS[1].top - 0.4, MASTS[1].z);
    const flagBase = Float32Array.from(fg.attributes.position.array);

    const root = new THREE.Group();
    root.name = 'pirate-ship';
    root.rotation.order = 'YXZ';
    root.add(hull, sails, glass, rigging, flag);
    const glows = [];
    for (const L of LANTERNS) {
      const sp = new THREE.Sprite(M.glow);
      sp.position.set(L[0], L[1], L[2]);
      sp.scale.setScalar(2.2);
      root.add(sp);
      glows.push(sp);
    }
    const sp2 = new THREE.Sprite(M.glow);
    sp2.position.set(0, 3.25, SHIP.z0 - 0.3);
    sp2.scale.set(4.2, 1.6, 1);
    root.add(sp2);
    glows.push(sp2);
    root.visible = false;

    // health bar (world-space sprite, redrawn when hp changes)
    const barCanvas = makeCanvas(256, 48);
    const barTex = canvasTex(barCanvas);
    const bar = new THREE.Sprite(new THREE.SpriteMaterial({ map: barTex, transparent: true, depthWrite: false, depthTest: false }));
    bar.scale.set(8, 1.5, 1);
    bar.renderOrder = 9;
    bar.visible = false;

    return { root, hull, sails, glass, rigging, flag, flagBase, glows, muzzles, bar, barCanvas, barTex, barFrac: -1, skirt: null };
  }

  // Foam skirt around the hull at the waterline (follows the waves vertex by vertex).
  function buildSkirt() {
    const N = 16, pts = [];
    for (let k = 0; k <= N; k++) { const t = k / N; pts.push([SHIP.w(t) * 0.93, SHIP.z0 + t * SHIP.len, t]); }
    for (let k = N - 1; k >= 0; k--) { const t = k / N; pts.push([-SHIP.w(t) * 0.93, SHIP.z0 + t * SHIP.len, t]); }
    const n = pts.length;
    const pos = new Float32Array(n * 2 * 3), col = new Float32Array(n * 2 * 4), uv = new Float32Array(n * 2 * 2);
    const base = new Float32Array(n * 2 * 2);
    const zc = SHIP.z0 + SHIP.len * 0.45;
    let run = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n], p = pts[i];
      let tx = b[0] - a[0], tz = b[1] - a[1];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l; tz /= l;
      let nx = tz, nz = -tx;
      if (nx * p[0] + nz * (p[1] - zc) < 0) { nx = -nx; nz = -nz; }
      const w = 1.0 + 1.4 * Math.max(0, p[2] - 0.7) / 0.3;
      base[i * 4] = p[0]; base[i * 4 + 1] = p[1];
      base[i * 4 + 2] = p[0] + nx * w; base[i * 4 + 3] = p[1] + nz * w;
      col.set([1, 1, 1, 0.85, 1, 1, 1, 0], i * 8);
      if (i > 0) run += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
      uv.set([0, run * 0.25, 1, run * 0.25], i * 4);
    }
    const idx = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, a = i * 2, c = j * 2;
      idx.push(a, a + 1, c, a + 1, c + 1, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, M.skirt);
    m.frustumCulled = false;
    m.renderOrder = 1;
    m.visible = false;
    return { mesh: m, base, n };
  }
  function updateSkirt(x, z, h, y0, alpha) {
    const S = shipM.skirt, m = S.mesh;
    m.visible = alpha > 0.01;
    if (!m.visible) return;
    m.position.set(x, y0, z);
    m.rotation.y = h;
    M.skirt.opacity = alpha;
    const ch = Math.cos(h), sh = Math.sin(h);
    const P = m.geometry.attributes.position.array, B = S.base;
    for (let i = 0; i < S.n * 2; i++) {
      const lx = B[i * 2], lz = B[i * 2 + 1];
      const wx = x + lx * ch + lz * sh, wz = z - lx * sh + lz * ch;
      P[i * 3] = lx; P[i * 3 + 1] = waveH(wx, wz) + 0.07 - y0; P[i * 3 + 2] = lz;
    }
    m.geometry.attributes.position.needsUpdate = true;
  }

  function drawBar(frac) {
    const S = shipM;
    if (!S || Math.abs(S.barFrac - frac) < 0.001) return;
    S.barFrac = frac;
    const x = S.barCanvas.getContext('2d');
    x.clearRect(0, 0, 256, 48);
    x.fillStyle = 'rgba(6,20,25,0.78)';
    roundRect(x, 4, 8, 248, 32, 12); x.fill();
    x.fillStyle = 'rgba(255,255,255,0.08)';
    roundRect(x, 10, 14, 236, 20, 8); x.fill();
    if (frac > 0) {
      const g = x.createLinearGradient(0, 0, 256, 0);
      g.addColorStop(0, '#e8643c');
      g.addColorStop(1, '#d9a441');
      x.fillStyle = g;
      roundRect(x, 10, 14, Math.max(16, 236 * frac), 20, 8); x.fill();
    }
    x.strokeStyle = 'rgba(230,207,159,0.65)';
    x.lineWidth = 2;
    x.setLineDash([6, 4]);
    roundRect(x, 4, 8, 248, 32, 12); x.stroke();
    x.setLineDash([]);
    S.barTex.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // Rowboat model
  // ---------------------------------------------------------------------------
  const BOAT = {
    n: 10, z0: -1.9, len: 3.8,
    w(t) {
      if (t < 0.5) return G.lerp(0.5, 0.78, smooth01(t / 0.5));
      const u = (t - 0.5) / 0.5;
      return Math.max(0.04, 0.78 * Math.sqrt(Math.max(0, 1 - u * u)));
    },
    top(t) { return 0.52 + (t > 0.7 ? 0.2 * Math.pow((t - 0.7) / 0.3, 1.5) : 0) + (t < 0.1 ? 0.06 * (1 - t / 0.1) : 0); },
    depth() { return 0.3; },
  };
  BOAT.prof = [[0.92, (top) => top], [0.95, (top) => top - 0.07], [1.0, () => 0.26], [0.8, () => -0.1], [0.42, (t, d) => -0.8 * d], [0, (t, d) => -d]];
  BOAT.colors = [0x5a3a22, 0x8a6444, 0x7c5a3c, 0x4a3a2c, 0x3a2c22];
  BOAT.transom = 0x6e4f33;
  const BOAT_SEATS = [[0, 0.3, 0.72], [0, 0.3, -0.1], [0, 0.3, -0.95], [0, 0.3, 1.32]];
  let boatM = null;

  function buildBoat() {
    const Mg = new Merger();
    loft(Mg, BOAT);
    deckStrip(Mg, BOAT, 0.02, 0.9, 8, 0.02, 0.78, 0x6e4f33, 0x664830);
    for (const s of BOAT_SEATS) {
      const w = BOAT.w((s[2] - BOAT.z0) / BOAT.len) * 1.8;
      box(Mg, w, 0.05, 0.24, 0, 0.3, s[2], 0x9a7450);
    }
    for (const sg of [1, -1]) box(Mg, 0.06, 0.08, 0.06, sg * 0.74, 0.58, 0.05, 0x2b2d31);
    const hull = new THREE.Mesh(Mg.geometry(false), M.vc);
    hull.castShadow = true;
    hull.receiveShadow = true;
    const root = new THREE.Group();
    root.name = 'pirate-rowboat';
    root.rotation.order = 'YXZ';
    root.add(hull);
    const oars = [];
    for (const sg of [1, -1]) {
      const Mo = new Merger();
      cyl(Mo, 0.028, 0.028, 2.5, 5, 0.5, 0, 0, 0x9a7450, 0, 0, HALF_PI);
      box(Mo, 0.55, 0.025, 0.15, 1.72, 0, 0, 0x8a6444);
      const oar = new THREE.Mesh(Mo.geometry(false), M.wood);
      oar.castShadow = true;
      const pivot = new THREE.Group();
      pivot.position.set(sg * 0.74, 0.6, 0.05);
      if (sg < 0) pivot.scale.x = -1;
      pivot.add(oar);
      root.add(pivot);
      oars.push(pivot);
    }
    root.visible = false;
    return { root, oars };
  }

  // ---------------------------------------------------------------------------
  // The player's cannon (structure 'cannon')
  // ---------------------------------------------------------------------------
  function buildCannonGeos() {
    // turntable base
    const Mb = new Merger();
    cyl(Mb, 0.62, 0.66, 0.08, 12, 0, 0.04, 0, 0x7a5638);
    Mb.add(new THREE.TorusGeometry(0.64, 0.025, 4, 16), mat(0, 0.08, 0, HALF_PI, 0, 0), 0x2b2d31);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      box(Mb, 0.05, 0.03, 0.05, Math.cos(a) * 0.5, 0.09, Math.sin(a) * 0.5, 0x2b2d31);
    }
    GEO.cBase = Mb.geometry(false);
    // carriage: stepped cheeks, axles, transom, trucks
    const Mc = new Merger();
    const sh = new THREE.Shape();
    const pts = [[-0.55, 0.1], [0.45, 0.1], [0.45, 0.55], [0.2, 0.55], [0.2, 0.46], [-0.05, 0.46], [-0.05, 0.36], [-0.3, 0.36], [-0.3, 0.26], [-0.55, 0.26]];
    sh.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]);
    sh.closePath();
    for (const sg of [1, -1]) {
      const g = new THREE.ExtrudeGeometry(sh, { depth: 0.09, bevelEnabled: false });
      g.rotateY(-HALF_PI);
      Mc.add(g, mat(sg * 0.2 + 0.045, 0, 0), 0x8b5a2b);
      box(Mc, 0.1, 0.05, 0.14, sg * 0.2, 0.56, TRUNNION_Z, 0x2b2d31);
    }
    box(Mc, 0.34, 0.14, 0.12, 0, 0.2, -0.47, 0x6e4526);
    box(Mc, 0.34, 0.08, 0.3, 0, 0.14, 0.2, 0x6e4526);
    for (const az of [0.3, -0.4]) {
      box(Mc, 0.66, 0.07, 0.07, 0, 0.13, az, 0x5a3a22);
      for (const sg of [1, -1]) {
        cyl(Mc, 0.13, 0.13, 0.07, 10, sg * 0.3, 0.13, az, 0x5a3a22, 0, 0, HALF_PI);
        box(Mc, 0.08, 0.05, 0.05, sg * 0.34, 0.13, az, 0x2b2d31);
      }
    }
    // breeching rope loops
    for (const sg of [1, -1]) Mc.add(new THREE.TorusGeometry(0.06, 0.015, 4, 8), mat(sg * 0.26, 0.3, -0.5, 0, HALF_PI, 0), 0xc9a36b);
    GEO.cCarriage = Mc.geometry(false);
    // barrel (lathe along +Z, trunnion at the origin)
    const Mr = new Merger();
    const prof = [[0.0, -0.74], [0.055, -0.74], [0.065, -0.68], [0.035, -0.63], [0.035, -0.6], [0.12, -0.58], [0.17, -0.52],
      [0.175, -0.2], [0.19, -0.18], [0.19, -0.1], [0.168, -0.08], [0.15, 0.42], [0.162, 0.44], [0.162, 0.49], [0.145, 0.51],
      [0.125, 0.83], [0.15, 0.87], [0.157, 0.95], [0.085, 0.95], [0.085, 0.9]];
    const lathe = new THREE.LatheGeometry(prof.map((p) => new THREE.Vector2(p[0], p[1])), 12);
    lathe.rotateX(HALF_PI);
    Mr.add(lathe, new THREE.Matrix4(), 0x2e3136);
    for (const rz of [-0.14, 0.465]) Mr.add(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 12), mat(0, 0, rz, HALF_PI, 0, 0), 0xc9a13f);
    Mr.add(new THREE.CircleGeometry(0.084, 12), mat(0, 0, 0.9, 0, 0, 0), 0x050505);
    cyl(Mr, 0.055, 0.055, 0.46, 8, 0, 0, 0, 0x2e3136, 0, 0, HALF_PI);
    box(Mr, 0.05, 0.03, 0.05, 0, 0.185, -0.5, 0xc9a13f);
    GEO.cBarrel = Mr.geometry(false);
  }

  function createCannon(s) {
    const root = new THREE.Group();
    root.name = 'cannon';
    const base = new THREE.Mesh(GEO.cBase, M.wood);
    root.add(base);
    const yawG = new THREE.Group();
    root.add(yawG);
    const recoilG = new THREE.Group();
    yawG.add(recoilG);
    const carriage = new THREE.Mesh(GEO.cCarriage, M.wood);
    recoilG.add(carriage);
    const pitchG = new THREE.Group();
    pitchG.position.set(0, TRUNNION_Y, TRUNNION_Z);
    recoilG.add(pitchG);
    const barrel = new THREE.Mesh(GEO.cBarrel, M.metal);
    pitchG.add(barrel);
    const pile = [];
    const PILE = [[-0.78, 0.1, -0.52], [-0.78, 0.1, -0.32], [-0.78, 0.1, -0.12], [-0.78, 0.26, -0.42], [-0.78, 0.26, -0.22], [-0.78, 0.42, -0.32]];
    for (const p of PILE) {
      const ball = new THREE.Mesh(GEO.ball, M.ball);
      ball.position.set(p[0], p[1], p[2]);
      ball.scale.setScalar(0.54);
      ball.castShadow = true;
      root.add(ball);
      pile.push(ball);
    }
    const d = s.data || (s.data = {});
    if (!Number.isFinite(d.yaw)) d.yaw = 0;
    if (!Number.isFinite(d.pitch)) d.pitch = 12 * DEG;
    d.yaw = G.clamp(d.yaw, -YAW_LIMIT, YAW_LIMIT);
    d.pitch = G.clamp(d.pitch, PITCH_MIN, PITCH_MAX);
    s._cv = { yawG, recoilG, pitchG, pile, reload: 0, recoilT: 9, shownPile: -1 };
    yawG.rotation.y = d.yaw;
    pitchG.rotation.x = -d.pitch;
    for (const b of pile) b.visible = !s.ghost;
    return root;
  }

  function cannonUpdateVisual(s, dt) {
    const cv = s._cv;
    if (!cv) return;
    cv.yawG.rotation.y = s.data.yaw;
    cv.pitchG.rotation.x = -s.data.pitch;
    cv.recoilT += dt;
    const t = cv.recoilT;
    cv.recoilG.position.z = t < 0.06 ? -0.3 * (t / 0.06) : -0.3 * (1 - smooth01((t - 0.06) / 0.75));
    const n = Math.min(cv.pile.length, ammoCache);
    if (n !== cv.shownPile) {
      cv.shownPile = n;
      for (let i = 0; i < cv.pile.length; i++) cv.pile[i].visible = i < n;
    }
  }

  // World-space trunnion position and barrel direction of a cannon.
  function cannonFrame(s, outPos, outDir) {
    s.object.getWorldPosition(outPos);
    const A = s.rotation * HALF_PI + s.data.yaw, p = s.data.pitch;
    const sa = Math.sin(A), ca = Math.cos(A);
    const rz = TRUNNION_Z + (s._cv ? s._cv.recoilG.position.z : 0);
    outPos.x += sa * rz;
    outPos.z += ca * rz;
    outPos.y += TRUNNION_Y;
    outDir.set(sa * Math.cos(p), Math.sin(p), ca * Math.cos(p));
    return A;
  }

  // Sets the aim of cannon `s` so a ball lands on (x, y, z). Returns true if reachable.
  function aimCannonAt(s, x, y, z) {
    if (!s || !s.data) return false;
    let ok = true;
    for (let it = 0; it < 3; it++) {
      cannonFrame(s, _a, _d);
      _a.addScaledVector(_d, BARREL_LEN);
      const base = s.rotation * HALF_PI;
      const want = Math.atan2(x - _a.x, z - _a.z);
      const yaw = angDiff(base, want);
      s.data.yaw = G.clamp(yaw, -YAW_LIMIT, YAW_LIMIT);
      if (Math.abs(yaw) > YAW_LIMIT + 1e-3) ok = false;
      const D = Math.hypot(x - _a.x, z - _a.z), H = y - _a.y;
      const v2 = BALL_V * BALL_V, g = BALL_G;
      const disc = v2 * v2 - g * (g * D * D + 2 * H * v2);
      let pitch;
      if (disc < 0) { pitch = PITCH_MAX; ok = false; }
      else pitch = Math.atan2(v2 - Math.sqrt(disc), g * D);
      if (pitch > PITCH_MAX || pitch < PITCH_MIN) ok = false;
      s.data.pitch = G.clamp(pitch, PITCH_MIN, PITCH_MAX);
    }
    return ok;
  }

  // ---------------------------------------------------------------------------
  // Cannonballs, target warning rings, trajectory preview
  // ---------------------------------------------------------------------------
  const balls = [];
  const ballPool = [];
  const rings = [];
  let preview = null, aimRing = null, aimMark = null;
  let ammoCache = 0;

  function getBall() {
    let b = ballPool.pop();
    if (!b) {
      const mesh = new THREE.Mesh(GEO.ball, M.ball);
      mesh.castShadow = true;
      b = { mesh, pos: new THREE.Vector3(), vel: new THREE.Vector3(), target: new THREE.Vector3() };
    }
    b.t = 0; b.T = 0; b.trailT = 0; b.whoosh = false; b.tile = null; b.hit = false; b.ring = null; b.owner = '';
    G.scene.add(b.mesh);
    b.mesh.visible = true;
    balls.push(b);
    return b;
  }
  function freeBall(i) {
    const b = balls[i];
    balls.splice(i, 1);
    if (b.ring) { freeRing(b.ring); b.ring = null; }
    if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
    ballPool.push(b);
  }
  function getRing(onRaft, x, z, T) {
    let r = null;
    for (const it of rings) if (!it.active) { r = it; break; }
    if (!r) {
      const m = new THREE.Mesh(GEO.ring, new THREE.MeshBasicMaterial({ color: 0xff4a2a, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide }));
      m.renderOrder = 3;
      r = { mesh: m, active: false };
      rings.push(r);
    }
    r.active = true; r.onRaft = onRaft; r.x = x; r.z = z; r.t = 0; r.T = T;
    r.mesh.visible = true;
    if (!r.mesh.parent) G.scene.add(r.mesh);
    return r;
  }
  function freeRing(r) { r.active = false; r.mesh.visible = false; if (r.mesh.parent) r.mesh.parent.remove(r.mesh); }
  function updateRings(dt) {
    for (const r of rings) {
      if (!r.active) continue;
      r.t += dt;
      const k = G.clamp(r.t / Math.max(0.1, r.T), 0, 1);
      const y = r.onRaft && raftHeight(r.x, r.z) !== null ? deckY() + 0.04 : waveH(r.x, r.z) + 0.07;
      r.mesh.position.set(r.x, y, r.z);
      const pulse = 0.5 + 0.5 * Math.sin(r.t * (6 + 14 * k));
      r.mesh.scale.setScalar(G.lerp(2.1, 1.0, k) * (1 + 0.08 * pulse));
      r.mesh.material.opacity = 0.35 + 0.5 * pulse * (0.4 + 0.6 * k);
    }
  }

  // Ballistic path from p0 with velocity v0; fills the preview dots, returns _sim.
  function simulate(p0, v0, dots) {
    const dtS = 0.05, maxSteps = 150;
    let x = p0.x, y = p0.y, z = p0.z, vx = v0.x, vy = v0.y, vz = v0.z;
    let n = 0;
    _sim.hit = '';
    const arr = dots ? dots.array : null;
    const cap = arr ? arr.length / 3 : 0;
    for (let i = 1; i <= maxSteps; i++) {
      vy -= BALL_G * dtS;
      x += vx * dtS; y += vy * dtS; z += vz * dtS;
      if (arr && (i < 24 || i % 2 === 0) && n < cap) { arr[n * 3] = x; arr[n * 3 + 1] = y; arr[n * 3 + 2] = z; n++; }
      if (ship && ship.hp > 0 && shipHitTest(x, y, z)) { _sim.hit = 'ship'; break; }
      if (y <= waveH(x, z)) { _sim.hit = 'water'; break; }
    }
    _sim.n = n; _sim.x = x; _sim.y = y; _sim.z = z;
    return _sim;
  }

  function launchBall(owner, from, vel) {
    const b = getBall();
    b.owner = owner;
    b.pos.copy(from);
    b.vel.copy(vel);
    b.mesh.position.copy(from);
    return b;
  }

  function updateBalls(dt) {
    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i];
      b.t += dt;
      b.vel.y -= BALL_G * dt;
      b.pos.addScaledVector(b.vel, dt);
      b.mesh.position.copy(b.pos);
      b.mesh.rotation.x += dt * 9;
      b.trailT -= dt;
      if (b.trailT <= 0) { b.trailT = 0.055; fx('smoke', b.pos, 0.32); }
      if (b.owner === 'ship') {
        if (!b.whoosh && b.T - b.t < 0.75) { b.whoosh = true; snd('whoosh', b.target, 0.7); }
        if (b.hit && b.t >= b.T) { impactShipBall(b); freeBall(i); continue; }
        if (!b.hit && b.pos.y <= waveH(b.pos.x, b.pos.z)) { splashAt(b.pos, 1.8); nearbyBlast(b.pos); freeBall(i); continue; }
        if (b.t > b.T + 4) { freeBall(i); continue; }
      } else {
        if (ship && ship.hp > 0 && shipHitTest(b.pos.x, b.pos.y, b.pos.z)) { hitShip(b.pos, BALL_SHIP_DMG, 'cannon'); freeBall(i); continue; }
        if (boat && boat.active && boat.state === 'row' && boatHitTest(b.pos)) { hitBoat(b.pos); freeBall(i); continue; }
        if (hitBoarderWithBall(b)) { freeBall(i); continue; }
        const rh = raftHeight(b.pos.x, b.pos.z);
        if (rh !== null && b.pos.y <= rh + 0.05 && b.vel.y < 0) {
          fx('explosion', b.pos, 0.4);
          snd('explosion', b.pos, 0.6);
          freeBall(i);
          continue;
        }
        if (b.pos.y <= waveH(b.pos.x, b.pos.z)) { splashAt(b.pos, 1.6); freeBall(i); continue; }
        if (b.t > 9) { freeBall(i); continue; }
      }
    }
  }

  function splashAt(pos, scale) {
    _p.set(pos.x, waveH(pos.x, pos.z), pos.z);
    fx('splash', _p, scale);
    snd('splash_big', _p, 0.8);
  }

  // An enemy ball arriving on the raft.
  function impactShipBall(b) {
    const t = G.raft ? G.raft.tileAt(b.target.x, b.target.z) : null;
    _p.set(b.target.x, deckY() + 0.2, b.target.z);
    if (t) {
      G.raft.damageTile(t, tune.tileDmg, 'cannon');
      fx('explosion', _p, 1.0);
      fx('debris', _p, 0x8b6a45, 18);
      snd('explosion', _p, 1);
    } else {
      splashAt(_p, 1.8);
    }
    nearbyBlast(_p);
  }

  // Damage the player / boarders near an impact.
  const _blast = new THREE.Vector3();
  function nearbyBlast(pos0) {
    const pos = _blast.copy(pos0);
    const P = player();
    if (P && P.alive) {
      const dx = P.position.x - pos.x, dz = P.position.z - pos.z;
      const dy = P.position.y + 0.9 - pos.y;
      if (Math.hypot(dx, dz) < tune.ballR && Math.abs(dy) < 2.5) {
        _d.set(dx, 0, dz);
        if (_d.lengthSq() < 1e-4) _d.set(1, 0, 0);
        P.damage(tune.ballDmg, 'cannon', _d.normalize());
      }
    }
    for (const b of boarders) {
      if (b.state !== 'fight') continue;
      const dx = b.pos.x - pos.x, dz = b.pos.z - pos.z, d = Math.hypot(dx, dz);
      if (d < 2 && Math.abs(b.pos.y - pos.y) < 2) {
        _d.set(dx, 0, dz);
        if (_d.lengthSq() < 1e-4) _d.set(1, 0, 0);
        hurtBoarder(b, 30, _d.normalize(), 'cannon', 6);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // The ship
  // ---------------------------------------------------------------------------
  let ship = null;

  function shipHitTest(x, y, z) {
    const s = ship;
    if (!s) return false;
    const dx = x - s.position.x, dz = z - s.position.z;
    if (dx * dx + dz * dz > 400) return false;
    const h = s.heading, ch = Math.cos(h), sh = Math.sin(h);
    const lx = dx * ch - dz * sh, lz = dx * sh + dz * ch, ly = y - s.object.position.y;
    if (lz > SHIP.z0 - 0.4 && lz < SHIP.z0 + SHIP.len + 0.2) {
      const t = G.clamp(tAtZ(lz), 0, 1);
      let top = SHIP.top(t);
      if (t < AFT_T + 0.01) top = AFT_TOP + 0.5;
      else if (t > FORE_T0 && t < FORE_T1) top = Math.max(top, FORE_TOP);
      if (ly > -1.3 && ly < top + 0.15 && Math.abs(lx) < SHIP.w(t) + 0.25) return true;
    }
    for (let i = 0; i < SAILS.length; i++) {
      const sl = SAILS[i], m = MASTS[sl.m];
      if (ly < sl.yb || ly > sl.yt) continue;
      if (Math.abs(lz - (m.z + 0.3 + sl.bl * 0.5)) > 0.9) continue;
      if (Math.abs(lx) < Math.max(sl.wt, sl.wb) * 0.5) return true;
    }
    for (let i = 0; i < MASTS.length; i++) {
      const m = MASTS[i];
      if (Math.abs(lz - m.z) < 0.5 && Math.abs(lx) < 0.5 && ly > m.base && ly < m.top) return true;
    }
    return false;
  }

  function makeShipTarget() {
    return {
      kind: 'pirate_ship',
      radius: SHIP_RADIUS,
      getPosition(out) {
        if (!ship) return out.set(0, -100, 0);
        return out.set(ship.position.x, ship.object.position.y + 2.2, ship.position.z);
      },
      alive() { return !!ship && ship.hp > 0 && ship.state !== 'sinking'; },
      onHit(damage, dir, source) {
        if (!ship || ship.hp <= 0) return;
        _t.set(ship.position.x + G.rand(-2, 2), ship.object.position.y + G.rand(1, 2.5), ship.position.z + G.rand(-2, 2));
        hitShip(_t, Number(damage) || 0, source || 'hit');
      },
    };
  }

  function circleRadius(s) {
    const base = G.clamp(s.radius + 4 * Math.sin(s.radiusPhase), CIRCLE_MIN, CIRCLE_MAX);
    return Math.max(base, raftRadius() + 24);
  }

  function spawnShip(opts) {
    const w = G.world && G.world.windDir;
    let wx = w ? w.x : 1, wz = w ? w.z : 0;
    const wl = Math.hypot(wx, wz) || 1;
    wx /= wl; wz /= wl;
    const side = G.chance(0.5) ? 1 : -1;
    const dist = opts.dist || SPAWN_DIST;
    const lat = G.rand(25, 55) * side;
    const x = wx * dist - wz * lat, z = wz * dist + wx * lat;
    const s = {
      object: shipM.root,
      position: new THREE.Vector3(x, 0, z),
      heading: Math.atan2(-x, -z),
      speed: SPEED_APPROACH * 0.8,
      hp: tune.shipHp, maxHp: tune.shipHp,
      state: 'approach',
      combatTime: 0, fireT: 3, boatLaunched: false, leaveAt: -1,
      circleDir: G.chance(0.5) ? 1 : -1,
      radius: G.rand(CIRCLE_MIN + 3, CIRCLE_MAX - 3), radiusPhase: Math.random() * TAU,
      sinkT: 0, lootDone: false, boomT: 0, fireFxT: 0, listSide: 1,
      bob: 0, pitch: 0, roll: 0, kick: 0, kickV: 0, heel: 0, turn: 0,
      spots: [], spotT: 0, rippleT: 0, target: null, frozen: false, bigSplash: false,
    };
    s.target = G.combat.add(makeShipTarget());
    const S = shipM;
    S.root.visible = true;
    S.root.position.set(x, 0, z);
    S.root.rotation.set(0, s.heading, 0);
    S.root.scale.setScalar(1);
    S.sails.visible = true;
    S.flag.visible = true;
    S.barFrac = -1;
    drawBar(1);
    if (!S.bar.parent) G.scene.add(S.bar);
    S.bar.visible = false;
    wakeReset(x - Math.sin(s.heading) * 9, z - Math.cos(s.heading) * 9);
    return s;
  }

  function startCombat() {
    const s = ship;
    s.state = 'circle';
    s.combatTime = 0;
    s.fireT = 2.5;
    G.notify('Pirátská loď útočí! Uhýbej z červených kruhů – tam dopadne koule.', 'warn');
    const cannons = G.raft ? G.raft.findStructures('cannon') : [];
    if (cannons.length) {
      if (ammo() > 0) G.notify('Sedni ke kanónu (E) a střílej na loď!', 'info');
      else G.notify('Máš kanón, ale žádné koule. Vyrob je z kovu!', 'warn');
    } else {
      G.notify('Tip: Postav kanón a vyrob dělové koule.', 'info');
    }
  }

  function steerShip(dt) {
    const s = ship;
    const px = s.position.x, pz = s.position.z;
    const dist = Math.hypot(px, pz) || 0.001;
    let tx = px, tz = pz, spd = 0;
    if (s.state === 'approach' || s.state === 'circle') {
      s.radiusPhase += dt * 0.05;
      const R = circleRadius(s);
      const ang = Math.atan2(pz, px) + s.circleDir * (s.state === 'approach' ? 0.5 : 0.32);
      tx = Math.cos(ang) * R;
      tz = Math.sin(ang) * R;
      if (s.state === 'approach') {
        spd = dist > R + 30 ? SPEED_APPROACH : G.lerp(SPEED_CIRCLE, SPEED_APPROACH, G.clamp((dist - R) / 30, 0, 1));
        if (Math.abs(dist - R) < 6) startCombat();
      } else spd = SPEED_CIRCLE;
    } else if (s.state === 'leave') {
      tx = px + (px / dist) * 60 + s.circleDir * (-pz / dist) * 20;
      tz = pz + (pz / dist) * 60 + s.circleDir * (px / dist) * 20;
      spd = SPEED_LEAVE;
    }
    if (s.frozen) spd = 0;
    let turn = 0;
    if (s.state !== 'sinking') {
      let dx = tx - px, dz = tz - pz;
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl; dz /= dl;
      islandPush(px, pz, _push);
      dx += _push.x * 3; dz += _push.z * 3;
      const minR = raftRadius() + 18;
      if (dist < minR) { const k = (minR - dist) / minR * 4; dx += (px / dist) * k; dz += (pz / dist) * k; }
      const want = Math.atan2(dx, dz);
      const dh = angDiff(s.heading, want);
      const maxTurn = TURN_RATE * dt * (s.frozen ? 0 : 1);
      turn = G.clamp(dh, -maxTurn, maxTurn);
      s.heading = wrapAngle(s.heading + turn);
      s.speed = G.damp(s.speed, spd, 0.5, dt);
    } else {
      s.speed = G.damp(s.speed, 0, 0.6, dt);
    }
    s.turn = dt > 0 ? turn / dt : 0;
    s.position.x += Math.sin(s.heading) * s.speed * dt;
    s.position.z += Math.cos(s.heading) * s.speed * dt;
  }

  function poseShip(dt) {
    const s = ship, S = shipM;
    const h = s.heading, fx_ = Math.sin(h), fz = Math.cos(h), rx = Math.cos(h), rz = -Math.sin(h);
    const x = s.position.x, z = s.position.z;
    const hb = waveH(x + fx_ * 7, z + fz * 7), hs = waveH(x - fx_ * 7, z - fz * 7);
    const hp = waveH(x - rx * 2.6, z - rz * 2.6), hst = waveH(x + rx * 2.6, z + rz * 2.6);
    const yT = (hb + hs + hp + hst) * 0.25 * 0.85;
    const pitchT = Math.atan2(hs - hb, 14) * 0.8;
    const rollT = Math.atan2(hst - hp, 5.2) * 0.7;
    s.bob = G.damp(s.bob, yT, 2.2, dt);
    s.pitch = G.damp(s.pitch, pitchT, 2, dt);
    s.roll = G.damp(s.roll, rollT, 2, dt);
    s.heel = G.damp(s.heel, -s.turn * s.speed * 0.25, 1.5, dt);
    s.kickV += (-s.kick * 16 - s.kickV * 3.2) * dt;
    s.kick += s.kickV * dt;
    let sinkY = 0, list = 0, tilt = 0;
    if (s.state === 'sinking') {
      const k = s.sinkT / SINK_TIME;
      // burns & lists for a few seconds, then goes down stern first
      sinkY = -0.9 * smooth01(k / 0.4) - Math.pow(Math.max(0, k - 0.4), 1.5) * 27;
      list = s.listSide * 0.45 * smooth01(k * 1.6);
      tilt = -0.32 * smooth01((k - 0.2) * 1.4);
    }
    S.root.position.set(x, s.bob + sinkY, z);
    S.root.rotation.set(s.pitch + tilt, h, s.roll + s.kick + s.heel + list);
    updateSkirt(x, z, h, s.bob, s.state === 'sinking' ? Math.max(0, 1 - s.sinkT / (SINK_TIME * 0.7)) : 1);
  }

  function animateShipDetails(dt, time) {
    const S = shipM, s = ship;
    // flag
    const camD = G.camera ? G.camera.position.distanceTo(S.root.position) : 0;
    if (camD < 160) {
      const pa = S.flag.geometry.attributes.position, arr = pa.array, base = S.flagBase;
      for (let i = 0; i < arr.length; i += 3) {
        const zz = base[i + 2], k = zz / 1.9;
        arr[i] = base[i] + Math.sin(zz * 3.3 - time * 7.5) * 0.16 * k;
        arr[i + 1] = base[i + 1] - k * 0.12 + Math.sin(zz * 2.1 - time * 5.2) * 0.04 * k;
      }
      pa.needsUpdate = true;
    }
    // lanterns & stern windows
    const n = nightK();
    const flick = 0.85 + 0.15 * Math.sin(time * 13.1) * Math.sin(time * 7.3 + 1);
    _c.setRGB(0.35 + 0.65 * n * flick, 0.26 + 0.52 * n * flick, 0.12 + 0.22 * n);
    M.glass.color.copy(_c);
    M.glow.opacity = n * 0.85 * flick * (s.state === 'sinking' ? Math.max(0, 1 - s.sinkT / 4) : 1);
    // health bar
    const bar = S.bar;
    const show = s.hp > 0 && s.state !== 'sinking' && s.state !== 'leave' && Math.hypot(s.position.x, s.position.z) < 120;
    bar.visible = show;
    if (show) {
      bar.position.set(s.position.x, S.root.position.y + MASTS[1].top + 2.6, s.position.z);
      drawBar(s.hp / s.maxHp);
    }
  }

  function shipFire(forceHit) {
    const s = ship;
    if (!s || !G.raft) return false;
    const obj = s.object;
    obj.updateMatrixWorld(true);
    const h = s.heading;
    const dx = -s.position.x, dz = -s.position.z;
    const lx = dx * Math.cos(h) - dz * Math.sin(h);
    const side = lx >= 0 ? 0 : 1;
    const lm = G.pick(shipM.muzzles[side]);
    _muz.copy(lm).applyMatrix4(obj.matrixWorld);
    const tile = G.raft.randomTile();
    if (!tile) return false;
    const hit = forceHit === true ? true : forceHit === false ? false : !G.chance(tune.miss);
    let tx, ty, tz, onRaft = false;
    if (hit) {
      G.raft.tileCenter(tile, _t);
      tx = _t.x + G.rand(-0.45, 0.45); tz = _t.z + G.rand(-0.45, 0.45); ty = deckY();
      onRaft = true;
    } else {
      const a = Math.atan2(_muz.z, _muz.x) + G.rand(-0.9, 0.9), r = raftRadius() + G.rand(2.5, 7);
      tx = Math.cos(a) * r; tz = Math.sin(a) * r; ty = 0;
    }
    const dist = Math.hypot(tx - _muz.x, tz - _muz.z);
    const T = 2.1 + dist * 0.012;
    _v.set((tx - _muz.x) / T, (ty - _muz.y + 0.5 * BALL_G * T * T) / T, (tz - _muz.z) / T);
    const b = launchBall('ship', _muz, _v);
    b.T = T;
    b.hit = hit;
    b.tile = hit ? tile : null;
    b.target.set(tx, ty, tz);
    b.ring = getRing(onRaft, tx, tz, T);
    const P = player();
    if (!ringTipShown && P && P.alive && Math.hypot(P.position.x - tx, P.position.z - tz) < 3) {
      ringTipShown = true;
      banner('Uhni z červeného kruhu!', 'warn', 3);
    }
    // muzzle flash & smoke
    _d.copy(_v).normalize();
    _p.copy(_muz).addScaledVector(_d, 0.4);
    fx('explosion', _p, 0.4);
    for (let i = 0; i < 3; i++) { _p.addScaledVector(_d, 0.5); fx('smoke', _p, 2.2 - i * 0.4); }
    snd('cannon', _muz, 1);
    if (G.chance(0.3)) snd('pirate_yell', s.position, 0.5);
    s.kickV += (side === 0 ? -1 : 1) * 0.1;
    return true;
  }

  function hitShip(pos, dmg, source) {
    const s = ship;
    if (!s || s.hp <= 0 || s.state === 'sinking') return;
    s.hp = Math.max(0, s.hp - dmg);
    fx('explosion', pos, 1.15);
    fx('debris', pos, 0x3a2a1c, 22);
    fx('debris', pos, 0x8a6a45, 10);
    snd('explosion', pos, 1);
    snd('break_wood', pos, 0.8);
    // heel away from the impact, remember a smoking hole
    const h = s.heading, dx = pos.x - s.position.x, dz = pos.z - s.position.z;
    const lx = dx * Math.cos(h) - dz * Math.sin(h), lz = dx * Math.sin(h) + dz * Math.cos(h);
    s.kickV += (lx >= 0 ? -1 : 1) * 0.35;
    s.listSide = lx >= 0 ? 1 : -1;
    if (s.spots.length < 5) s.spots.push(new THREE.Vector3(G.clamp(lx, -2.4, 2.4), G.clamp(pos.y - s.object.position.y, 0.5, 4), G.clamp(lz, -8, 8)));
    drawBar(s.hp / s.maxHp);
    if (s.hp <= 0) { startSinking(); return; }
    const pct = Math.round((s.hp / s.maxHp) * 100);
    G.notify('Zásah! Loď má ještě ' + pct + ' %.', 'good');
    if (source === 'cannon' && G.chance(0.6)) snd('pirate_yell', s.position, 0.6);
  }

  function startSinking() {
    const s = ship;
    s.state = 'sinking';
    s.sinkT = 0;
    s.boomT = 0.4;
    if (s.target) { G.combat.remove(s.target); s.target = null; }
    shipM.bar.visible = false;
    _p.set(s.position.x, s.object.position.y + 2, s.position.z);
    fx('explosion', _p, 2.4);
    snd('explosion', _p, 1);
    snd('pirate_yell', _p, 0.9);
    G.stats.piratesSunk = (G.stats.piratesSunk || 0) + 1;
    G.events.emit('pirates:sunk', { x: s.position.x, z: s.position.z });
    G.notify('Pirátská loď jde ke dnu!', 'good');
    banner('Pirátská loď potopena!', 'good', 3.5);
    for (const b of boarders) if (b.state === 'fight' && G.chance(0.6)) say(b, G.pick(LINES.sunk), 2.2);
    // floating wreckage
    const D = G.debris;
    if (D && typeof D.spawn === 'function') {
      for (let i = 0; i < 3; i++) {
        _p.set(s.position.x + G.rand(-4, 4), 0, s.position.z + G.rand(-4, 4));
        try { D.spawn('prkno', _p); } catch (err) { /* ignore */ }
      }
    }
  }

  function spawnLoot() {
    const s = ship;
    s.lootDone = true;
    const D = G.debris;
    if (!D || typeof D.spawnItem !== 'function') return;
    const bonus = Math.min(3, tune.sunk);
    const list = [['kov', G.randInt(3, 6) + bonus], ['koule', G.randInt(3, 5)], ['zlato', G.randInt(10, 30)], ['prkno', G.randInt(5, 10)]];
    if (G.chance(0.6)) list.push(['kelimek_sladky', G.randInt(1, 2)]);
    if (G.chance(0.5)) list.push([G.pick(['provaz', 'plast']), G.randInt(3, 6)]);
    // The waves bring the treasure to you: the bundles surface upstream of the raft (wherever the
    // ship went down), so they drift past within hook reach.
    const w = G.world && G.world.windDir;
    let wx = w ? w.x : 1, wz = w ? w.z : 0;
    const wl = Math.hypot(wx, wz) || 1;
    wx /= wl; wz /= wl;
    const base = Math.max(14, raftRadius() + 6);
    for (let i = 0; i < list.length; i++) {
      const along = base + G.rand(0, 8), lat = G.rand(-6, 6);
      _p.set(wx * along - wz * lat, 0, wz * along + wx * lat);
      try { D.spawnItem(list[i][0], list[i][1], _p); } catch (err) { /* ignore */ }
    }
    G.notify('Z vraku vyplavaly poklady! Vlny je nesou k tobě – chyť je hákem.', 'good');
  }

  function updateSinking(dt) {
    const s = ship, S = shipM;
    s.sinkT += dt;
    const k = s.sinkT / SINK_TIME;
    S.root.updateMatrixWorld(true);
    s.boomT -= dt;
    if (s.boomT <= 0 && k < 0.75) {
      s.boomT = G.rand(0.45, 1.0);
      _p.set(G.rand(-2, 2), G.rand(1, 3.2), G.rand(-7, 7)).applyMatrix4(S.root.matrixWorld);
      fx('explosion', _p, G.rand(0.7, 1.3));
      snd('explosion', _p, 0.75);
      if (G.chance(0.5)) fx('debris', _p, 0x3a2a1c, 14);
    }
    s.fireFxT -= dt;
    if (s.fireFxT <= 0) {
      s.fireFxT = 0.06;
      for (let i = 0; i < SINK_FIRES.length; i++) {
        _p.fromArray(SINK_FIRES[i]).applyMatrix4(S.root.matrixWorld);
        if (_p.y < waveH(_p.x, _p.z) + 0.2) continue;
        fx('fire', _p, 3);
        if (Math.random() < 0.3) fx('smoke', _p, 3.5);
      }
    }
    if (k > 0.45 && Math.random() < dt * 6) {
      _p.set(s.position.x + G.rand(-5, 5), waveH(s.position.x, s.position.z) + 0.1, s.position.z + G.rand(-5, 5));
      fx('bubbles', _p, 10);
      if (Math.random() < 0.4) fx('splash', _p, 1.2);
    }
    if (!s.lootDone && s.sinkT > 2.6) spawnLoot();
    if (!s.bigSplash && k > 0.62) {
      s.bigSplash = true;
      _p.set(s.position.x, 0, s.position.z);
      fx('splash', _p, 4);
      snd('splash_big', _p, 1);
    }
    if (s.sinkT > SINK_TIME + 1) removeShip();
  }
  const SINK_FIRES = [[0.4, 2.3, -2.5], [-0.8, 2.4, 1.8], [0.2, AFT_DECK + 0.3, -6.3], [0, FORE_DECK + 0.2, 5.8], [0.6, 7.5, 0.9]];

  function removeShip() {
    if (!ship) return;
    if (ship.target) G.combat.remove(ship.target);
    ship.target = null;
    shipM.root.visible = false;
    shipM.bar.visible = false;
    shipM.skirt.mesh.visible = false;
    wake.mesh.visible = false;
    ship = null;
    API.ship = null;
  }

  function updateShip(dt) {
    const s = ship;
    if (!s) return;
    const time = G.time;
    steerShip(dt);
    poseShip(dt);
    if (s.state === 'circle') {
      s.combatTime += dt;
      s.fireT -= dt;
      if (s.fireT <= 0) {
        const h = s.heading, dx = -s.position.x, dz = -s.position.z;
        const lx = dx * Math.cos(h) - dz * Math.sin(h), lz = dx * Math.sin(h) + dz * Math.cos(h);
        if (Math.abs(lx) > Math.abs(lz) * 0.7) { shipFire(); s.fireT = G.rand(tune.fireMin, tune.fireMax); }
        else s.fireT = 1;
      }
      if (!s.boatLaunched && s.combatTime >= BOAT_DELAY) { s.boatLaunched = true; launchBoat(); }
      const crewGone = s.boatLaunched && boardersRemaining() === 0;
      if (crewGone && s.leaveAt < 0) {
        s.leaveAt = s.combatTime + LEAVE_AFTER_CREW;
        G.notify('Všichni piráti jsou pryč! Loď brzy odpluje – vydrž.', 'good');
      }
      if ((s.leaveAt >= 0 && s.combatTime >= s.leaveAt) || (s.combatTime >= LEAVE_AFTER && boardersRemaining() === 0)) {
        s.state = 'leave';
        G.notify('Piráti to vzdávají a odplouvají!', 'info');
      }
    } else if (s.state === 'leave') {
      if (Math.hypot(s.position.x, s.position.z) > SPAWN_DIST + 20) {
        removeShip();
        G.events.emit('pirates:left');
        G.notify('Piráti odpluli.', 'info');
        return;
      }
    } else if (s.state === 'sinking') {
      updateSinking(dt);
      if (!ship) return;
    }
    // smoking damage holes
    if (s.spots.length && s.state !== 'sinking') {
      s.spotT -= dt;
      if (s.spotT <= 0) {
        s.spotT = 0.28;
        shipM.root.updateMatrixWorld(true);
        for (let i = 0; i < s.spots.length; i++) {
          _p.copy(s.spots[i]).applyMatrix4(shipM.root.matrixWorld);
          fx('smoke', _p, 1.6);
          if (s.hp < s.maxHp * 0.5 && i < 2) fx('fire', _p, 1.2);
        }
      }
    }
    // bow ripples
    if (s.speed > 2 && s.state !== 'sinking') {
      s.rippleT -= dt;
      if (s.rippleT <= 0) {
        s.rippleT = 0.3;
        _p.set(s.position.x + Math.sin(s.heading) * 8.6, 0, s.position.z + Math.cos(s.heading) * 8.6);
        _p.y = waveH(_p.x, _p.z) + 0.05;
        fx('ripple', _p, 1.6);
      }
    }
    updateWake(dt);
    animateShipDetails(dt, time);
  }

  // ---------------------------------------------------------------------------
  // Wake: a foam ribbon trailing the ship (world-space, drifts with the water)
  // ---------------------------------------------------------------------------
  const WAKE_N = 28, WAKE_LIFE = 11, WAKE_EVERY = 0.4;
  const wake = { mesh: null, x: new Float32Array(WAKE_N), z: new Float32Array(WAKE_N), age: new Float32Array(WAKE_N), str: new Float32Array(WAKE_N), count: 0, emitT: 0 };

  function buildWake() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(WAKE_N * 2 * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(WAKE_N * 2 * 4), 4));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(WAKE_N * 2 * 2), 2));
    const idx = [];
    for (let i = 0; i < WAKE_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(idx);
    g.attributes.position.setUsage(THREE.DynamicDrawUsage);
    g.attributes.color.setUsage(THREE.DynamicDrawUsage);
    g.attributes.uv.setUsage(THREE.DynamicDrawUsage);
    const m = new THREE.Mesh(g, M.wake);
    m.frustumCulled = false;
    m.renderOrder = 1;
    m.visible = false;
    wake.mesh = m;
  }
  function wakeReset(x, z) {
    wake.count = 1;
    wake.x[0] = x; wake.z[0] = z; wake.age[0] = 0; wake.str[0] = 0;
    wake.emitT = 0;
    if (wake.mesh) { wake.mesh.visible = true; wake.mesh.geometry.setDrawRange(0, 0); }
  }
  function updateWake(dt) {
    const s = ship;
    if (!wake.mesh || !s) return;
    const v = G.raft && G.raft.velocity;
    const vx = v ? v.x : 0, vz = v ? v.z : 0;
    for (let i = 0; i < wake.count; i++) { wake.x[i] -= vx * dt; wake.z[i] -= vz * dt; wake.age[i] += dt; }
    const sx = s.position.x - Math.sin(s.heading) * 8.8, sz = s.position.z - Math.cos(s.heading) * 8.8;
    const strength = s.state === 'sinking' ? 0 : G.clamp(s.speed / 4, 0.2, 1);
    wake.emitT += dt;
    if (wake.emitT >= WAKE_EVERY) {
      wake.emitT = 0;
      const n = Math.min(WAKE_N, wake.count + 1);
      for (let i = n - 1; i > 0; i--) { wake.x[i] = wake.x[i - 1]; wake.z[i] = wake.z[i - 1]; wake.age[i] = wake.age[i - 1]; wake.str[i] = wake.str[i - 1]; }
      wake.count = n;
      wake.age[0] = 0;
    }
    wake.x[0] = sx; wake.z[0] = sz; wake.str[0] = strength;
    while (wake.count > 1 && wake.age[wake.count - 1] > WAKE_LIFE) wake.count--;
    const g = wake.mesh.geometry;
    const P = g.attributes.position.array, Cc = g.attributes.color.array, U = g.attributes.uv.array;
    for (let i = 0; i < wake.count; i++) {
      const j = i < wake.count - 1 ? i + 1 : Math.max(0, i - 1);
      let dx = wake.x[i] - wake.x[j], dz = wake.z[i] - wake.z[j];
      if (i === wake.count - 1) { dx = -dx; dz = -dz; }
      const dl = Math.hypot(dx, dz) || 1;
      const nx = -dz / dl, nz = dx / dl;
      const age = wake.age[i], w = 1.4 + age * 0.75;
      const y = waveH(wake.x[i], wake.z[i]) + 0.09;
      const a = wake.str[i] * (1 - age / WAKE_LIFE) * (i === 0 ? 0 : 0.75);
      const o = i * 6;
      P[o] = wake.x[i] + nx * w; P[o + 1] = y; P[o + 2] = wake.z[i] + nz * w;
      P[o + 3] = wake.x[i] - nx * w; P[o + 4] = y; P[o + 5] = wake.z[i] - nz * w;
      const c = i * 8;
      Cc[c] = Cc[c + 1] = Cc[c + 2] = 1; Cc[c + 3] = a;
      Cc[c + 4] = Cc[c + 5] = Cc[c + 6] = 1; Cc[c + 7] = a;
      const u = i * 4;
      U[u] = 0; U[u + 1] = age * 0.22; U[u + 2] = 1; U[u + 3] = age * 0.22;
    }
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.attributes.uv.needsUpdate = true;
    g.setDrawRange(0, Math.max(0, wake.count - 1) * 6);
  }

  // ---------------------------------------------------------------------------
  // Rowboat & boarders
  // ---------------------------------------------------------------------------
  const LINES = {
    boat: ['Hej rup! Hej rup!', 'Veslujte, líní psi!', 'Arrr!', 'Už tě vidíme!'],
    land: ['Ten vor je náš!', 'Arrr! Vzdej se!', 'Za mnou, hoši!'],
    chase: ['Arrr! Vzdej se!', 'Dej sem zlato!', 'Ten vor je náš!', 'Hromy a blesky!', 'Na prkno s tebou!'],
    attack: ['Na!', 'Tumáš!', 'Hyjé!'],
    hit: ['Au!', 'Jau!', 'To bolí!', 'Ty jeden!'],
    water: ['Pojď sem, suchozemská kryso!', 'Plav, plav! Hehe!', 'Žraloci už čekají!', 'Vylez, jestli se nebojíš!'],
    fall: ['Neumím plavat!', 'Áááá!', 'Pomóóc!'],
    die: ['Arrgh…', 'Já se vrátím!', 'Au au au…'],
    sunk: ['Naše loď!', 'Hromy a blesky!', 'To ne!'],
    flee: ['Ústup!', 'Zpátky na loď!', 'Tohle nestojí za to!'],
  };

  const boarders = [];
  let boarderModels = [];
  const boat = { active: false, state: 'none', pos: new THREE.Vector3(), heading: 0, speed: 0, phase: 0, passengers: [],
    tx: 0, tz: 0, dirx: 0, dirz: 0, bx: 0, bz: 0, retargetT: 0, unloadT: 0, sinkT: 0, bob: 0, landed: false, driftT: 0 };
  let boardingAnnounced = false;
  let boardT = 0, gaveUp = false, shoveCd = 0;

  function boardersRemaining() {
    let n = 0;
    for (const b of boarders) if (!b.defeated) n++;
    return n;
  }

  function say(b, text, dur) {
    const bub = b.m.bubble;
    const tex = bubbleTex(text);
    bub.material.map = tex;
    bub.visible = true;
    b.bubbleT = dur || 2;
    b.bubbleAge = 0;
    b.speakCd = G.rand(3.5, 6.5);
  }

  function makeBoarderTarget(b) {
    return {
      kind: 'pirate',
      radius: 0.45,
      getPosition(out) { return out.set(b.pos.x, b.pos.y + (b.state === 'boat' ? 0.6 : 1.1), b.pos.z); },
      alive() { return !b.defeated && (b.state === 'fight' || b.state === 'boat' || b.state === 'climb'); },
      onHit(damage, dir, source) { hurtBoarder(b, Number(damage) || 0, dir, source || 'hit', 5.5); },
    };
  }

  function spawnBoarder(variant, seat) {
    const m = boarderModels[variant];
    const b = {
      m, variant, seat, hp: BOARDER_HP, state: 'boat', stateT: 0, defeated: false,
      pos: new THREE.Vector3(), yaw: 0, kbx: 0, kbz: 0, vy: 0,
      walk: 0, moveK: 0, attackT: -1, attackCd: 0.8, hitDone: false, flash: 0, flinch: 0,
      speakCd: G.rand(1, 4), bubbleT: 0, bubbleAge: 0, from: new THREE.Vector3(), to: new THREE.Vector3(),
      target: null, rowPhase: seat * 1.3, cause: '',
    };
    m.root.visible = true;
    m.root.scale.setScalar(1);
    m.body.rotation.set(0, 0, 0);
    m.body.position.set(0, 0, 0);
    m.bubble.visible = false;
    setFlash(b, false);
    if (!m.root.parent) G.scene.add(m.root);
    b.target = G.combat.add(makeBoarderTarget(b));
    boarders.push(b);
    return b;
  }

  function setFlash(b, on) {
    if (b.flashOn === on) return;
    b.flashOn = on;
    const mat_ = on ? M.figHit : M.fig;
    for (const mesh of b.m.meshes) mesh.material = mat_;
  }

  function removeBoarder(b) {
    const i = boarders.indexOf(b);
    if (i >= 0) boarders.splice(i, 1);
    if (b.target) { G.combat.remove(b.target); b.target = null; }
    b.m.root.visible = false;
    b.m.bubble.visible = false;
    setFlash(b, false);
  }

  function defeat(b, cause) {
    if (b.defeated) return;
    b.defeated = true;
    b.cause = cause;
    if (b.target) { G.combat.remove(b.target); b.target = null; }
    G.stats.piratesDefeated = (G.stats.piratesDefeated || 0) + 1;
    const gold = G.randInt(3, 8);
    let left = gold;
    if (G.inventory && typeof G.inventory.add === 'function') left = Math.max(0, Number(G.inventory.add('zlato', gold, 'pirate')) || 0);
    if (left > 0 && G.debris && typeof G.debris.spawnItem === 'function') {
      _p.set(b.pos.x, 0, b.pos.z);                             // spawnItem moves it off the deck
      try { G.debris.spawnItem('zlato', left, _p); } catch (err) { /* ignore */ }
    }
    const got = gold - left;
    snd('coins', b.pos, 0.9);
    _p.set(b.pos.x, b.pos.y + 1.2, b.pos.z);
    fx('sparkle', _p, 0xe8b923);
    G.events.emit('pirate:killed', { cause, gold, x: b.pos.x, z: b.pos.z });
    if (left <= 0) G.notify('Pirát poražen! +' + gold + ' ' + plural(gold, 'zlaťák', 'zlaťáky', 'zlaťáků'), 'good');
    else if (got > 0) G.notify('Pirát poražen! +' + got + ' ' + plural(got, 'zlaťák', 'zlaťáky', 'zlaťáků') + ', zbytek plave ve vodě.', 'good');
    else G.notify('Pirát poražen! Zlaťáky plavou ve vodě.', 'good');
  }

  function hurtBoarder(b, dmg, dir, source, push) {
    if (b.defeated || !(dmg > 0)) return;
    if (b.state !== 'fight' && b.state !== 'boat' && b.state !== 'climb') return;
    b.hp -= dmg;
    b.flash = 0.14;
    b.flinch = 1;
    b.attackT = -1;
    b.attackCd = Math.max(b.attackCd, 0.7);
    let dx = dir ? dir.x : 0, dz = dir ? dir.z : 0;
    const dl = Math.hypot(dx, dz);
    if (dl > 1e-4) { dx /= dl; dz /= dl; } else { dx = Math.sin(b.yaw + PI); dz = Math.cos(b.yaw + PI); }
    if (b.state === 'fight') { b.kbx = dx * push; b.kbz = dz * push; }
    if (b.hp <= 0) {
      if (b.state === 'boat' || b.state === 'climb') { startFall(b, dx * 2, dz * 2); defeat(b, source); say(b, G.pick(LINES.fall), 1.6); }
      else { b.state = 'dying'; b.stateT = 0; defeat(b, source); say(b, G.pick(LINES.die), 1.6); snd('pirate_yell', b.pos, 0.6); }
      return;
    }
    if (G.chance(0.65)) say(b, G.pick(LINES.hit), 1.1);
    if (G.chance(0.35)) snd('pirate_yell', b.pos, 0.45);
  }

  function hitBoarderWithBall(ball) {
    for (const b of boarders) {
      if (b.defeated || b.state !== 'fight') continue;
      const dx = ball.pos.x - b.pos.x, dz = ball.pos.z - b.pos.z, dy = ball.pos.y - (b.pos.y + 0.9);
      if (dx * dx + dz * dz < 0.6 && Math.abs(dy) < 1) {
        fx('explosion', ball.pos, 0.6);
        snd('explosion', ball.pos, 0.8);
        _d.copy(ball.vel).setY(0).normalize();
        hurtBoarder(b, BALL_SHIP_DMG, _d, 'cannon', 8);
        return true;
      }
    }
    return false;
  }

  function startFall(b, kx, kz) {
    b.state = 'fall';
    b.stateT = 0;
    b.vy = 2.5;
    b.kbx = kx; b.kbz = kz;
    b.attackT = -1;
  }

  // Nearest raft edge (outside point, edge point, board point) to (x, z).
  function findBoatTarget(x, z) {
    const R = G.raft;
    if (!R) return false;
    const edges = R.edgeTiles ? R.edgeTiles() : [];
    let best = Infinity;
    const DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0]];
    const TILE = G.C.TILE;
    for (const t of edges) {
      const cx = (t.i + 0.5) * TILE, cz = (t.j + 0.5) * TILE;
      for (const d of DIRS) {
        if (R.getTile ? R.getTile(t.i + d[0], t.j + d[1]) : R.tileAt(cx + d[0] * TILE, cz + d[1] * TILE)) continue;
        const ox = cx + d[0] * 2.95, oz = cz + d[1] * 2.95;
        const dd = (ox - x) * (ox - x) + (oz - z) * (oz - z);
        if (dd < best) {
          best = dd;
          boat.tx = ox; boat.tz = oz; boat.dirx = d[0]; boat.dirz = d[1];
          boat.bx = cx + d[0] * 0.45; boat.bz = cz + d[1] * 0.45;
        }
      }
    }
    return best < Infinity;
  }

  function launchBoat() {
    const s = ship;
    if (!s || boat.active) return false;
    const h = s.heading, dx = -s.position.x, dz = -s.position.z;
    const lx = dx * Math.cos(h) - dz * Math.sin(h);
    const sg = lx >= 0 ? 1 : -1;
    const rx = Math.cos(h), rz = -Math.sin(h);
    boat.pos.set(s.position.x + rx * sg * 4.6, 0, s.position.z + rz * sg * 4.6);
    boat.heading = Math.atan2(-boat.pos.x, -boat.pos.z);
    boat.speed = 0;
    boat.phase = 0;
    boat.active = true;
    boat.state = 'row';
    boat.retargetT = 0;
    boat.unloadT = 0;
    boat.landed = false;
    boat.passengers.length = 0;
    boatM.root.visible = true;
    boatM.root.scale.setScalar(1);
    if (!boatM.root.parent) G.scene.add(boatM.root);
    findBoatTarget(boat.pos.x, boat.pos.z);
    const n = G.clamp(tune.boarders | 0, 1, 4);
    // seat 0 = bow (captain with the hat), seat 1 = rower, seat 2 = stern, seat 3 = front
    const plan = n === 1 ? [[0, 1]] : [[1, 0], [0, 1], [2, 2], [3, 3]].slice(0, n);
    for (const [variant, seat] of plan) {
      const b = spawnBoarder(variant, seat);
      boat.passengers.push(b);
    }
    placeBoat(0);
    for (const b of boat.passengers) seatBoarder(b);
    _p.set(boat.pos.x, 0, boat.pos.z);
    fx('splash', _p, 1.6);
    snd('splash_big', _p, 0.8);
    snd('pirate_yell', s.position, 1);
    G.notify(spearInInventory() ? 'Piráti spouštějí člun! Připrav si oštěp.' : 'Piráti spouštějí člun a jedou k voru!', 'warn');
    say(boat.passengers[0], 'Arrr! Na ně!', 2);
    return true;
  }

  function placeBoat(dt) {
    const x = boat.pos.x, z = boat.pos.z, h = boat.heading;
    const fx_ = Math.sin(h), fz = Math.cos(h);
    const hb = waveH(x + fx_ * 1.6, z + fz * 1.6), hs = waveH(x - fx_ * 1.6, z - fz * 1.6);
    const y = (hb + hs) * 0.5;
    boat.bob = dt > 0 ? G.damp(boat.bob, y, 5, dt) : y;
    const sinkY = boat.state === 'sunk' ? -boat.sinkT * 1.2 : 0;
    boatM.root.position.set(x, boat.bob + 0.05 + sinkY, z);
    boatM.root.rotation.set(Math.atan2(hs - hb, 3.2) * 0.9 + (boat.state === 'sunk' ? boat.sinkT * 0.4 : 0), h, Math.sin(G.time * 1.7 + 1) * 0.05);
    boatM.root.updateMatrixWorld(true);
  }

  function seatBoarder(b) {
    const S = BOAT_SEATS[b.seat] || BOAT_SEATS[0];
    _p.set(S[0], S[1] - 0.35, S[2]).applyMatrix4(boatM.root.matrixWorld);
    b.pos.copy(_p);
    b.yaw = boat.heading + (b.seat === 1 ? PI : 0);
  }

  function updateBoat(dt) {
    if (!boat.active) return;
    if (boat.state === 'row') {
      boat.retargetT -= dt;
      if (boat.retargetT <= 0) { boat.retargetT = 1.2; findBoatTarget(boat.pos.x, boat.pos.z); }
      const dx = boat.tx - boat.pos.x, dz = boat.tz - boat.pos.z, d = Math.hypot(dx, dz);
      let want = Math.atan2(dx, dz);
      if (d < 3.5) want = Math.atan2(-boat.dirx, -boat.dirz);
      boat.heading = dampAngle(boat.heading, want, d < 3.5 ? 3 : 1.6, dt);
      const spd = BOAT_SPEED * G.clamp(d / 3, 0.25, 1);
      boat.speed = G.damp(boat.speed, spd, 2, dt);
      if (d > 0.05) {
        const step = Math.min(d, boat.speed * dt);
        boat.pos.x += (dx / d) * step;
        boat.pos.z += (dz / d) * step;
      }
      boat.phase += dt * 5.2;
      const ph = boat.phase;
      for (let i = 0; i < 2; i++) {
        const o = boatM.oars[i];
        const sg = i === 0 ? 1 : -1;
        o.rotation.y = -Math.sin(ph) * 0.55 * sg;
        o.rotation.z = (-0.32 + Math.cos(ph) * 0.2) * sg;
      }
      if (Math.sin(ph) > 0.97 && !boat.dipped) {
        boat.dipped = true;
        for (const sg of [1, -1]) {
          const rx = Math.cos(boat.heading), rz = -Math.sin(boat.heading);
          _p.set(boat.pos.x + rx * sg * 2.1, 0, boat.pos.z + rz * sg * 2.1);
          _p.y = waveH(_p.x, _p.z) + 0.05;
          fx('ripple', _p, 0.6);
        }
      } else if (Math.sin(ph) < 0.5) boat.dipped = false;
      if (d < 0.4) {
        boat.state = 'moored';
        boat.unloadT = 0;
        boatM.oars[0].rotation.set(0, 0.2, -0.1);
        boatM.oars[1].rotation.set(0, -0.2, 0.1);
      }
    } else if (boat.state === 'moored') {
      boat.unloadT += dt;
      let k = 0;
      for (const b of boat.passengers) {
        if (b.state === 'boat' && !b.defeated && boat.unloadT > 0.3 + k * 0.7) startClimb(b, k);
        k++;
      }
    } else if (boat.state === 'adrift') {
      const dv = G.world && G.world.driftVelocity;
      if (dv) { boat.pos.x += dv.x * dt; boat.pos.z += dv.z * dt; }
      boat.driftT += dt;
      if (boat.driftT > 40 || Math.hypot(boat.pos.x, boat.pos.z) > 90) { hideBoat(); return; }
    } else if (boat.state === 'sunk') {
      boat.sinkT += dt;
      if (boat.sinkT > 3) { hideBoat(); return; }
    }
    placeBoat(dt);
  }

  function hideBoat() {
    boat.active = false;
    boat.state = 'none';
    boat.passengers.length = 0;
    if (boatM) boatM.root.visible = false;
  }

  function boatHitTest(pos) {
    const dx = pos.x - boat.pos.x, dz = pos.z - boat.pos.z;
    return dx * dx + dz * dz < 1.9 * 1.9 && pos.y < boat.bob + 1.6;
  }
  function hitBoat(pos) {
    fx('explosion', pos, 1.1);
    fx('debris', pos, 0x8a6444, 20);
    snd('explosion', pos, 1);
    snd('break_wood', pos, 0.9);
    boat.state = 'sunk';
    boat.sinkT = 0;
    for (const b of boat.passengers) {
      if (b.defeated || b.state !== 'boat') continue;
      startFall(b, G.rand(-2, 2), G.rand(-2, 2));
      b.vy = 5;
      defeat(b, 'cannon');
      say(b, G.pick(LINES.fall), 1.6);
    }
    G.notify('Trefa! Člun s piráty jde ke dnu!', 'good');
  }

  function startClimb(b, k) {
    b.state = 'climb';
    b.stateT = 0;
    b.from.copy(b.pos);
    const side = (k - 1) * 0.55;
    const px = -boat.dirz, pz = boat.dirx;
    let tx = boat.bx + px * side, tz = boat.bz + pz * side;
    if (raftHeight(tx, tz) === null) { tx = boat.bx; tz = boat.bz; }
    b.to.set(tx, deckY(), tz);
    b.yaw = Math.atan2(-boat.dirx, -boat.dirz);
  }

  // Where boarders go: the player (on the raft) or the raft spot closest to the player.
  const goal = { x: 0, z: 0, onRaft: false, frame: -1 };
  function updateGoal() {
    const P = player();
    goal.onRaft = playerOnRaft();
    if (!P) { goal.x = goal.z = 0; return; }
    if (goal.onRaft) { goal.x = P.position.x; goal.z = P.position.z; return; }
    const R = G.raft;
    let best = Infinity, bx = 0, bz = 0;
    const TILE = G.C.TILE;
    if (R && R.tiles) {
      for (const t of R.tiles.values()) {
        const cx = (t.i + 0.5) * TILE, cz = (t.j + 0.5) * TILE;
        const d = (cx - P.position.x) * (cx - P.position.x) + (cz - P.position.z) * (cz - P.position.z);
        if (d < best) { best = d; bx = cx; bz = cz; }
      }
    }
    const dx = P.position.x - bx, dz = P.position.z - bz;
    goal.x = bx + G.clamp(dx, -0.65, 0.65);
    goal.z = bz + G.clamp(dz, -0.65, 0.65);
  }

  function tryMove(b, mx, mz) {
    const nx = b.pos.x + mx, nz = b.pos.z + mz;
    const l = Math.hypot(mx, mz) || 1;
    const ax = nx + (mx / l) * 0.3, az = nz + (mz / l) * 0.3;
    if (raftHeight(nx, nz) !== null && raftHeight(ax, az) !== null) { b.pos.x = nx; b.pos.z = nz; return true; }
    return false;
  }

  function updateBoarder(b, dt) {
    b.stateT += dt;
    if (b.speakCd > 0) b.speakCd -= dt;
    if (b.flash > 0) { b.flash -= dt; if (b.flash <= 0) setFlash(b, false); else setFlash(b, true); }
    b.flinch = Math.max(0, b.flinch - dt * 4);
    let moving = 0;
    const P = player();

    if (b.state === 'boat') {
      if (boat.active && boat.state !== 'sunk') seatBoarder(b);
      if (b.speakCd <= 0 && G.chance(0.4)) say(b, G.pick(LINES.boat), 1.8);
      else if (b.speakCd <= 0) b.speakCd = G.rand(2, 4);
    } else if (b.state === 'climb') {
      const k = Math.min(1, b.stateT / 0.85), e = smooth01(k);
      b.pos.lerpVectors(b.from, b.to, e);
      b.to.y = deckY();
      b.pos.y += Math.sin(PI * e) * 0.9;
      if (k >= 1) {
        b.state = 'fight';
        b.stateT = 0;
        b.pos.y = deckY();
        snd('step', b.pos, 0.6);
        if (!boardingAnnounced) {
          boardingAnnounced = true;
          G.events.emit('pirates:boarding', { count: boardersRemaining() });
          if (spearInInventory()) G.notify('Piráti lezou na vor! Braň se oštěpem!', 'danger');
          else {
            G.notify('Piráti lezou na vor!', 'danger');
            G.notify('Nemáš oštěp! Vyrob si ho: 4 prkna, 1 kov, 2 provazy.', 'warn');
            G.notify('Zatím je strkej do vody: ' + btnL() + '.', 'info');
          }
          banner('Piráti na voru!', 'danger', 2.5);
          snd('pirate_yell', b.pos, 1);
          say(b, G.pick(LINES.land), 2);
        } else if (G.chance(0.6)) say(b, G.pick(LINES.land), 1.8);
      }
    } else if (b.state === 'fight') {
      // knockback slide (no ground check: a push off the edge drops them into the sea)
      const kb = Math.hypot(b.kbx, b.kbz);
      if (kb > 0.05) {
        b.pos.x += b.kbx * dt; b.pos.z += b.kbz * dt;
        const f = Math.exp(-7 * dt);
        b.kbx *= f; b.kbz *= f;
      }
      const gh = raftHeight(b.pos.x, b.pos.z);
      if (gh === null) {
        startFall(b, b.kbx * 0.6, b.kbz * 0.6);
        defeat(b, 'sea');
        say(b, G.pick(LINES.fall), 1.6);
      } else {
        b.pos.y = gh;
        if (goal.frame !== frameNo) { goal.frame = frameNo; updateGoal(); }
        const dx = goal.x - b.pos.x, dz = goal.z - b.pos.z, d = Math.hypot(dx, dz);
        const stop = goal.onRaft ? 1.05 : 0.15;
        if (d > 0.05) b.yaw = dampAngle(b.yaw, Math.atan2(dx, dz), 8, dt);
        if (b.attackT < 0 && d > stop && kb < 1.2) {
          const step = Math.min(d - stop, BOARDER_SPEED * dt);
          const mx = (dx / d) * step, mz = (dz / d) * step;
          if (tryMove(b, mx, mz) || tryMove(b, mx, 0) || tryMove(b, 0, mz)) { moving = 1; b.walk += step; }
        }
        // keep apart from each other and from the player
        for (const o of boarders) {
          if (o === b || o.state !== 'fight') continue;
          const ox = b.pos.x - o.pos.x, oz = b.pos.z - o.pos.z, od = Math.hypot(ox, oz);
          if (od < 0.7 && od > 1e-4) tryMove(b, (ox / od) * (0.7 - od) * 0.5, (oz / od) * (0.7 - od) * 0.5);
        }
        if (P && goal.onRaft) {
          const px = b.pos.x - P.position.x, pz = b.pos.z - P.position.z, pd = Math.hypot(px, pz);
          if (pd < 0.7 && pd > 1e-4) tryMove(b, (px / pd) * (0.7 - pd), (pz / pd) * (0.7 - pd));
        }
        // melee
        b.attackCd -= dt;
        if (goal.onRaft && P && P.alive && b.attackT < 0 && b.attackCd <= 0 && d < MELEE_RANGE && Math.abs(P.position.y - b.pos.y) < 1.3) {
          b.attackT = 0;
          b.hitDone = false;
          b.attackCd = MELEE_CD;
          if (G.chance(0.3)) say(b, G.pick(LINES.attack), 0.8);
        }
        if (b.attackT >= 0) {
          b.attackT += dt;
          if (!b.hitDone && b.attackT >= 0.38) {
            b.hitDone = true;
            const px = P.position.x - b.pos.x, pz = P.position.z - b.pos.z, pd = Math.hypot(px, pz);
            _p.set(b.pos.x, b.pos.y + 1.2, b.pos.z);
            if (P.alive && playerOnRaft() && pd < MELEE_RANGE + 0.4 && Math.abs(P.position.y - b.pos.y) < 1.4) {
              _d.set(px, 0, pz);
              if (_d.lengthSq() < 1e-4) _d.set(Math.sin(b.yaw), 0, Math.cos(b.yaw));
              P.damage(tune.meleeDmg, 'pirate', _d.normalize());
              snd('sword', _p, 1);
            } else snd('whoosh', _p, 0.5);
          }
          if (b.attackT >= 0.8) b.attackT = -1;
        }
        // taunts
        if (b.speakCd <= 0) {
          if (!goal.onRaft) { say(b, G.pick(LINES.water), 2.2); if (G.chance(0.5)) snd('pirate_yell', b.pos, 0.5); }
          else if (G.chance(0.45)) say(b, G.pick(LINES.chase), 1.8);
          else b.speakCd = G.rand(2, 4);
        }
      }
    } else if (b.state === 'fall') {
      b.vy -= G.C.GRAVITY * dt;
      b.pos.x += b.kbx * dt; b.pos.z += b.kbz * dt;
      b.pos.y += b.vy * dt;
      const wy = waveH(b.pos.x, b.pos.z);
      if (b.pos.y < wy - 0.5) {
        b.state = b.cause === 'retreat' ? 'swim' : 'sink';
        b.stateT = 0;
        _p.set(b.pos.x, wy, b.pos.z);
        fx('splash', _p, 1.3);
        snd('splash_big', _p, 0.7);
      }
    } else if (b.state === 'sink') {
      const wy = waveH(b.pos.x, b.pos.z);
      const dv = G.world && G.world.driftVelocity;
      if (dv) { b.pos.x += dv.x * dt * 0.5; b.pos.z += dv.z * dt * 0.5; }
      b.pos.y = b.stateT < 1.3 ? wy - 1.0 + Math.sin(b.stateT * 7) * 0.08 : wy - 1.0 - (b.stateT - 1.3) * 0.9;
      if (Math.random() < dt * 5) { _p.set(b.pos.x, wy, b.pos.z); fx('bubbles', _p, 6); }
      if (b.stateT > 3.2) { removeBoarder(b); return; }
    } else if (b.state === 'flee') {
      // run to the nearest raft edge and jump in
      const dx = b.to.x - b.pos.x, dz = b.to.z - b.pos.z, d = Math.hypot(dx, dz) || 1;
      b.yaw = dampAngle(b.yaw, Math.atan2(dx, dz), 10, dt);
      const step = Math.min(d, BOARDER_SPEED * 1.4 * dt);
      b.pos.x += (dx / d) * step; b.pos.z += (dz / d) * step;
      moving = 1; b.walk += step;
      const gh = raftHeight(b.pos.x, b.pos.z);
      if (gh === null || d < 0.1 || b.stateT > 8) { startFall(b, (dx / d) * 2.5, (dz / d) * 2.5); b.vy = 4.5; }
      else b.pos.y = gh;
    } else if (b.state === 'swim') {
      // swim away from the raft and dive out of sight
      const wy = waveH(b.pos.x, b.pos.z);
      const l = Math.hypot(b.pos.x, b.pos.z) || 1;
      b.pos.x += (b.pos.x / l) * 1.8 * dt; b.pos.z += (b.pos.z / l) * 1.8 * dt;
      b.yaw = Math.atan2(b.pos.x, b.pos.z);
      b.pos.y = b.stateT < 6 ? wy - 1.05 + Math.sin(b.stateT * 5) * 0.06 : wy - 1.05 - (b.stateT - 6) * 0.9;
      if (Math.random() < dt * 2) { _p.set(b.pos.x, wy, b.pos.z); fx('ripple', _p, 0.5); }
      if (b.stateT > 8) { removeBoarder(b); return; }
    } else if (b.state === 'dying') {
      const kb = Math.hypot(b.kbx, b.kbz);
      if (kb > 0.05) {
        b.pos.x += b.kbx * dt; b.pos.z += b.kbz * dt;
        const f = Math.exp(-7 * dt);
        b.kbx *= f; b.kbz *= f;
      }
      const gh = raftHeight(b.pos.x, b.pos.z);
      if (gh === null) { startFall(b, b.kbx * 0.5, b.kbz * 0.5); }
      else b.pos.y = gh;
      if (b.stateT > 1.6) {
        const k = (b.stateT - 1.6) / 0.35;
        b.m.root.scale.setScalar(Math.max(0.01, 1 - k));
        if (!b.poofed) {
          b.poofed = true;
          _p.set(b.pos.x, b.pos.y + 0.4, b.pos.z);
          fx('smoke', _p, 1.5);
          fx('sparkle', _p, 0xe8b923);
        }
        if (k >= 1) { removeBoarder(b); return; }
      }
    }
    b.moveK = G.damp(b.moveK, moving, 10, dt);
    poseBoarder(b, dt);
  }

  function poseBoarder(b, dt) {
    const m = b.m, t = G.time + b.seat * 1.7;
    m.root.position.copy(b.pos);
    m.root.rotation.y = b.yaw;
    let legL = 0, legR = 0, armL = -0.15, armR = -0.6, armLz = -0.12, armRz = 0.12, torsoX = 0, torsoY = 0, bodyY = 0, bodyX = 0, headX = 0;
    const ph = b.walk * 4.4, mk = b.moveK;
    if (b.state === 'boat') {
      legL = legR = -1.05;
      bodyY = -0.55;
      if (b.seat === 1) {
        const r = Math.sin(boat.phase);
        armL = armR = -1.25 + r * 0.45;
        torsoX = r * 0.25;
      } else {
        armR = -2.4 + Math.sin(t * 5) * 0.35;
        armL = -0.4;
      }
    } else if (b.state === 'climb') {
      const k = b.stateT * 9;
      armL = -2.7 + Math.sin(k) * 0.3; armR = -2.5 - Math.sin(k) * 0.3;
      legL = -0.9 * Math.max(0, Math.sin(k)); legR = -0.9 * Math.max(0, -Math.sin(k));
      torsoX = 0.3;
    } else if (b.state === 'fight' || b.state === 'flee') {
      legL = Math.sin(ph) * 0.7 * mk; legR = -legL;
      armL = -0.2 - Math.sin(ph) * 0.45 * mk;
      armR = -0.65 + Math.sin(ph) * 0.2 * mk;
      bodyY = Math.abs(Math.sin(ph)) * 0.05 * mk;
      torsoX = 0.03 * Math.sin(t * 2) + 0.12 * mk;
      if (b.attackT >= 0) {
        const a = b.attackT;
        if (a < 0.38) { const e = easeOut(a / 0.38); armR = G.lerp(-0.65, -3.3, e); torsoY = 0.35 * e; torsoX = -0.1 * e; }
        else if (a < 0.5) { const e = (a - 0.38) / 0.12; armR = G.lerp(-3.3, -0.8, e); torsoY = G.lerp(0.35, -0.35, e); torsoX = G.lerp(-0.1, 0.25, e); }
        else { const e = smooth01((a - 0.5) / 0.3); armR = G.lerp(-0.8, -0.65, e); torsoY = G.lerp(-0.35, 0, e); torsoX = G.lerp(0.25, 0.05, e); }
      } else if (!goal.onRaft && b.state === 'fight') {
        armR = -2.7 + Math.sin(t * 8) * 0.45;
        armL = -0.3; armLz = -0.9;
        bodyY = Math.abs(Math.sin(t * 5)) * 0.07;
      }
      torsoX -= b.flinch * 0.45;
      headX = -b.flinch * 0.3;
    } else if (b.state === 'fall' || b.state === 'sink' || b.state === 'swim') {
      armL = -2.8 + Math.sin(t * 15) * 0.5; armR = -2.6 + Math.cos(t * 14) * 0.5;
      armLz = -0.5; armRz = 0.5;
      legL = Math.sin(t * 12) * 0.6; legR = -legL;
    } else if (b.state === 'dying') {
      const e = easeOut(b.stateT / 0.5);
      bodyX = -HALF_PI * 0.95 * e;
      bodyY = 0.15 * e;
      armL = -2.4 * e; armR = -2.2 * e; armLz = -0.4; armRz = 0.4;
      legL = -0.2 * e; legR = 0.1 * e;
    }
    m.legL.rotation.x = legL; m.legR.rotation.x = legR;
    m.armL.rotation.set(armL, 0, armLz);
    m.armR.rotation.set(armR, 0, armRz);
    m.torso.rotation.set(torsoX, torsoY, 0);
    m.head.rotation.x = headX;
    m.body.position.y = bodyY;
    m.body.rotation.x = bodyX;
    // speech bubble pop
    const bub = m.bubble;
    if (bub.visible) {
      b.bubbleT -= dt;
      b.bubbleAge += dt;
      const k = Math.min(1, b.bubbleAge / 0.18), out = b.bubbleT < 0.2 ? Math.max(0, b.bubbleT / 0.2) : 1;
      // close up (a boarder right in front of you) the bubble shrinks so it never fills the screen
      const cp = G.camera.position;
      const near = G.clamp(Math.hypot(b.pos.x - cp.x, b.pos.z - cp.z) / 7, 0.28, 1);
      const sc = (0.6 + 0.4 * easeOut(k)) * out * near;
      bub.scale.set(2.0 * sc, 0.5 * sc, 1);
      bub.position.y = (b.state === 'boat' ? 1.7 : 2.25) + (b.state === 'dying' ? -0.8 : 0) + 0.25 * (1 - near);
      if (b.bubbleT <= 0) bub.visible = false;
    }
  }

  // Nearest point just outside the raft edge from (x, z).
  function nearestEdgeOut(x, z, out) {
    const R = G.raft, TILE = G.C.TILE;
    const DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0]];
    let best = Infinity;
    out.set(x + 3, 0, z);
    const edges = R && R.edgeTiles ? R.edgeTiles() : [];
    for (const t of edges) {
      const cx = (t.i + 0.5) * TILE, cz = (t.j + 0.5) * TILE;
      for (const d of DIRS) {
        if (R.getTile ? R.getTile(t.i + d[0], t.j + d[1]) : R.tileAt(cx + d[0] * TILE, cz + d[1] * TILE)) continue;
        const ox = cx + d[0] * (TILE * 0.5 + 0.6), oz = cz + d[1] * (TILE * 0.5 + 0.6);
        const dd = (ox - x) * (ox - x) + (oz - z) * (oz - z);
        if (dd < best) { best = dd; out.set(ox, 0, oz); }
      }
    }
    return out;
  }

  // After BOARD_GIVE_UP s on deck the boarders give up and jump back into the sea (no gold).
  function retreat(b) {
    if (b.defeated) return;
    b.defeated = true;
    b.cause = 'retreat';
    if (b.target) { G.combat.remove(b.target); b.target = null; }
    b.state = 'flee';
    b.stateT = 0;
    b.attackT = -1;
    b.kbx = b.kbz = 0;
    nearestEdgeOut(b.pos.x, b.pos.z, b.to);
    say(b, G.pick(LINES.flee), 1.6);
  }

  // Unarmed fallback: LMB without the spear shoves a boarder in front of you (5 dmg + knock-back),
  // so they can still be pushed off the raft.
  function updateShove(dt) {
    if (shoveCd > 0) shoveCd -= dt;
    if (shoveCd > 0 || !boarders.length || !G.input.mousePressed(0) || G.uiBlocking() || seat.active) return;
    const P = player();
    if (!P || !P.alive || P.controlOverride || typeof P.eye !== 'function' || typeof P.forward !== 'function') return;
    const sel = G.inventory && typeof G.inventory.getSelected === 'function' ? G.inventory.getSelected() : null;
    const def = sel && G.items && typeof G.items.def === 'function' ? G.items.def(sel.id) : null;
    if (def && def.tool === 'spear') return;                 // the spear does its own (stronger) hit
    P.eye(_a); P.forward(_dir);
    let best = null, bestD = Infinity;
    for (const b of boarders) {
      if (b.defeated || b.state !== 'fight') continue;
      _t.set(b.pos.x - _a.x, b.pos.y + 1.1 - _a.y, b.pos.z - _a.z);
      const len = _t.length();
      if (len - 0.45 > SHOVE_RANGE || len < 1e-4) continue;
      const ang = Math.acos(G.clamp(_t.dot(_dir) / len, -1, 1));
      if (ang > 0.6 + Math.atan(0.45 / Math.max(len, 0.1))) continue;
      if (len < bestD) { bestD = len; best = b; }
    }
    if (!best) return;
    shoveCd = SHOVE_CD;
    _d.set(best.pos.x - P.position.x, 0, best.pos.z - P.position.z);
    if (_d.lengthSq() < 1e-4) _d.set(_dir.x, 0, _dir.z);
    _d.normalize();
    hurtBoarder(best, SHOVE_DMG, _d, 'shove', SHOVE_PUSH);
    snd('hit', best.pos, 0.8);
  }

  function updateBoarders(dt) {
    let onDeck = 0;
    for (const b of boarders) if (!b.defeated && b.state === 'fight') onDeck++;
    if (onDeck > 0 && !gaveUp) {
      boardT += dt;
      if (boardT >= BOARD_GIVE_UP) {
        gaveUp = true;
        for (const b of boarders) if (!b.defeated && b.state === 'fight') retreat(b);
        G.notify('Piráti to vzdali a skáčou zpátky do moře!', 'good');
      }
    }
    updateShove(dt);
    for (let i = boarders.length - 1; i >= 0; i--) {
      const b = boarders[i];
      if (!b) continue;
      updateBoarder(b, dt);
    }
    // boat done unloading and everyone off → let it drift once the raid ends
    if (boat.active && boat.state === 'moored') {
      let aboard = 0;
      for (const b of boat.passengers) if (b.state === 'boat' && !b.defeated) aboard++;
      if (!aboard && !API.active) { boat.state = 'adrift'; boat.driftT = 0; }
    }
  }

  // ---------------------------------------------------------------------------
  // The seat: sitting at a cannon (control override)
  // ---------------------------------------------------------------------------
  const seat = { active: false, s: null, blendT: 0, fromPos: new THREE.Vector3(), fromQuat: new THREE.Quaternion(),
    shake: 0, unblock: 0, noAmmoAt: -10, hint: '', wantStand: false };

  const override = { update(dt) { seatUpdate(dt); } };

  function sit(s) {
    const P = player();
    if (seat.active || !P || !P.alive || !s || !s.object) return false;
    seat.active = true;
    seat.s = s;
    seat.blendT = 0;
    seat.wantStand = false;
    seat.hint = '';
    seat.fromPos.copy(G.camera.position);
    seat.fromQuat.copy(G.camera.quaternion);
    if (typeof P.setControlOverride === 'function') P.setControlOverride(override);
    G.interaction.blocked = true;
    seat.unblock = 0;
    G.hud.crosshair = 'hidden';
    if (preview) preview.visible = true;
    s.object.getWorldPosition(_p);
    snd('step', _p, 0.5);
    if (ammo() <= 0) {
      seat.noAmmoAt = G.time;
      G.notify('Nemáš dělové koule. Vyrob je z kovu (2× Kovový šrot).', 'warn');
    }
    return true;
  }

  function stand(immediate) {
    if (!seat.active) return;
    const s = seat.s, P = player();
    seat.active = false;
    seat.s = null;
    seat.wantStand = false;
    if (P && P.controlOverride === override) {
      if (s && s.data && P.alive) {
        P.yaw = wrapAngle(s.rotation * HALF_PI + s.data.yaw + PI);
        P.pitch = 0;
      }
      P.setControlOverride(null);
    }
    if (immediate) { G.interaction.blocked = false; seat.unblock = 0; }
    else seat.unblock = 2;
    G.hud.setToolHint('');
    G.hud.setProgress(null);
    G.hud.crosshair = 'dot';
    if (preview) preview.visible = false;
    if (aimRing) aimRing.visible = false;
    if (aimMark) aimMark.visible = false;
  }

  function seatUpdate(dt) {
    const s = seat.s, P = player();
    if (!s || !s.object || !s.object.parent || !s._cv || !P || !P.alive) { stand(); return; }
    const inp = G.input, ui = G.uiBlocking();
    if (!ui && (seat.wantStand || inp.pressed('KeyE') || inp.pressed('Escape'))) { stand(); return; }
    seat.wantStand = false;
    const cv = s._cv, d = s.data;
    if (!ui && inp.looking()) {
      const k = LOOK_K * (Number(G.settings.sensitivity) || 1);
      d.yaw = G.clamp(d.yaw - inp.mouse.dx * k, -YAW_LIMIT, YAW_LIMIT);
      d.pitch = G.clamp(d.pitch - inp.mouse.dy * k * (G.settings.invertY ? -1 : 1), PITCH_MIN, PITCH_MAX);
    }
    cv.yawG.rotation.y = d.yaw;
    cv.pitchG.rotation.x = -d.pitch;
    const n = ammo();
    // fire
    if (!ui) {
      if ((inp.mouseDown(0) || inp.mousePressed(0)) && cv.reload <= 0 && n > 0) fireCannon(s);
      else if (inp.mousePressed(0) && n <= 0) {
        G.sfx('error');
        if (G.time - seat.noAmmoAt > 3) { seat.noAmmoAt = G.time; G.notify('Nemáš dělové koule!', 'warn'); }
      }
    }
    // camera behind & above the barrel
    const A = cannonFrame(s, _a, _dir);
    const sa = Math.sin(A), ca = Math.cos(A);
    seat.shake = Math.max(0, seat.shake - dt * 3.5);
    const sh = seat.shake * seat.shake;
    _t.set(_a.x - sa * 2.6 - ca * 0.95, _a.y + 1.3, _a.z - ca * 2.6 + sa * 0.95);
    _t.x += Math.sin(G.time * 57) * 0.05 * sh;
    _t.y += Math.sin(G.time * 43 + 1) * 0.06 * sh;
    _e.set(d.pitch * 0.55 - 0.1 + sh * 0.04, A + PI, 0, 'YXZ');
    _q.setFromEuler(_e);
    seat.blendT = Math.min(1, seat.blendT + dt / 0.35);
    const e = smooth01(seat.blendT);
    const cam = G.camera;
    if (e < 1) {
      cam.position.lerpVectors(seat.fromPos, _t, e);
      _qc.copy(seat.fromQuat).slerp(_q, e);
      cam.quaternion.copy(_qc);
    } else {
      cam.position.copy(_t);
      cam.quaternion.copy(_q);
    }
    // keep the player's body at the seat (behind the cannon, on the deck)
    let px = _a.x - sa * 1.25, pz = _a.z - ca * 1.25;
    if (raftHeight(px, pz) === null) { s.object.getWorldPosition(_p); px = _p.x - sa * 0.7; pz = _p.z - ca * 0.7; }
    P.position.set(px, deckY(), pz);
    // trajectory preview
    updatePreview(s);
    // HUD
    const hint = btnL() + ': Pal! · Koule: ' + n + ' · E: Vstát';
    if (hint !== seat.hint) { seat.hint = hint; }
    G.hud.setToolHint(seat.hint);
    if (cv.reload > 0) G.hud.setProgress(1 - cv.reload / RELOAD, 'Nabíjím…');
    else G.hud.setProgress(null);
    G.hud.crosshair = 'hidden';
  }

  function updatePreview(s) {
    if (!preview) return;
    cannonFrame(s, _a, _dir);
    _muz.copy(_a).addScaledVector(_dir, BARREL_LEN);
    _v.copy(_dir).multiplyScalar(BALL_V);
    const attr = preview.geometry.attributes.position;
    const r = simulate(_muz, _v, attr);
    attr.needsUpdate = true;
    preview.geometry.setDrawRange(0, r.n);
    preview.visible = true;
    M.dots.color.setHex(r.hit === 'ship' ? 0xffc04a : 0xffffff);
    const k = 1 + 0.1 * Math.sin(G.time * 8);
    if (aimRing) {
      aimRing.visible = r.hit !== 'ship';
      aimRing.position.set(r.x, waveH(r.x, r.z) + 0.08, r.z);
      aimRing.scale.setScalar((1.1 + Math.hypot(r.x - _muz.x, r.z - _muz.z) * 0.02) * k);
    }
    if (aimMark) {
      aimMark.visible = r.hit === 'ship';
      aimMark.position.set(r.x, r.y, r.z);
      aimMark.scale.setScalar(0.075 * k);
    }
  }

  function fireCannon(s) {
    const cv = s._cv;
    if (!cv || cv.reload > 0) return false;
    if (!G.inventory || !G.inventory.remove('koule', 1)) return false;
    cannonFrame(s, _a, _dir);
    _muz.copy(_a).addScaledVector(_dir, BARREL_LEN + 0.1);
    _v.copy(_dir).multiplyScalar(BALL_V);
    launchBall('player', _muz, _v);
    cv.reload = RELOAD;
    cv.recoilT = 0;
    _p.copy(_muz).addScaledVector(_dir, 0.35);
    fx('explosion', _p, 0.45);
    for (let i = 0; i < 3; i++) { _p.addScaledVector(_dir, 0.45); fx('smoke', _p, 1.9 - i * 0.4); }
    snd('cannon', _muz, 1);
    if (seat.s === s) seat.shake = 1;
    G.events.emit('cannon:fired', { player: true });
    return true;
  }

  // Escape while seated gets up instead of pausing (when the key reaches the page at all:
  // with pointer lock the browser eats it and core pauses — then we stand up on 'game:paused').
  function onKeyCapture(e) {
    if (e.code !== 'Escape' || !seat.active || !G.isPlaying()) return;
    if (G.uiBlocking()) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    // the same Escape also releases pointer lock: do not let core turn that into a pause
    if (document.pointerLockElement) G._suppressLockPause = true;
    seat.wantStand = true;
  }

  // ---------------------------------------------------------------------------
  // Raid lifecycle
  // ---------------------------------------------------------------------------
  let checkT = CHECK_EVERY;
  let frameNo = 0;

  function spawnRaid(opts) {
    opts = opts || {};
    if (API.active || !shipM) return false;
    clearRaid(false);
    boardingAnnounced = false;
    boardT = 0; gaveUp = false; shoveCd = 0;
    raidNo++;
    makeTune();
    ship = spawnShip(opts);
    API.ship = ship;
    API.active = true;
    if (opts.near) {
      const R = circleRadius(ship);
      const a = Math.atan2(ship.position.z, ship.position.x);
      ship.position.set(Math.cos(a) * R, 0, Math.sin(a) * R);
      ship.heading = Math.atan2(-Math.sin(a) * ship.circleDir, Math.cos(a) * ship.circleDir);
      ship.speed = SPEED_CIRCLE;
      wakeReset(ship.position.x - Math.sin(ship.heading) * 9, ship.position.z - Math.cos(ship.heading) * 9);
    }
    poseShip(0);
    G.events.emit('pirates:sighted', { x: ship.position.x, z: ship.position.z });
    G.notify('Piráti na obzoru!', 'danger');
    G.sfx('warning');
    banner('Piráti na obzoru!', 'danger', 4);
    if (opts.near) startCombat();
    return true;
  }

  function endRaid() {
    API.active = false;
    API.nextRaidAt = G.time + G.rand(RAID_MIN, RAID_MAX);
    if (boat.active && boat.state !== 'sunk') { boat.state = 'adrift'; boat.driftT = 0; }
  }

  // Removes every raid object. full=true also clears the seat and cannon state.
  function clearRaid(full) {
    if (ship && ship.target) G.combat.remove(ship.target);
    ship = null;
    API.ship = null;
    if (shipM) {
      shipM.root.visible = false; shipM.bar.visible = false;
      if (shipM.bar.parent) shipM.bar.parent.remove(shipM.bar);     // re-added by the next raid
      if (shipM.skirt) shipM.skirt.mesh.visible = false;
    }
    if (wake.mesh) wake.mesh.visible = false;
    wake.count = 0;
    for (let i = boarders.length - 1; i >= 0; i--) removeBoarder(boarders[i]);
    boarders.length = 0;
    hideBoat();
    for (let i = balls.length - 1; i >= 0; i--) freeBall(i);
    for (const r of rings) freeRing(r);
    API.active = false;
    if (full) stand(true);
  }

  // The periodic raid check (every CHECK_EVERY s). Returns true if a raid started.
  function raidCheck() {
    checkT = CHECK_EVERY;
    const P = player();
    if (API.active || G.time < API.nextRaidAt || !G.raft || G.raft.count() < MIN_TILES || (P && !P.alive)) return false;
    if (raidNo === 0 && !hasSpear()) return false;          // the first raid never comes before the spear
    return spawnRaid();
  }

  // Compile the raid's shaders during boot so the first sighting does not hitch.
  function precompile() {
    if (!G.renderer || typeof G.renderer.compile !== 'function') return;
    const roots = [shipM.root, shipM.bar, shipM.skirt.mesh, boatM.root, wake.mesh, preview, aimRing, aimMark].concat(boarderModels.map((m) => m.root));
    const was = roots.map((r) => r.visible);
    const extra = new THREE.Group();
    extra.add(new THREE.Mesh(GEO.ball, M.ball), new THREE.Mesh(GEO.ring, M.aimRing), new THREE.Mesh(GEO.ball, M.figHit));
    G.scene.add(extra);
    roots.forEach((r) => { r.visible = true; });
    try { G.renderer.compile(G.scene, G.camera); } catch (err) { /* optional optimisation */ }
    roots.forEach((r, i) => { r.visible = was[i]; });
    G.scene.remove(extra);
  }

  function checkRaidEnd() {
    if (!API.active) return;
    if (ship) return;
    if (boardersRemaining() > 0) return;
    endRaid();
  }

  // ---------------------------------------------------------------------------
  // Public API (exists at load time)
  // ---------------------------------------------------------------------------
  const API = (G.pirates = {
    active: false,
    ship: null,
    nextRaidAt: FIRST_RAID,
    spawnRaid(opts) { return spawnRaid(opts); },
    // --- extras ---
    boarders,
    boat,
    get seated() { return seat.active; },
    seatedCannon() { return seat.s; },
    sit(s) { return sit(s); },
    stand() { stand(false); },
    fire(s) { return fireCannon(s || seat.s); },
    aimAt(s, x, y, z) { return aimCannonAt(s || seat.s, x, y, z); },
    predict(s) {
      s = s || seat.s;
      if (!s) return null;
      cannonFrame(s, _a, _dir);
      _muz.copy(_a).addScaledVector(_dir, BARREL_LEN);
      _v.copy(_dir).multiplyScalar(BALL_V);
      const r = simulate(_muz, _v, null);
      return { hit: r.hit, x: r.x, y: r.y, z: r.z };
    },
    launchBoat() { return launchBoat(); },
    checkNow() { return raidCheck(); },
    shipFire(hit) { return ship ? shipFire(hit) : false; },
    sinkShip() { if (ship && ship.hp > 0) { ship.hp = 0; startSinking(); return true; } return false; },
    balls,
    BALL_V, BALL_G, RELOAD,
    get raids() { return raidNo; },
    tune,
  });

  // ---------------------------------------------------------------------------
  // Structure registration
  // ---------------------------------------------------------------------------
  const cannonDef = {
    name: 'Kanón',
    item: 'kanon',
    size: 0.7,
    interactY: 0.6,
    facesWater: true,
    data() { return { yaw: 0, pitch: 12 * DEG }; },
    create(s) { return createCannon(s); },
    interact: {
      label(s) {
        const n = ammo();
        return n > 0 ? 'Sednout ke kanónu (koule: ' + n + ')' : 'Sednout ke kanónu (nemáš koule)';
      },
      onInteract(s) { sit(s); },
      enabled() { return !seat.active; },
    },
    update(s, dt) { if (s._cv && s._cv.reload > 0) s._cv.reload = Math.max(0, s._cv.reload - dt); },
    frame(s, dt) { cannonUpdateVisual(s, dt); },
    save(s) { return { yaw: Math.round(s.data.yaw * 1000) / 1000, pitch: Math.round(s.data.pitch * 1000) / 1000 }; },
    remove(s) { if (seat.s === s) stand(false); },
  };

  // ---------------------------------------------------------------------------
  // Module
  // ---------------------------------------------------------------------------
  G.register({
    name: 'pirates',
    order: 55,

    init() {
      assets();
      buildCannonGeos();
      shipM = buildShip();
      G.scene.add(shipM.root);
      shipM.skirt = buildSkirt();
      G.scene.add(shipM.skirt.mesh);
      boatM = buildBoat();
      G.scene.add(boatM.root);
      boarderModels = FIG_VARIANTS.map((v) => {
        const m = makeBoarderModel(v);
        G.scene.add(m.root);
        return m;
      });
      buildWake();
      G.scene.add(wake.mesh);
      // trajectory preview dots + landing ring
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(100 * 3), 3));
      pg.attributes.position.setUsage(THREE.DynamicDrawUsage);
      preview = new THREE.Points(pg, M.dots);
      preview.frustumCulled = false;
      preview.renderOrder = 6;
      preview.visible = false;
      G.scene.add(preview);
      aimRing = new THREE.Mesh(GEO.aimRing, M.aimRing);
      aimRing.renderOrder = 6;
      aimRing.visible = false;
      G.scene.add(aimRing);
      aimMark = new THREE.Sprite(M.aimMark);
      aimMark.renderOrder = 11;
      aimMark.visible = false;
      G.scene.add(aimMark);

      if (G.raft && typeof G.raft.registerStructure === 'function') G.raft.registerStructure('cannon', cannonDef);
      precompile();

      window.addEventListener('keydown', onKeyCapture, true);
      G.events.on('inventory:changed', () => { ammoCache = ammo(); });
      G.events.on('game:paused', () => { if (seat.active) stand(true); });
      G.events.on('game:over', () => { if (seat.active) stand(true); });
      G.events.on('game:menu', () => { clearRaid(true); });
    },

    reset() {
      clearRaid(true);
      API.active = false;
      API.nextRaidAt = FIRST_RAID;
      checkT = CHECK_EVERY;
      boardingAnnounced = false;
      raidNo = 0;
      ringTipShown = false;
      boardT = 0; gaveUp = false; shoveCd = 0;
      makeTune();
      ammoCache = ammo();
      seat.unblock = 0;
      if (G.interaction.blocked && !seat.active) G.interaction.blocked = false;
    },

    save() {
      // a raid in progress is not saved: after loading, the pirates come back a bit later
      const next = API.active ? Math.max(API.nextRaidAt, G.time + 300) : API.nextRaidAt;
      return { nextRaidAt: Math.round(next), raids: raidNo, ringTip: ringTipShown ? 1 : 0 };
    },

    load(d) {
      if (!d || typeof d !== 'object') return;
      const n = Number(d.nextRaidAt);
      if (Number.isFinite(n)) API.nextRaidAt = n;
      const r = Number(d.raids);
      if (Number.isFinite(r) && r >= 0) raidNo = Math.floor(r);
      ringTipShown = !!d.ringTip;
      ammoCache = ammo();
    },

    update(dt) {
      frameNo++;
      if (seat.unblock > 0) {
        seat.unblock--;
        if (seat.unblock === 0 && !seat.active) G.interaction.blocked = false;
      }
      if (seat.active) {
        const P = player();
        if (!P || P.controlOverride !== override) stand(true);
      }
      // raid scheduling
      if (!API.active) {
        checkT -= dt;
        if (checkT <= 0) raidCheck();
      }
      updateShip(dt);
      updateBoat(dt);
      updateBoarders(dt);
      updateBalls(dt);
      updateRings(dt);
      checkRaidEnd();
      if (!seat.active && preview && preview.visible) { preview.visible = false; aimRing.visible = false; aimMark.visible = false; }
    },
  });

  // ---------------------------------------------------------------------------
  // Debug
  // ---------------------------------------------------------------------------
  // G.debug.pirates()        → start a raid now (ship sails in from the horizon)
  // G.debug.pirates('near')  → start a raid with the ship already circling at ~40 m
  G.debug.pirates = (mode) => {
    const near = mode === 'near' || (mode && mode.near);
    if (API.active) clearRaid(false);
    const ok = spawnRaid({ near });
    return ok ? { state: ship.state, x: Math.round(ship.position.x), z: Math.round(ship.position.z), hp: ship.hp } : false;
  };
})();
