// creatures.js — the shark (G.shark: model, wake, state machine, combat target) and cosmetic
// seagulls circling overhead in daytime. Contract: ../DESIGN.md §6 "creatures.js".
// Registers as module 'creatures' (order 50).
(function () {
  'use strict';

  const G = window.G;
  if (!G) return;

  const TAU = Math.PI * 2, HALF_PI = Math.PI / 2;
  const TILE = G.C.TILE;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));
  const lerp = (a, b, t) => a + (b - a) * t;
  const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const R = (a, b) => a + Math.random() * (b - a);
  const num = (v, d) => { v = Number(v); return Number.isFinite(v) ? v : d; };

  // ---------------------------------------------------------------------------
  // Tuning
  // ---------------------------------------------------------------------------
  const APPEAR_AT = 90;           // seconds of play before the shark shows up
  const MAX_HP = 100;
  const HIT_RADIUS = 1.2;
  const SCALE = 1.12;             // model scale (the model is built ~3.8 m long)
  const HEAD_Z = 1.75 * SCALE;    // nose ahead of the body centre (m)
  const HEAD_HIT_Z = 1.35 * SCALE; // combat position ahead of the centre
  const BITE_OVERLAP = 0.42;      // how far the (unpitched) nose would reach over the tile edge;
                                  // the head is lifted while biting, so the real overlap is ~0.2 m
  const APPROACH = 5;             // lining-up point in front of the edge
  const BITE_TIME = 8;            // max seconds biting one tile
  const BITE_DMG = 10;            // per chomp (one chomp per second → 10/s)
  const PLAYER_DMG = 20, PLAYER_CD = 2;
  const FLEE_TIME = 30;
  const RESPAWN = 180;
  const FLOAT_TIME = 40;          // dead body floats this long before it sinks
  const GULLS = 5;

  // Scratch objects (no per-frame allocations)
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _hp = new THREE.Vector3();
  const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
  const _s = new THREE.Vector3(), _e = new THREE.Euler();
  const UP = new THREE.Vector3(0, 1, 0);

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function waveH(x, z) {
    const W = G.world;
    if (W && typeof W.waveHeight === 'function') { const h = W.waveHeight(x, z); return Number.isFinite(h) ? h : 0; }
    return 0;
  }
  function lightK() { const W = G.world; return W && Number.isFinite(W.lightLevel) ? W.lightLevel : 1; }
  function isNight() { const W = G.world; return !!(W && typeof W.isNight === 'function' && W.isNight()); }
  function sfx(name, pos, vol) {
    const o = {};
    if (pos) o.position = pos.clone();
    if (vol != null) o.volume = vol;
    G.sfx(name, o);
  }
  function fx(name, pos, a, b) {
    const F = G.fx;
    if (!F || typeof F[name] !== 'function') return;
    try { F[name](pos, a, b); } catch (err) { /* cosmetic only */ }
  }
  function banner(text, kind, secs) {
    const U = G.ui;
    if (U && typeof U.banner === 'function') {
      try { U.banner(text, kind, secs); return; } catch (err) { /* fall back to a notification */ }
    }
    G.notify(text, kind);
  }

  // ---------------------------------------------------------------------------
  // Geometry builder (vertex-coloured, merged)
  // ---------------------------------------------------------------------------
  const _bq = new THREE.Quaternion(), _bm = new THREE.Matrix4(), _bp = new THREE.Vector3(), _bs = new THREE.Vector3();
  const _be = new THREE.Euler(), _ba = new THREE.Vector3(), _bb = new THREE.Vector3(), _bc = new THREE.Vector3();
  const colorCache = new Map();
  function rgb(c) {
    let v = colorCache.get(c);
    if (!v) { const k = new THREE.Color(c); v = [k.r, k.g, k.b]; colorCache.set(c, v); }
    return v;
  }
  function Builder() { this.p = []; this.c = []; }
  Builder.prototype.tri = function (a, b, c, col) {
    const k = rgb(col);
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.c.push(k[0], k[1], k[2], k[0], k[1], k[2], k[0], k[1], k[2]);
  };
  Builder.prototype.quad = function (a, b, c, d, col) { this.tri(a, b, c, col); this.tri(a, c, d, col); };
  Builder.prototype.geo = function (g, col, x, y, z, rx, ry, rz, sx, sy, sz) {
    _be.set(rx || 0, ry || 0, rz || 0);
    _bq.setFromEuler(_be);
    _bm.compose(_bp.set(x || 0, y || 0, z || 0), _bq, _bs.set(sx || 1, sy || sx || 1, sz || sx || 1));
    const ng = g.index ? g.toNonIndexed() : g;
    ng.applyMatrix4(_bm);
    const a = ng.attributes.position.array, k = rgb(col);
    for (let i = 0; i < a.length; i += 3) { this.p.push(a[i], a[i + 1], a[i + 2]); this.c.push(k[0], k[1], k[2]); }
    if (ng !== g) ng.dispose();
    g.dispose();
  };
  // Thin fin: convex polygon extruded ±off, the thickness scaled per vertex by `tk` (taper).
  Builder.prototype.fin = function (pts, off, col, tk) {
    _ba.set(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]);
    _bb.set(pts[2][0] - pts[0][0], pts[2][1] - pts[0][1], pts[2][2] - pts[0][2]);
    _bc.crossVectors(_ba, _bb);
    let order = pts.map((p, i) => i);
    if (_bc.x * off[0] + _bc.y * off[1] + _bc.z * off[2] < 0) order = order.reverse();
    const n = pts.length, Fr = [], Bk = [];
    for (let q = 0; q < n; q++) {
      const i = order[q], p = pts[i], t = tk ? tk[i] : 1;
      Fr.push([p[0] + off[0] * t, p[1] + off[1] * t, p[2] + off[2] * t]);
      Bk.push([p[0] - off[0] * t, p[1] - off[1] * t, p[2] - off[2] * t]);
    }
    for (let i = 1; i < n - 1; i++) {
      this.tri(Fr[0], Fr[i], Fr[i + 1], col);
      this.tri(Bk[0], Bk[i + 1], Bk[i], col);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.quad(Fr[i], Bk[i], Bk[j], Fr[j], col);
      this.quad(Fr[i], Fr[j], Bk[j], Bk[i], col);
    }
  };
  // Lofted body along +Z. rings: [z, halfWidth, halfHeight, yCentre] from tail to nose.
  Builder.prototype.loft = function (rings, sides, colorFn, tailPt, nosePt, belly) {
    const verts = [];
    for (let r = 0; r < rings.length; r++) {
      const [z, w, h, yc] = rings[r];
      const ring = [];
      for (let k = 0; k < sides; k++) {
        const a = HALF_PI - (k / sides) * TAU;
        const s = Math.sin(a);
        ring.push([Math.cos(a) * w, yc + s * h * (s < 0 ? (belly || 1) : 1), z]);
      }
      verts.push(ring);
    }
    for (let r = 0; r < rings.length - 1; r++) {
      for (let k = 0; k < sides; k++) {
        const k2 = (k + 1) % sides;
        const A = verts[r][k], B = verts[r][k2], C = verts[r + 1][k2], D = verts[r + 1][k];
        const col = colorFn(Math.sin(HALF_PI - ((k + 0.5) / sides) * TAU), r);
        this.tri(A, C, B, col);
        this.tri(A, D, C, col);
      }
    }
    const last = verts.length - 1;
    for (let k = 0; k < sides; k++) {
      const k2 = (k + 1) % sides;
      const s = Math.sin(HALF_PI - ((k + 0.5) / sides) * TAU);
      if (tailPt) this.tri(tailPt, verts[0][k], verts[0][k2], colorFn(s, -1));
      if (nosePt) this.tri(nosePt, verts[last][k2], verts[last][k], colorFn(s, last));
    }
  };
  Builder.prototype.build = function () {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  };

  // ---------------------------------------------------------------------------
  // Shark model (head along +Z, origin at the body centre)
  // ---------------------------------------------------------------------------
  const SK = { top: '#687d8b', mid: '#98a8b1', belly: '#ebe7db', fin: '#5f7280', dark: '#39474f', eye: '#0d1114',
    mouth: '#6b2a30', tooth: '#f6f3ea' };

  function sharkBodyGeometry() {
    const b = new Builder();
    const rings = [
      [-1.62, 0.045, 0.07, 0.03], [-1.3, 0.085, 0.12, 0.03], [-0.85, 0.16, 0.22, 0.02], [-0.25, 0.26, 0.33, 0.02],
      [0.35, 0.31, 0.37, 0.0], [0.9, 0.27, 0.31, -0.02], [1.25, 0.2, 0.22, -0.03], [1.52, 0.12, 0.13, -0.03],
      [1.68, 0.05, 0.06, -0.02],
    ];
    b.loft(rings, 8, (s) => (s > 0.2 ? SK.top : s > -0.55 ? SK.mid : SK.belly), [0, 0.03, -1.67], [0, -0.03, 1.79], 0.85);
    // dorsal fin (the one that cuts the surface), swept back with a curved trailing edge
    b.fin([[0, 0.3, 0.58], [0, 0.72, 0.08], [0, 0.95, -0.32], [0, 0.6, -0.2], [0, 0.3, -0.36]], [0.05, 0, 0], SK.fin, [1, 0.55, 0.12, 0.4, 1]);
    // second dorsal, anal and pelvic fins
    b.fin([[0, 0.12, -0.88], [0, 0.36, -1.13], [0, 0.11, -1.1]], [0.016, 0, 0], SK.fin, [1, 0.3, 1]);
    b.fin([[0, -0.08, -0.93], [0, -0.07, -1.12], [0, -0.28, -1.16]], [0.014, 0, 0], SK.mid, [1, 1, 0.3]);
    for (const sx of [1, -1]) {
      b.fin([[sx * 0.24, -0.15, 0.8], [sx * 0.21, -0.2, 0.45], [sx * 0.9, -0.44, 0.1]], [0, 0.022, 0], SK.fin, [1, 1, 0.3]);
      b.fin([[sx * 0.12, -0.2, -0.38], [sx * 0.11, -0.2, -0.58], [sx * 0.36, -0.34, -0.7]], [0, 0.012, 0], SK.mid, [1, 1, 0.3]);
    }
    // tail: big upper lobe, smaller lower lobe
    b.fin([[0, 0.09, -1.46], [0, 0.84, -2.1], [0, 0.0, -1.74]], [0.022, 0, 0], SK.fin, [1, 0.25, 1]);
    b.fin([[0, 0.02, -1.5], [0, -0.03, -1.76], [0, -0.5, -1.93]], [0.02, 0, 0], SK.fin, [1, 1, 0.3]);
    // eyes (black with a tiny glint) and gill slits
    for (const sx of [1, -1]) {
      const ex = sx * 0.175, ey = 0.035, ez = 1.3, es = 0.036;
      const A = [ex, ey + es, ez], B = [ex, ey, ez + es], C = [ex, ey - es, ez], D = [ex, ey, ez - es];
      if (sx > 0) b.quad(A, B, C, D, SK.eye); else b.quad(A, D, C, B, SK.eye);
      const gx = ex + sx * 0.002, g = 0.012;
      const A2 = [gx, ey + 0.016 + g, ez + 0.01], B2 = [gx, ey + 0.016, ez + 0.01 + g], C2 = [gx, ey + 0.016 - g, ez + 0.01];
      if (sx > 0) b.tri(A2, B2, C2, '#ffffff'); else b.tri(A2, C2, B2, '#ffffff');
      for (let i = 0; i < 3; i++) {
        const z = 0.98 - i * 0.085, x = sx * (0.262 - i * 0.004);
        const P1 = [x, 0.11, z], P2 = [x, 0.11, z + 0.014], P3 = [x, -0.13, z + 0.03], P4 = [x, -0.13, z + 0.016];
        if (sx > 0) b.quad(P1, P2, P3, P4, SK.dark); else b.quad(P1, P4, P3, P2, SK.dark);
      }
    }
    // mouth roof under the snout (seen when the jaw opens)
    b.tri([0.13, -0.235, 1.02], [-0.13, -0.235, 1.02], [0, -0.2, 1.6], SK.mouth);
    return b.build();
  }

  // Lower jaw, hinge at the origin, pointing +Z. Opens by rotating around X.
  function sharkJawGeometry() {
    const b = new Builder();
    const rings = [[0, 0.165, 0.1], [0.3, 0.13, 0.08], [0.5, 0.075, 0.05]];
    const tip = [0, -0.01, 0.62];
    const ring = (r) => {
      const out = [];
      for (let k = 0; k <= 4; k++) {
        const a = -(k / 4) * Math.PI;           // 0 … −π: the lower half
        out.push([Math.cos(a) * rings[r][1], Math.sin(a) * rings[r][2], rings[r][0]]);
      }
      return out;
    };
    const V = [ring(0), ring(1), ring(2)];
    for (let r = 0; r < 2; r++) {
      for (let k = 0; k < 4; k++) {
        const A = V[r][k], B = V[r][k + 1], C = V[r + 1][k + 1], D = V[r + 1][k];
        const col = k === 0 || k === 3 ? SK.mid : SK.belly;
        b.tri(A, B, C, col);
        b.tri(A, C, D, col);
      }
    }
    for (let k = 0; k < 4; k++) b.tri(V[2][k], V[2][k + 1], tip, k === 0 || k === 3 ? SK.mid : SK.belly);
    // mouth floor (dark), facing up
    for (let r = 0; r < 2; r++) b.quad(V[r][4], V[r + 1][4], V[r + 1][0], V[r][0], SK.mouth);
    b.tri(V[2][4], tip, V[2][0], SK.mouth);
    // teeth along the rim
    for (const sx of [1, -1]) {
      for (let i = 0; i < 5; i++) {
        const t = i / 4, z = 0.08 + t * 0.44;
        const w = lerp(0.155, 0.06, t) * sx;
        const A = [w, 0.0, z - 0.024], B = [w, 0.0, z + 0.024], C = [w * 0.97, 0.065, z];
        b.tri(A, C, B, SK.tooth);
        b.tri(A, B, C, SK.tooth);
      }
    }
    for (const sx of [0.025, -0.025]) {
      const A = [sx - 0.02, 0.0, 0.58], B = [sx + 0.02, 0.0, 0.58], C = [sx, 0.06, 0.575];
      b.tri(A, C, B, SK.tooth);
      b.tri(A, B, C, SK.tooth);
    }
    return b.build();
  }

  function makeWakeTexture() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 128;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 64, 128);
    const grd = g.createRadialGradient(32, 9, 1, 32, 9, 13);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 30);
    for (let i = 0; i < 460; i++) {
      const t = Math.random();
      const y = 6 + t * 118;
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = 32 + side * (3 + t * 27) + (Math.random() - 0.5) * (2 + t * 7);
      const a = Math.pow(1 - t, 1.3) * 0.85;
      g.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
      g.beginPath();
      g.arc(x, y, 0.7 + Math.random() * (1.1 + t * 1.6), 0, TAU);
      g.fill();
    }
    for (let i = 0; i < 180; i++) {
      const t = Math.pow(Math.random(), 1.6);
      const y = 8 + t * 64;
      const x = 32 + (Math.random() - 0.5) * (5 + t * 18);
      g.fillStyle = 'rgba(255,255,255,' + ((1 - t) * 0.5).toFixed(3) + ')';
      g.beginPath();
      g.arc(x, y, 0.6 + Math.random() * 1.5, 0, TAU);
      g.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ---------------------------------------------------------------------------
  // Seagull model
  // ---------------------------------------------------------------------------
  function gullBodyGeometry() {
    const b = new Builder();
    const rings = [[-0.26, 0.025, 0.018, 0.01], [-0.14, 0.06, 0.055, 0.0], [0.0, 0.075, 0.07, 0.0], [0.12, 0.06, 0.06, 0.012],
      [0.18, 0.046, 0.05, 0.036], [0.24, 0.04, 0.043, 0.046], [0.285, 0.022, 0.026, 0.046]];
    b.loft(rings, 6, (s, r) => (s > 0.5 && r >= 0 && r < 3 ? '#bfc8d0' : '#f5f5f1'), [0, 0.01, -0.28], [0, 0.045, 0.3], 0.9);
    b.geo(new THREE.CylinderGeometry(0, 0.014, 0.09, 4), '#f0b233', 0, 0.04, 0.335, HALF_PI, 0, 0);
    b.fin([[0, 0.012, -0.2], [0.085, 0.0, -0.37], [-0.085, 0.0, -0.37]], [0, 0.004, 0], '#dde2e6');
    for (const sx of [1, -1]) {
      const ex = sx * 0.036, ey = 0.058, ez = 0.245, es = 0.009;
      const A = [ex, ey + es, ez], B = [ex, ey, ez + es], C = [ex, ey - es, ez], D = [ex, ey, ez - es];
      if (sx > 0) b.quad(A, B, C, D, '#15181b'); else b.quad(A, D, C, B, '#15181b');
    }
    b.geo(new THREE.CylinderGeometry(0.006, 0.006, 0.07, 3), '#d98a3a', 0.025, -0.05, -0.12, 0.9, 0, 0);
    b.geo(new THREE.CylinderGeometry(0.006, 0.006, 0.07, 3), '#d98a3a', -0.025, -0.05, -0.12, 0.9, 0, 0);
    return b.build();
  }
  // Right wing (root at x = 0, span along +X); the left one is mirrored per instance.
  function gullWingGeometry() {
    const b = new Builder();
    const r0 = [0, 0, 0.075], r1 = [0, 0, -0.1], e0 = [0.3, 0.05, 0.085], e1 = [0.3, 0.05, -0.11];
    const w0 = [0.47, 0.035, 0.035], w1 = [0.47, 0.035, -0.13], tip = [0.8, -0.035, -0.13];
    b.quad(r0, e0, e1, r1, '#d3dae0');
    b.quad(e0, w0, w1, e1, '#bac4cc');
    b.tri(w0, tip, w1, '#26292c');
    b.tri([0.47, 0.036, -0.02], [0.62, 0.0, -0.06], [0.47, 0.036, -0.12], '#f2f2ee');
    return b.build();
  }

  // ---------------------------------------------------------------------------
  // Public API (exists at load time)
  // ---------------------------------------------------------------------------
  const pos = new THREE.Vector3(0, -3, 60);
  const S = (G.shark = {
    state: 'away',          // away | circle | attackRaft | attackPlayer | flee | dead
    phase: '',              // attackRaft: approach|lunge|bite|leave · attackPlayer: rush|pass
    hp: MAX_HP,
    maxHp: MAX_HP,
    position: pos,          // body centre (world == raft-relative, the raft never moves in XZ)
    heading: 0,             // yaw, 0 = facing +Z
    speed: 0,
    targetTile: null,       // tile being attacked
    nextAttackIn: 60,       // seconds until the next raft attack (while circling)
    target: null,           // the G.combat target (built at load)
    present() { return S.state !== 'away' && S.state !== 'dead'; },
    alive() { return S.present() && S.hp > 0; },
    headPosition(out) { return headPos(out || new THREE.Vector3()); },
    spawn(dist) { spawnAt(num(dist, 50)); return true; },
    startAttack() { return debugAttack(); },
  });

  // Combat target: 100 hp, positioned at the head so a spear from the deck reaches it while it bites.
  S.target = {
    kind: 'shark',
    radius: HIT_RADIUS,
    getPosition(out) { return headPos(out); },
    alive() { return S.alive(); },
    onHit(damage, dir, source) { hit(damage, dir, source); },
  };
  G.combat.add(S.target);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let built = false, clock = 0;
  let root = null, body = null, bodyBase = null, jaw = null, wake = null, wakeBase = null, sharkMat = null;
  let spd = 0, turnRate = 0, depth = 0.9, ySm = -1, pitch = 0, roll = 0, amp = 0.12, swimPhase = 0;
  let jawOpen = 0, jawSnap = 0, flash = 0, thrash = 0, stateT = 0, slam = 0;
  let circleDir = 1, circleBase = 8.5, dirSwitchT = 40;
  let biteT = 0, chompT = 0, splashT = 0, leaveSide = 1;
  const edgeP = new THREE.Vector3(), biteC = new THREE.Vector3(), approachP = new THREE.Vector3();
  let edgeDX = 0, edgeDZ = 0;
  let passT = 0, noticeT = 0, warnedSwim = false;
  const fleeP = new THREE.Vector3();
  let fleeT = 0;
  let deadT = 0, respawnT = 0, sunk = false;
  let announced = false;

  // Raft footprint cache (tile rectangles)
  const rects = [];
  let rectN = 0, rectCount = -1, rectsDirty = true, nearX = 0, nearZ = 0;
  const raftC = { x: 0, z: 0 };
  let raftRad = 3;

  function refreshRaft() {
    const Rf = G.raft;
    if (!Rf || !Rf.tiles || typeof Rf.tiles.forEach !== 'function') { rectN = 0; return; }
    const n = typeof Rf.count === 'function' ? Rf.count() : Rf.tiles.size;
    if (!rectsDirty && n === rectCount) return;
    rectsDirty = false;
    rectCount = n;
    rectN = 0;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    Rf.tiles.forEach((t) => {
      if (!t) return;
      const x0 = t.i * TILE, z0 = t.j * TILE;
      rects[rectN * 2] = x0;
      rects[rectN * 2 + 1] = z0;
      rectN++;
      if (x0 < minX) minX = x0;
      if (x0 + TILE > maxX) maxX = x0 + TILE;
      if (z0 < minZ) minZ = z0;
      if (z0 + TILE > maxZ) maxZ = z0 + TILE;
    });
    if (!rectN) { raftC.x = raftC.z = 0; raftRad = 1; return; }
    raftC.x = (minX + maxX) / 2;
    raftC.z = (minZ + maxZ) / 2;
    raftRad = 0;
    for (let k = 0; k < rectN; k++) {
      const fx0 = Math.max(Math.abs(rects[k * 2] - raftC.x), Math.abs(rects[k * 2] + TILE - raftC.x));
      const fz0 = Math.max(Math.abs(rects[k * 2 + 1] - raftC.z), Math.abs(rects[k * 2 + 1] + TILE - raftC.z));
      raftRad = Math.max(raftRad, Math.hypot(fx0, fz0));
    }
  }

  // Distance from (x, z) to the nearest raft tile (0 inside). Sets nearX/nearZ.
  function raftDist(x, z) {
    let best = Infinity;
    for (let k = 0; k < rectN; k++) {
      const x0 = rects[k * 2], z0 = rects[k * 2 + 1], x1 = x0 + TILE, z1 = z0 + TILE;
      const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
      const dz = z < z0 ? z0 - z : z > z1 ? z - z1 : 0;
      const d = dx * dx + dz * dz;
      if (d < best) { best = d; nearX = clamp(x, x0, x1); nearZ = clamp(z, z0, z1); }
    }
    return rectN ? Math.sqrt(best) : Infinity;
  }

  function pathBlocked(ax, az, bx, bz, clearance) {
    for (let i = 1; i <= 6; i++) {
      const t = i / 7;
      if (raftDist(lerp(ax, bx, t), lerp(az, bz, t)) < clearance) return true;
    }
    return false;
  }

  function circleRadius() { return Math.max(circleBase + Math.sin(clock * 0.13) * 0.8, raftRad + 4.5); }

  function tileLive(t) {
    const Rf = G.raft;
    return !!(t && Rf && typeof Rf.tileAt === 'function' && Rf.tileAt((t.i + 0.5) * TILE, (t.j + 0.5) * TILE) === t);
  }

  function headPos(out) {
    if (root && root.visible) {
      root.updateMatrixWorld();
      out.set(0, 0.08, 1.35).applyMatrix4(root.matrixWorld);
    } else {
      out.set(pos.x + Math.sin(S.heading) * HEAD_HIT_Z, ySm + 0.08, pos.z + Math.cos(S.heading) * HEAD_HIT_Z);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Build (init)
  // ---------------------------------------------------------------------------
  let gullBody = null, gullWings = null, gullMat = null, gullWingMat = null;
  const gulls = [];
  let gullAway = 1;

  function build() {
    sharkMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.55, metalness: 0.05 });
    root = new THREE.Group();
    root.name = 'shark';
    root.rotation.order = 'YXZ';
    root.scale.setScalar(SCALE);
    const bg = sharkBodyGeometry();
    bodyBase = Float32Array.from(bg.attributes.position.array);
    bg.attributes.position.setUsage(THREE.DynamicDrawUsage);
    bg.boundingSphere.radius += 0.6;
    body = new THREE.Mesh(bg, sharkMat);
    body.castShadow = true;
    root.add(body);
    jaw = new THREE.Mesh(sharkJawGeometry(), sharkMat);
    jaw.position.set(0, -0.155, 0.98);
    jaw.castShadow = true;
    root.add(jaw);
    root.visible = false;
    G.scene.add(root);

    // V-shaped foam wake behind the fin, draped over the waves every frame
    const wg = new THREE.PlaneGeometry(2.4, 4.2, 4, 8);
    wg.rotateX(-HALF_PI);
    wg.rotateY(Math.PI);
    wg.translate(0, 0, -2.0);
    wakeBase = Float32Array.from(wg.attributes.position.array);
    wg.attributes.position.setUsage(THREE.DynamicDrawUsage);
    wg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 12);
    wake = new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ map: makeWakeTexture(), transparent: true, depthWrite: false, opacity: 0.8 }));
    wake.name = 'shark-wake';
    wake.renderOrder = 3;
    wake.frustumCulled = false;
    wake.visible = false;
    G.scene.add(wake);

    // seagulls: bodies + wings as two instanced meshes
    // a little self-light so the white undersides do not turn dark against the bright sky
    gullMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0, emissive: 0x4a4e52 });
    gullWingMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, emissive: 0x4a4e52 });
    const gmat = gullMat, wmat = gullWingMat;
    gullBody = new THREE.InstancedMesh(gullBodyGeometry(), gmat, GULLS);
    gullWings = new THREE.InstancedMesh(gullWingGeometry(), wmat, GULLS * 2);
    for (const m of [gullBody, gullWings]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      m.visible = false;
      G.scene.add(m);
    }
    gullBody.name = 'gulls';
    gullWings.name = 'gull-wings';
    built = true;
  }

  // Tail sway: bend the body sideways, more towards the tail (flat shading needs no normals).
  function bendBody(a, ph) {
    const attr = body.geometry.attributes.position, arr = attr.array, B = bodyBase;
    for (let i = 0; i < arr.length; i += 3) {
      const z = B[i + 2];
      let w = (0.75 - z) / 2.35;
      if (w <= 0) { arr[i] = B[i]; continue; }
      if (w > 1.25) w = 1.25;
      arr[i] = B[i] + a * w * Math.sqrt(w) * Math.sin(ph - z * 1.9);
    }
    attr.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // Movement helpers
  // ---------------------------------------------------------------------------
  function steer(tx, tz, speed, turn, dt) {
    const want = Math.atan2(tx - pos.x, tz - pos.z);
    const diff = wrapPi(want - S.heading);
    const d = clamp(diff, -turn * dt, turn * dt);
    S.heading = wrapPi(S.heading + d);
    turnRate = dt > 0 ? d / dt : 0;
    const slow = 1 - 0.45 * Math.min(1, Math.abs(diff) / Math.PI);
    spd = damp(spd, speed * slow, 1.8, dt);
  }
  function move(dt) {
    pos.x += Math.sin(S.heading) * spd * dt;
    pos.z += Math.cos(S.heading) * spd * dt;
    S.speed = spd;
  }
  // Keep the body (and optionally the head) out of the raft footprint.
  function keepOff(minC, minH, dt) {
    if (!rectN) return;
    const maxPush = Math.max(0.05, 8 * dt);
    const d = raftDist(pos.x, pos.z);
    if (d < minC) {
      let nx = pos.x - nearX, nz = pos.z - nearZ, l = Math.hypot(nx, nz);
      if (l < 1e-4) {
        nx = pos.x - raftC.x; nz = pos.z - raftC.z; l = Math.hypot(nx, nz);
        if (l < 1e-4) { nx = 1; nz = 0; l = 1; }
      }
      const push = Math.min(minC - d, maxPush);
      pos.x += (nx / l) * push;
      pos.z += (nz / l) * push;
    }
    if (minH !== null && minH !== undefined) {
      const sx = Math.sin(S.heading), sz = Math.cos(S.heading);
      const dh = raftDist(pos.x + sx * HEAD_Z, pos.z + sz * HEAD_Z);
      if (dh < minH) {
        const back = Math.min(minH - dh, maxPush);
        pos.x -= sx * back;
        pos.z -= sz * back;
        spd = Math.min(spd, 1.2);
      }
    }
  }

  // Islands: is there (non-raft) ground shallower than `depth` below the surface here?
  function shallow(x, z, depth) {
    const gr = G.ground;
    if (!gr || !gr.providers) return false;
    const list = gr.providers;
    let lim = NaN;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || p.kind === 'raft') continue;
      let h;
      try { h = p.heightAt(x, z); } catch (err) { continue; }
      if (h === null || h === undefined) continue;
      if (lim !== lim) lim = waveH(x, z) - depth;
      if (h > lim) return true;
    }
    return false;
  }
  // The shark keeps to deep water: it turns away from island shallows instead of beaching.
  let landTurn = 1;
  function avoidLand(dt) {
    const sx = Math.sin(S.heading), sz = Math.cos(S.heading);
    if (!shallow(pos.x + sx * HEAD_Z * 1.6, pos.z + sz * HEAD_Z * 1.6, 1.4)) { landTurn = G.chance(0.5) ? 1 : -1; return; }
    S.heading = wrapPi(S.heading + landTurn * 2.8 * dt);
    spd = Math.min(spd, 2.2);
    if (shallow(pos.x + sx * HEAD_Z, pos.z + sz * HEAD_Z, 1.0)) {
      pos.x -= sx * Math.min(0.5, 4 * dt);
      pos.z -= sz * Math.min(0.5, 4 * dt);
    }
  }

  // ---------------------------------------------------------------------------
  // States
  // ---------------------------------------------------------------------------
  function setState(s, phase) {
    S.state = s;
    S.phase = phase || '';
    stateT = 0;
  }

  function spawnAt(dist, angle) {
    refreshRaft();
    const a = angle === undefined ? R(0, TAU) : angle;
    pos.set(raftC.x + Math.cos(a) * dist, 0, raftC.z + Math.sin(a) * dist);
    S.heading = Math.atan2(raftC.x - pos.x, raftC.z - pos.z) + R(-0.5, 0.5);
    setState('circle');
    S.hp = MAX_HP;
    S.targetTile = null;
    S.nextAttackIn = R(45, 80);
    spd = 2.5;
    depth = 1.1;
    ySm = waveH(pos.x, pos.z) - depth;
    pitch = 0; roll = 0; jawOpen = 0; flash = 0; thrash = 0;
    circleDir = G.chance(0.5) ? 1 : -1;
    circleBase = R(7, 10);
    dirSwitchT = R(30, 60);
    deadT = 0; sunk = false;
    if (root) root.visible = true;
  }

  function toCircle() {
    setState('circle');
    S.targetTile = null;
  }

  function updateCircle(dt, canAttack) {
    const Rc = circleRadius();
    const ax = pos.x - raftC.x, az = pos.z - raftC.z;
    const ang = Math.atan2(az, ax), dist = Math.hypot(ax, az);
    const far = dist > Rc + 8;
    const ahead = ang + circleDir * (far ? 0.25 : 0.55);
    steer(raftC.x + Math.cos(ahead) * Rc, raftC.z + Math.sin(ahead) * Rc, far ? 3.8 : 2.5, 1.15, dt);
    dirSwitchT -= dt;
    if (dirSwitchT <= 0) { dirSwitchT = R(30, 70); circleDir = -circleDir; }
    if (!announced && canAttack && dist < Rc + 4) {
      announced = true;
      G.notify('Kolem voru krouží žralok! Radši nelez do vody.', 'warn');
    }
    if (canAttack) {
      S.nextAttackIn -= dt;
      if (S.nextAttackIn <= 0 && !startAttackRaft()) S.nextAttackIn = R(10, 18);
    }
  }

  // Pick the open side of tile t and plan the bite pose. Returns false if there is no good side.
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  function planBite(t) {
    const Rf = G.raft;
    if (!t || t.reinforced || !Rf || typeof Rf.tileAt !== 'function') return false;
    const cx = (t.i + 0.5) * TILE, cz = (t.j + 0.5) * TILE;
    let best = -Infinity, bd = null;
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k];
      if (Rf.tileAt(cx + d[0] * TILE, cz + d[1] * TILE)) continue;
      const ex = cx + d[0] * TILE * 0.5, ez = cz + d[1] * TILE * 0.5;
      const reach = HEAD_Z - BITE_OVERLAP;
      const bx = ex + d[0] * reach, bz = ez + d[1] * reach;
      if (raftDist(bx, bz) < reach - 0.3) continue;
      if (raftDist(bx + d[0] * 1.6, bz + d[1] * 1.6) < 1.0) continue;
      if (raftDist(ex + d[0] * APPROACH, ez + d[1] * APPROACH) < APPROACH - 0.8) continue;
      const sx = pos.x - ex, sz = pos.z - ez, sl = Math.hypot(sx, sz) || 1;
      const score = (d[0] * sx + d[1] * sz) / sl + Math.random() * 0.35;
      if (score > best) { best = score; bd = d; }
    }
    if (!bd) return false;
    edgeDX = bd[0]; edgeDZ = bd[1];
    edgeP.set(cx + bd[0] * TILE * 0.5, 0, cz + bd[1] * TILE * 0.5);
    biteC.set(edgeP.x + bd[0] * (HEAD_Z - BITE_OVERLAP), 0, edgeP.z + bd[1] * (HEAD_Z - BITE_OVERLAP));
    approachP.set(edgeP.x + bd[0] * APPROACH, 0, edgeP.z + bd[1] * APPROACH);
    return true;
  }

  function startAttackRaft() {
    const Rf = G.raft;
    if (!Rf || typeof Rf.edgeTiles !== 'function' || !S.present()) return false;
    refreshRaft();
    let t = typeof Rf.randomEdgeTile === 'function' ? Rf.randomEdgeTile() : null;
    if (!t || t.reinforced || !planBite(t)) {
      t = null;
      const edges = Rf.edgeTiles().filter((e) => e && !e.reinforced);
      edges.sort((a, b) => Math.hypot((a.i + 0.5) * TILE - pos.x, (a.j + 0.5) * TILE - pos.z) -
        Math.hypot((b.i + 0.5) * TILE - pos.x, (b.j + 0.5) * TILE - pos.z));
      for (let k = 0; k < edges.length; k++) if (planBite(edges[k])) { t = edges[k]; break; }
      if (!t) return false;          // every edge tile is reinforced: keep circling
    }
    setState('attackRaft', 'approach');
    S.targetTile = t;
    biteT = 0;
    return true;
  }

  function chomp() {
    const t = S.targetTile;
    jawSnap = 0.18;
    slam = 1;
    thrash = Math.min(1.5, thrash + 0.6);
    headPos(_hp);
    if (t && G.raft && typeof G.raft.damageTile === 'function') G.raft.damageTile(t, BITE_DMG, 'shark');
    sfx('shark_bite', _hp, 1);
    _v.set(edgeP.x + edgeDX * 0.3, waveH(edgeP.x, edgeP.z), edgeP.z + edgeDZ * 0.3);
    fx('splash', _v, 0.8);
  }

  function updateAttackRaft(dt) {
    const t = S.targetTile;
    // the tile is gone, got reinforced, or the bitten side was built over: give up
    if (S.phase !== 'leave' && (!tileLive(t) || t.reinforced ||
      (G.raft.tileAt(edgeP.x + edgeDX * 0.6, edgeP.z + edgeDZ * 0.6)))) { startLeave(); }
    switch (S.phase) {
      case 'approach': {
        if (pathBlocked(pos.x, pos.z, approachP.x, approachP.z, 1.6)) {
          // swim around the raft until the lining-up point is in clear water
          const aS = Math.atan2(pos.z - raftC.z, pos.x - raftC.x);
          const aT = Math.atan2(approachP.z - raftC.z, approachP.x - raftC.x);
          const step = clamp(wrapPi(aT - aS), -0.6, 0.6);
          const Rc = circleRadius();
          steer(raftC.x + Math.cos(aS + step) * Rc, raftC.z + Math.sin(aS + step) * Rc, 3.4, 1.5, dt);
        } else {
          steer(approachP.x, approachP.z, 3.6, 1.8, dt);
        }
        move(dt);
        keepOff(1.2, 0.8, dt);
        if (Math.hypot(pos.x - approachP.x, pos.z - approachP.z) < 1.4) { S.phase = 'lunge'; stateT = 0; }
        else if (stateT > 30) { toCircle(); S.nextAttackIn = R(20, 35); }
        break;
      }
      case 'lunge': {
        const d = Math.hypot(biteC.x - pos.x, biteC.z - pos.z);
        steer(biteC.x, biteC.z, clamp(d * 2 + 0.9, 0.9, 5.2), 3.4, dt);
        move(dt);
        keepOff(0.9, null, dt);
        if (d < 0.4 || stateT > 7) {
          S.phase = 'bite';
          biteT = 0;
          chompT = 0.55;
          splashT = 0;
          G.events.emit('shark:attack', { target: 'raft', tile: t });
          banner('Žralok útočí na vor!', 'danger', 3);
          sfx('splash_big', biteC, 0.7);
        }
        break;
      }
      case 'bite': {
        biteT += dt;
        pos.x = damp(pos.x, biteC.x, 6, dt);
        pos.z = damp(pos.z, biteC.z, 6, dt);
        const want = Math.atan2(-edgeDX, -edgeDZ);
        const diff = wrapPi(want - S.heading);
        S.heading = wrapPi(S.heading + diff * (1 - Math.exp(-6 * dt)));
        turnRate = 0;
        spd = damp(spd, 0, 6, dt);
        S.speed = spd;
        chompT -= dt;
        if (chompT <= 0) { chompT += 1.0; chomp(); }
        splashT -= dt;
        if (splashT <= 0) {
          splashT = R(0.22, 0.34);
          _v.set(pos.x + R(-0.6, 0.6), 0, pos.z + R(-0.6, 0.6));
          _v.y = waveH(_v.x, _v.z);
          fx('splash', _v, R(0.25, 0.45));
        }
        if (biteT >= BITE_TIME) startLeave();
        break;
      }
      case 'leave':
      default: {
        const px = -edgeDZ * leaveSide, pz = edgeDX * leaveSide;
        steer(biteC.x + edgeDX * 6 + px * 4, biteC.z + edgeDZ * 6 + pz * 4, 3.2, 2.2, dt);
        move(dt);
        keepOff(0.9, 0.1, dt);
        if (stateT > 2.5) { toCircle(); S.nextAttackIn = R(45, 80); }
        break;
      }
    }
  }

  function startLeave() {
    S.phase = 'leave';
    stateT = 0;
    leaveSide = G.chance(0.5) ? 1 : -1;
    S.targetTile = null;
  }

  function startAttackPlayer() {
    setState('attackPlayer', 'rush');
    S.targetTile = null;
    passT = 0;
    noticeT = 0.6;
    G.events.emit('shark:attack', { target: 'player' });
    if (!warnedSwim) { warnedSwim = true; banner('Žralok! Rychle z vody!', 'danger', 2.5); }
  }

  function updateAttackPlayer(dt) {
    const P = G.player;
    const inW = !!(P && P.alive !== false && P.inWater && P.position);
    if (!inW && S.phase !== 'pass') { toCircle(); return; }
    const sx = Math.sin(S.heading), sz = Math.cos(S.heading);
    if (S.phase === 'rush') {
      noticeT -= dt;
      const pv = P.velocity;
      const tx = P.position.x + (pv ? pv.x * 0.35 : 0), tz = P.position.z + (pv ? pv.z * 0.35 : 0);
      steer(tx, tz, noticeT > 0 ? 3 : 6.3, 2.6, dt);
      move(dt);
      keepOff(1.0, 0.05, dt);
      const mx = pos.x + sx * (HEAD_Z - 0.15), mz = pos.z + sz * (HEAD_Z - 0.15);
      if (Math.hypot(P.position.x - mx, P.position.z - mz) < 1.05) {
        _v.set(sx, 0, sz);
        if (typeof P.damage === 'function') P.damage(PLAYER_DMG, 'shark', _v);
        _hp.set(P.position.x, waveH(P.position.x, P.position.z), P.position.z);
        fx('blood', _hp);
        fx('splash', _hp, 0.9);
        sfx('shark_bite', _hp, 1);
        jawSnap = 0.2;
        thrash = 1.2;
        S.phase = 'pass';
        passT = 0;
      }
    } else {
      passT += dt;
      if (passT < 0.8 || !inW) {
        steer(pos.x + sx * 5, pos.z + sz * 5, 4.5, 0.8, dt);
      } else {
        // curve round for another run
        const ox = pos.x - P.position.x, oz = pos.z - P.position.z, l = Math.hypot(ox, oz) || 1;
        const a = Math.atan2(oz, ox) + 0.9;
        steer(P.position.x + Math.cos(a) * 6, P.position.z + Math.sin(a) * 6, 3.8, 2.0, dt);
      }
      move(dt);
      keepOff(1.0, 0.2, dt);
      if (passT >= PLAYER_CD) {
        if (inW) { S.phase = 'rush'; noticeT = 0; } else toCircle();
      }
    }
  }

  function startFlee() {
    setState('flee');
    S.targetTile = null;
    fleeT = FLEE_TIME;
    let ax = pos.x - raftC.x, az = pos.z - raftC.z;
    let l = Math.hypot(ax, az);
    if (l < 1e-3) { ax = Math.sin(S.heading); az = Math.cos(S.heading); l = 1; }
    const a = Math.atan2(az / l, ax / l) + R(-0.35, 0.35);
    fleeP.set(pos.x + Math.cos(a) * 60, 0, pos.z + Math.sin(a) * 60);
    thrash = 1.5;
    headPos(_hp);
    _hp.y = waveH(_hp.x, _hp.z);
    fx('splash', _hp, 1.1);
    sfx('splash_big', _hp, 0.8);
    G.events.emit('shark:fled');
  }

  function updateFlee(dt) {
    fleeT -= dt;
    if (Math.hypot(fleeP.x - pos.x, fleeP.z - pos.z) < 5) {
      const a = R(0, TAU);
      fleeP.set(pos.x + Math.cos(a) * 25, 0, pos.z + Math.sin(a) * 25);
      if (Math.hypot(fleeP.x - raftC.x, fleeP.z - raftC.z) < 40) fleeP.set(pos.x - Math.cos(a) * 25, 0, pos.z - Math.sin(a) * 25);
    }
    steer(fleeP.x, fleeP.z, stateT < 4 ? 7.2 : 3.8, 2.6, dt);
    move(dt);
    keepOff(1.0, 0.3, dt);
    if (fleeT <= 0) { toCircle(); S.nextAttackIn = R(45, 80); }
  }

  function hit(damage, dir, source) {
    if (!S.alive()) return;
    damage = Number(damage) || 0;
    if (damage <= 0) return;
    S.hp = Math.max(0, S.hp - damage);
    flash = 1;
    headPos(_hp);
    fx('blood', _hp);
    fx('splash', _hp, 0.6);
    if (S.hp <= 0) die();
    else startFlee();
  }

  function die() {
    setState('dead');
    S.hp = 0;
    S.targetTile = null;
    deadT = 0;
    sunk = false;
    respawnT = RESPAWN;
    thrash = 1.5;
    G.stats.sharksKilled = (G.stats.sharksKilled || 0) + 1;
    G.events.emit('shark:killed');
    // the meat floats up beside the body
    const px = -Math.cos(S.heading), pz = Math.sin(S.heading);
    _v.set(pos.x + px * 1.3, 0, pos.z + pz * 1.3);
    _v.y = waveH(_v.x, _v.z);
    if (G.debris && typeof G.debris.spawnItem === 'function') {
      try { G.debris.spawnItem('zralok_maso', 3, _v); } catch (err) { console.error('[creatures] spawnItem failed', err); }
    }
    _hp.set(pos.x, waveH(pos.x, pos.z), pos.z);
    fx('splash', _hp, 1.6);
    fx('blood', _hp);
    sfx('splash_big', _hp, 1);
    G.notify('Žralok je poražený! Jeho maso plave ve vodě – chyť ho hákem.', 'good');
  }

  function updateDead(dt) {
    deadT += dt;
    respawnT -= dt;
    if (!sunk) {
      const W = G.world;
      const k = deadT < FLOAT_TIME ? 1 : 0.4;
      if (W && W.driftVelocity) { pos.x += W.driftVelocity.x * k * dt; pos.z += W.driftVelocity.z * k * dt; }
      keepOff(1.3, null, dt);          // the body floats past the raft, not under it
      spd = damp(spd, 0, 2, dt);
      S.speed = spd;
      if (deadT > FLOAT_TIME + 10) {
        sunk = true;
        if (root) root.visible = false;
      }
    }
    if (respawnT <= 0) spawnAt(R(65, 80));
  }

  function debugAttack() {
    if (!S.present()) spawnAt(circleRadius() + 1);
    if (S.state === 'attackRaft') return true;
    if (S.state !== 'circle') toCircle();
    return startAttackRaft();
  }

  // ---------------------------------------------------------------------------
  // Pose & effects
  // ---------------------------------------------------------------------------
  function pose(dt) {
    if (!root) return;
    const st = S.state;
    if (st === 'away' || (st === 'dead' && sunk)) {
      root.visible = false;
      wake.visible = false;
      return;
    }
    root.visible = true;
    const surf = waveH(pos.x, pos.z);
    let dT = 0.56, pT = 0, rT = 0, ampT = 0.1 + spd * 0.035, freq = 2.2 + spd * 1.3, jawT = 0.04;
    let yawOff = 0, rollOff = 0, pitchOff = 0;
    thrash = Math.max(0, thrash - dt * 0.9);
    slam = Math.max(0, slam - dt * 3.2);
    switch (st) {
      case 'attackRaft':
        if (S.phase === 'lunge') { dT = 0.42; pT = -0.1; jawT = 0.45; }
        else if (S.phase === 'bite') {
          dT = 0.04; pT = -0.44; ampT = 0.26; freq = 12;
          jawT = chompT > 0.45 ? 0.85 : 0.1;
          yawOff = Math.sin(clock * 16) * 0.2 + Math.sin(clock * 27) * 0.05;
          rollOff = Math.sin(clock * 11.3) * 0.3;
          pitchOff = Math.sin(clock * 9.1) * 0.06 + slam * 0.3;   // the head slams down on each chomp
        } else dT = 0.54;
        break;
      case 'attackPlayer': {
        dT = S.phase === 'rush' ? 0.44 : 0.62;
        const P = G.player;
        if (S.phase === 'rush' && P && P.position && Math.hypot(P.position.x - pos.x, P.position.z - pos.z) < 5) { jawT = 0.8; pT = -0.08; }
        break;
      }
      case 'flee': dT = stateT < 5 ? 0.62 : 1.6; ampT = 0.2 + spd * 0.03; break;
      case 'dead': {
        dT = deadT < FLOAT_TIME ? 0.16 : 0.16 + (deadT - FLOAT_TIME) * 0.45;
        rT = Math.PI;
        ampT = deadT < 2 ? 0.3 * (1 - deadT / 2) : 0.01;
        freq = 9;
        jawT = 0.35;
        break;
      }
      default: break;
    }
    ampT += thrash * 0.18;
    depth = damp(depth, dT, st === 'dead' ? 1.2 : 2.2, dt);
    ySm = damp(ySm, surf - depth, 6, dt);
    pitch = damp(pitch, pT, 4, dt);
    if (st !== 'dead') rT += clamp(-turnRate * 0.45, -0.4, 0.4);
    roll = damp(roll, rT, st === 'dead' ? 1.6 : 4, dt);
    amp = damp(amp, ampT, 3, dt);
    swimPhase += dt * freq;
    const counter = -Math.sin(swimPhase) * amp * 0.22;
    pos.y = ySm;
    root.position.set(pos.x, ySm, pos.z);
    root.rotation.set(pitch + pitchOff, S.heading + yawOff + counter, roll + rollOff);
    bendBody(amp, swimPhase);
    if (jawSnap > 0) { jawSnap -= dt; jawOpen = damp(jawOpen, 0, 30, dt); }
    else jawOpen = damp(jawOpen, jawT, 9, dt);
    jaw.rotation.x = jawOpen * 0.7;
    flash = Math.max(0, flash - dt * 3.5);
    sharkMat.emissive.setRGB(flash * 0.55, flash * 0.05, flash * 0.05);
    root.updateMatrixWorld();
    updateWake(dt, surf);
  }

  function updateWake(dt, surf) {
    // the dorsal fin tip in world space: is it above the water?
    _v.set(0, 1.0, -0.18).applyMatrix4(root.matrixWorld);
    const finOut = S.state !== 'dead' && _v.y > waveH(_v.x, _v.z) + 0.05;
    const target = finOut ? clamp(0.25 + spd * 0.13, 0.25, 0.9) : 0;
    const op = damp(wake.material.opacity, target, 4, dt);
    wake.material.opacity = op;
    wake.visible = op > 0.02;
    if (!wake.visible) return;
    _v2.set(0, 0, 0.35).applyMatrix4(root.matrixWorld);
    wake.position.set(_v2.x, 0, _v2.z);
    const h = S.heading;
    wake.rotation.set(0, h, 0);
    const ch = Math.cos(h), sh = Math.sin(h);
    const stretch = clamp(0.55 + spd * 0.2, 0.55, 1.6), widen = clamp(0.7 + spd * 0.1, 0.7, 1.3);
    const arr = wake.geometry.attributes.position.array, B = wakeBase;
    for (let i = 0; i < arr.length; i += 3) {
      const lx = B[i] * widen, lz = B[i + 2] * stretch;
      arr[i] = lx;
      arr[i + 2] = lz;
      const wx = wake.position.x + lx * ch + lz * sh, wz = wake.position.z - lx * sh + lz * ch;
      arr[i + 1] = waveH(wx, wz) + 0.035;
    }
    wake.geometry.attributes.position.needsUpdate = true;
    const L = 0.35 + 0.65 * lightK();
    wake.material.color.setRGB(L, L, L);
  }

  // ---------------------------------------------------------------------------
  // Seagulls
  // ---------------------------------------------------------------------------
  function initGulls() {
    gulls.length = 0;
    for (let i = 0; i < GULLS; i++) {
      gulls.push({
        ang: R(0, TAU), angVel: (i % 2 ? 1 : -1) * R(0.22, 0.36), rad: R(9, 22), radT: R(9, 22), alt: R(13, 20), altT: R(13, 20),
        cx: R(-4, 4), cz: R(-4, 4), flapT: R(0, 1.5), nextFlap: R(1, 6), ph: R(0, TAU), wing: 0.15, bank: 0, retarget: R(5, 12),
      });
    }
    gullAway = isNight() ? 1 : 0;
  }

  function updateGulls(dt) {
    if (!gullBody) return;
    const W = G.world;
    const gone = isNight() || !!(W && W.storm > 0.55);
    gullAway = damp(gullAway, gone ? 1 : 0, gone ? 0.25 : 0.35, dt);
    if (gullAway > 0.985 && gone) { gullBody.visible = gullWings.visible = false; return; }
    gullBody.visible = gullWings.visible = true;
    const lk = lightK();
    gullMat.emissive.setRGB(0.3 * lk, 0.31 * lk, 0.33 * lk);
    gullWingMat.emissive.copy(gullMat.emissive);
    const t = clock;
    for (let i = 0; i < gulls.length; i++) {
      const g = gulls[i];
      g.retarget -= dt;
      if (g.retarget <= 0) {
        g.retarget = R(6, 14);
        g.radT = R(9, 24);
        g.altT = R(12, 21);
        if (G.chance(0.2)) g.angVel = -g.angVel;
      }
      g.rad = damp(g.rad, g.radT, 0.25, dt);
      g.alt = damp(g.alt, g.altT, 0.2, dt);
      g.ang += g.angVel * dt;
      const away = gullAway;
      const rr = g.rad * (1 + away * 5), yy = g.alt + away * 30 + Math.sin(t * 0.5 + g.ph) * 0.8;
      const x = raftC.x + g.cx + Math.cos(g.ang) * rr, z = raftC.z + g.cz + Math.sin(g.ang) * rr;
      // tangent heading of the circle
      const vx = -Math.sin(g.ang) * g.angVel, vz = Math.cos(g.ang) * g.angVel;
      const yaw = Math.atan2(vx, vz);
      g.bank = damp(g.bank, clamp(g.angVel * 1.6, -0.55, 0.55), 2, dt);
      // flapping bursts between long glides
      if (g.flapT > 0 || away > 0.05) {
        g.flapT -= dt;
        g.wing = Math.sin(t * 11 + g.ph) * 0.62 + 0.05;
      } else {
        g.nextFlap -= dt;
        g.wing = damp(g.wing, 0.14 + Math.sin(t * 1.4 + g.ph) * 0.05, 6, dt);
        if (g.nextFlap <= 0) { g.nextFlap = R(3, 9); g.flapT = R(0.7, 1.8); }
      }
      const sc = 1.35;
      _e.set(g.flapT > 0 ? -0.08 : 0.04, yaw, g.bank, 'YXZ');
      _q.setFromEuler(_e);
      _m.compose(_v.set(x, yy, z), _q, _s.set(sc, sc, sc));
      gullBody.setMatrixAt(i, _m);
      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? 1 : -1;
        _e.set(0, 0, side * g.wing, 'XYZ');
        _q2.setFromEuler(_e);
        _m2.compose(_v2.set(side * 0.05, 0.03, 0.02), _q2, _s.set(side, 1, 1));
        _m2.premultiply(_m);
        gullWings.setMatrixAt(i * 2 + s, _m2);
      }
    }
    gullBody.count = gulls.length;
    gullWings.count = gulls.length * 2;
    gullBody.instanceMatrix.needsUpdate = true;
    gullWings.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // Main update
  // ---------------------------------------------------------------------------
  function update(dt) {
    clock += dt;
    stateT += dt;
    refreshRaft();
    if (S.state === 'away') {
      if (G.time >= APPEAR_AT) spawnAt(R(50, 60));
      else { pose(dt); return; }
    }
    if (S.state === 'dead') { updateDead(dt); pose(dt); return; }
    const P = G.player;
    const pw = !!(P && P.alive !== false && P.inWater);
    if (!pw) warnedSwim = false;
    if (pw && S.state !== 'flee' && S.state !== 'attackPlayer') startAttackPlayer();
    switch (S.state) {
      case 'circle': updateCircle(dt, true); move(dt); keepOff(1.6, 1.0, dt); break;
      case 'attackRaft': updateAttackRaft(dt); break;
      case 'attackPlayer': updateAttackPlayer(dt); break;
      case 'flee': updateFlee(dt); break;
      default: toCircle(); break;
    }
    if (!(S.state === 'attackRaft' && S.phase === 'bite')) avoidLand(dt);
    pose(dt);
  }

  // Cosmetic motion outside play: the fin circles the raft behind the menu / game-over screen.
  function cosmetic(dt) {
    clock += dt;
    stateT += dt;
    refreshRaft();
    if (S.state === 'dead') { updateDead(dt); pose(dt); return; }
    if (!S.present()) {
      if (G.state !== 'menu') { pose(dt); return; }
      spawnAt(circleRadius(), R(0, TAU));
    }
    if (S.state !== 'circle') toCircle();
    updateCircle(dt, false);
    move(dt);
    keepOff(1.6, 1.0, dt);
    pose(dt);
  }

  G.register({
    name: 'creatures',
    order: 50,

    init() {
      build();
      initGulls();
      G.events.on('build:tile', () => { rectsDirty = true; });
      G.events.on('tile:destroyed', () => { rectsDirty = true; });
    },

    reset() {
      setState('away');
      S.hp = MAX_HP;
      S.targetTile = null;
      S.nextAttackIn = R(45, 80);
      S.heading = 0;
      S.speed = 0;
      pos.set(0, -3, 60);
      spd = 0; turnRate = 0; depth = 1; ySm = -1; pitch = 0; roll = 0; amp = 0.12;
      jawOpen = 0; jawSnap = 0; flash = 0; thrash = 0;
      deadT = 0; respawnT = 0; sunk = false; fleeT = 0; biteT = 0;
      announced = false; warnedSwim = false;
      rectsDirty = true;
      if (root) root.visible = false;
      if (wake) { wake.visible = false; wake.material.opacity = 0; }
      if (built) initGulls();
    },

    save() {
      const st = S.state === 'away' ? 'away' : S.state === 'dead' ? 'dead' : 'alive';
      return { st, hp: Math.round(S.hp), next: Math.round(S.nextAttackIn), respawn: Math.round(respawnT), seen: announced };
    },

    load(d) {
      if (!d || typeof d !== 'object') return;
      announced = !!d.seen;
      if (d.st === 'alive') {
        spawnAt(R(40, 55));
        S.hp = clamp(num(d.hp, MAX_HP), 1, MAX_HP);
        S.nextAttackIn = clamp(num(d.next, 60), 15, 120);
      } else if (d.st === 'dead') {
        setState('dead');
        S.hp = 0;
        deadT = FLOAT_TIME + 20;
        sunk = true;
        respawnT = clamp(num(d.respawn, RESPAWN), 0, RESPAWN);
        if (root) root.visible = false;
      }
    },

    update(dt) { update(dt); },

    frame(dt) {
      if (!built) return;
      if (G.state === 'menu' || (G.state === 'dead' && !G.paused)) cosmetic(dt);
      if (G.state === 'menu' || G.state === 'dead' || G.isPlaying()) updateGulls(dt);
    },
  });

  // ---------------------------------------------------------------------------
  // Debug
  // ---------------------------------------------------------------------------
  G.debug.sharkAttack = () => debugAttack();
  G.debug.sharkSpawn = (dist) => { spawnAt(num(dist, circleRadius())); return true; };
})();
