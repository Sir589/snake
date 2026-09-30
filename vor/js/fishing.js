// fishing.js — the 'rod' tool (charge → cast → wait → bite → catch) and cosmetic fish schools
// swimming under the surface around the raft. Contract: ../DESIGN.md §6 "fishing.js".
// Registers as module 'fishing' (order 45).
(function () {
  'use strict';

  const G = window.G;
  if (!G) return;

  const TAU = Math.PI * 2, HALF_PI = Math.PI / 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const easeOut = (t) => { t = clamp(t, 0, 1); return 1 - (1 - t) * (1 - t); };
  const R = (a, b) => a + Math.random() * (b - a);

  // ---------------------------------------------------------------------------
  // Tuning
  // ---------------------------------------------------------------------------
  const CAST_MIN = 4, CAST_MAX = 16;     // cast distance (m)
  const CHARGE_TIME = 1.0;               // seconds to full power
  const BITE_MIN = 4, BITE_MAX = 12;     // wait for a bite (s)
  const BITE_WINDOW = 1.2;               // time to click after the bite starts (s)
  const LINE_MAX = 20;                   // beyond this the line drags the bobber along
  const LINE_BREAK = 32;                 // beyond this (teleport…) the line is reeled in
  const BOB_G = 16;                      // bobber flight gravity
  const HANG_LEN = 0.24;                 // bobber dangling below the rod tip when not cast
  const HANG_SCALE = 0.42;               // bobber size while dangling near the hand
  const LINE_SEG = 22;
  const CATCH_FLY = 0.55, CATCH_HANG = 1.55, CATCH_END = 1.75;
  const SCHOOLS = 3, PER_SCHOOL = 13;

  const SPECIES = {
    sardinka: { len: 0.2, h: 0.042, w: 0.021, back: '#33638d', side: '#a9c2d4', belly: '#eef4f7', fin: '#6f8ea6',
      weight: 0.3, text: 'Máš sardinku!' },
    makrela: { len: 0.32, h: 0.056, w: 0.031, back: '#2c6c63', side: '#8cb8bc', belly: '#eff1e7', fin: '#4b7a75',
      stripe: '#14303a', weight: 0.55, text: 'Máš makrelu!' },
    tunak: { len: 0.6, h: 0.125, w: 0.085, back: '#1b2d61', side: '#7c90ae', belly: '#e8ecf0', fin: '#26396b',
      accent: '#f4c430', weight: 1, text: 'Máš tuňáka! To je kus!' },
  };
  const WEIGHTS_DAY = [['sardinka', 55], ['makrela', 35], ['tunak', 10]];
  const WEIGHTS_NIGHT = [['sardinka', 45], ['makrela', 35], ['tunak', 20]];

  // Scratch objects (no per-frame allocations)
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
  const _tip = new THREE.Vector3(), _ra = new THREE.Vector3(), _rb = new THREE.Vector3();
  const _cam = new THREE.Vector3(), _fwd = new THREE.Vector3(), _n = new THREE.Vector3();
  const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4();
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
  function waveN(x, z, out) {
    const W = G.world;
    if (W && typeof W.waveNormal === 'function') return W.waveNormal(x, z, out);
    return out.set(0, 1, 0);
  }
  function tileAt(x, z) { const Rf = G.raft; return Rf && typeof Rf.tileAt === 'function' ? Rf.tileAt(x, z) : null; }
  function onRaft(x, z, m) {
    if (tileAt(x, z)) return true;
    if (!m) return false;
    return !!(tileAt(x + m, z) || tileAt(x - m, z) || tileAt(x, z + m) || tileAt(x, z - m));
  }
  // Island ground (not the raft) above the water here?
  function onLand(x, z) {
    const gr = G.ground;
    if (!gr || !gr.providers) return false;
    const s = waveH(x, z);
    const list = gr.providers;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || p.kind === 'raft') continue;
      let h;
      try { h = p.heightAt(x, z); } catch (err) { continue; }
      if (h !== null && h !== undefined && h > s - 0.25) return true;
    }
    return false;
  }
  function lightK() { const W = G.world; return W && Number.isFinite(W.lightLevel) ? W.lightLevel : 1; }
  function isNight() { const W = G.world; return !!(W && typeof W.isNight === 'function' && W.isNight()); }
  function btnL() { return G.input && G.input.touchMode ? '●' : 'Levé tlačítko'; }
  function btnR() { return G.input && G.input.touchMode ? '◐' : 'Pravé tlačítko'; }
  // The bite call must end with '!' (ui.js shows it in the urgent style).
  function biteText() { return G.input && G.input.touchMode ? 'Záběr! Stiskni ●!' : 'Záběr! Klikni!'; }
  function inWater() { const P = G.player; return !!(P && P.inWater); }
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
  function isInScene(o) {
    for (let p = o; p; p = p.parent) if (p === G.scene) return true;
    return false;
  }
  function itemDef(id) { return id && G.items && typeof G.items.def === 'function' ? G.items.def(id) : null; }
  function isRodSlot(slot) { const d = slot && itemDef(slot.id); return !!(d && d.tool === 'rod'); }
  function playerXZ(out) {
    const P = G.player;
    if (P && P.position && P.position.isVector3) return out.copy(P.position);
    if (G.camera) return out.copy(G.camera.position);
    return out.set(0, 0, 0);
  }

  // ---------------------------------------------------------------------------
  // Geometry builder: merges primitives / triangles into one vertex-coloured geometry
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
  Builder.prototype.addGeo = function (g, col, m) {
    const ng = g.index ? g.toNonIndexed() : g;
    if (m) ng.applyMatrix4(m);
    const a = ng.attributes.position.array, k = rgb(col);
    for (let i = 0; i < a.length; i += 3) { this.p.push(a[i], a[i + 1], a[i + 2]); this.c.push(k[0], k[1], k[2]); }
    if (ng !== g) ng.dispose();
    g.dispose();
  };
  Builder.prototype.geo = function (g, col, x, y, z, rx, ry, rz, sx, sy, sz) {
    _be.set(rx || 0, ry || 0, rz || 0);
    _bq.setFromEuler(_be);
    _bm.compose(_bp.set(x || 0, y || 0, z || 0), _bq, _bs.set(sx || 1, sy || sx || 1, sz || sx || 1));
    this.addGeo(g, col, _bm);
  };
  // thin cylinder between two points
  Builder.prototype.stick = function (x0, y0, z0, x1, y1, z1, r, col, sides) {
    _ba.set(x1 - x0, y1 - y0, z1 - z0);
    const len = _ba.length();
    if (len < 1e-5) return;
    _ba.divideScalar(len);
    _bq.setFromUnitVectors(UP, _ba);
    _bm.compose(_bp.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), _bq, _bs.set(1, 1, 1));
    this.addGeo(new THREE.CylinderGeometry(r, r, len, sides || 4, 1, true), col, _bm);
  };
  // Thin fin: convex polygon pts ([x,y,z]…) extruded ±off (half-thickness vector [x,y,z]).
  Builder.prototype.fin = function (pts, off, col) {
    _ba.set(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]);
    _bb.set(pts[2][0] - pts[0][0], pts[2][1] - pts[0][1], pts[2][2] - pts[0][2]);
    _bc.crossVectors(_ba, _bb);
    if (_bc.x * off[0] + _bc.y * off[1] + _bc.z * off[2] < 0) pts = pts.slice().reverse();
    const n = pts.length;
    const F = [], B = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      F.push([p[0] + off[0], p[1] + off[1], p[2] + off[2]]);
      B.push([p[0] - off[0], p[1] - off[1], p[2] - off[2]]);
    }
    for (let i = 1; i < n - 1; i++) {
      this.tri(F[0], F[i], F[i + 1], col);
      this.tri(B[0], B[i + 1], B[i], col);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.quad(F[i], B[i], B[j], F[j], col);
      this.quad(F[i], F[j], B[j], B[i], col);
    }
  };
  // Lofted body along +Z. rings: [z, halfWidth, halfHeight, yCentre] from tail to nose.
  // colorFn(sinAngle, ringIndex) → colour of that face.
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
        const am = HALF_PI - ((k + 0.5) / sides) * TAU;
        const col = colorFn(Math.sin(am), r);
        this.tri(A, C, B, col);
        this.tri(A, D, C, col);
      }
    }
    const last = verts.length - 1;
    for (let k = 0; k < sides; k++) {
      const k2 = (k + 1) % sides;
      const am = HALF_PI - ((k + 0.5) / sides) * TAU;
      if (tailPt) this.tri(tailPt, verts[0][k], verts[0][k2], colorFn(Math.sin(am), -1));
      if (nosePt) this.tri(nosePt, verts[last][k2], verts[last][k], colorFn(Math.sin(am), last));
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

  // A low-poly fish, head along +Z. mouthOrigin: the mouth sits at the origin (hangs from a hook).
  function fishGeometry(sp, mouthOrigin, eyes) {
    const L = sp.len, H = sp.h, W = sp.w;
    const b = new Builder();
    const rings = [
      [-0.44, 0.10, 0.14, 0.0], [-0.32, 0.36, 0.42, 0.0], [-0.14, 0.76, 0.82, 0.02], [0.06, 1.0, 1.0, 0.03],
      [0.24, 0.92, 0.88, 0.02], [0.37, 0.64, 0.62, 0.0], [0.46, 0.3, 0.3, -0.06],
    ].map((r) => [r[0] * L, r[1] * W, r[2] * H, r[3] * H]);
    b.loft(rings, 6, (s, r) => {
      if (s > 0.5) return sp.stripe && r >= 0 && r < 5 && (r % 2 === 1) ? sp.stripe : sp.back;
      if (s < -0.5) return sp.belly;
      return sp.side;
    }, [0, 0, -0.47 * L], [0, -0.07 * H, 0.5 * L], 0.9);
    // forked tail
    const zt = -0.44 * L, ze = -0.66 * L, zn = -0.56 * L, tail = sp.accent ? sp.fin : sp.fin;
    const off = [0.004 + W * 0.05, 0, 0];
    b.fin([[0, 0.12 * H, zt], [0, 1.2 * H, ze], [0, 0, zn]], off, tail);
    b.fin([[0, -0.12 * H, zt], [0, 0, zn], [0, -1.2 * H, ze]], off, tail);
    b.fin([[0, 0.12 * H, zt], [0, 0, zn], [0, -0.12 * H, zt]], off, tail);
    // dorsal fin(s)
    b.fin([[0, 0.9 * H, 0.16 * L], [0, 1.55 * H, -0.02 * L], [0, 0.9 * H, -0.08 * L]], [0.003, 0, 0], sp.fin);
    if (sp.accent) {
      // tuna: yellow second dorsal + anal fin and little finlets towards the tail
      b.fin([[0, 0.8 * H, -0.12 * L], [0, 1.5 * H, -0.24 * L], [0, 0.6 * H, -0.22 * L]], [0.004, 0, 0], sp.accent);
      b.fin([[0, -0.75 * H, -0.12 * L], [0, -0.6 * H, -0.22 * L], [0, -1.45 * H, -0.24 * L]], [0.004, 0, 0], sp.accent);
      for (let i = 0; i < 3; i++) {
        const z = (-0.28 - i * 0.05) * L, yy = (0.45 - i * 0.09) * H;
        b.fin([[0, yy, z + 0.02 * L], [0, yy + 0.22 * H, z - 0.02 * L], [0, yy - 0.02 * H, z - 0.025 * L]], [0.003, 0, 0], sp.accent);
        b.fin([[0, -yy, z + 0.02 * L], [0, -yy + 0.02 * H, z - 0.025 * L], [0, -yy - 0.22 * H, z - 0.02 * L]], [0.003, 0, 0], sp.accent);
      }
    } else {
      b.fin([[0, -0.85 * H, -0.08 * L], [0, -0.85 * H, -0.2 * L], [0, -1.3 * H, -0.2 * L]], [0.003, 0, 0], sp.fin);
    }
    // pectoral fins
    for (const sx of [1, -1]) {
      b.fin([[sx * 0.7 * W, -0.25 * H, 0.28 * L], [sx * 0.8 * W, -0.3 * H, 0.2 * L], [sx * 1.5 * W, -0.75 * H, 0.12 * L]], [0, 0.003, 0], sp.fin);
    }
    if (eyes) {
      const ez = 0.37 * L, ey = 0.14 * H, es = Math.max(0.006, H * 0.16);
      for (const sx of [1, -1]) {
        const ex = sx * (0.66 * W + 0.002);
        const A = [ex, ey + es, ez], B = [ex, ey, ez + es], C = [ex, ey - es, ez], D = [ex, ey, ez - es];
        if (sx > 0) b.quad(A, B, C, D, '#101318'); else b.quad(A, D, C, B, '#101318');
        const g = es * 0.45, A2 = [ex + sx * 0.0005, ey + es * 0.5 + g, ez + es * 0.2], B2 = [ex + sx * 0.0005, ey + es * 0.5, ez + es * 0.2 + g], C2 = [ex + sx * 0.0005, ey + es * 0.5 - g, ez + es * 0.2];
        if (sx > 0) b.tri(A2, B2, C2, '#ffffff'); else b.tri(A2, C2, B2, '#ffffff');
      }
    }
    const geo = b.build();
    if (mouthOrigin) { geo.translate(0, 0, -0.5 * L); geo.computeBoundingSphere(); }
    return geo;
  }

  // ---------------------------------------------------------------------------
  // Public API (exists at load time)
  // ---------------------------------------------------------------------------
  const bob = new THREE.Vector3();
  const F = (G.fishing = {
    get state() { return st; },   // idle | charging | flying | waiting | bite | reeling | catch
    bobber: bob,              // world position of the bobber (valid while cast)
    species: null,            // fish on the line during a catch
    schools: [],              // cosmetic schools: { position: Vector3, heading, scatter }
    forceBite() { return forceBite(); },
    cancel() { cancelAll(); },
    isCast() { return st === 'flying' || st === 'waiting' || st === 'bite'; },
  });

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let st = 'idle';
  let equipped = false, built = false;
  let clock = 0;
  let chargeT = 0, lastDirX = 0, lastDirZ = -1;
  let flyT = 0, flyDur = 1, flyVy = 0, forcePending = false;
  const flyFrom = new THREE.Vector3(), flyTo = new THREE.Vector3();
  let landT = 0, biteIn = 0, nibbleAt = -1, nibT = 0, biteT = 0, rippleT = 0, splashT = 0, idleRippleT = 0;
  let reelT = 0, reelDur = 0.4, reelArc = 1;
  const reelFrom = new THREE.Vector3();
  let catchT = 0, catchSp = null, caughtDone = false, sparkled = false;
  const catchFrom = new THREE.Vector3(), mouth = new THREE.Vector3();
  let msg = '', msgT = 0;
  let progressShown = false;
  let bobScale = HANG_SCALE, bobTilt = 0;
  const hang = new THREE.Vector3(), hangPrev = new THREE.Vector3();
  let hangInit = false;

  // three.js objects (built in init)
  let matVC = null, matFish = null, matSchool = null;
  let bobber = null, line = null, linePts = null, linePos = null, marker = null;
  const ripples = [];
  const fishMeshes = {};
  let fishMesh = null;
  let schoolMesh = null;
  const vm = { root: null, pivot: null, segs: [], tip: null, spool: null, crank: null,
    lift: 0, bend: 0, whipT: -1, whipFrom: 0, spin: 0, pop: 1 };
  const BEND_K = [0.2, 0.36, 0.58];

  function say(text, secs) { msg = text; msgT = secs || 2.2; }

  function setProgress(v, label) { G.hud.setProgress(v, label); progressShown = true; }
  function clearProgress() { if (progressShown) { G.hud.setProgress(null); progressShown = false; } }

  // Rope start: the rod tip in the view model (falls back to the hand, then the camera).
  function tipWorld(out) {
    if (vm.tip && isInScene(vm.tip)) return vm.tip.getWorldPosition(out);
    const hand = G.player && G.player.hand;
    if (hand && hand.isObject3D && isInScene(hand)) return hand.getWorldPosition(out);
    if (!G.camera) return out.set(0, 1.8, 0);
    return G.camera.localToWorld(out.set(0.3, 0.15, -1.2));
  }
  function vmShown() {
    const hand = G.player && G.player.hand;
    return equipped && !!vm.root && !!vm.root.parent && (!hand || hand.visible !== false) && isInScene(vm.root);
  }

  // ---------------------------------------------------------------------------
  // Build (init)
  // ---------------------------------------------------------------------------
  function mesh(geo, mat) {
    const m = new THREE.Mesh(geo, mat || matVC);
    m.castShadow = false;
    m.receiveShadow = false;
    return m;
  }

  function buildRod() {
    const CORK = '#b88b5b', ROPE = '#dcc38e', DARK = '#4a3322', BRASS = '#c99a3c', BAMBOO = '#d2b672',
      NODE = '#977338', METAL = '#8f969d', LINEC = '#f1ece0', WOODD = '#6b4a2f';
    const root = new THREE.Group();
    root.name = 'rod-view';
    root.rotation.order = 'YXZ';
    const pivot = new THREE.Group();
    root.add(pivot);

    // handle: cork grip, rope wraps, butt cap, brass ferrule, reel foot
    const hb = new Builder();
    hb.geo(new THREE.CylinderGeometry(0.019, 0.022, 0.27, 8), CORK, 0, -0.03, 0);
    hb.geo(new THREE.CylinderGeometry(0.0235, 0.0235, 0.03, 8), ROPE, 0, -0.1, 0);
    hb.geo(new THREE.CylinderGeometry(0.0215, 0.0215, 0.025, 8), ROPE, 0, 0.055, 0);
    hb.geo(new THREE.CylinderGeometry(0.025, 0.021, 0.035, 8), DARK, 0, -0.182, 0);
    hb.geo(new THREE.CylinderGeometry(0.0165, 0.019, 0.05, 8), BRASS, 0, 0.125, 0);
    hb.geo(new THREE.BoxGeometry(0.012, 0.06, 0.036), BRASS, 0, 0.0, -0.034);
    pivot.add(mesh(hb.build()));

    // reel below the rod (−Z local), spinning spool with line, crank on the right
    const reel = new THREE.Group();
    reel.position.set(0, 0.0, -0.07);
    pivot.add(reel);
    const rb = new Builder();
    rb.geo(new THREE.CylinderGeometry(0.043, 0.043, 0.01, 12), WOODD, -0.021, 0, 0, 0, 0, HALF_PI);
    rb.geo(new THREE.CylinderGeometry(0.043, 0.043, 0.01, 12), WOODD, 0.021, 0, 0, 0, 0, HALF_PI);
    rb.geo(new THREE.CylinderGeometry(0.031, 0.031, 0.033, 12), LINEC, 0, 0, 0, 0, 0, HALF_PI);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      rb.geo(new THREE.BoxGeometry(0.046, 0.008, 0.008), BRASS, 0, Math.cos(a) * 0.036, Math.sin(a) * 0.036);
    }
    const spool = mesh(rb.build());
    reel.add(spool);
    const crank = new THREE.Group();
    crank.position.set(0.029, 0, 0);
    reel.add(crank);
    const cb = new Builder();
    cb.geo(new THREE.BoxGeometry(0.006, 0.052, 0.01), BRASS, 0.003, 0.022, 0);
    cb.geo(new THREE.CylinderGeometry(0.0085, 0.0085, 0.026, 6), DARK, 0.017, 0.044, 0, 0, 0, HALF_PI);
    crank.add(mesh(cb.build()));

    // blank: three bamboo segments that bend, with nodes, line guides and the line along them
    const SEG = [{ len: 0.46, r0: 0.0155, r1: 0.0115 }, { len: 0.44, r0: 0.0112, r1: 0.0075 }, { len: 0.4, r0: 0.0072, r1: 0.0034 }];
    let parent = pivot, y0 = 0.15, prevZ = -0.036, prevY = -0.13;
    const segs = [];
    let tip = null;
    for (let i = 0; i < 3; i++) {
      const s = SEG[i];
      const g = new THREE.Group();
      g.position.y = y0;
      parent.add(g);
      const b = new Builder();
      b.geo(new THREE.CylinderGeometry(s.r1, s.r0, s.len, 7), BAMBOO, 0, s.len / 2, 0);
      const nodes = i === 2 ? 2 : 3;
      for (let k = 1; k <= nodes; k++) {
        const yy = (s.len * k) / (nodes + 1);
        const rr = lerp(s.r0, s.r1, yy / s.len) + 0.0022;
        b.geo(new THREE.CylinderGeometry(rr, rr, 0.011, 7), NODE, 0, yy, 0);
      }
      const gr = lerp(0.0115, 0.0065, i / 2);
      const gy = s.len - 0.025, gz = -(s.r1 + gr + 0.004);
      b.geo(new THREE.TorusGeometry(gr, 0.0021, 4, 10), METAL, 0, gy, gz, HALF_PI, 0, 0);
      b.stick(0, gy, -s.r1 * 0.8, 0, gy, gz + gr, 0.0018, METAL);
      b.stick(0, prevY, prevZ, 0, gy, gz, 0.0011, LINEC, 3);
      if (i === 2) b.geo(new THREE.SphereGeometry(0.0055, 6, 4), METAL, 0, s.len, 0);
      g.add(mesh(b.build()));
      segs.push(g);
      if (i === 2) {
        tip = new THREE.Object3D();
        tip.position.set(0, s.len + 0.004, 0);
        g.add(tip);
      }
      parent = g;
      y0 = s.len;
      prevY = gy - s.len;
      prevZ = gz;
    }
    root.position.set(0.0, -0.02, 0.03);
    root.rotation.set(-1.02, 0.1, 0.06);
    root.scale.setScalar(0.86);
    vm.root = root; vm.pivot = pivot; vm.segs = segs; vm.tip = tip; vm.spool = spool; vm.crank = crank;
    rod.viewModel = root;
  }

  function buildWorldObjects() {
    // bobber: red top, white bottom, antenna
    const bb = new Builder();
    bb.geo(new THREE.SphereGeometry(0.075, 10, 4, 0, TAU, 0, HALF_PI), '#e0342b', 0, 0, 0);
    bb.geo(new THREE.SphereGeometry(0.075, 10, 4, 0, TAU, HALF_PI, HALF_PI), '#f4f1ea', 0, 0, 0);
    bb.geo(new THREE.CylinderGeometry(0.077, 0.077, 0.014, 10, 1, true), '#a61f1b', 0, 0, 0);
    bb.geo(new THREE.CylinderGeometry(0.009, 0.012, 0.09, 5), '#f4f1ea', 0, 0.1, 0);
    bb.geo(new THREE.CylinderGeometry(0.011, 0.011, 0.03, 5), '#e0342b', 0, 0.158, 0);
    bb.geo(new THREE.CylinderGeometry(0.004, 0.009, 0.06, 4), '#f4f1ea', 0, -0.1, 0);
    bobber = mesh(bb.build());
    bobber.name = 'fishing-bobber';
    bobber.visible = false;
    G.scene.add(bobber);

    // line: camera-facing ribbon along a sagging curve (buffers reused every frame)
    const n = LINE_SEG + 1;
    linePts = new Float32Array(n * 3);
    linePos = new Float32Array(n * 2 * 3);
    const idx = [];
    for (let i = 0; i < LINE_SEG; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const lg = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(linePos, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    lg.setAttribute('position', pa);
    lg.setIndex(idx);
    lg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    line = new THREE.Mesh(lg, new THREE.MeshBasicMaterial({ color: 0xf2eee4, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
    line.name = 'fishing-line';
    line.frustumCulled = false;
    line.visible = false;
    line.renderOrder = 4;
    G.scene.add(line);

    // ripple rings around the bobber
    const rg = new THREE.RingGeometry(0.8, 1.0, 28);
    rg.rotateX(-HALF_PI);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: 0xf4fbff, transparent: true, opacity: 0, depthWrite: false }));
      m.name = 'fishing-ripple';
      m.visible = false;
      m.renderOrder = 3;
      m.userData.age = 1;
      m.userData.life = 1;
      m.userData.size = 1;
      G.scene.add(m);
      ripples.push(m);
    }

    // aim marker while charging
    const mg = new THREE.RingGeometry(0.28, 0.42, 24);
    mg.rotateX(-HALF_PI);
    const dot = new THREE.CircleGeometry(0.08, 10);
    dot.rotateX(-HALF_PI);
    const mm = new THREE.MeshBasicMaterial({ color: 0xffd98a, transparent: true, opacity: 0.85, depthWrite: false });
    marker = new THREE.Group();
    marker.add(new THREE.Mesh(mg, mm), new THREE.Mesh(dot, mm));
    marker.name = 'fishing-marker';
    marker.visible = false;
    marker.renderOrder = 3;
    G.scene.add(marker);

    // caught fish (one mesh per species, mouth at the origin)
    for (const id in SPECIES) {
      const m = new THREE.Mesh(fishGeometry(SPECIES[id], true, true), matFish);
      m.name = 'caught-' + id;
      m.castShadow = true;
      m.visible = false;
      G.scene.add(m);
      fishMeshes[id] = m;
    }

    // ambient schools: one instanced mesh for all school fish
    const sg = fishGeometry(Object.assign({}, SPECIES.sardinka, { len: 0.3, h: 0.062, w: 0.03, back: '#4a7ea6', side: '#d5e3ec' }), false, false);
    schoolMesh = new THREE.InstancedMesh(sg, matSchool, SCHOOLS * PER_SCHOOL);
    schoolMesh.name = 'fish-schools';
    schoolMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    schoolMesh.frustumCulled = false;
    schoolMesh.castShadow = false;
    schoolMesh.receiveShadow = false;
    const tints = ['#dcebf5', '#c9eedd', '#f3e6bd'];
    const col = new THREE.Color();
    for (let k = 0; k < SCHOOLS; k++) {
      for (let i = 0; i < PER_SCHOOL; i++) schoolMesh.setColorAt(k * PER_SCHOOL + i, col.set(tints[k % tints.length]));
    }
    if (schoolMesh.instanceColor) schoolMesh.instanceColor.needsUpdate = true;
    G.scene.add(schoolMesh);
  }

  // ---------------------------------------------------------------------------
  // Casting & the line
  // ---------------------------------------------------------------------------
  // Where a cast with `power` lands (out: world point on the water).
  function predictLanding(power, out) {
    const P = G.player;
    if (P && typeof P.forward === 'function') P.forward(_fwd);
    else if (G.camera) G.camera.getWorldDirection(_fwd);
    else _fwd.set(0, 0, -1);
    let hx = _fwd.x, hz = _fwd.z;
    const hl = Math.hypot(hx, hz);
    if (hl < 0.05) { hx = lastDirX; hz = lastDirZ; } else { hx /= hl; hz /= hl; lastDirX = hx; lastDirZ = hz; }
    const pitch = Math.asin(clamp(_fwd.y, -1, 1));
    const D = clamp(lerp(CAST_MIN, CAST_MAX, power) * clamp(1 + pitch * 0.35, 0.75, 1.15), CAST_MIN, CAST_MAX);
    playerXZ(_v3);
    out.set(_v3.x + hx * D, 0, _v3.z + hz * D);
    // it cannot land on the deck: carry on along the cast until just past the raft edge
    for (let i = 0; i < 240 && onRaft(out.x, out.z, 0.45); i++) { out.x += hx * 0.25; out.z += hz * 0.25; }
    out.y = waveH(out.x, out.z);
    return out;
  }

  function nearSchool(x, z, r) {
    const list = F.schools;
    for (let i = 0; i < list.length; i++) {
      const p = list[i].position;
      if ((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < r * r) return true;
    }
    return false;
  }

  function cast() {
    const power = clamp(chargeT / CHARGE_TIME, 0, 1);
    predictLanding(power, flyTo);
    flyFrom.copy(bob);
    const D = Math.hypot(flyTo.x - flyFrom.x, flyTo.z - flyFrom.z);
    flyDur = 0.45 + D * 0.034;
    flyVy = (flyTo.y - flyFrom.y + 0.5 * BOB_G * flyDur * flyDur) / flyDur;
    flyT = 0;
    st = 'flying';
    msgT = 0;
    vm.whipT = 0;
    vm.whipFrom = vm.lift;
    clearProgress();
    if (marker) marker.visible = false;
    sfx('cast', flyFrom, 0.8);
  }

  function land() {
    st = 'waiting';
    bob.copy(flyTo);
    bob.y = waveH(bob.x, bob.z);
    landT = 0;
    fx('splash', bob, 0.28);
    sfx('splash', bob, 0.35);
    spawnRipple(bob.x, bob.z, 1.2, 1.3);
    idleRippleT = R(1.5, 2.5);
    if (onLand(bob.x, bob.z)) { reelIn(); say('Tady nic nechytíš. Nahoď do vody.'); return; }
    biteIn = nearSchool(bob.x, bob.z, 4) ? R(BITE_MIN, 7) : R(BITE_MIN, BITE_MAX);
    nibbleAt = biteIn > 3 && G.chance(0.65) ? R(0.9, Math.min(2.4, biteIn - 1.2)) : -1;
    nibT = 0;
    if (forcePending) { forcePending = false; biteIn = 0.25; nibbleAt = -1; }
  }

  function startBite() {
    st = 'bite';
    msgT = 0;
    biteT = 0;
    rippleT = 0;
    splashT = 0.4;
    fx('splash', bob, 0.22);
    sfx('fish_bite', null, 1);
    spawnRipple(bob.x, bob.z, 1.4, 0.9);
    setProgress(1, biteText());
  }

  function escape() {
    st = 'waiting';
    clearProgress();
    biteIn = R(4, 9);
    nibbleAt = -1;
    fx('splash', bob, 0.18);
    sfx('splash', bob, 0.3);
    say('Ryba utekla!');
  }

  // Line back in (empty): the bobber flies back to the rod tip.
  function reelIn() {
    if (st === 'idle' || st === 'charging') return;
    const wasIn = st === 'waiting' || st === 'bite';
    st = 'reeling';
    reelT = 0;
    reelFrom.copy(bob);
    playerXZ(_v3);
    const d = Math.hypot(bob.x - _v3.x, bob.z - _v3.z);
    reelDur = clamp(0.25 + d * 0.022, 0.25, 0.65);
    reelArc = clamp(0.3 + d * 0.06, 0.3, 1.2);
    clearProgress();
    forcePending = false;
    if (wasIn) fx('splash', bob, 0.18);
    sfx('reel', bob, 0.7);
  }

  function startCatch() {
    catchSp = G.weighted(isNight() ? WEIGHTS_NIGHT : WEIGHTS_DAY);
    F.species = catchSp;
    st = 'catch';
    catchT = 0;
    caughtDone = false;
    sparkled = false;
    catchFrom.copy(bob);
    catchFrom.y = waveH(bob.x, bob.z);
    mouth.copy(catchFrom);
    clearProgress();
    fx('splash', catchFrom, 0.45 + SPECIES[catchSp].weight * 0.4);
    sfx('splash', catchFrom, 0.7);
    sfx('reel', catchFrom, 0.8);
    if (fishMesh) fishMesh.visible = false;
    fishMesh = fishMeshes[catchSp] || null;
    if (fishMesh) { fishMesh.visible = true; fishMesh.scale.setScalar(0.01); }
  }

  function giveFish() {
    const id = catchSp;
    const sp = SPECIES[id];
    let left = 1;
    const inv = G.inventory;
    if (inv && typeof inv.add === 'function') left = inv.add(id, 1, 'fish');
    if (left > 0 && G.debris && typeof G.debris.spawnItem === 'function') {
      _v.copy(catchFrom);
      G.debris.spawnItem(id, left, _v);
    }
    G.stats.fishCaught = (G.stats.fishCaught || 0) + 1;
    G.events.emit('fish:caught', { id });
    sfx('fish_catch', null, 1);
    if (left === 0 && sp) G.notify(sp.text, 'good');
  }

  function finishCatch() {
    if (fishMesh) fishMesh.visible = false;
    fishMesh = null;
    F.species = null;
    st = 'idle';
    hang.copy(bob);
    hangPrev.copy(bob);
    hangInit = true;
    const inv = G.inventory;
    if (equipped && inv && typeof inv.getSelected === 'function' && isRodSlot(inv.getSelected())) {
      inv.damageSelected(1);          // may break the rod → onUnequip → cancelAll
    }
  }

  function forceBite() {
    if (st === 'waiting') { biteIn = 0; nibbleAt = -1; return true; }
    if (st === 'flying') { forcePending = true; return true; }
    return false;
  }

  function cancelAll() {
    st = 'idle';
    F.species = null;
    chargeT = 0;
    forcePending = false;
    hangInit = false;
    vm.whipT = -1;
    clearProgress();
    if (bobber) bobber.visible = false;
    if (line) line.visible = false;
    if (marker) marker.visible = false;
    if (fishMesh) fishMesh.visible = false;
    fishMesh = null;
    for (const r of ripples) { r.visible = false; r.userData.age = r.userData.life; }
  }

  function spawnRipple(x, z, size, life) {
    let best = ripples[0];
    for (const r of ripples) if (r.userData.age / r.userData.life > best.userData.age / best.userData.life) best = r;
    if (!best) return;
    best.userData.age = 0;
    best.userData.life = life || 1.2;
    best.userData.size = size || 1;
    best.userData.x = x;
    best.userData.z = z;
    best.visible = true;
  }

  function updateRipples(dt) {
    const L = 0.35 + 0.65 * lightK();
    for (const r of ripples) {
      const u = r.userData;
      if (!r.visible) continue;
      u.age += dt;
      const k = u.age / u.life;
      if (k >= 1) { r.visible = false; continue; }
      const s = (0.12 + k * 0.55) * u.size;
      const y = waveH(u.x, u.z);
      waveN(u.x, u.z, _n);
      r.quaternion.setFromUnitVectors(UP, _n);
      r.position.set(u.x, y + 0.025, u.z);
      r.scale.set(s, 1, s);
      r.material.opacity = (1 - k) * (1 - k) * 0.55 * L;
    }
  }

  // ---------------------------------------------------------------------------
  // Per-state updates
  // ---------------------------------------------------------------------------
  // Bobber dangling below the rod tip (idle / charging): a damped rope pendulum.
  function hangUpdate(dt) {
    tipWorld(_tip);
    if (!hangInit) {
      hang.copy(_tip);
      hang.y -= HANG_LEN;
      hangPrev.copy(hang);
      hangInit = true;
    }
    _v.copy(hang).sub(hangPrev).multiplyScalar(Math.exp(-2.4 * dt));
    hangPrev.copy(hang);
    hang.add(_v);
    hang.y -= 9.8 * dt * dt;
    _v.copy(hang).sub(_tip);
    const len = _v.length();
    if (len > HANG_LEN) hang.copy(_tip).addScaledVector(_v, HANG_LEN / len);
    if (!Number.isFinite(hang.x + hang.y + hang.z)) { hang.copy(_tip); hang.y -= HANG_LEN; hangPrev.copy(hang); }
    bob.copy(hang);
    bobScale = damp(bobScale, HANG_SCALE, 10, dt);
    // hang along the line
    _v.copy(_tip).sub(bob);
    if (_v.lengthSq() > 1e-6) bobber.quaternion.setFromUnitVectors(UP, _v.normalize());
  }

  function flyUpdate(dt) {
    flyT += dt;
    const u = Math.min(1, flyT / flyDur);
    bob.x = lerp(flyFrom.x, flyTo.x, u);
    bob.z = lerp(flyFrom.z, flyTo.z, u);
    bob.y = flyFrom.y + flyVy * flyT - 0.5 * BOB_G * flyT * flyT;
    bobScale = lerp(HANG_SCALE, 1, easeOut(u * 1.6));
    _q.setFromAxisAngle(_v.set(-lastDirZ, 0, lastDirX), flyT * 9);
    bobber.quaternion.copy(_q);
    if (flyT >= flyDur) land();
  }

  function floatUpdate(dt) {
    landT += dt;
    // drifts a little with the water; the line holds it
    const W = G.world;
    if (W && W.driftVelocity) {
      bob.x += W.driftVelocity.x * 0.15 * dt;
      bob.z += W.driftVelocity.z * 0.15 * dt;
    }
    playerXZ(_v3);
    const dx = bob.x - _v3.x, dz = bob.z - _v3.z;
    const d = Math.hypot(dx, dz);
    if (d > LINE_BREAK) { reelIn(); return; }
    if (d > LINE_MAX) { bob.x = _v3.x + (dx / d) * LINE_MAX; bob.z = _v3.z + (dz / d) * LINE_MAX; }
    if (onRaft(bob.x, bob.z, 0.2)) { reelIn(); return; }

    let dip = 0, lean = 0;
    if (landT < 0.6) dip += Math.sin((landT / 0.6) * Math.PI) * 0.14;
    if (st === 'waiting') {
      biteIn -= dt;
      if (nibbleAt > 0 && biteIn <= nibbleAt) {
        nibbleAt = -1;
        nibT = 0.45;
        spawnRipple(bob.x, bob.z, 0.8, 0.8);
        sfx('bubble', bob, 0.25);
      }
      if (nibT > 0) {
        nibT -= dt;
        const k = 1 - nibT / 0.45;
        dip += Math.max(0, Math.sin(k * Math.PI * 2)) * 0.06;
        lean = Math.sin(k * Math.PI * 4) * 0.25;
      }
      idleRippleT -= dt;
      if (idleRippleT <= 0) { idleRippleT = R(2.2, 3.4); spawnRipple(bob.x, bob.z, 0.7, 1.6); }
      if (biteIn <= 0) startBite();
    }
    if (st === 'bite') {
      biteT += dt;
      dip += 0.06 + 0.12 * Math.abs(Math.sin(biteT * 13)) + (biteT > 0.45 ? 0.07 : 0);
      lean = Math.sin(biteT * 21) * 0.4;
      rippleT -= dt;
      if (rippleT <= 0) { rippleT = 0.26; spawnRipple(bob.x, bob.z, 1.1, 0.7); }
      splashT -= dt;
      if (splashT <= 0) { splashT = 0.42; fx('splash', bob, 0.14); }
      setProgress(clamp(1 - biteT / BITE_WINDOW, 0, 1), biteText());
      if (biteT >= BITE_WINDOW) { escape(); }
    }
    bob.y = waveH(bob.x, bob.z) + 0.012 - dip;
    // float upright on the wave, leaning towards the line when something pulls
    waveN(bob.x, bob.z, _n);
    _q.setFromUnitVectors(UP, _n);
    bobTilt = damp(bobTilt, lean, 12, dt);
    _q2.setFromAxisAngle(_v.set(-dz / (d || 1), 0, dx / (d || 1)), bobTilt + Math.sin(clock * 1.7) * 0.05);
    bobber.quaternion.copy(_q).multiply(_q2);
    const cd = G.camera ? G.camera.position.distanceTo(bob) : 8;
    bobScale = damp(bobScale, 1.3 + Math.max(0, cd - 5) * 0.07, 6, dt);
  }

  function reelUpdate(dt) {
    reelT += dt;
    const u = Math.min(1, reelT / reelDur);
    tipWorld(_tip);
    _v.copy(_tip);
    _v.y -= HANG_LEN;
    const e = ease(u);
    bob.lerpVectors(reelFrom, _v, e);
    bob.y += Math.sin(Math.PI * u) * reelArc;
    bobScale = lerp(bobScale, HANG_SCALE, Math.min(1, dt * 8));
    _q.setFromAxisAngle(_v2.set(1, 0, 0), reelT * 8);
    bobber.quaternion.copy(_q);
    if (u >= 1) {
      st = 'idle';
      hang.copy(bob);
      hangPrev.copy(bob);
      hangInit = true;
    }
  }

  function catchUpdate(dt) {
    catchT += dt;
    const sp = SPECIES[catchSp] || SPECIES.sardinka;
    tipWorld(_tip);
    const hangLen = 0.32 + sp.len * 0.25;
    _v2.copy(_tip);
    _v2.y -= hangLen;
    if (catchT < CATCH_FLY) {
      // leaps out of the water and flies up along the line
      const u = ease(catchT / CATCH_FLY);
      _v.lerpVectors(catchFrom, _v2, 0.5);
      _v.y += 2.2 + sp.weight;
      const a = (1 - u) * (1 - u), b2 = 2 * (1 - u) * u, c = u * u;
      mouth.set(a * catchFrom.x + b2 * _v.x + c * _v2.x, a * catchFrom.y + b2 * _v.y + c * _v2.y, a * catchFrom.z + b2 * _v.z + c * _v2.z);
    } else {
      // dangles from the rod tip, swinging and flapping
      const k = catchT - CATCH_FLY;
      const sw = Math.exp(-k * 2.2);
      mouth.copy(_v2);
      mouth.x += Math.sin(k * 6.5) * 0.09 * sw;
      mouth.z += Math.cos(k * 5.3) * 0.06 * sw;
    }
    if (!caughtDone && catchT >= CATCH_FLY) { caughtDone = true; giveFish(); }
    if (fishMesh) {
      let s = Math.min(1, catchT / 0.12);
      if (catchT > CATCH_HANG) s *= 1 - ease((catchT - CATCH_HANG) / (CATCH_END - CATCH_HANG));
      fishMesh.scale.setScalar(Math.max(0.01, s));
      fishMesh.position.copy(mouth);
      fishMesh.lookAt(_tip);
      const fl = catchT < CATCH_FLY ? 1 : 0.65 + 0.35 * Math.sin(catchT * 3);
      fishMesh.rotateZ(Math.sin(catchT * 23) * 0.55 * fl);
      fishMesh.rotateY(Math.sin(catchT * 17 + 1) * 0.35 * fl);
    }
    if (!sparkled && catchT >= CATCH_HANG) {
      sparkled = true;
      _v.copy(mouth);
      _v.y -= sp.len * 0.4;
      fx('sparkle', _v, '#bfe6ff');
    }
    // the bobber rides the line a little above the fish
    _v.copy(_tip).sub(mouth);
    const ll = _v.length();
    bob.copy(mouth).addScaledVector(_v, ll > 1e-4 ? Math.min(0.3, ll * 0.5) / ll : 0);
    if (ll > 1e-4) bobber.quaternion.setFromUnitVectors(UP, _v.normalize());
    bobScale = damp(bobScale, 0.45, 8, dt);
    if (catchT >= CATCH_END) finishCatch();
  }

  // ---------------------------------------------------------------------------
  // View model pose
  // ---------------------------------------------------------------------------
  function poseRod(dt) {
    if (!vm.pivot) return;
    let liftT = 0.02, bendT = 0.04, jit = 0, spinT = 0;
    const sway = Math.sin(clock * 1.6) * 0.012;
    switch (st) {
      case 'charging': {
        const k = ease(Math.min(1, chargeT / CHARGE_TIME));
        liftT = 0.95 * k;
        bendT = -0.12 * k;
        jit = chargeT >= CHARGE_TIME ? 0.012 : 0;
        break;
      }
      case 'flying': liftT = -0.12; bendT = 0.12; spinT = -28; break;
      case 'waiting': liftT = -0.06; bendT = 0.14 + (nibT > 0 ? 0.12 * Math.abs(Math.sin(nibT * 20)) : 0); break;
      case 'bite': liftT = -0.1; bendT = 0.35 + 0.3 * Math.abs(Math.sin(biteT * 13)); jit = 0.012; break;
      case 'reeling': liftT = 0.22; bendT = 0.12; spinT = 34; break;
      case 'catch': {
        const w = (SPECIES[catchSp] || SPECIES.sardinka).weight;
        if (catchT < CATCH_FLY) { liftT = 0.6; bendT = 0.55 + 0.45 * w; spinT = 40; jit = 0.008 * w; }
        else { liftT = 0.32; bendT = 0.25 + 0.3 * w + Math.sin(catchT * 20) * 0.06 * w; }
        break;
      }
      default: break;
    }
    if (vm.whipT >= 0) {
      // cast: flick forward past the rest pose, the tip lagging behind
      vm.whipT += dt;
      const t = vm.whipT;
      if (t < 0.12) { vm.lift = lerp(vm.whipFrom, -0.42, easeOut(t / 0.12)); vm.bend = lerp(-0.35, 0.1, t / 0.12); }
      else if (t < 0.5) { const u = ease((t - 0.12) / 0.38); vm.lift = lerp(-0.42, liftT, u); vm.bend = lerp(0.55, bendT, u); }
      else vm.whipT = -1;
    } else {
      vm.lift = damp(vm.lift, liftT, 11, dt);
      vm.bend = damp(vm.bend, bendT, 12, dt);
    }
    vm.spin = damp(vm.spin, spinT, 8, dt);
    vm.pivot.rotation.x = vm.lift + sway;
    vm.pivot.rotation.z = jit ? Math.sin(clock * 47) * jit : 0;
    vm.pivot.position.y = jit ? Math.sin(clock * 39) * jit * 0.5 : 0;
    for (let i = 0; i < vm.segs.length; i++) vm.segs[i].rotation.x = -vm.bend * BEND_K[i];
    if (vm.spool) vm.spool.rotation.x += vm.spin * dt;
    if (vm.crank) vm.crank.rotation.x += vm.spin * 0.5 * dt;
  }

  // ---------------------------------------------------------------------------
  // Bobber + line rendering
  // ---------------------------------------------------------------------------
  function updateBobberMesh() {
    if (!bobber) return;
    const show = vmShown() || st === 'flying' || st === 'waiting' || st === 'bite';
    bobber.visible = show && equipped;
    if (!bobber.visible) return;
    bobber.position.copy(bob);
    bobber.scale.setScalar(bobScale);
  }

  function updateLine() {
    if (!line) return;
    if (!equipped || !bobber || !bobber.visible || !G.camera || !vmShown()) { line.visible = false; return; }
    line.visible = true;
    tipWorld(_ra);
    let sag = 0, floorOn = false;
    if (st === 'catch') {
      _rb.copy(mouth);
    } else {
      _rb.copy(bob);
      _rb.y += 0.165 * bobScale;
    }
    const dist = _ra.distanceTo(_rb);
    switch (st) {
      case 'flying': sag = 0.04 * dist; break;
      case 'waiting': sag = Math.min(2.4, 0.12 * dist); floorOn = true; break;
      case 'bite': sag = 0.035 * dist; floorOn = true; break;
      case 'reeling': sag = 0.03 * dist; break;
      case 'catch': sag = 0.01 * dist; break;
      default: sag = 0;
    }
    const P = linePts, N = LINE_SEG;
    for (let i = 0; i <= N; i++) {
      const s = i / N;
      const x = _ra.x + (_rb.x - _ra.x) * s, z = _ra.z + (_rb.z - _ra.z) * s;
      let y = _ra.y + (_rb.y - _ra.y) * s - sag * 4 * s * (1 - s);
      if (floorOn && i > 0 && i < N) {
        const fl = waveH(x, z) + 0.015;
        if (y < fl) y = fl;
      }
      P[i * 3] = x; P[i * 3 + 1] = y; P[i * 3 + 2] = z;
    }
    G.camera.getWorldPosition(_cam);
    const V = linePos;
    for (let i = 0; i <= N; i++) {
      const a = Math.max(0, i - 1) * 3, b = Math.min(N, i + 1) * 3, c = i * 3;
      const tx = P[b] - P[a], ty = P[b + 1] - P[a + 1], tz = P[b + 2] - P[a + 2];
      const vx = P[c] - _cam.x, vy = P[c + 1] - _cam.y, vz = P[c + 2] - _cam.z;
      let sx = ty * vz - tz * vy, sy = tz * vx - tx * vz, sz = tx * vy - ty * vx;
      const sl = Math.hypot(sx, sy, sz);
      const w = 0.5 * (0.0016 + 0.0024 * Math.hypot(vx, vy, vz));
      if (sl > 1e-7) { sx *= w / sl; sy *= w / sl; sz *= w / sl; } else { sx = w; sy = 0; sz = 0; }
      V[i * 6] = P[c] - sx; V[i * 6 + 1] = P[c + 1] - sy; V[i * 6 + 2] = P[c + 2] - sz;
      V[i * 6 + 3] = P[c] + sx; V[i * 6 + 4] = P[c + 1] + sy; V[i * 6 + 5] = P[c + 2] + sz;
    }
    line.geometry.attributes.position.needsUpdate = true;
    const L = 0.3 + 0.7 * lightK();
    line.material.color.setRGB(0.95 * L, 0.93 * L, 0.88 * L);
  }

  // ---------------------------------------------------------------------------
  // Tool handler 'rod'
  // ---------------------------------------------------------------------------
  const rod = {
    viewModel: null,
    onEquip() {
      equipped = true;
      cancelAll();
      vm.lift = 0.5;
      vm.bend = 0;
      bobScale = HANG_SCALE;
    },
    onUnequip() {
      equipped = false;
      cancelAll();
      G.hud.setToolHint('');
    },
    primaryDown() {
      if (!equipped) return;
      if (st === 'idle') {
        if (inWater()) { say('Ve vodě nemůžeš nahazovat. Vylez na vor.'); sfx('error', null, 0.3); return; }
        st = 'charging';
        chargeT = 0;
        return;
      }
      if (st === 'waiting') { reelIn(); say('Nic nezabralo.'); return; }
      if (st === 'bite') startCatch();
    },
    primaryUp(slot) {
      if (st !== 'charging') return;
      // switching items, pausing or opening a panel releases the button: no cast then
      if (!equipped || !isRodSlot(slot) || G.paused || G.uiBlocking()) {
        st = 'idle'; chargeT = 0; clearProgress(); if (marker) marker.visible = false; return;
      }
      cast();
    },
    secondaryDown() {
      if (st === 'charging') { st = 'idle'; chargeT = 0; clearProgress(); if (marker) marker.visible = false; return; }
      if (st === 'flying' || st === 'waiting' || st === 'bite') reelIn();
    },
    secondaryUp() {},
    update() {},
    hint() {
      if (st === 'bite') return biteText();
      if (msgT > 0) return msg;
      if (inWater()) return 'Ve vodě nemůžeš nahazovat.';
      switch (st) {
        case 'idle': return 'Podrž ' + btnL().toLowerCase() + ' a pusť: nahodit udici';
        case 'charging': return 'Pusť ' + btnL().toLowerCase() + ': nahodit · ' + btnR() + ': zrušit';
        case 'waiting': return 'Čekej na záběr… pak rychle ' + (G.input && G.input.touchMode ? 'stiskni ●' : 'klikni') + '! · ' + btnR() + ': navinout';
        case 'bite': return biteText();
        default: return '';
      }
    },
  };
  G.tools.register('rod', rod);

  // ---------------------------------------------------------------------------
  // Ambient fish schools (cosmetic)
  // ---------------------------------------------------------------------------
  function initSchools() {
    F.schools.length = 0;
    for (let k = 0; k < SCHOOLS; k++) {
      const ang = (k / SCHOOLS) * TAU + R(-0.4, 0.4);
      const rad = R(7, 15);
      const s = {
        position: new THREE.Vector3(Math.cos(ang) * rad, -1.5, Math.sin(ang) * rad),
        heading: R(0, TAU), speed: 1.1, ang, angVel: (G.chance(0.5) ? 1 : -1) * R(0.05, 0.1),
        rad, radT: R(6, 18), radTimer: R(6, 14), depth: R(0.6, 1.4), scatter: 0, spread: 1,
        fleeX: 0, fleeZ: 0, fleeT: 0, phase: R(0, TAU), fish: [],
      };
      for (let i = 0; i < PER_SCHOOL; i++) {
        const a = R(0, TAU), rr = Math.sqrt(Math.random());
        s.fish.push({ ox: Math.cos(a) * rr * 1.1, oy: R(-0.3, 0.3), oz: Math.sin(a) * rr * 1.5, ph: R(0, TAU),
          sp: R(0.85, 1.2), sc: R(1.1, 1.6), sx: R(-1, 1), sz: R(-1, 1) });
      }
      F.schools.push(s);
    }
  }

  function threatNear(p, out) {
    // shark
    const S = G.shark;
    if (S && S.position && S.position.isVector3 && S.state && S.state !== 'away' && S.state !== 'dead') {
      const dx = p.x - S.position.x, dz = p.z - S.position.z;
      if (dx * dx + dz * dz < 10 * 10) { out.set(dx, 0, dz); return true; }
    }
    // swimming player
    const P = G.player;
    if (P && P.inWater && P.position) {
      const dx = p.x - P.position.x, dz = p.z - P.position.z;
      if (dx * dx + dz * dz < 4.5 * 4.5) { out.set(dx, 0, dz); return true; }
    }
    return false;
  }

  function updateSchools(dt) {
    if (!schoolMesh) return;
    const list = F.schools;
    let idx = 0;
    for (let k = 0; k < list.length; k++) {
      const s = list[k];
      const p = s.position;
      s.phase += dt;
      if (s.fleeT > 0) s.fleeT -= dt;
      if (threatNear(p, _v)) {
        const l = Math.hypot(_v.x, _v.z) || 1;
        s.fleeX = _v.x / l; s.fleeZ = _v.z / l;
        s.fleeT = 2.5;
      }
      let targetH, spd;
      if (s.fleeT > 0) {
        targetH = Math.atan2(s.fleeX, s.fleeZ);
        spd = 4.2;
        s.scatter = damp(s.scatter, 1, 6, dt);
      } else {
        s.radTimer -= dt;
        if (s.radTimer <= 0) { s.radTimer = R(6, 14); s.radT = R(5.5, 19); if (G.chance(0.25)) s.angVel = -s.angVel; }
        s.rad = damp(s.rad, s.radT, 0.2, dt);
        s.ang += s.angVel * dt;
        const tx = Math.cos(s.ang) * s.rad, tz = Math.sin(s.ang) * s.rad;
        targetH = Math.atan2(tx - p.x, tz - p.z);
        spd = Math.hypot(tx - p.x, tz - p.z) > 6 ? 2.2 : 1.2;
        s.scatter = damp(s.scatter, 0, 0.8, dt);
      }
      let dh = targetH - s.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      s.heading += clamp(dh, -2.2 * dt, 2.2 * dt) * (s.fleeT > 0 ? 2 : 1);
      s.speed = damp(s.speed, spd, 2, dt);
      p.x += Math.sin(s.heading) * s.speed * dt;
      p.z += Math.cos(s.heading) * s.speed * dt;
      const d = Math.hypot(p.x, p.z);
      if (d > 30) { p.x *= 30 / d; p.z *= 30 / d; s.ang = Math.atan2(p.z, p.x); }
      p.y = waveH(p.x, p.z) * 0.35 - s.depth;
      const spread = 1 + s.scatter * 1.6;
      const ch = Math.cos(s.heading), sh = Math.sin(s.heading);
      for (let i = 0; i < s.fish.length; i++) {
        const f = s.fish[i];
        const t = s.phase * f.sp + f.ph;
        const lx = (f.ox + Math.sin(t * 0.7) * 0.18 + f.sx * s.scatter * 1.2) * spread;
        const lz = (f.oz + Math.cos(t * 0.53) * 0.22 + f.sz * s.scatter * 1.2) * spread;
        const x = p.x + lx * ch + lz * sh, z = p.z - lx * sh + lz * ch;
        const y = p.y + f.oy + Math.sin(t * 0.9) * 0.08;
        const yaw = s.heading + Math.sin(t * (9 + s.speed * 3)) * 0.2 + f.sx * s.scatter * 0.5;
        _e.set(Math.sin(t * 0.8) * 0.08, yaw, 0, 'YXZ');
        _q.setFromEuler(_e);
        _m.compose(_v.set(x, y, z), _q, _s.set(f.sc, f.sc, f.sc));
        schoolMesh.setMatrixAt(idx++, _m);
      }
    }
    schoolMesh.count = idx;
    schoolMesh.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // Module
  // ---------------------------------------------------------------------------
  function update(dt) {
    clock += dt;
    if (msgT > 0) msgT -= dt;
    if (!equipped) return;
    if (inWater() && st !== 'idle' && st !== 'charging' && st !== 'reeling') {
      if (st === 'catch') { if (!caughtDone) { caughtDone = true; giveFish(); } finishCatch(); }
      else { reelIn(); say('Ve vodě nejde rybařit.'); }
    }
    if (st === 'charging' && inWater()) { st = 'idle'; clearProgress(); }
    poseRod(dt);
    switch (st) {
      case 'idle': hangUpdate(dt); break;
      case 'charging': {
        hangUpdate(dt);
        chargeT += dt;
        setProgress(Math.min(1, chargeT / CHARGE_TIME), 'Síla nahození');
        predictLanding(clamp(chargeT / CHARGE_TIME, 0, 1), _v2);
        if (marker) {
          marker.visible = true;
          marker.position.set(_v2.x, _v2.y + 0.06, _v2.z);
          playerXZ(_v3);
          const md = Math.hypot(_v2.x - _v3.x, _v2.z - _v3.z);
          marker.scale.setScalar((0.6 + md * 0.07) * (1 + 0.08 * Math.sin(clock * 7)));
        }
        break;
      }
      case 'flying': flyUpdate(dt); break;
      case 'waiting': case 'bite': floatUpdate(dt); break;
      case 'reeling': reelUpdate(dt); break;
      case 'catch': catchUpdate(dt); break;
      default: break;
    }
    updateRipples(dt);
    updateBobberMesh();
    updateLine();
  }

  G.register({
    name: 'fishing',
    order: 45,

    init() {
      matVC = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.78, metalness: 0 });
      matFish = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.38, metalness: 0.18 });
      // school fish glint a little so they read through the water
      matSchool = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.3, metalness: 0.05, emissive: 0x2a4c5c });
      buildRod();
      buildWorldObjects();
      initSchools();
      built = true;
    },

    reset() {
      cancelAll();
      msg = '';
      msgT = 0;
      if (built) initSchools();
    },

    update(dt) { update(dt); },

    frame(dt) {
      if (!built) return;
      if (G.state === 'menu' || G.isPlaying()) {
        updateSchools(dt);
        const k = lightK();
        matSchool.emissive.setRGB(0.16 * k, 0.3 * k, 0.36 * k);
      }
      // leaving play (menu / death): nothing of the rod stays in the world
      if ((G.state === 'menu' || G.state === 'dead') && st !== 'idle') cancelAll();
      if ((G.state === 'menu' || G.state === 'dead') && line && (line.visible || bobber.visible)) {
        line.visible = false;
        bobber.visible = false;
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Debug
  // ---------------------------------------------------------------------------
  G.debug.fishBite = () => forceBite();
})();
