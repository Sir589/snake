// islands.js — passing islands: seeded sand + jungle hills with palms, boulders, bushes, sometimes
// a shipwreck, a hut or a flag; shallow turquoise water and lapping foam around them; gatherable
// palms / stone piles / wrecks. Contract: ../DESIGN.md §2 and §6 "islands.js". Module 'islands'
// (order 25).
(function () {
  'use strict';

  const G = window.G;
  if (!G || !window.THREE) return;

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

  // ---------------------------------------------------------------------------------------------
  // Tuning
  // ---------------------------------------------------------------------------------------------
  const FIRST_AT = 75;               // G.time of the first island (early, so the first minutes have a destination)
  const EVERY_MIN = 240, EVERY_MAX = 400;
  const SPAWN_DIST = 220;            // upstream spawn distance
  const REMOVE_DIST = 260;           // removed this far downstream
  const NEAR_DIST = 80;              // island:near when the shore comes this close to the raft
  const MAX_ALIVE = 3;
  const SAFE_GAP = 8;                // min gap between the shore and the raft on the passing line
  const FIRST_DIST = 100;            // the first island spawns closer, so it arrives without the sail
  const LAT_STEER = 0.3;             // m/s: pull back to the planned passing line when the wind turns
  const SWIM_HINT_DIST = 40;         // predicted passing shore distance that is worth swimming
  const EDGE_H = -0.6;               // beach height at the outer edge
  const BEACH_TOP = 0.7;             // beach height at the foot of the hill
  const OUT_N = 64;                  // outline lookup resolution
  const RISE_TIME = 7;               // far islands rise out of the haze / sink when leaving
  const ANIM_DIST = 110;             // sway / flag animation only this close to the camera (shore)
  const LABEL_PALM = 'Otrhat palmu';
  const LABEL_ROCK = 'Sebrat kameny';
  const LABEL_WRECK = 'Prohledat vrak';

  // Names; the name also flavours what grows on the island.
  const NAMES = [
    ['Kokosový ostrůvek', { coco: 1, palms: [5, 7], small: 1 }],
    ['Želví ostrov', { turtles: 1 }],
    ['Racčí skála', { rocky: 1, palms: [3, 4] }],
    ['Ostrov U Vraku', { wreck: 1 }],
    ['Palmová laguna', { palms: [6, 7] }],
    ['Ostrov Poustevníka', { hut: 1 }],
    ['Mušlový ostrov', { shells: 1 }],
    ['Ostrov Tří palem', { palms: [3, 3] }],
    ['Zelený ostrůvek', { lush: 1 }],
    ['Ostrov Ztracené vlajky', { flag: 1 }],
    ['Slunečná pláž', { sandy: 1 }],
    ['Písečný ostrůvek', { small: 1, sandy: 1 }],
    ['Jeskynní ostrov', { cave: 1, rocky: 1 }],
    ['Borový ostrov', { pines: 1 }],
    ['Banánová zátoka', { bananas: 1, shape: 'bay' }],
    ['Dlouhý ostrov', { shape: 'long' }],
    ['Dvojhorka', { shape: 'twin', big: 1 }],
    ['Džunglový ostrov', { jungle: 1, lush: 1, big: 1 }],
    ['Laločnatý ostrov', { shape: 'lobed' }],
  ];
  const LABEL_TREE = 'Nasbírat větve';
  const LABEL_BANANA = 'Utrhnout banány';
  const LABEL_CAVE = 'Prohledat jeskyni';

  // Palette (sRGB hex; converted to linear THREE.Color in init)
  const HEX = {
    sandDeep: 0x8f8a64, sandWet: 0xbfa872, sandDamp: 0xdcc38e, sandDry: 0xf1dfb0,
    grassLight: 0x96c65a, grass: 0x70a944, jungle: 0x4a8834, dirt: 0x9c7c52, rock: 0x8e8a7e,
  };
  const CC = {};

  // ---------------------------------------------------------------------------------------------
  // State & public API (exists at load time)
  // ---------------------------------------------------------------------------------------------
  const list = [];
  const vel = new THREE.Vector3();          // ground velocity = -G.raft.velocity (shared by providers)
  const usedNames = new Set();
  let ready = false;
  let nextAt = FIRST_AT;
  let spawnedCount = 0;
  let lastSide = 1;
  let idSeq = 0;
  let clock = 0;
  let mats = null, geos = null;
  let pendingDecor = false;          // menu scenery waits for the first menu frame (camera placed)

  const I = (G.islands = {
    list,
    velocity: vel,
    spawnIsland(opts) { return spawnIsland(opts || {}); },
    // Island whose shore is nearest to pos (Vector3/{x,z}; default the raft at the origin), or null.
    nearest(pos) {
      const x = pos && Number.isFinite(pos.x) ? pos.x : 0, z = pos && Number.isFinite(pos.z) ? pos.z : 0;
      let best = null, bd = Infinity;
      for (let i = 0; i < list.length; i++) {
        const d = shoreDist(list[i], x, z);
        if (d < bd) { bd = d; best = list[i]; }
      }
      return best;
    },
    remove(isl) { removeIsland(isl); },
    // Highest island surface at (x, z) or null (same as the ground providers).
    heightAt(x, z) {
      let best = null;
      for (let i = 0; i < list.length; i++) {
        const h = heightAtIsland(list[i], x, z);
        if (h !== null && (best === null || h > best)) best = h;
      }
      return best;
    },
    // Distance from (x, z) to the island's (outer, conservative) shore; negative inside.
    shoreDistance(isl, x, z) { return isl ? shoreDist(isl, Number(x) || 0, Number(z) || 0) : Infinity; },
    // Predicted closest distance between island centre and raft along the current motion.
    closestApproach(isl) { return closestApproach(isl); },
    timeToNext() { return Math.max(0, nextAt - G.time); },
  });

  // ---------------------------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------------------------
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _w = new THREE.Vector3();
  const _m = new THREE.Matrix4(), _mL = new THREE.Matrix4(), _mW = new THREE.Matrix4();
  const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3();
  const _ta = new THREE.Vector3(), _tb = new THREE.Vector3(), _tc = new THREE.Vector3();
  const _cb = new THREE.Color(), _cf = new THREE.Color();
  const _X = new THREE.Vector3(1, 0, 0);
  const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);

  function mulberry(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function raftRadius() {
    try {
      const r = G.raft && typeof G.raft.radius === 'function' ? G.raft.radius() : 2.83;
      return Number.isFinite(r) && r > 0 ? r : 2.83;
    } catch (e) { return 2.83; }
  }
  function windDir(out) {
    const w = G.world && G.world.windDir;
    if (w && (w.x || w.z)) { const l = Math.hypot(w.x, w.z); return out.set(w.x / l, 0, w.z / l); }
    return out.set(1, 0, 0);
  }
  function give(id, n) {
    if (!G.inventory || typeof G.inventory.add !== 'function') return n;
    const left = G.inventory.add(id, n, 'island');
    return Number.isFinite(left) ? left : 0;
  }
  function fx(name, pos, a, b) {
    const f = G.fx && G.fx[name];
    if (typeof f === 'function') { try { f.call(G.fx, pos, a, b); } catch (e) { /* cosmetic */ } }
  }
  // Local transform helper: returns the scratch matrix _mL.
  function tr(x, y, z, rx, ry, rz, sx, sy, sz, order) {
    _e.set(rx || 0, ry || 0, rz || 0, order || 'XYZ');
    _q.setFromEuler(_e);
    _v.set(x, y, z);
    _s.set(sx, sy === undefined ? sx : sy, sz === undefined ? sx : sz);
    return _mL.compose(_v, _q, _s);
  }
  // Beam (box) between two points a → b with cross-section w × h, as matrix _mL.
  function beam(a, b, w, h) {
    _v2.subVectors(b, a);
    const len = _v2.length() || 1e-3;
    _v2.multiplyScalar(1 / len);
    _q.setFromUnitVectors(_X, _v2);
    _v.addVectors(a, b).multiplyScalar(0.5);
    _s.set(len, h, w);
    return _mL.compose(_v, _q, _s);
  }

  // ---------------------------------------------------------------------------------------------
  // Geometry builder: non-indexed triangles with one colour per face (merged, one draw call)
  // ---------------------------------------------------------------------------------------------
  function Builder() { this.p = []; this.c = []; }
  Builder.prototype.tri = function (a, b, c, col) {
    this.p.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.c.push(col.r, col.g, col.b, col.r, col.g, col.b, col.r, col.g, col.b);
  };
  // Triangle whose winding is flipped if needed so the face normal points along (hx, hy, hz).
  Builder.prototype.triO = function (a, b, c, col, hx, hy, hz) {
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * hx + ny * hy + nz * hz < 0) this.tri(a, c, b, col); else this.tri(a, b, c, col);
  };
  // Adds a geometry transformed by m. color: hex or fn(cx, cy, cz, outColor) per face.
  Builder.prototype.geo = function (src, m, color, jit, rnd) {
    const pa = src.attributes.position, idx = src.index;
    const n = idx ? idx.count : pa.count;
    const fn = typeof color === 'function' ? color : null;
    if (!fn) _cb.setHex(color);
    for (let i = 0; i + 2 < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      _ta.fromBufferAttribute(pa, i0).applyMatrix4(m);
      _tb.fromBufferAttribute(pa, i1).applyMatrix4(m);
      _tc.fromBufferAttribute(pa, i2).applyMatrix4(m);
      if (fn) fn((_ta.x + _tb.x + _tc.x) / 3, (_ta.y + _tb.y + _tc.y) / 3, (_ta.z + _tb.z + _tc.z) / 3, _cb);
      const k = jit ? 1 + (rnd() - 0.5) * 2 * jit : 1;
      _cf.copy(_cb).multiplyScalar(k);
      this.tri(_ta, _tb, _tc, _cf);
    }
  };
  Builder.prototype.empty = function () { return this.p.length === 0; };
  Builder.prototype.build = function () {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  };

  // Jitters a polyhedron radially; shared corners get the same factor so faces stay closed.
  function jitterGeo(geo, rnd, amt) {
    const p = geo.attributes.position, map = new Map();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const key = Math.round(x * 997) + ',' + Math.round(y * 997) + ',' + Math.round(z * 997);
      let k = map.get(key);
      if (k === undefined) { k = 1 + (rnd() - 0.5) * 2 * amt; map.set(key, k); }
      p.setXYZ(i, x * k, y * k, z * k);
    }
    return geo;
  }

  // ---------------------------------------------------------------------------------------------
  // Shared resources (built once in init)
  // ---------------------------------------------------------------------------------------------
  function buildShared() {
    for (const k in HEX) CC[k] = new THREE.Color(HEX[k]);
    mats = {
      solid: new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.93, metalness: 0 }),
      leaf: new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide }),
      foam: new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      ring: null,
      crystal: new THREE.MeshStandardMaterial({ color: 0x9fe8ff, emissive: 0x3fb8e0, emissiveIntensity: 1.2, flatShading: true, roughness: 0.3 }),
    };
    mats.solid.name = 'island-solid';
    mats.leaf.name = 'island-leaf';
    mats.foam.name = 'island-foam';
    const rnd = mulberry(4242);
    geos = {
      box: new THREE.BoxGeometry(1, 1, 1),
      ico0: new THREE.IcosahedronGeometry(1, 0),
      cyl6: new THREE.CylinderGeometry(1, 1, 1, 6, 1),
      cone5: new THREE.ConeGeometry(1, 1, 5, 1),
      frond: makeFrondGeo(rnd),
      coco: makeCocoGeo(rnd),
      pile: makePileGeo(rnd),
      loot: makeLootGeo(rnd),
      bananas: makeBananaGeo(rnd),
    };
  }

  // A drooping palm frond along +X: feathered leaflets on both sides of a curved spine.
  function makeFrondGeo(rnd) {
    const b = new Builder();
    const L = 2.8, n = 9;
    const S0 = new THREE.Vector3(), S1 = new THREE.Vector3(), E = new THREE.Vector3();
    const spine = (t, out) => out.set(L * t, L * (0.24 * t - 0.62 * t * t), 0);
    const base = new THREE.Color(0x3d7a2a), tip = new THREE.Color(0x9cc450), col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n, tm = Math.min(1.02, (i + 1.45) / n);
      spine(t0, S0); spine(t1, S1);
      const w = (i === 0 ? 0.22 : 0.62) * Math.pow(Math.sin(Math.PI * Math.min(0.97, (i + 0.8) / n)), 0.7);
      for (let side = -1; side <= 1; side += 2) {
        spine(tm, E);
        E.z = side * w;
        E.y -= 0.2 * w + 0.05;
        col.copy(base).lerp(tip, t1 * 0.85).multiplyScalar(1 + (rnd() - 0.5) * 0.16);
        b.tri(S0, S1, E, col);
      }
      // thin midrib so the frond reads from below
      col.setHex(0x6b7a38);
      E.set(S1.x, S1.y + 0.035, 0);
      b.tri(S0, S1, E, col);
    }
    return b.build();
  }
  function makeCocoGeo(rnd) {
    const b = new Builder();
    const ico = new THREE.IcosahedronGeometry(1, 0);
    b.geo(ico, tr(0, 0, 0, 0, 0, 0, 0.15, 0.17, 0.15), (x, y, z, out) => out.setHex(y > 0.05 ? 0x6a8a36 : 0x7a5530), 0.12, rnd);
    ico.dispose();
    return b.build();
  }
  function makePileGeo(rnd) {
    const b = new Builder();
    const parts = [
      [0, 0.16, 0, 0.42, 0.32, 0.36, 0xa09d92],
      [0.36, 0.08, 0.2, 0.26, 0.2, 0.24, 0x8c897e],
      [-0.26, 0.07, 0.26, 0.22, 0.17, 0.2, 0xaaa79c],
      [0.05, 0.06, -0.36, 0.2, 0.14, 0.18, 0x95928a],
    ];
    for (const p of parts) {
      const g = jitterGeo(new THREE.IcosahedronGeometry(1, 0), rnd, 0.22);
      b.geo(g, tr(p[0], p[1], p[2], rnd() * 3, rnd() * 3, rnd() * 3, p[3], p[4], p[5]), p[6], 0.1, rnd);
      g.dispose();
    }
    return b.build();
  }
  // A bunch of bananas hanging from its stem.
  function makeBananaGeo(rnd) {
    const b = new Builder();
    const cyl = new THREE.CylinderGeometry(1, 0.7, 1, 6, 1);
    b.geo(cyl, tr(0, 0.1, 0, 0, 0, 0, 0.03, 0.5, 0.03), 0x6f7a3a, 0.05, rnd);
    for (let row = 0; row < 3; row++) {
      for (let k = 0; k < 6; k++) {
        const a = k / 6 * TAU + row * 0.5;
        b.geo(cyl, tr(Math.cos(a) * 0.09, -0.05 - row * 0.1, Math.sin(a) * 0.09, Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5, 0.03, 0.2, 0.03),
          row === 2 ? 0xe8d04a : 0xf2d95a, 0.08, rnd);
      }
    }
    cyl.dispose();
    return b.build();
  }
  // Sea chest with iron bands and a rusty pipe: the wreck's loot marker.
  function makeLootGeo(rnd) {
    const b = new Builder();
    const box = new THREE.BoxGeometry(1, 1, 1);
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 7, 1);
    b.geo(box, tr(0, 0.24, 0, 0, 0, 0, 0.78, 0.46, 0.5), 0x7d5a36, 0.08, rnd);
    for (let i = 0; i < 3; i++) b.geo(box, tr(0, 0.5, -0.17 + i * 0.17, 0, 0, 0, 0.8, 0.08, 0.16), i === 1 ? 0x8f6a42 : 0x6e4e2e, 0.06, rnd);
    for (let s = -1; s <= 1; s += 2) b.geo(box, tr(s * 0.26, 0.28, 0, 0, 0, 0, 0.07, 0.52, 0.54), 0x5a5e62, 0.05, rnd);
    b.geo(box, tr(0, 0.33, 0.26, 0, 0, 0, 0.12, 0.12, 0.04), 0xc9a13a, 0.05, rnd);        // brass lock
    b.geo(cyl, tr(-0.05, 0.62, 0.02, 0.2, 0.5, Math.PI / 2, 0.06, 0.9, 0.06), 0x8a5234, 0.08, rnd); // rusty pipe
    b.geo(box, tr(0.52, 0.05, 0.25, 0, 0.6, 0.15, 0.34, 0.05, 0.26), 0x6d7378, 0.06, rnd);  // scrap plate
    b.geo(cyl, tr(-0.55, 0.12, -0.2, 0, 0, 0, 0.12, 0.24, 0.12), 0x7b6a58, 0.06, rnd);     // bucket
    box.dispose(); cyl.dispose();
    return b.build();
  }

  // ---------------------------------------------------------------------------------------------
  // Terrain function
  // ---------------------------------------------------------------------------------------------
  function outlineAt(tab, a) {
    let u = (a < 0 ? a + TAU : a) * (OUT_N / TAU);
    let i = u | 0;
    if (i >= OUT_N) { i -= OUT_N; u -= OUT_N; }
    const f = u - i;
    return tab[i] + (tab[i + 1] - tab[i]) * f;
  }
  // Base terrain height (no obstacles) at local (lx, lz) with radius r, beach edge rb, hill foot rh.
  function profile(T, lx, lz, r, rb, rh) {
    if (r >= rh) {
      const u = (r - rh) / (rb - rh);
      return EDGE_H + T.beachRise * Math.pow(clamp(1 - u, 0, 1), 1.3);
    }
    const v = r / rh, w = 1 - v * v;
    let h = BEACH_TOP + T.hillH * w * w;
    const dx = lx - T.p2x, dz = lz - T.p2z, q = (dx * dx + dz * dz) * T.ir2;
    if (q < 1) { const s = 1 - q; h += T.h2 * s * s * w; }
    h += w * T.nA * (Math.sin(lx * T.f1 + T.q1) * Math.cos(lz * T.f2 + T.q2) + 0.5 * Math.sin((lx - lz) * T.f3 + T.q3));
    return h;
  }
  // Local base height or null outside.
  function baseH(T, lx, lz) {
    const d2 = lx * lx + lz * lz;
    if (d2 > T.maxR2) return null;
    const r = Math.sqrt(d2), a = Math.atan2(lz, lx);
    const rb = outlineAt(T.outB, a);
    if (r > rb) return null;
    return profile(T, lx, lz, r, rb, outlineAt(T.outH, a));
  }
  // Full local height (with rocks / trunks as obstacles) or null outside.
  function localH(T, lx, lz) {
    let h = baseH(T, lx, lz);
    if (h === null) return null;
    const bs = T.bumps;
    for (let k = 0; k < bs.length; k++) {
      const b = bs[k];
      const dx = lx - b.x, dz = lz - b.z;
      if (dx > b.r || dx < -b.r || dz > b.r || dz < -b.r) continue;
      const q = (dx * dx + dz * dz) * b.ir2;
      if (q >= 1) continue;
      const bh = b.flat ? b.y + b.h : b.y + b.h * Math.sqrt(1 - q);
      if (bh > h) h = bh;
    }
    return h;
  }
  function heightAtIsland(isl, x, z) {
    if (!isl.alive) return null;
    const T = isl.T, lx = x - isl.position.x, lz = z - isl.position.z;
    if (lx > T.maxR || lx < -T.maxR || lz > T.maxR || lz < -T.maxR) return null;
    const h = localH(T, lx, lz);
    return h === null ? null : h + isl.position.y;
  }
  function shoreDist(isl, x, z) {
    return Math.hypot(x - isl.position.x, z - isl.position.z) - isl.radius;
  }

  // ---------------------------------------------------------------------------------------------
  // Island generation
  // ---------------------------------------------------------------------------------------------
  function featuresFor(name) {
    for (const n of NAMES) if (n[0] === name) return Object.assign({}, n[1]);
    return {};
  }
  function pickName() {
    const free = NAMES.filter((n) => !usedNames.has(n[0]));
    if (free.length) return G.pick(free)[0];
    const base = G.pick(NAMES)[0];
    for (let k = 2; k < 50; k++) {
      const nm = base + ' ' + ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][Math.min(8, k - 2)];
      if (!usedNames.has(nm) || k >= 10) return nm;
    }
    return base;
  }
  function genOpts(o) {
    const g = {};
    if (Number(o.hillRadius) > 0) g.hillRadius = Number(o.hillRadius);
    if (Number(o.hillHeight) > 0) g.hillHeight = Number(o.hillHeight);
    if (Number(o.palms) > 0) g.palms = Math.round(Number(o.palms));
    for (const k of ['wreck', 'hut', 'flag', 'small', 'cave']) if (typeof o[k] === 'boolean') g[k] = o[k];
    if (['small', 'medium', 'large'].includes(o.size)) g.size = o.size;
    if (['round', 'long', 'bay', 'lobed', 'twin'].includes(o.shape)) g.shape = o.shape;
    return g;
  }

  function createIsland(seed, name, gen) {
    const rnd = mulberry(seed ^ hashStr(name));
    const R = (a, b) => a + (b - a) * rnd();
    const Ri = (a, b) => Math.floor(a + (b - a + 1) * rnd());
    const feat = featuresFor(name.replace(/ [IVX]+$/, ''));
    const small = gen.small !== undefined ? gen.small : !!feat.small;
    // variety (ROADMAP 7) from its own random stream, so the older features keep their rolls
    const vr = mulberry(((seed ^ hashStr(name)) + 0x2b7e1516) >>> 0);
    const VR = (a, b) => a + (b - a) * vr();
    const sizeRoll = vr(), shapeRoll = vr();
    const size = gen.size || (small ? 'small' : feat.big || sizeRoll < 0.25 ? 'large' : 'medium');
    const SHAPES = ['round', 'long', 'bay', 'lobed', 'twin'];
    const shape = gen.shape || feat.shape || SHAPES[Math.floor(shapeRoll * SHAPES.length)];

    // --- shape ---
    let hillR = gen.hillRadius || (small ? R(10, 13.5) : R(11, 22));
    if (!gen.hillRadius && size === 'large') hillR = VR(22, 29);
    hillR = clamp(hillR, 8, 30);
    let hillH = gen.hillHeight || R(3, 9);
    if (!gen.hillHeight && size === 'large') hillH = Math.min(9.5, hillH * VR(1.1, 1.3));
    if (feat.sandy) hillH *= 0.6;
    if (feat.rocky) hillH += 1.5;
    hillH = clamp(hillH, 2, 0.45 * hillR);
    const beachW = feat.sandy ? R(9.5, 12) : R(7, 10);

    const T = {
      feat, hillR, hillH, beachW, beachRise: BEACH_TOP - EDGE_H,
      outB: new Float32Array(OUT_N + 1), outH: new Float32Array(OUT_N + 1),
      maxR: 0, maxR2: 0, minH: Infinity,
      p2x: 0, p2z: 0, ir2: 1, h2: 0,
      nA: feat.rocky ? R(0.45, 0.7) : R(0.22, 0.45),
      f1: R(0.22, 0.38), f2: R(0.22, 0.38), f3: R(0.45, 0.7), q1: R(0, TAU), q2: R(0, TAU), q3: R(0, TAU),
      bumps: [],
      top: 0,
    };
    const pa = R(0, TAU), pd = hillR * R(0.2, 0.42), r2 = hillR * R(0.3, 0.45);
    T.p2x = Math.cos(pa) * pd; T.p2z = Math.sin(pa) * pd; T.ir2 = 1 / (r2 * r2); T.h2 = hillH * R(0, 0.28);
    const twA = VR(0, TAU), twD = hillR * VR(0.45, 0.6), twR = hillR * VR(0.42, 0.52), twH = VR(0.6, 0.9);
    if (shape === 'twin') {                          // a second summit
      T.p2x = Math.cos(twA) * twD; T.p2z = Math.sin(twA) * twD; T.ir2 = 1 / (twR * twR); T.h2 = hillH * twH;
    }
    // outline shape: stretched (long), a sheltered sandy cove (bay), three lobes, or round
    const eL = shape === 'long' ? VR(0.22, 0.34) : 0, pL = VR(0, TAU);
    const bayA = VR(0, TAU), bayW = VR(0.35, 0.6), bayD = shape === 'bay' ? VR(0.32, 0.46) : 0;
    const lob = shape === 'lobed' ? VR(0.1, 0.16) : 0, lobP = VR(0, TAU);
    const ab = [R(0.04, 0.08), R(0.02, 0.05), R(0.01, 0.03)], pb = [R(0, TAU), R(0, TAU), R(0, TAU)];
    const ah = [R(0.05, 0.1), R(0.03, 0.06), R(0.01, 0.03)], ph = [R(0, TAU), R(0, TAU), R(0, TAU)];
    for (let i = 0; i <= OUT_N; i++) {
      const a = (i % OUT_N) / OUT_N * TAU;
      const kh = 1 + ah[0] * Math.sin(2 * a + ph[0]) + ah[1] * Math.sin(3 * a + ph[1]) + ah[2] * Math.sin(5 * a + ph[2]);
      const kb = 1 + ab[0] * Math.sin(2 * a + pb[0]) + ab[1] * Math.sin(3 * a + pb[1]) + ab[2] * Math.sin(4 * a + pb[2]);
      let ks = 1 + eL * Math.cos(2 * (a - pL)) + lob * Math.sin(3 * a + lobP);
      if (bayD) { const d = Math.atan2(Math.sin(a - bayA), Math.cos(a - bayA)); ks *= 1 - bayD * Math.exp(-(d / bayW) * (d / bayW)); }
      const kbS = bayD ? 1 - (1 - ks) * 0.7 : ks;      // the cove keeps a wide beach
      const rh = hillR * kh * ks;
      const rb = Math.max(rh + beachW * 0.65, (hillR + beachW) * kb * kbS);
      T.outH[i] = rh; T.outB[i] = rb;
      if (rb > T.maxR) T.maxR = rb;
      if (rh < T.minH) T.minH = rh;
    }
    T.maxR2 = T.maxR * T.maxR;
    T.top = BEACH_TOP + hillH + T.h2 + T.nA * 1.5;

    const group = new THREE.Group();
    group.name = 'island:' + name;
    const isl = {
      id: ++idSeq, seed, name, gen, T, feat, group,
      position: group.position,
      radius: T.maxR,
      hillRadius: hillR, hillHeight: hillH,
      provider: null, shallow: null,
      palms: [], rocks: [], wreck: null, hut: null, flag: null, turtles: 0,
      trees: [], cave: null, size, shape, theme: 'tropical', bananaIM: null, crystalMesh: null, caveLoot: null,
      fr: [], co: [],
      its: [], disposables: [],
      frondIM: null, cocoIM: null, pileIM: null, lootMesh: null, flagMesh: null, flagRest: null, foam: null,
      near: false, visited: false, decor: false, alive: true,
      rise: 1, sinking: false, sinkDepth: T.top + 3,
      side: 1, dirty: true, glintT: 1, playerShore: Infinity,
      summary() { return summary(isl); },
    };

    const solid = new Builder(), leaf = new Builder();
    const spots = [];      // occupied circles {x, z, r}
    const findSpot = (z0, z1, rad, minH, maxH, tries) => {
      for (let t = 0; t < (tries || 40); t++) {
        const a = R(0, TAU), zone = R(z0, z1);
        const rb = outlineAt(T.outB, a), rh = outlineAt(T.outH, a);
        const r = zone <= 1 ? zone * rh : rh + (zone - 1) * (rb - rh);
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const h = profile(T, x, z, r, rb, rh);
        if (h < minH || h > maxH) continue;
        let ok = true;
        for (const s of spots) if (Math.hypot(s.x - x, s.z - z) < s.r + rad) { ok = false; break; }
        if (!ok) continue;
        spots.push({ x, z, r: rad });
        return { x, z, h, a, zone, rh, rb };
      }
      return null;
    };

    buildTerrain(isl, solid, rnd);

    // --- shipwreck (first so it gets the room it needs) ---
    const wantWreck = gen.wreck !== undefined ? gen.wreck : (feat.wreck || rnd() < 0.4);
    if (wantWreck) {
      const sp = findSpot(1.14, 1.34, 4.6, 0.12, 0.66, 60) || findSpot(1.05, 1.5, 3.6, -0.2, 0.75, 60);
      if (sp) buildWreck(isl, solid, leaf, rnd, sp);
    }
    // --- hut ---
    const wantHut = gen.hut !== undefined ? gen.hut : (feat.hut || rnd() < 0.25);
    if (wantHut) {
      const sp = findSpot(0.95, 1.12, 3.2, 0.45, BEACH_TOP + 1.2, 60);
      if (sp) buildHut(isl, solid, leaf, rnd, sp);
    }
    // --- flag (on the hut roof or on the summit) ---
    const wantFlag = gen.flag !== undefined ? gen.flag : (feat.flag || rnd() < 0.3);
    if (wantFlag) buildFlagPole(isl, solid, rnd);

    // --- palms ---
    let nPalms = gen.palms || (feat.palms ? Ri(feat.palms[0], feat.palms[1]) : Ri(3, 7));
    nPalms = clamp(nPalms, 1, 9);
    for (let i = 0; i < nPalms; i++) {
      const sp = findSpot(0.5, 1.42, 1.7, 0.3, 99, 50);
      if (!sp) break;
      buildPalm(isl, solid, rnd, sp, feat.coco ? true : rnd() < 0.5);
    }
    // --- gatherable stone piles ---
    const nPiles = feat.rocky ? Ri(4, 5) : Ri(2, 4);
    for (let i = 0; i < nPiles; i++) {
      const sp = findSpot(0.45, 1.3, 1.1, 0.35, 99, 40);
      if (sp) isl.rocks.push({ x: sp.x, y: sp.h - 0.04, z: sp.z, ry: R(0, TAU), s0: R(0.95, 1.2), uses: 2, cur: 1, target: 1, pulse: 0, it: null });
    }
    // --- decorative boulders (surf rocks + hill rocks), a sea stack on gull rock ---
    const nSurf = Ri(2, 4) + (feat.rocky ? 3 : 0), nHill = Ri(1, 3) + (feat.rocky ? 3 : 0);
    for (let i = 0; i < nSurf; i++) {
      const sp = findSpot(1.55, 2.0, 1.6, -0.62, 0.25, 30);
      if (sp) buildBoulder(isl, solid, rnd, sp, R(0.7, 1.7), feat.rocky);
    }
    for (let i = 0; i < nHill; i++) {
      const sp = findSpot(0.15, 0.95, 1.8, 0.8, 99, 30);
      if (sp) buildBoulder(isl, solid, rnd, sp, R(0.5, 1.3), feat.rocky);
    }
    if (feat.rocky) {
      const sp = findSpot(1.6, 1.95, 3, -0.6, 0.1, 40);
      if (sp) buildStack(isl, solid, rnd, sp);
    }
    // --- bushes, grass tufts ---
    const nBush = Ri(3, 6) + (feat.lush ? 6 : 0) - (feat.sandy ? 2 : 0);
    for (let i = 0; i < nBush; i++) {
      const sp = findSpot(0.05, 0.95, 1.2, 0.8, 99, 30);
      if (sp) buildBush(solid, rnd, sp);
    }
    const nTuft = Ri(18, 30) + (feat.lush ? 20 : 0);
    for (let i = 0; i < nTuft; i++) {
      const a = R(0, TAU), zone = R(0.1, 1.18);
      const rb = outlineAt(T.outB, a), rh = outlineAt(T.outH, a);
      const r = zone <= 1 ? zone * rh : rh + (zone - 1) * (rb - rh);
      const x = Math.cos(a) * r, z = Math.sin(a) * r, h = profile(T, x, z, r, rb, rh);
      if (h > 0.45) buildTuft(leaf, rnd, x, h, z, zone);
    }
    // --- turtles, shells & starfish ---
    if (feat.turtles) {
      const n = Ri(2, 3);
      for (let i = 0; i < n; i++) {
        const sp = findSpot(1.2, 1.45, 1.2, 0.1, 0.6, 40);
        if (sp) { buildTurtle(solid, rnd, sp); isl.turtles++; }
      }
    }
    const nShell = feat.shells ? Ri(12, 18) : Ri(3, 6);
    for (let i = 0; i < nShell; i++) {
      const sp = findSpot(1.22, 1.5, 0.3, 0.03, 0.55, 20);
      if (sp) buildShell(solid, rnd, sp);
    }

    // --- a cave in the hillside (ROADMAP 7) ---
    const caveRoll = vr();
    const wantCave = gen.cave !== undefined ? gen.cave : (!!feat.cave || (!small && hillH >= 3.5 && caveRoll < 0.35));
    if (wantCave) {
      const sp = findSpot(0.9, 1.05, 3.6, 0.45, 2.2, 90) || findSpot(0.8, 1.15, 3.4, 0.3, 3, 90);
      if (sp) buildCave(isl, solid, rnd, sp);
    }
    // --- other kinds of trees: jungle broadleaves, pines, bananas ---
    const themeRoll = vr();
    const theme = feat.jungle ? 'jungle' : feat.pines || feat.rocky ? 'pines' : feat.bananas ? 'bananas'
      : ['tropical', 'tropical', 'jungle', 'pines', 'bananas'][Math.floor(themeRoll * 5)];
    isl.theme = theme;
    const cnt = (a, b) => Math.floor(VR(a, b + 0.999));
    const nBroad = theme === 'jungle' ? cnt(4, 7) : theme === 'tropical' ? cnt(0, 1) : 0;
    const nPine = theme === 'pines' ? cnt(3, 6) : 0;
    const nBanana = theme === 'bananas' ? cnt(3, 5) : theme === 'jungle' ? cnt(1, 2) : theme === 'tropical' ? cnt(0, 1) : 0;
    for (let i = 0; i < nBroad; i++) { const sp = findSpot(0.05, 0.92, 2.1, 0.8, 99, 40); if (sp) buildBroadleaf(isl, solid, leaf, rnd, sp); }
    for (let i = 0; i < nPine; i++) { const sp = findSpot(0.05, 0.92, 1.7, 0.8, 99, 40); if (sp) buildPine(isl, solid, leaf, rnd, sp); }
    for (let i = 0; i < nBanana; i++) { const sp = findSpot(0.4, 1.1, 1.5, 0.45, 99, 40); if (sp) buildBanana(isl, solid, leaf, rnd, sp); }

    // --- meshes ---
    const land = new THREE.Mesh(solid.build(), mats.solid);
    land.name = 'island-land';
    group.add(land);
    isl.disposables.push(land.geometry);
    if (!leaf.empty()) {
      const lm = new THREE.Mesh(leaf.build(), mats.leaf);
      lm.name = 'island-leaves';
      group.add(lm);
      isl.disposables.push(lm.geometry);
    }
    const sphere = new THREE.Sphere(new THREE.Vector3(0, T.top * 0.4, 0), T.maxR + 8);
    if (isl.fr.length) {
      const im = new THREE.InstancedMesh(geos.frond, mats.leaf, isl.fr.length);
      im.name = 'island-fronds';
      im.boundingSphere = sphere.clone();
      group.add(im);
      isl.frondIM = im;
    }
    if (isl.co.length) {
      const im = new THREE.InstancedMesh(geos.coco, mats.solid, isl.co.length);
      im.name = 'island-coconuts';
      im.boundingSphere = sphere.clone();
      group.add(im);
      isl.cocoIM = im;
    }
    if (isl.rocks.length) {
      const im = new THREE.InstancedMesh(geos.pile, mats.solid, isl.rocks.length);
      im.name = 'island-stones';
      im.boundingSphere = sphere.clone();
      for (let i = 0; i < isl.rocks.length; i++) {
        const k = R(0.88, 1.08);
        _cf.setRGB(k, k * R(0.97, 1.02), k * R(0.95, 1.02));
        im.setColorAt(i, _cf);
      }
      group.add(im);
      isl.pileIM = im;
    }
    if (isl.wreck) {
      const lm = new THREE.Mesh(geos.loot, mats.solid);
      lm.name = 'island-wreck-loot';
      lm.position.set(isl.wreck.x, isl.wreck.y, isl.wreck.z);
      lm.rotation.y = isl.wreck.ry;
      group.add(lm);
      isl.lootMesh = lm;
    }
    if (isl.flag) {
      buildFlagCloth(isl, rnd);
      windDir(_w);
      isl.flag.yaw = isl.flagMesh.rotation.y = Math.atan2(-_w.z, _w.x);
    }
    const bananas = isl.trees.filter((t) => t.kind === 'banana');
    if (bananas.length) {
      const im = new THREE.InstancedMesh(geos.bananas, mats.solid, bananas.length);
      im.name = 'island-bananas';
      im.boundingSphere = sphere.clone();
      group.add(im);
      isl.bananaIM = im;
      writeBananas(isl);
    }
    if (isl.cave) {
      if (isl.cave.crystals) {
        const cm = new THREE.Mesh(isl.cave.crystals.build(), mats.crystal);
        cm.name = 'island-crystals';
        group.add(cm);
        isl.disposables.push(cm.geometry);
        isl.crystalMesh = cm;
        isl.cave.crystals = null;
      }
      const lm = new THREE.Mesh(geos.loot, mats.solid);
      lm.name = 'island-cave-loot';
      lm.position.set(isl.cave.lx, isl.cave.ly, isl.cave.lz);
      lm.rotation.y = isl.cave.lry;
      lm.scale.setScalar(0.85);
      group.add(lm);
      isl.caveLoot = lm;
    }
    buildFoam(isl, rnd);

    writeFronds(isl);
    writeCocos(isl);
    writePiles(isl, 0);
    return isl;
  }

  // Radial terrain grid; rings follow the hill foot and the beach edge so the profile is sampled
  // where it bends. Per-face colours by height / slope / patch noise.
  function buildTerrain(isl, b, rnd) {
    const T = isl.T;
    const SEG = T.maxR > 27 ? 60 : 50, NH = 9, NB = 7;
    const defs = [];
    for (let k = 1; k <= NH; k++) defs.push([0, k / NH]);
    for (let k = 1; k <= NB; k++) defs.push([1, k / NB]);
    defs.push([2, 1.2], [2, 3.2]);
    const rows = [], zones = [];
    const centre = new THREE.Vector3(0, profile(T, 0, 0, 0, T.outB[0], T.outH[0]), 0);
    for (let k = 0; k < defs.length; k++) {
      const [kind, s] = defs[k];
      const row = [], zr = [];
      for (let j = 0; j < SEG; j++) {
        let a = (j / SEG) * TAU;
        if (kind === 0 && k < NH - 1) a += (rnd() - 0.5) * 0.45 * (TAU / SEG);
        const rb = outlineAt(T.outB, a), rh = outlineAt(T.outH, a);
        let r, h, zone;
        if (kind === 0) {
          r = s * rh;
          if (k < NH - 1) r += (rnd() - 0.5) * 0.5 * (rh / NH);
          zone = r / rh;
        } else if (kind === 1) {
          r = rh + s * (rb - rh);
          if (s < 1) r += (rnd() - 0.5) * 0.35 * ((rb - rh) / NB);
          zone = 1 + (r - rh) / (rb - rh);
        } else {
          r = rb + s;
          zone = 2 + s * 0.1;
        }
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (kind === 2) h = EDGE_H - (s < 2 ? 1.1 : 3.4);
        else h = profile(T, x, z, r, rb, rh);
        row.push(new THREE.Vector3(x, h, z));
        zr.push(zone);
      }
      rows.push(row); zones.push(zr);
    }
    const col = new THREE.Color();
    const face = (a, bb, c, za, zb, zc) => {
      const ux = bb.x - a.x, uy = bb.y - a.y, uz = bb.z - a.z;
      const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      terrainColor(T, (za + zb + zc) / 3, (a.y + bb.y + c.y) / 3, Math.abs(ny) / nl, (a.x + bb.x + c.x) / 3, (a.z + bb.z + c.z) / 3, col);
      col.multiplyScalar(1 + (rnd() - 0.5) * 0.07);
      b.triO(a, bb, c, col, 0, 1, 0);
    };
    const r0 = rows[0], z0 = zones[0];
    for (let j = 0; j < SEG; j++) {
      const j1 = (j + 1) % SEG;
      face(centre, r0[j], r0[j1], 0, z0[j], z0[j1]);
    }
    for (let k = 1; k < rows.length; k++) {
      const A = rows[k - 1], B = rows[k], za = zones[k - 1], zb = zones[k];
      for (let j = 0; j < SEG; j++) {
        const j1 = (j + 1) % SEG;
        if ((j + k) & 1) {
          face(A[j], A[j1], B[j1], za[j], za[j1], zb[j1]);
          face(A[j], B[j1], B[j], za[j], zb[j1], zb[j]);
        } else {
          face(A[j], A[j1], B[j], za[j], za[j1], zb[j]);
          face(A[j1], B[j1], B[j], za[j1], zb[j1], zb[j]);
        }
      }
    }
  }
  function terrainColor(T, zone, h, ny, cx, cz, out) {
    if (zone > 1.0) {                                   // beach and the underwater skirt
      if (h < -0.35) out.copy(CC.sandDeep);
      else if (h < 0.0) out.copy(CC.sandDeep).lerp(CC.sandWet, (h + 0.35) / 0.35);
      else if (h < 0.3) out.copy(CC.sandWet).lerp(CC.sandDamp, h / 0.3);
      else out.copy(CC.sandDamp).lerp(CC.sandDry, clamp((h - 0.3) / 0.25, 0, 1));
      return out;
    }
    const n = 0.5 + 0.5 * Math.sin(cx * 0.41 + T.q1 * 2) * Math.cos(cz * 0.37 + T.q2 * 2);
    const g = clamp(n * 0.85 + (1 - zone) * 0.3, 0, 1);
    if (g < 0.5) out.copy(CC.grassLight).lerp(CC.grass, g * 2);
    else out.copy(CC.grass).lerp(CC.jungle, (g - 0.5) * 2);
    if (T.feat.lush) out.lerp(CC.jungle, 0.25);
    if (T.feat.sandy) out.lerp(CC.grassLight, 0.35);
    const steep = clamp((0.9 - ny) / 0.22, 0, 1);
    if (steep > 0) out.lerp(T.feat.rocky ? CC.rock : CC.dirt, steep * 0.75);
    if (T.feat.rocky && n > 0.5) out.lerp(CC.rock, 0.65);
    if (zone > 0.78) out.lerp(CC.sandDry, clamp((zone - 0.78) / 0.22 + (n - 0.5) * 0.7, 0, 1));
    return out;
  }

  // --- palms ------------------------------------------------------------------------------------
  function buildPalm(isl, b, rnd, sp, coco) {
    const R = (a, c) => a + (c - a) * rnd();
    const T = isl.T;
    const H = R(4.6, 7.2);
    const la = sp.a + (rnd() - 0.5) * 1.3;           // lean mostly towards the sea
    const lx = Math.cos(la), lz = Math.sin(la);
    const k = H * R(0.12, 0.32) * (sp.zone > 1 ? 1.3 : 1);
    const bx = sp.x, by = sp.h - 0.25, bz = sp.z;
    const pt = (t, out) => { const s = k * (2 * t - t * t); return out.set(bx + lx * s, by + H * t, bz + lz * s); };
    const n = 7, sides = 6;
    const A = new THREE.Vector3(), B = new THREE.Vector3(), P = [], Q = [];
    for (let s = 0; s < sides; s++) { P.push(new THREE.Vector3()); Q.push(new THREE.Vector3()); }
    const col = new THREE.Color();
    const tw = rnd() * TAU;
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      pt(t0, A); pt(t1, B);
      const r0 = lerp(0.27, 0.15, t0) * (i === 0 ? 1.5 : 1.14), r1 = lerp(0.27, 0.15, t1) * 0.9;
      for (let s = 0; s < sides; s++) {
        const a = tw + (s / sides) * TAU + i * 0.25;
        P[s].set(A.x + Math.cos(a) * r0, A.y - (i === 0 ? 0.1 : 0), A.z + Math.sin(a) * r0);
        Q[s].set(B.x + Math.cos(a) * r1, B.y, B.z + Math.sin(a) * r1);
      }
      for (let s = 0; s < sides; s++) {
        const s1 = (s + 1) % sides;
        col.setHex(i % 2 ? 0x8f6d47 : 0x7a5b3b).multiplyScalar(1 + (rnd() - 0.5) * 0.12);
        const hx = (P[s].x + P[s1].x) * 0.5 - A.x, hz = (P[s].z + P[s1].z) * 0.5 - A.z;
        b.triO(P[s], P[s1], Q[s1], col, hx, 0, hz);
        b.triO(P[s], Q[s1], Q[s], col, hx, 0, hz);
      }
      // ledge cap between segments (the ring look)
      if (i > 0) {
        col.setHex(0x6a4e33);
        for (let s = 0; s < sides; s++) b.triO(A, P[s], P[(s + 1) % sides], col, 0, 1, 0);
      }
    }
    const C = pt(1, new THREE.Vector3());
    // crown bulb
    b.geo(geos.ico0, tr(C.x, C.y + 0.05, C.z, rnd(), rnd(), 0, 0.3, 0.32, 0.3), 0x5d5a2c, 0.1, rnd);
    const palm = {
      x: sp.x, y: sp.h, z: sp.z, H, coco, picked: false, shake: 0,
      cx: C.x, cy: C.y + 0.12, cz: C.z,
      ix: 0, iy: 0, iz: 0, it: null,
    };
    pt(clamp(1.35 / H, 0, 1), A);
    palm.ix = A.x; palm.iy = A.y; palm.iz = A.z;
    // trunk as an obstacle (you cannot walk through a palm)
    isl.T.bumps.push({ x: bx, z: bz, r: 0.34, ir2: 1 / (0.34 * 0.34), y: sp.h, h: 2.6, flat: true });
    // fronds
    const nF = 7 + Math.floor(rnd() * 3), yaw0 = rnd() * TAU;
    for (let i = 0; i < nF; i++) {
      const low = i % 2 === 1;
      isl.fr.push({
        palm, low,
        yaw: yaw0 + (i / nF) * TAU + (rnd() - 0.5) * 0.4,
        pitch: low ? R(-0.32, -0.02) : R(0.18, 0.5),
        roll: (rnd() - 0.5) * 0.5,
        s: R(0.85, 1.15) * (H / 6),
        ph: rnd() * TAU,
        state: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, fp: 0, fr: 0, spin: 0, k: 1, t: 0,
      });
    }
    // two young upright fronds in the middle
    for (let i = 0; i < 2; i++) {
      isl.fr.push({
        palm, low: false, yaw: rnd() * TAU, pitch: R(0.9, 1.15), roll: 0, s: R(0.45, 0.6) * (H / 6), ph: rnd() * TAU,
        state: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, fp: 0, fr: 0, spin: 0, k: 1, t: 0,
      });
    }
    if (coco) {
      const nc = 2 + Math.floor(rnd() * 3), c0 = rnd() * TAU;
      for (let i = 0; i < nc; i++) {
        const a = c0 + (i / nc) * TAU + (rnd() - 0.5) * 0.5;
        isl.co.push({
          palm, rx: C.x + Math.cos(a) * 0.24, ry: C.y - 0.14 - rnd() * 0.12, rz: C.z + Math.sin(a) * 0.24,
          s: R(0.9, 1.12), rot: rnd() * TAU,
          state: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0, k: 1, bounces: 0,
        });
      }
    }
    isl.palms.push(palm);
  }

  // --- other trees (ROADMAP 7) ----------------------------------------------------------------------
  function trunkBump(isl, x, z, y, r) { isl.T.bumps.push({ x, z, r, ir2: 1 / (r * r), y, h: 2.6, flat: true }); }
  function buildBroadleaf(isl, b, leaf, rnd, sp) {
    const R = (a, c) => a + (c - a) * rnd();
    const H = R(3.3, 4.8), by = sp.h - 0.2;
    b.geo(geos.cyl6, tr(sp.x, by + H * 0.5, sp.z, (rnd() - 0.5) * 0.12, rnd() * TAU, (rnd() - 0.5) * 0.12, 0.2, H, 0.2), 0x6e5236, 0.08, rnd);
    const greens = [0x3f7f32, 0x4f9a3c, 0x356d2a, 0x5aa545];
    const nB = 4 + Math.floor(rnd() * 3), top = by + H;
    for (let k = 0; k < nB; k++) {
      const a = rnd() * TAU, d = k === 0 ? 0 : R(0.7, 1.35), sc = R(1.0, 1.45);
      leaf.geo(geos.ico0, tr(sp.x + Math.cos(a) * d, top + R(-0.35, 0.45), sp.z + Math.sin(a) * d, rnd(), rnd() * TAU, rnd(), sc, sc * 0.78, sc),
        greens[Math.floor(rnd() * 4)], 0.1, rnd);
    }
    trunkBump(isl, sp.x, sp.z, sp.h, 0.32);
    isl.trees.push({ kind: 'broadleaf', x: sp.x, y: sp.h, z: sp.z, ix: sp.x, iy: sp.h + 1.2, iz: sp.z, picked: false, it: null });
  }
  function buildPine(isl, b, leaf, rnd, sp) {
    const R = (a, c) => a + (c - a) * rnd();
    const H = R(5, 7.4), by = sp.h - 0.2;
    b.geo(geos.cyl6, tr(sp.x, by + H * 0.32, sp.z, 0, rnd() * TAU, 0, 0.17, H * 0.64, 0.17), 0x5e4630, 0.08, rnd);
    const greens = [0x2f5e34, 0x376b3b, 0x2a5530];
    for (let k = 0; k < 4; k++) {
      const y = by + H * (0.3 + k * 0.17), r = (1.6 - k * 0.33) * R(0.9, 1.1), h = 1.7 - k * 0.2;
      leaf.geo(geos.cone5, tr(sp.x, y + h * 0.5, sp.z, 0, rnd() * TAU, 0, r, h, r), greens[k % 3], 0.08, rnd);
    }
    trunkBump(isl, sp.x, sp.z, sp.h, 0.3);
    isl.trees.push({ kind: 'pine', x: sp.x, y: sp.h, z: sp.z, ix: sp.x, iy: sp.h + 1.2, iz: sp.z, picked: false, it: null });
  }
  function buildBanana(isl, b, leaf, rnd, sp) {
    const R = (a, c) => a + (c - a) * rnd();
    const H = R(2.2, 3), by = sp.h - 0.15, top = by + H;
    b.geo(geos.cyl6, tr(sp.x, by + H * 0.5, sp.z, 0, rnd() * TAU, 0, 0.15, H, 0.15), 0x7c8a4a, 0.1, rnd);
    const n = 6 + Math.floor(rnd() * 3), greens = [0x5fa83c, 0x6fbb46, 0x4f9433];
    for (let k = 0; k < n; k++) {
      const a = k / n * TAU + rnd() * 0.3;
      leaf.geo(geos.ico0, tr(sp.x + Math.cos(a) * 0.95, top + 0.15, sp.z + Math.sin(a) * 0.95, 0, -a, -0.4 - rnd() * 0.25, 1.15, 0.05, 0.33),
        greens[k % 3], 0.08, rnd);
    }
    const ba = rnd() * TAU;
    trunkBump(isl, sp.x, sp.z, sp.h, 0.26);
    isl.trees.push({ kind: 'banana', x: sp.x, y: sp.h, z: sp.z, ix: sp.x, iy: sp.h + 1.2, iz: sp.z, picked: false, it: null,
      bx: sp.x + Math.cos(ba) * 0.24, by: top - 0.3, bz: sp.z + Math.sin(ba) * 0.24 });
  }
  function writeBananas(isl) {
    const im = isl.bananaIM;
    if (!im) return;
    let k = 0;
    for (const t of isl.trees) {
      if (t.kind !== 'banana') continue;
      if (t.picked) im.setMatrixAt(k, ZERO_M);
      else im.setMatrixAt(k, _m.compose(_v.set(t.bx, t.by, t.bz), _q.identity(), _s.set(1, 1, 1)));
      k++;
    }
    im.instanceMatrix.needsUpdate = true;
  }
  // A small cave: a ring of big boulders with a roof, the opening facing the beach, glowing
  // crystals and a chest inside. The walls are ground bumps (you cannot walk through them).
  function buildCave(isl, b, rnd, sp) {
    const R = (a, c) => a + (c - a) * rnd();
    const cx = sp.x, cz = sp.z, base = sp.h;
    const out = Math.atan2(sp.z, sp.x);              // opening towards the sea
    const RAD = 2.5, n = 12, gap = 0.62;
    const rockCol = (y0) => (x, y, z, o) => { o.setHex(y > y0 + 2.6 ? 0x7f7a6e : 0x8d887c); if (y < base + 0.25) o.setHex(0x6b665a); };
    for (let k = 0; k < n; k++) {
      const a = out + gap + (k / (n - 1)) * (TAU - 2 * gap);
      const x = cx + Math.cos(a) * RAD, z = cz + Math.sin(a) * RAD;
      for (let layer = 0; layer < 2; layer++) {
        const sc = R(0.95, 1.25) * (layer ? 0.9 : 1);
        const g = jitterGeo(new THREE.IcosahedronGeometry(1, 1), rnd, 0.18);
        const k2 = layer ? 0.9 : 1;
        b.geo(g, tr(cx + Math.cos(a) * RAD * k2, base + 0.55 + layer * 1.45, cz + Math.sin(a) * RAD * k2, rnd(), rnd() * TAU, rnd(), sc, sc, sc),
          rockCol(base), 0.08, rnd);
        g.dispose();
      }
      isl.T.bumps.push({ x, z, r: 0.95, ir2: 1 / (0.95 * 0.95), y: base, h: 3.2, flat: true });
    }
    // roof and the lintel over the opening
    for (let k = 0; k < 3; k++) {
      const g = jitterGeo(new THREE.IcosahedronGeometry(1, 1), rnd, 0.16);
      const a = k / 3 * TAU + rnd();
      b.geo(g, tr(cx + Math.cos(a) * 0.9, base + 3.15, cz + Math.sin(a) * 0.9, rnd() * 0.3, rnd() * TAU, rnd() * 0.3, R(1.7, 2.1), R(0.65, 0.85), R(1.7, 2.1)),
        rockCol(base), 0.08, rnd);
      g.dispose();
    }
    {
      const g = jitterGeo(new THREE.IcosahedronGeometry(1, 1), rnd, 0.12);
      b.geo(g, tr(cx + Math.cos(out) * RAD * 0.92, base + 2.75, cz + Math.sin(out) * RAD * 0.92, 0, -out + Math.PI / 2, 0, 1.7, 0.6, 0.8), rockCol(base), 0.08, rnd);
      g.dispose();
    }
    // dark floor inside
    b.geo(geos.cyl6, tr(cx, base + 0.03, cz, 0, rnd(), 0, RAD * 0.92, 0.05, RAD * 0.92), 0x3b342c, 0.05, rnd);
    isl.T.bumps.push({ x: cx, z: cz, r: RAD * 0.9, ir2: 1 / (RAD * RAD * 0.81), y: base, h: 0.055, flat: true });
    // glowing crystals along the back wall
    const cb = new Builder();
    for (let k = 0; k < 6; k++) {
      const a = out + Math.PI + (rnd() - 0.5) * 2.2, d = RAD * R(0.55, 0.75);
      const oct = new THREE.OctahedronGeometry(1, 0);
      cb.geo(oct, tr(cx + Math.cos(a) * d, base + R(0.15, 0.5), cz + Math.sin(a) * d, (rnd() - 0.5) * 0.6, rnd() * TAU, (rnd() - 0.5) * 0.6, R(0.08, 0.14), R(0.22, 0.45), R(0.08, 0.14)),
        rnd() < 0.5 ? 0x9fe8ff : 0xd6a8ff, 0.05, rnd);
      oct.dispose();
    }
    const lx = cx - Math.cos(out) * 1.1, lz = cz - Math.sin(out) * 1.1;
    isl.cave = { x: cx, y: base, z: cz, out, lx, ly: base + 0.05, lz, lry: -out + Math.PI / 2, looted: false, k: 1, it: null, crystals: cb };
  }

  // --- rocks ------------------------------------------------------------------------------------
  function buildBoulder(isl, b, rnd, sp, size, rocky) {
    const sx = size * (0.9 + rnd() * 0.45), sy = size * (0.55 + rnd() * 0.35), sz = size * (0.9 + rnd() * 0.45);
    const y = sp.h - sy * 0.3;
    const g = jitterGeo(new THREE.IcosahedronGeometry(1, 1), rnd, 0.16);
    const moss = !rocky && sp.zone < 1;
    b.geo(g, tr(sp.x, y, sp.z, (rnd() - 0.5) * 0.3, rnd() * TAU, (rnd() - 0.5) * 0.3, sx, sy, sz), (cx, cy, cz, out) => {
      out.setHex(0x8b877b);
      if (cy > y + sy * 0.55) out.setHex(moss ? 0x7d9a52 : 0xa29e92);
      else if (cy < 0.05) out.setHex(0x6b665a);
    }, 0.1, rnd);
    g.dispose();
    const top = y + sy - sp.h;
    if (top > 0.35) {
      const r = Math.min(sx, sz) * 0.88;
      isl.T.bumps.push({ x: sp.x, z: sp.z, r, ir2: 1 / (r * r), y, h: sy, flat: false });
    }
  }
  // A tall stack of rocks with white gull droppings on top (Racčí skála).
  function buildStack(isl, b, rnd, sp) {
    let y = sp.h - 1.2;
    const sizes = [2.1, 1.6, 1.15];
    for (let i = 0; i < sizes.length; i++) {
      const s = sizes[i];
      const g = jitterGeo(new THREE.IcosahedronGeometry(1, 1), rnd, 0.18);
      const ox = (rnd() - 0.5) * 0.5, oz = (rnd() - 0.5) * 0.5, sy = s * 1.1;
      const yy = y + sy * 0.8;
      const last = i === sizes.length - 1;
      b.geo(g, tr(sp.x + ox, yy, sp.z + oz, 0, rnd() * TAU, 0, s, sy, s), (cx, cy, cz, out) => {
        out.setHex(cy < 0.1 ? 0x5f5b52 : 0x857f73);
        if (last && cy > yy + sy * 0.45) out.setHex(0xefeee6);
      }, 0.1, rnd);
      g.dispose();
      y = yy + sy * 0.55;
    }
    const r = 1.9;
    isl.T.bumps.push({ x: sp.x, z: sp.z, r, ir2: 1 / (r * r), y: sp.h, h: y - sp.h, flat: true });
  }

  function buildBush(b, rnd, sp) {
    const n = 3 + Math.floor(rnd() * 3);
    const greens = [0x4f8f3a, 0x5d9e40, 0x3f7a30, 0x6aa84a];
    const flowers = rnd() < 0.35 ? (rnd() < 0.5 ? 0xff7aa2 : 0xffd24a) : 0;
    for (let i = 0; i < n; i++) {
      const a = rnd() * TAU, d = rnd() * 0.7, s = 0.45 + rnd() * 0.45;
      const x = sp.x + Math.cos(a) * d, z = sp.z + Math.sin(a) * d;
      b.geo(geos.ico0, tr(x, sp.h + s * 0.45, z, rnd(), rnd() * TAU, rnd(), s, s * 0.78, s), greens[Math.floor(rnd() * 4)], 0.12, rnd);
      if (flowers && i < 3) {
        for (let f = 0; f < 3; f++) {
          const fa = rnd() * TAU, fe = rnd() * 0.9 + 0.3;
          b.geo(geos.ico0, tr(x + Math.cos(fa) * s * Math.cos(fe), sp.h + s * 0.45 + Math.sin(fe) * s * 0.78, z + Math.sin(fa) * s * Math.cos(fe),
            0, 0, 0, 0.075), flowers, 0.1, rnd);
        }
      }
    }
  }
  function buildTuft(b, rnd, x, h, z, zone) {
    const col = new THREE.Color(zone > 1 ? 0xa9b85e : 0x88bb52).multiplyScalar(1 + (rnd() - 0.5) * 0.2);
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
    for (let i = 0; i < 3; i++) {
      const a = rnd() * TAU, len = 0.35 + rnd() * 0.3, pa = a + Math.PI / 2;
      A.set(x + Math.cos(pa) * 0.05, h - 0.03, z + Math.sin(pa) * 0.05);
      B.set(x - Math.cos(pa) * 0.05, h - 0.03, z - Math.sin(pa) * 0.05);
      C.set(x + Math.cos(a) * len * 0.45, h + len, z + Math.sin(a) * len * 0.45);
      b.tri(A, B, C, col);
    }
  }
  function buildShell(b, rnd, sp) {
    const y = sp.h + 0.015;
    if (rnd() < 0.5) {                       // starfish
      const col = new THREE.Color(rnd() < 0.5 ? 0xe8703a : 0xe0607e);
      const c = new THREE.Vector3(sp.x, y + 0.025, sp.z), p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), tip = new THREE.Vector3();
      const a0 = rnd() * TAU, R = 0.14 + rnd() * 0.06;
      for (let i = 0; i < 5; i++) {
        const a = a0 + (i / 5) * TAU;
        p0.set(sp.x + Math.cos(a - 0.63) * 0.05, y, sp.z + Math.sin(a - 0.63) * 0.05);
        p1.set(sp.x + Math.cos(a + 0.63) * 0.05, y, sp.z + Math.sin(a + 0.63) * 0.05);
        tip.set(sp.x + Math.cos(a) * R, y + 0.005, sp.z + Math.sin(a) * R);
        b.triO(p0, tip, p1, col, 0, 1, 0);
        b.triO(c, p0, p1, col, 0, 1, 0);
      }
    } else {                                 // spiral-ish shell
      const s = 0.06 + rnd() * 0.05;
      b.geo(geos.cone5, tr(sp.x, y + s * 0.4, sp.z, 0, rnd() * TAU, 1.35, s, s * 1.7, s, 'YXZ'), rnd() < 0.5 ? 0xf3e6d6 : 0xe8bfb0, 0.08, rnd);
    }
  }
  function buildTurtle(b, rnd, sp) {
    const yaw = sp.a + (rnd() - 0.5) * 1.2;                // looking roughly out to sea
    const M = new THREE.Matrix4().compose(new THREE.Vector3(sp.x, sp.h - 0.03, sp.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -yaw, 0)), new THREE.Vector3(1, 1, 1).multiplyScalar(0.9 + rnd() * 0.4));
    const add = (geo, x, y, z, rx, ry, rz, sx, sy, sz, color) => {
      _mW.multiplyMatrices(M, tr(x, y, z, rx, ry, rz, sx, sy, sz));
      b.geo(geo, _mW, color, 0.1, rnd);
    };
    const shell = jitterGeo(new THREE.IcosahedronGeometry(1, 1), rnd, 0.06);
    add(shell, 0, 0.17, 0, 0, 0, 0, 0.55, 0.3, 0.42, (cx, cy, cz, out) => out.setHex(((cx * 7 + cz * 5) | 0) & 1 ? 0x5e6e36 : 0x4b5a2a));
    shell.dispose();
    add(geos.ico0, 0, 0.07, 0, 0, 0, 0, 0.5, 0.09, 0.38, 0xcdbb7c);
    add(geos.ico0, 0.64, 0.19, 0, 0, 0, 0, 0.16, 0.13, 0.13, 0x8fa060);
    add(geos.box, 0.74, 0.23, 0.07, 0, 0, 0, 0.03, 0.03, 0.03, 0x1c1c1c);
    add(geos.box, 0.74, 0.23, -0.07, 0, 0, 0, 0.03, 0.03, 0.03, 0x1c1c1c);
    for (let s = -1; s <= 1; s += 2) {
      add(geos.box, 0.3, 0.07, s * 0.42, 0, s * 0.6, 0, 0.36, 0.05, 0.14, 0x829455);
      add(geos.box, -0.36, 0.06, s * 0.32, 0, -s * 0.5, 0, 0.22, 0.05, 0.11, 0x829455);
    }
  }

  // --- shipwreck ----------------------------------------------------------------------------------
  function buildWreck(isl, b, leaf, rnd, sp) {
    const R = (a, c) => a + (c - a) * rnd();
    const L = R(5.8, 7.2), W = R(2.3, 2.8), D = R(1.4, 1.8);
    const heading = sp.a + Math.PI / 2 + (rnd() - 0.5) * 0.8;   // keel roughly along the shore
    const roll = R(0.28, 0.5), pitch = (rnd() - 0.5) * 0.14;
    const M = new THREE.Matrix4().compose(new THREE.Vector3(sp.x, sp.h - D * 0.18, sp.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(roll, -heading, pitch, 'YZX')), new THREE.Vector3(1, 1, 1));
    const wood = [0x5b4633, 0x6b543a, 0x4e3c2b, 0x73593d];
    const P0 = new THREE.Vector3(), P1 = new THREE.Vector3();
    const put = (m, color) => { _mW.multiplyMatrices(M, m); b.geo(geos.box, _mW, color, 0.1, rnd); };
    const hullPt = (x, side, th, out) => {
      const k = 2 * x / L, wi = (W / 2) * (1 - 0.6 * k * k);
      return out.set(x, D * (1 - Math.cos(th)), side * wi * Math.sin(th));
    };
    // keel + stem / stern posts
    put(tr(0, 0, 0, 0, 0, 0, L, 0.22, 0.26), wood[2]);
    P0.set(L / 2 - 0.1, 0, 0); P1.set(L / 2 + 0.55, D * 1.15, 0);
    put(beam(P0, P1, 0.2, 0.22), wood[2]);
    P0.set(-L / 2 + 0.1, 0, 0); P1.set(-L / 2 - 0.25, D * 0.7, 0);
    put(beam(P0, P1, 0.2, 0.22), wood[2]);
    // ribs (some broken)
    const nr = 6 + Math.floor(rnd() * 2);
    const NS = 5;
    for (let i = 0; i < nr; i++) {
      const x = -L / 2 + 0.55 + (i * (L - 1.1)) / (nr - 1);
      for (let side = -1; side <= 1; side += 2) {
        const broken = rnd() < 0.35;
        const kEnd = broken ? 2 + Math.floor(rnd() * 2) : NS;
        for (let k = 0; k < kEnd; k++) {
          const th0 = (k / NS) * (Math.PI / 2 + 0.2), th1 = ((k + 1) / NS) * (Math.PI / 2 + 0.2);
          hullPt(x, side, th0, P0); hullPt(x, side, th1, P1);
          put(beam(P0, P1, 0.12, 0.14), wood[(i + k) % 2]);
        }
      }
    }
    // hull shell: planked bands between the stations, double sided (leaf builder), with holes and
    // a ragged broken top edge; the seaward (high) side is broken off lower so the ribs stick out
    const NX = 8, NBAND = 5, TH = Math.PI / 2 + 0.1;
    const Q0 = new THREE.Vector3(), Q1 = new THREE.Vector3(), Q2 = new THREE.Vector3(), Q3 = new THREE.Vector3();
    const pc = new THREE.Color();
    for (let side = -1; side <= 1; side += 2) {
      const top = side > 0 ? NBAND : 3;
      for (let sx = 0; sx < NX; sx++) {
        const xa = -L / 2 + 0.2 + (sx * (L - 0.4)) / NX, xb = -L / 2 + 0.2 + ((sx + 1) * (L - 0.4)) / NX;
        const lim = top - (rnd() < 0.45 ? 1 : 0) - (side < 0 && rnd() < 0.25 ? 1 : 0);
        for (let bnd = 0; bnd < lim; bnd++) {
          if (bnd > 0 && rnd() < (side > 0 ? 0.08 : 0.15)) continue;
          const ta = (bnd / NBAND) * TH, tb = ((bnd + 1) / NBAND) * TH;
          hullPt(xa, side, ta, Q0).applyMatrix4(M); hullPt(xb, side, ta, Q1).applyMatrix4(M);
          hullPt(xb, side, tb, Q2).applyMatrix4(M); hullPt(xa, side, tb, Q3).applyMatrix4(M);
          pc.setHex(bnd % 2 ? 0x7d6648 : 0x69533a).multiplyScalar(1 + (rnd() - 0.5) * 0.14);
          leaf.tri(Q0, Q1, Q2, pc);
          leaf.tri(Q0, Q2, Q3, pc);
        }
      }
    }
    // gunwale remains on the landward side
    for (let i = 0; i < nr - 1; i++) {
      if (rnd() < 0.35) continue;
      const x0 = -L / 2 + 0.55 + (i * (L - 1.1)) / (nr - 1), x1 = -L / 2 + 0.55 + ((i + 1) * (L - 1.1)) / (nr - 1);
      hullPt(x0 - 0.1, 1, TH, P0); hullPt(x1 + 0.1, 1, TH, P1);
      put(beam(P0, P1, 0.14, 0.12), wood[2]);
    }
    // a few deck boards across the stern
    for (let i = 0; i < 3; i++) {
      const x = -L / 2 + 0.7 + i * 0.34;
      const k = 2 * x / L, wi = (W / 2) * (1 - 0.6 * k * k);
      if (rnd() < 0.3) continue;
      put(tr(x, D * 0.85, 0, 0, 0, 0, 0.3, 0.06, wi * 2 * (0.6 + rnd() * 0.4)), wood[3]);
    }
    // broken mast lying on the sand + a barrel (island frame, not rolled)
    const ma = sp.a + (rnd() - 0.5) * 0.6, md = 2.6;
    const mx = sp.x + Math.cos(ma) * md, mz = sp.z + Math.sin(ma) * md;
    const mh = baseH(isl.T, mx, mz);
    b.geo(geos.cyl6, tr(mx, (mh === null ? sp.h : mh) + 0.08, mz, 0, -(ma + Math.PI / 2 + 0.4), Math.PI / 2, 0.13, R(3.4, 4.4), 0.13, 'YXZ'), 0x6a5238, 0.08, rnd);
    const ba = sp.a + Math.PI / 2 + 0.6, bd = L * 0.55;
    const bx = sp.x + Math.cos(ba) * bd, bz = sp.z + Math.sin(ba) * bd, bh = baseH(isl.T, bx, bz);
    if (bh !== null && bh > -0.3) {
      b.geo(geos.cyl6, tr(bx, bh + 0.3, bz, 0.25, 0, 0, 0.3, 0.7, 0.3), 0x7a5a36, 0.06, rnd);
      b.geo(geos.cyl6, tr(bx, bh + 0.3, bz, 0.25, 0, 0, 0.31, 0.08, 0.31), 0x55595c, 0.04, rnd);
    }
    // loot chest on the sand beside the low (landward) side of the hull, clear of the rib tips
    _v2.set(0.3, 0, W / 2 + 1.45).applyMatrix4(M);
    const lx = _v2.x, lz = _v2.z;
    let lh = baseH(isl.T, lx, lz);
    if (lh === null) lh = sp.h;
    isl.wreck = { x: lx, y: lh - 0.04, z: lz, ry: -heading + (rnd() - 0.5) * 0.6, looted: false, k: 1, it: null };
  }

  // --- hut ----------------------------------------------------------------------------------------
  function buildHut(isl, b, leaf, rnd, sp) {
    const yaw = sp.a;                                   // front faces the sea
    const M = new THREE.Matrix4().compose(new THREE.Vector3(sp.x, sp.h - 0.05, sp.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -yaw + Math.PI / 2, 0)), new THREE.Vector3(1, 1, 1));
    const put = (geo, m, color, bb) => { _mW.multiplyMatrices(M, m); (bb || b).geo(geo, _mW, color, 0.1, rnd); };
    const pole = 0x6b5034, plank = 0x8a6a45;
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        put(geos.cyl6, tr(sx * 1.05, 1.2, sz * 0.95, (rnd() - 0.5) * 0.05, 0, (rnd() - 0.5) * 0.05, 0.09, 2.5, 0.09), pole);
      }
    }
    for (let i = 0; i < 5; i++) put(geos.box, tr(0, 0.5, -0.88 + i * 0.44, 0, (rnd() - 0.5) * 0.04, 0, 2.3, 0.07, 0.4), i % 2 ? plank : 0x7a5c3b);
    put(geos.box, tr(0, 0.42, 0, 0, 0, 0, 2.2, 0.1, 0.12), pole);
    put(geos.box, tr(1.02, 2.35, 0, 0, 0, 0, 0.1, 0.1, 2.1), pole);
    put(geos.box, tr(-1.02, 2.35, 0, 0, 0, 0, 0.1, 0.1, 2.1), pole);
    // woven back wall and half side walls (leaf builder: double sided)
    put(geos.box, tr(0, 1.45, -0.98, 0, 0, 0, 2.1, 1.85, 0.04), 0xb7934f, leaf);
    put(geos.box, tr(-1.07, 1.1, -0.35, 0, 0, 0, 0.04, 1.2, 1.2), 0xa98646, leaf);
    // thatched roof: two layers of a four-sided pyramid
    const apex = new THREE.Vector3(), c = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const col = new THREE.Color();
    const layer = (ay, by, hw, hd, hex) => {
      apex.set(0, ay, 0).applyMatrix4(M);
      c[0].set(-hw, by, -hd).applyMatrix4(M); c[1].set(hw, by, -hd).applyMatrix4(M);
      c[2].set(hw, by, hd).applyMatrix4(M); c[3].set(-hw, by, hd).applyMatrix4(M);
      for (let i = 0; i < 4; i++) {
        col.setHex(hex).multiplyScalar(1 + (rnd() - 0.5) * 0.14);
        leaf.tri(c[i], c[(i + 1) % 4], apex, col);
      }
    };
    layer(3.25, 2.3, 1.55, 1.45, 0xc9a85c);
    layer(3.35, 2.75, 1.05, 0.98, 0xb8964a);
    apex.set(0, 3.3, 0).applyMatrix4(M);
    isl.hut = { x: sp.x, z: sp.z, apexX: apex.x, apexY: apex.y, apexZ: apex.z };
    // the floor is solid: hop up onto it
    isl.T.bumps.push({ x: sp.x, z: sp.z, r: 1.12, ir2: 1 / (1.12 * 1.12), y: sp.h - 0.05, h: 0.54, flat: true });
    // a little clay pot by the door
    _v2.set(0.7, 0, 1.35).applyMatrix4(M);
    const ph = baseH(isl.T, _v2.x, _v2.z);
    if (ph !== null) b.geo(geos.ico0, tr(_v2.x, ph + 0.18, _v2.z, 0, 0, 0, 0.22, 0.24, 0.22), 0xb0613a, 0.1, rnd);
  }

  // --- flag ---------------------------------------------------------------------------------------
  function buildFlagPole(isl, b, rnd) {
    let px, py, pz, len;
    if (isl.hut) { px = isl.hut.apexX; pz = isl.hut.apexZ; py = isl.hut.apexY - 0.3; len = 1.9; }
    else {
      // summit: the highest of a few probes near the centre
      let best = -Infinity;
      px = 0; pz = 0;
      for (let i = 0; i < 16; i++) {
        const a = rnd() * TAU, d = rnd() * isl.T.hillR * 0.45;
        const x = Math.cos(a) * d, z = Math.sin(a) * d, h = baseH(isl.T, x, z);
        if (h !== null && h > best) { best = h; px = x; pz = z; }
      }
      py = best - 0.1; len = 3.6;
    }
    b.geo(geos.cyl6, tr(px, py + len / 2, pz, 0, 0, 0, 0.055, len, 0.055), 0x6b5034, 0.06, rnd);
    b.geo(geos.ico0, tr(px, py + len + 0.04, pz, 0, 0, 0, 0.09), 0xc9a13a, 0.05, rnd);
    isl.flag = { x: px, y: py + len - 0.05, z: pz, yaw: 0, ph: rnd() * TAU };
    if (!isl.hut) isl.T.bumps.push({ x: px, z: pz, r: 0.18, ir2: 1 / (0.18 * 0.18), y: py, h: 2.6, flat: true });
  }
  function buildFlagCloth(isl, rnd) {
    // maritime signal flags: 'O' (red/yellow diagonal, man overboard!), 'N' (blue/white check),
    // or a plain weathered red pennant
    const cols = 6, rows = 4, W = 1.15, H = 0.72;
    const kind = Math.floor(rnd() * 3);
    const cellHex = (i, j) => {
      if (kind === 0) return (i + 0.5) / cols > (j + 0.5) / rows ? 0xf2c230 : 0xd23b2f;
      if (kind === 1) return ((Math.floor(i * 4 / cols) + Math.floor(j * 4 / rows)) & 1) ? 0x2f5fa8 : 0xf1efe6;
      return i === cols - 1 ? 0xa8342b : 0xcf4436;
    };
    const pos = [], col = [];
    const c = new THREE.Color();
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        c.setHex(cellHex(i, j));
        // tattered end: the last column is shorter on some rows
        const x0 = (i / cols) * W, x1 = ((i + 1) / cols) * W * (i === cols - 1 && j !== 1 ? 0.93 : 1);
        const y0 = -(j / rows) * H, y1 = -((j + 1) / rows) * H;
        pos.push(x0, y0, 0, x0, y1, 0, x1, y1, 0, x0, y0, 0, x1, y1, 0, x1, y0, 0);
        const k = 1 + (rnd() - 0.5) * 0.06;
        for (let v = 0; v < 6; v++) col.push(c.r * k, c.g * k, c.b * k);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(W / 2, -H / 2, 0), W);
    const m = new THREE.Mesh(g, mats.leaf);
    m.name = 'island-flag';
    m.position.set(isl.flag.x, isl.flag.y, isl.flag.z);
    isl.group.add(m);
    isl.flagMesh = m;
    isl.flagRest = new Float32Array(pos);
    isl.flagW = W;
    isl.disposables.push(g);
  }

  // --- lapping foam on the wet sand ---------------------------------------------------------------
  // A translucent strip on the beach around the waterline. It is drawn after the (transparent)
  // ocean, so the sea's depth hides the part under water: the visible foam line follows the waves.
  function buildFoam(isl, rnd) {
    const T = isl.T, SEG = 72;
    const H = [0.32, 0.12, -0.02, -0.25], A = [0, 0.62, 0.45, 0];
    const pos = [], col = [], idx = [];
    for (let j = 0; j <= SEG; j++) {
      const a = (j / SEG) * TAU;
      const rb = outlineAt(T.outB, a), rh = outlineAt(T.outH, a);
      const wob = 1 + (rnd() - 0.5) * 0.25;
      for (let k = 0; k < H.length; k++) {
        const u = 1 - Math.pow(clamp((H[k] - EDGE_H) / T.beachRise, 0, 1), 1 / 1.3);
        const r = rh + u * (rb - rh);
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        pos.push(x, profile(T, x, z, r, rb, rh) + 0.05, z);
        col.push(1, 1, 1, A[k] * (k === 1 ? wob : 1));
      }
    }
    const NK = H.length;
    for (let j = 0; j < SEG; j++) {
      for (let k = 0; k < NK - 1; k++) {
        const a = j * NK + k, b2 = (j + 1) * NK + k;
        idx.push(a, b2, a + 1, a + 1, b2, b2 + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mats.foam);
    m.name = 'island-foam';
    m.renderOrder = 1;
    isl.group.add(m);
    isl.foam = m;
    isl.disposables.push(g);
  }

  // ---------------------------------------------------------------------------------------------
  // Instance writers (fronds sway, fall; coconuts drop; stone piles shrink)
  // ---------------------------------------------------------------------------------------------
  function writeFronds(isl) {
    const im = isl.frondIM;
    if (!im) return;
    const storm = G.world ? G.world.storm || 0 : 0;
    const amp = 0.035 + storm * 0.1;
    for (let k = 0; k < isl.fr.length; k++) {
      const f = isl.fr[k];
      if (f.state === 3) { im.setMatrixAt(k, ZERO_M); continue; }
      const palm = f.palm;
      let pitch, roll, sc = f.s;
      if (f.state === 0) {
        const sw = Math.sin(clock * 1.35 + f.ph) * amp + palm.shake * Math.sin(clock * 31 + f.ph * 3) * 0.2;
        pitch = f.pitch + (palm.picked ? -0.24 : 0) + sw;
        roll = f.roll + sw * 0.6;
        _v.set(palm.cx, palm.cy, palm.cz);
      } else {
        pitch = f.fp; roll = f.fr; sc *= f.k;
        _v.set(f.x, f.y, f.z);
      }
      _e.set(roll, f.yaw, pitch, 'YZX');
      _q.setFromEuler(_e);
      _s.set(sc, sc, sc);
      _m.compose(_v, _q, _s);
      im.setMatrixAt(k, _m);
    }
    im.instanceMatrix.needsUpdate = true;
  }
  function writeCocos(isl) {
    const im = isl.cocoIM;
    if (!im) return;
    for (let k = 0; k < isl.co.length; k++) {
      const c = isl.co[k];
      if (c.state === 3) { im.setMatrixAt(k, ZERO_M); continue; }
      if (c.state === 0) _v.set(c.rx, c.ry, c.rz); else _v.set(c.x, c.y, c.z);
      _e.set(0, c.rot, c.state ? c.t * 3 : 0);
      _q.setFromEuler(_e);
      const s = c.s * c.k;
      _s.set(s, s, s);
      _m.compose(_v, _q, _s);
      im.setMatrixAt(k, _m);
    }
    im.instanceMatrix.needsUpdate = true;
  }
  function writePiles(isl, dt) {
    const im = isl.pileIM;
    if (!im) return;
    for (let k = 0; k < isl.rocks.length; k++) {
      const r = isl.rocks[k];
      if (dt > 0) {
        r.cur = G.damp(r.cur, r.target, 9, dt);
        if (Math.abs(r.cur - r.target) < 0.004) r.cur = r.target;
        r.pulse = Math.max(0, r.pulse - dt * 3.5);
      }
      if (r.cur <= 0.002) { im.setMatrixAt(k, ZERO_M); continue; }
      const p = r.pulse * Math.sin(r.pulse * 9);
      const s = r.s0 * r.cur;
      _e.set(0, r.ry, 0);
      _q.setFromEuler(_e);
      _v.set(r.x, r.y, r.z);
      _s.set(s * (1 + 0.12 * p), s * (1 - 0.22 * p), s * (1 + 0.12 * p));
      _m.compose(_v, _q, _s);
      im.setMatrixAt(k, _m);
    }
    im.instanceMatrix.needsUpdate = true;
  }

  // Falling fronds & coconuts, the wreck chest popping away. Local (island) coordinates.
  function animate(isl, dt) {
    let busy = false;
    for (const p of isl.palms) if (p.shake > 0) { p.shake = Math.max(0, p.shake - dt * 1.4); busy = true; }
    for (const f of isl.fr) {
      if (f.state === 1) {
        busy = true;
        f.t += dt;
        f.vy -= 5.5 * dt;
        const drag = Math.exp(-1.3 * dt);
        f.vx *= drag; f.vz *= drag;
        f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
        f.fp += f.spin * dt;
        f.fr = Math.sin(f.t * 6 + f.ph) * 0.45;
        const g = localH(isl.T, f.x, f.z);
        const gy = g === null ? 0 : Math.max(g, 0);
        if (f.y <= gy + 0.08) { f.y = gy + 0.08; f.state = 2; f.t = 0; }
      } else if (f.state === 2) {
        busy = true;
        f.t += dt;
        f.fp = G.damp(f.fp, 0.25, 4, dt);
        f.fr = G.damp(f.fr, 0, 4, dt);
        if (f.t > 2.6) { f.k = Math.max(0, 1 - (f.t - 2.6) / 0.7); if (f.k <= 0) f.state = 3; }
      }
    }
    for (const c of isl.co) {
      if (c.state === 1) {
        busy = true;
        c.t += dt;
        c.vy -= 14 * dt;
        c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
        const g = localH(isl.T, c.x, c.z);
        const gy = (g === null ? 0 : Math.max(g, 0)) + 0.13;
        if (c.y <= gy && c.vy < 0) {
          c.y = gy;
          if (c.bounces < 2 && c.vy < -1.2) {
            c.vy = -c.vy * 0.35; c.vx *= 0.6; c.vz *= 0.6; c.bounces++;
            if (c.bounces === 1) G.sfx('step', { position: worldPos(isl, c.x, c.y, c.z, _v2), volume: 0.35 });
          } else { c.state = 2; c.t = 0; c.vx = c.vz = c.vy = 0; }
        }
      } else if (c.state === 2) {
        busy = true;
        c.t += dt;
        if (c.t > 0.9) {
          c.k = Math.max(0, 1 - (c.t - 0.9) / 0.3);
          if (c.k <= 0) { c.state = 3; fx('sparkle', worldPos(isl, c.x, c.y, c.z, _v2), 0xf2d27a); }
        }
      }
    }
    const w = isl.wreck;
    if (w && w.looted && isl.lootMesh && isl.lootMesh.visible) {
      busy = true;
      w.k = Math.max(0, w.k - dt * 2.4);
      const s = w.k > 0.75 ? 1 + (1 - w.k) * 0.6 : w.k / 0.75 * 1.15;
      isl.lootMesh.scale.setScalar(Math.max(0.001, s));
      if (w.k <= 0) isl.lootMesh.visible = false;
    }
    return busy;
  }
  function worldPos(isl, lx, ly, lz, out) {
    return out.set(isl.position.x + lx, isl.position.y + ly, isl.position.z + lz);
  }

  // ---------------------------------------------------------------------------------------------
  // Gathering
  // ---------------------------------------------------------------------------------------------
  function pickPalm(isl, palm) {
    if (palm.picked || !isl.alive) return false;
    const nL = G.randInt(2, 3);
    const leftL = give('list', nL);
    const gotK = palm.coco ? 1 - give('kokos', 1) : 0;
    if (leftL >= nL && gotK <= 0) return false;           // inventory full: the palm stays as it was
    palm.picked = true;
    palm.shake = 1;
    for (const f of isl.fr) {
      if (f.palm !== palm || !f.low || f.state !== 0) continue;
      f.state = 1; f.t = 0;
      f.x = palm.cx; f.y = palm.cy; f.z = palm.cz;
      const sp = G.rand(0.6, 1.5);
      f.vx = Math.cos(f.yaw) * sp; f.vz = -Math.sin(f.yaw) * sp; f.vy = G.rand(0.3, 1.4);
      f.fp = f.pitch; f.fr = f.roll; f.spin = G.rand(-1.1, -0.4); f.k = 1;
    }
    for (const c of isl.co) {
      if (c.palm !== palm || c.state !== 0) continue;
      c.state = 1; c.t = 0; c.bounces = 0;
      c.x = c.rx; c.y = c.ry; c.z = c.rz;
      const a = G.rand(0, TAU), sp = G.rand(0.4, 1.2);
      c.vx = Math.cos(a) * sp; c.vz = Math.sin(a) * sp; c.vy = G.rand(0, 1);
    }
    isl.dirty = true;
    worldPos(isl, palm.cx, palm.cy, palm.cz, _v2);
    fx('debris', _v2, 0x6fae4a, 16);
    G.sfx('whoosh', { position: _v2, volume: 0.7 });
    worldPos(isl, palm.ix, palm.iy, palm.iz, _v2);
    fx('sparkle', _v2, 0x9bd35a);
    G.sfx('pickup', { position: _v2 });
    G.events.emit('island:gathered', { island: isl, kind: 'palm', items: { list: nL - leftL, kokos: Math.max(0, gotK) } });
    return true;
  }
  function mineRock(isl, rock) {
    if (rock.uses <= 0 || !isl.alive) return false;
    const n = G.randInt(1, 2);
    const left = give('kamen', n);
    if (left >= n) return false;
    rock.uses--;
    rock.target = rock.uses > 0 ? 0.64 : 0;
    rock.pulse = 1;
    isl.dirty = true;
    worldPos(isl, rock.x, rock.y + 0.3, rock.z, _v2);
    fx('debris', _v2, 0x9b9a90, 12);
    G.sfx('hit', { position: _v2, volume: 0.8 });
    G.sfx('pickup', { position: _v2, volume: 0.7 });
    G.events.emit('island:gathered', { island: isl, kind: 'rock', items: { kamen: n - left } });
    return true;
  }
  function searchWreck(isl, w) {
    if (w.looted || !isl.alive) return false;
    const nK = G.randInt(2, 4), nP = G.randInt(1, 3);
    const lk = give('kov', nK), lp = give('prkno', nP);
    if (lk >= nK && lp >= nP) return false;
    w.looted = true;
    w.k = 1;
    worldPos(isl, w.x, w.y + 0.4, w.z, _v2);
    fx('debris', _v2, 0x6b543a, 18);
    fx('sparkle', _v2, 0xc9d2da);
    G.sfx('break_wood', { position: _v2, volume: 0.8 });
    G.sfx('pickup', { position: _v2 });
    G.notify('Z vraku máš kovový šrot a prkna!', 'good');
    G.events.emit('island:gathered', { island: isl, kind: 'wreck', items: { kov: nK - lk, prkno: nP - lp } });
    return true;
  }

  function pickTree(isl, t) {
    if (t.picked || !isl.alive) return false;
    let got = {};
    if (t.kind === 'banana') {
      const n = G.randInt(2, 3), left = give('banan', n);
      if (left >= n) return false;
      got = { banan: n - left };
    } else {
      const nP = t.kind === 'pine' ? G.randInt(2, 3) : G.randInt(1, 2), nL = t.kind === 'pine' ? 0 : G.randInt(1, 2);
      const lp = give('prkno', nP), ll = nL ? give('list', nL) : 0;
      if (lp >= nP && ll >= nL) return false;
      got = { prkno: nP - lp, list: nL - ll };
    }
    t.picked = true;
    if (t.kind === 'banana') writeBananas(isl);
    worldPos(isl, t.ix, t.iy + 0.6, t.iz, _v2);
    fx('debris', _v2, t.kind === 'banana' ? 0xf2d95a : 0x6fae4a, 12);
    fx('sparkle', _v2, 0x9bd35a);
    G.sfx('whoosh', { position: _v2, volume: 0.6 });
    G.sfx('pickup', { position: _v2 });
    G.events.emit('island:gathered', { island: isl, kind: t.kind, items: got });
    return true;
  }
  function searchCave(isl) {
    const c = isl.cave;
    if (!c || c.looted || !isl.alive) return false;
    const nZ = G.randInt(10, 25), nK = G.randInt(2, 4);
    const lz = give('zlato', nZ), lk = give('kov', nK);
    if (lz >= nZ && lk >= nK) return false;
    const extra = G.pick([['koule', G.randInt(3, 6)], ['provaz', 3], ['kelimek_sladky', 1], ['kamen', 4]]);
    give(extra[0], extra[1]);
    c.looted = true;
    if (isl.caveLoot) isl.caveLoot.visible = false;
    worldPos(isl, c.lx, c.ly + 0.4, c.lz, _v2);
    fx('sparkle', _v2, 0xffd76a);
    G.sfx('coins', { position: _v2, volume: 0.9 });
    G.notify('V jeskyni jsi našel poklad! ' + (nZ - lz) + '× Zlaté mince, ' + (nK - lk) + '× Kovový šrot a ještě něco navíc.', 'good');
    G.events.emit('island:gathered', { island: isl, kind: 'cave', items: { zlato: nZ - lz, kov: nK - lk } });
    return true;
  }

  function addInteractables(isl) {
    const avail = () => isl.alive && isl.rise >= 1 && isl.playerShore < 12;
    for (const palm of isl.palms) {
      palm.it = G.interaction.add({
        getPosition: (out) => worldPos(isl, palm.ix, palm.iy, palm.iz, out),
        label: LABEL_PALM,
        onInteract: () => { pickPalm(isl, palm); },
        enabled: () => !palm.picked && avail(),
        range: 3.3, size: 0.5,
      });
      isl.its.push(palm.it);
    }
    for (const rock of isl.rocks) {
      rock.it = G.interaction.add({
        getPosition: (out) => worldPos(isl, rock.x, rock.y + 0.28 * rock.cur, rock.z, out),
        label: LABEL_ROCK,
        onInteract: () => { mineRock(isl, rock); },
        enabled: () => rock.uses > 0 && avail(),
        range: 3.5, size: 0.6,
      });
      isl.its.push(rock.it);
    }
    for (const t of isl.trees) {
      t.it = G.interaction.add({
        getPosition: (out) => worldPos(isl, t.ix, t.iy, t.iz, out),
        label: t.kind === 'banana' ? LABEL_BANANA : LABEL_TREE,
        onInteract: () => { pickTree(isl, t); },
        enabled: () => !t.picked && avail(),
        range: 3.3, size: 0.5,
      });
      isl.its.push(t.it);
    }
    const cv = isl.cave;
    if (cv) {
      cv.it = G.interaction.add({
        getPosition: (out) => worldPos(isl, cv.lx, cv.ly + 0.4, cv.lz, out),
        label: LABEL_CAVE,
        onInteract: () => { searchCave(isl); },
        enabled: () => !cv.looted && avail(),
        range: 3.2, size: 0.8,
      });
      isl.its.push(cv.it);
    }
    const w = isl.wreck;
    if (w) {
      w.it = G.interaction.add({
        getPosition: (out) => worldPos(isl, w.x, w.y + 0.4, w.z, out),
        label: LABEL_WRECK,
        onInteract: () => { searchWreck(isl, w); },
        enabled: () => !w.looted && avail(),
        range: 3.8, size: 0.9,
      });
      isl.its.push(w.it);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Spawning / placement / removal
  // ---------------------------------------------------------------------------------------------
  function clearOfOthers(isl, x, z) {
    for (const o of list) {
      if (o === isl || o.decor) continue;
      if (Math.hypot(o.position.x - x, o.position.z - z) < isl.radius + o.radius + 25) return false;
    }
    return true;
  }
  // `first`: the very first island comes ~100 m upstream on the closest safe line, so it arrives
  // within a few minutes even at drift speed and passes close enough to swim to.
  function placeUpstream(isl, side, first) {
    windDir(_w);
    const raftR = raftRadius();
    for (let t = 0; t < 10; t++) {
      let s = side || (Math.random() < 0.65 ? -lastSide : lastSide);
      if (t >= 5 && !side) s = -s;
      // 28–60 m to the side, but always far enough that the shore misses the raft by > SAFE_GAP
      const minLat = Math.max(28, isl.radius + raftR + SAFE_GAP + 1);
      const lateral = first ? minLat + G.rand(0, 4) : G.rand(minLat, Math.min(Math.max(60, minLat), minLat + 24));
      const along = first ? FIRST_DIST + G.rand(-5, 10) + (t % 5) * 30 : SPAWN_DIST + G.rand(-10, 15) + (t % 5) * 45;
      const x = _w.x * along - _w.z * lateral * s, z = _w.z * along + _w.x * lateral * s;
      if (clearOfOthers(isl, x, z)) {
        isl.position.set(x, 0, z); isl.side = s; lastSide = s;
        isl.lat = lateral * s;                 // planned signed offset from the raft's passing line
        return true;
      }
    }
    return false;
  }
  function placeNear(isl, side) {
    windDir(_w);
    const raftR = raftRadius();
    const lateral = Math.max(35, isl.radius + raftR + 10);
    let s = side === -1 || side === 1 ? side : (Math.random() < 0.5 ? -1 : 1);
    for (let t = 0; t < 2; t++, s = -s) {
      const x = _w.x * 12 - _w.z * lateral * s, z = _w.z * 12 + _w.x * lateral * s;
      if (clearOfOthers(isl, x, z) || t === 1) { isl.position.set(x, 0, z); isl.side = s; return; }
    }
  }
  // Menu scenery: behind the raft as seen by world.js' orbiting menu camera, slightly ahead of the
  // orbit so it drifts across the view.
  function placeDecor(isl) {
    const cam = G.camera;
    const a = cam && (cam.position.x || cam.position.z) ? Math.atan2(cam.position.z, cam.position.x) + Math.PI + 0.35
      : Math.random() * TAU;
    const d = 95 + isl.radius;
    isl.position.set(Math.cos(a) * d, 0, Math.sin(a) * d);
  }

  function spawnIsland(opts) {
    if (!ready) return null;
    const seed = Number.isFinite(Number(opts.seed)) && opts.seed !== null && opts.seed !== undefined
      ? Number(opts.seed) >>> 0 : (Math.random() * 4294967296) >>> 0;
    const name = typeof opts.name === 'string' && opts.name ? opts.name : pickName();
    const gen = genOpts(opts);
    if (opts.auto && spawnedCount === 0 && gen.wreck === undefined) gen.wreck = true;  // the first one always has scrap
    let isl;
    try { isl = createIsland(seed, name, gen); }
    catch (err) { console.error('[islands] generation failed', err); return null; }

    if (opts.position && Number.isFinite(Number(opts.position.x)) && Number.isFinite(Number(opts.position.z))) {
      isl.position.set(Number(opts.position.x), 0, Number(opts.position.z));
    } else if (opts.decor) placeDecor(isl);
    else if (opts.near) placeNear(isl, opts.side);
    else if (!placeUpstream(isl, opts.side, !!opts.auto && spawnedCount === 0)) {
      if (opts.auto) { destroyIsland(isl); return null; }
      windDir(_w);
      const lat = isl.radius + raftRadius() + 20, along = SPAWN_DIST + 120;
      isl.position.set(_w.x * along - _w.z * lat, 0, _w.z * along + _w.x * lat);
    }
    isl.decor = !!opts.decor;
    const far = Math.hypot(isl.position.x, isl.position.z) - isl.radius > 150;
    isl.rise = (far || opts.auto) && !opts.restored ? 0 : 1;
    isl.group.position.y = isl.rise < 1 ? -isl.sinkDepth : 0;

    list.push(isl);
    usedNames.add(name);
    if (!isl.decor) G.events.emit('island:spawned', { island: isl });
    if (!isl.decor) spawnedCount++;
    G.scene.add(isl.group);
    isl.provider = G.ground.add({
      kind: 'island',
      velocity: vel,
      island: isl,
      heightAt: (x, z) => heightAtIsland(isl, x, z),
    });
    const W = G.world;
    if (W && typeof W.addShallow === 'function') isl.shallow = W.addShallow(isl.group, isl.radius * 1.9, 1);
    else addRingFallback(isl);
    if (!isl.decor) addInteractables(isl);
    return isl;
  }

  // Fallback when world.js has no shallow-water tint: a translucent turquoise disc.
  function addRingFallback(isl) {
    if (!mats.ring) mats.ring = new THREE.MeshBasicMaterial({ color: 0x3fd0c0, transparent: true, opacity: 0.32, depthWrite: false });
    const g = new THREE.RingGeometry(isl.radius * 0.8, isl.radius * 1.7, 48, 1);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, mats.ring);
    m.name = 'island-shallows';
    m.position.y = 0.02;
    m.renderOrder = 1;
    isl.group.add(m);
    isl.ringMesh = m;
    isl.disposables.push(g);
  }

  function destroyIsland(isl) {
    isl.alive = false;
    if (isl.group.parent) isl.group.parent.remove(isl.group);
    for (const d of isl.disposables) d.dispose();
    isl.disposables.length = 0;
    for (const im of [isl.frondIM, isl.cocoIM, isl.pileIM]) if (im && im.dispose) im.dispose();
  }
  function removeIsland(isl) {
    if (isl && !isl.decor) G.events.emit('island:removed', { island: isl, seed: isl.seed });
    const i = list.indexOf(isl);
    if (i < 0) return;
    list.splice(i, 1);
    if (isl.provider) G.ground.remove(isl.provider);
    if (isl.shallow && G.world && typeof G.world.removeShallow === 'function') G.world.removeShallow(isl.shallow);
    for (const it of isl.its) G.interaction.remove(it);
    isl.its.length = 0;
    destroyIsland(isl);
  }
  function clearAll() {
    for (let i = list.length - 1; i >= 0; i--) removeIsland(list[i]);
  }

  // Predicted closest centre distance between island and raft along the current relative motion.
  function closestApproach(isl) {
    const sp = Math.hypot(vel.x, vel.z), px = isl.position.x, pz = isl.position.z;
    if (sp < 1e-4) return Math.hypot(px, pz);
    const dx = vel.x / sp, dz = vel.z / sp, along = px * dx + pz * dz;
    if (along >= 0) return Math.hypot(px, pz);
    return Math.hypot(px - along * dx, pz - along * dz);
  }
  // Never on a collision course: nudge the island sideways (smoothly) until its passing line
  // clears the raft by radius + raft radius + SAFE_GAP; push it out if it is somehow too close.
  function keepClear(isl, dt, raftR) {
    const need = isl.radius + raftR + SAFE_GAP;
    const px = isl.position.x, pz = isl.position.z;
    const d = Math.hypot(px, pz);
    if (d < need && d > 1e-3) {
      const push = Math.min(need - d, 4 * dt);
      isl.position.x += (px / d) * push; isl.position.z += (pz / d) * push;
    }
    const sp = Math.hypot(vel.x, vel.z);
    if (sp < 0.02) return;
    const dx = vel.x / sp, dz = vel.z / sp;
    const along = isl.position.x * dx + isl.position.z * dz;
    if (along >= 0) return;                                  // already passing / moving away
    const qx = isl.position.x - along * dx, qz = isl.position.z - along * dz;
    const miss = Math.hypot(qx, qz);
    if (miss >= need) return;
    let nx, nz;                                              // sideways, away from the passing line
    if (miss < 1e-3) { nx = -dz * isl.side; nz = dx * isl.side; } else { nx = qx / miss; nz = qz / miss; }
    const tArrive = Math.max(0.5, -along / sp);
    const gap = need - miss;
    const speed = Math.max(0.6, sp * 0.8, (gap / tArrive) * 1.6);
    const push = Math.min(gap, speed * dt);
    isl.position.x += nx * push; isl.position.z += nz * push;
  }

  // Ground-fixed islands travel along -raft.velocity, but the wind slowly turns (±25°), which would
  // swing an island that is still far upstream tens of metres off its planned passing line. Pull its
  // sideways offset (perpendicular to the current motion) back towards isl.lat, gently.
  function keepOnLine(isl, dt, raftR) {
    if (!Number.isFinite(isl.lat) || isl.playerShore < 20) return;
    const sp = Math.hypot(vel.x, vel.z);
    if (sp < 0.02) return;
    const dx = vel.x / sp, dz = vel.z / sp;
    if (isl.position.x * dx + isl.position.z * dz >= -isl.radius) return;   // passing / gone by
    const need = isl.radius + raftR + SAFE_GAP + 1;
    const target = (isl.lat < 0 ? -1 : 1) * Math.max(Math.abs(isl.lat), need);
    const px = dz, pz = -dx;                                  // same side convention as placeUpstream
    const lat = isl.position.x * px + isl.position.z * pz;
    const maxStep = (LAT_STEER + 0.2 * sp) * dt;
    const step = G.clamp(target - lat, -maxStep, maxStep);
    isl.position.x += px * step; isl.position.z += pz * step;
  }

  // Predicted gap between the shore and the raft when the island passes by.
  function passingShore(isl) {
    const raftR = raftRadius();
    if (Number.isFinite(isl.lat)) return Math.max(Math.abs(isl.lat), isl.radius + raftR + SAFE_GAP + 1) - isl.radius;
    return closestApproach(isl) - isl.radius;
  }

  function playerOn(isl) {
    const P = G.player;
    if (!P || !P.onGround) return false;
    if (P.groundProvider === isl.provider) return true;
    if (P.groundKind !== 'island' || P.groundProvider) return false;
    const h = heightAtIsland(isl, P.position.x, P.position.z);
    return h !== null && Math.abs(h - P.position.y) < 0.6;
  }

  function onNear(isl, shore) {
    isl.near = true;
    G.events.emit('island:near', { island: isl, name: isl.name, distance: Math.max(0, Math.round(shore)) });
    G.notify('Na obzoru je ostrov: ' + isl.name, 'info');
    const close = passingShore(isl) < SWIM_HINT_DIST;
    if (close && !I._nearHintShown) {
      I._nearHintShown = true;
      G.notify('Doplav k němu – najdeš tam palmové listy, kokosy a kameny.', 'info');
    } else if (!close && !I._farHintShown) {
      I._farHintShown = true;
      G.notify('Ostrov je daleko – s plachtou ho doženeš příště.', 'info');
    }
  }
  function onVisit(isl) {
    isl.visited = true;
    G.stats.islandsVisited = (G.stats.islandsVisited || 0) + 1;
    G.events.emit('island:visited', { island: isl, name: isl.name });
    G.notify('Jsi na ostrově „' + isl.name + '“!', 'good');
    if (G.stats.islandsVisited === 1) {
      G.notify('Otrhej palmy a seber kameny (E).' + (isl.wreck && !isl.wreck.looted ? ' A prohledej vrak!' : ''), 'info');
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Module lifecycle
  // ---------------------------------------------------------------------------------------------
  function init() {
    buildShared();
    ready = true;
    G.events.on('game:menu', () => { pendingDecor = G.state === 'menu' && !list.length; });
    // Debug hooks return a plain summary (cheap to pass out of page.evaluate); the island object
    // itself is on the non-enumerable property `island`.
    const dbgOut = (isl) => {
      if (!isl) return null;
      const o = summary(isl);
      Object.defineProperty(o, 'island', { value: isl, enumerable: false });
      return o;
    };
    G.debug.island = (opts) => dbgOut(spawnIsland(Object.assign({ near: true, wreck: true }, opts || {})));
    G.debug.visitIsland = () => {
      const isl = I.nearest() || spawnIsland({ near: true, wreck: true });
      if (!isl) return null;
      const a = Math.atan2(-isl.position.z, -isl.position.x);          // side facing the raft
      const rb = outlineAt(isl.T.outB, a), rh = outlineAt(isl.T.outH, a), r = rh + (rb - rh) * 0.2;
      const x = isl.position.x + Math.cos(a) * r, z = isl.position.z + Math.sin(a) * r;
      if (typeof G.debug.teleport === 'function') G.debug.teleport(x, z);
      else if (G.player && G.player.position) G.player.position.set(x, heightAtIsland(isl, x, z) || 0, z);
      return dbgOut(isl);
    };
  }

  function reset() {
    clearAll();
    pendingDecor = false;
    usedNames.clear();
    nextAt = FIRST_AT;
    spawnedCount = 0;
    lastSide = Math.random() < 0.5 ? -1 : 1;
    vel.set(0, 0, 0);
    I._nearHintShown = false;
    I._farHintShown = false;
  }

  function save() {
    const out = { next: Math.max(0, Math.round(nextAt - G.time)), n: spawnedCount, islands: [] };
    for (const isl of list) {
      if (isl.decor || isl.sinking) continue;
      let picked = 0;
      isl.palms.forEach((p, i) => { if (p.picked) picked |= 1 << i; });
      out.islands.push({
        seed: isl.seed, name: isl.name, gen: isl.gen,
        x: Math.round(isl.position.x * 100) / 100, z: Math.round(isl.position.z * 100) / 100,
        near: isl.near ? 1 : 0, visited: isl.visited ? 1 : 0,
        lat: Number.isFinite(isl.lat) ? Math.round(isl.lat * 10) / 10 : undefined,
        palms: picked, rocks: isl.rocks.map((r) => r.uses), wreck: isl.wreck && isl.wreck.looted ? 1 : 0,
        trees: isl.trees.reduce((m, t, i) => (t.picked ? m | (1 << i) : m), 0), cave: isl.cave && isl.cave.looted ? 1 : 0,
      });
    }
    return out;
  }

  function load(d) {
    if (!d || typeof d !== 'object') return;
    const next = Number(d.next);
    nextAt = G.time + (Number.isFinite(next) && next >= 0 ? next : FIRST_AT);
    spawnedCount = Number.isFinite(Number(d.n)) ? Number(d.n) : 0;
    if (!Array.isArray(d.islands)) return;
    for (const s of d.islands) {
      if (!s || !Number.isFinite(Number(s.x)) || !Number.isFinite(Number(s.z)) || typeof s.name !== 'string') continue;
      const opts = Object.assign({}, s.gen || {}, { seed: s.seed, name: s.name, position: { x: s.x, z: s.z }, restored: true });
      const isl = spawnIsland(opts);
      if (!isl) continue;
      spawnedCount = Math.max(0, spawnedCount - 1);        // not a new island
      isl.near = !!s.near;
      isl.visited = !!s.visited;
      if (Number.isFinite(Number(s.lat)) && s.lat !== null) isl.lat = Number(s.lat);
      if (isl.near) I._nearHintShown = true;
      const picked = Number(s.palms) || 0;
      isl.palms.forEach((p, i) => {
        if (!(picked & (1 << i))) return;
        p.picked = true;
        for (const f of isl.fr) if (f.palm === p && f.low) f.state = 3;
        for (const c of isl.co) if (c.palm === p) c.state = 3;
      });
      if (Array.isArray(s.rocks)) {
        isl.rocks.forEach((r, i) => {
          const u = Number(s.rocks[i]);
          if (!Number.isFinite(u)) return;
          r.uses = clamp(Math.round(u), 0, 2);
          r.cur = r.target = r.uses === 2 ? 1 : r.uses === 1 ? 0.64 : 0;
        });
      }
      if (s.wreck && isl.wreck) {
        isl.wreck.looted = true;
        isl.wreck.k = 0;
        if (isl.lootMesh) isl.lootMesh.visible = false;
      }
      const tp = Number(s.trees) || 0;
      isl.trees.forEach((t, i) => { if (tp & (1 << i)) t.picked = true; });
      writeBananas(isl);
      if (s.cave && isl.cave) { isl.cave.looted = true; if (isl.caveLoot) isl.caveLoot.visible = false; }
      writeFronds(isl); writeCocos(isl); writePiles(isl, 0);
    }
  }

  function update(dt) {
    if (!ready) return;
    const rv = G.raft && G.raft.velocity;
    if (rv && Number.isFinite(rv.x) && Number.isFinite(rv.z)) vel.set(-rv.x, 0, -rv.z);
    else vel.set(0, 0, 0);

    // schedule: first at ~180 s, then every 240–400 s (postponed while anchored / crowded)
    if (G.time >= nextAt && !(G.net && G.net.guest)) {
      let alive = 0;
      for (const isl of list) if (!isl.decor) alive++;
      if ((G.raft && G.raft.anchored) || alive >= MAX_ALIVE) nextAt = G.time + 20;
      else {
        const isl = spawnIsland({ auto: true });
        nextAt = G.time + (isl ? G.rand(EVERY_MIN, EVERY_MAX) : 25);
      }
    }

    const raftR = raftRadius();
    const P = G.player;
    const px = P && P.position ? P.position.x : 0, pz = P && P.position ? P.position.z : 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const isl = list[i];
      if (isl.decor) { removeIsland(isl); continue; }      // menu scenery never enters a game
      isl.position.x += vel.x * dt;
      isl.position.z += vel.z * dt;
      keepOnLine(isl, dt, raftR);
      keepClear(isl, dt, raftR);

      // rise out of the haze / sink away
      if (isl.sinking) {
        isl.rise = Math.max(0, isl.rise - dt / RISE_TIME);
        isl.group.position.y = -(1 - smooth(isl.rise)) * isl.sinkDepth;
        if (isl.rise <= 0) { removeIsland(isl); continue; }
      } else if (isl.rise < 1) {
        isl.rise = Math.min(1, isl.rise + dt / RISE_TIME);
        isl.group.position.y = -(1 - smooth(isl.rise)) * isl.sinkDepth;
      }

      const dist = Math.hypot(isl.position.x, isl.position.z);
      const shore = dist - isl.radius;
      isl.playerShore = shoreDist(isl, px, pz);
      if (!isl.near && shore < NEAR_DIST && isl.rise >= 1) onNear(isl, shore);
      if (!isl.visited && isl.playerShore < 2 && playerOn(isl)) onVisit(isl);

      // removal downstream (never from under the player's feet)
      const away = isl.position.x * vel.x + isl.position.z * vel.z > 0;
      if (!isl.sinking && isl.playerShore > 15 && ((dist > REMOVE_DIST && away) || dist > 700)) isl.sinking = true;

      // a glint on the unlooted wreck chest when the player is around
      const w = isl.wreck;
      if (w && !w.looted && isl.playerShore < 30) {
        isl.glintT -= dt;
        if (isl.glintT <= 0) {
          isl.glintT = G.rand(2.2, 3.6);
          fx('sparkle', worldPos(isl, w.x, w.y + 0.6, w.z, _v2), 0xffe08a);
        }
      }
    }
  }

  function frame(dt) {
    if (!ready) return;
    if (pendingDecor) {
      pendingDecor = false;
      if (G.state === 'menu' && !list.length) spawnIsland({ decor: true });
    }
    if (!list.length) return;
    const adt = G.paused || G.state === 'dead' ? 0 : dt;
    clock = (clock + adt) % 10000;
    const cam = G.camera;
    const cx = cam ? cam.position.x : 0, cz = cam ? cam.position.z : 0;
    const W = G.world;
    // foam brightness follows daylight; a slow wash in and out
    const light = W && Number.isFinite(W.lightLevel) ? W.lightLevel : 1;
    mats.foam.color.setScalar(0.12 + 0.88 * light * light);
    mats.foam.opacity = (0.6 + 0.3 * Math.sin(clock * 0.9)) * (0.35 + 0.65 * light);
    for (let i = 0; i < list.length; i++) {
      const isl = list[i];
      const busy = G.state === 'playing' && adt > 0 ? animate(isl, adt) : false;
      const near = Math.hypot(cx - isl.position.x, cz - isl.position.z) - isl.radius < ANIM_DIST;
      if (near || busy || isl.dirty) {
        writeFronds(isl);
        writeCocos(isl);
        writePiles(isl, adt);
        isl.dirty = false;
      }
      if (isl.flagMesh && near) waveFlag(isl, adt);
    }
  }

  function waveFlag(isl, dt) {
    const f = isl.flag, m = isl.flagMesh;
    windDir(_w);
    const target = Math.atan2(-_w.z, _w.x);
    let d = target - f.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    f.yaw += d * Math.min(1, dt * 1.5);
    m.rotation.y = f.yaw;
    const storm = G.world ? G.world.storm || 0 : 0;
    const p = m.geometry.attributes.position, rest = isl.flagRest, W = isl.flagW;
    const t = clock * (6 + storm * 5) + f.ph;
    const amp = 0.12 + storm * 0.1;
    for (let v = 0; v < p.count; v++) {
      const x = rest[v * 3], y = rest[v * 3 + 1];
      const u = x / W;
      p.setXYZ(v, x * (1 - 0.05 * u), y - 0.07 * u * u, (Math.sin(t - u * 6) * amp + Math.sin(t * 0.47 - u * 2.5) * 0.05) * u);
    }
    p.needsUpdate = true;
  }

  function summary(isl) {
    return {
      id: isl.id, name: isl.name, seed: isl.seed,
      x: Math.round(isl.position.x * 10) / 10, z: Math.round(isl.position.z * 10) / 10,
      radius: Math.round(isl.radius * 10) / 10, hillRadius: Math.round(isl.hillRadius * 10) / 10,
      hillHeight: Math.round(isl.hillHeight * 10) / 10,
      palms: isl.palms.length, coconutPalms: isl.palms.filter((p) => p.coco).length, rocks: isl.rocks.length,
      wreck: !!isl.wreck, hut: !!isl.hut, flag: !!isl.flag, turtles: isl.turtles,
      size: isl.size, shape: isl.shape, theme: isl.theme, cave: !!isl.cave,
      trees: isl.trees.reduce((o, t) => { o[t.kind] = (o[t.kind] || 0) + 1; return o; }, {}),
      near: isl.near, visited: isl.visited, decor: isl.decor,
    };
  }

  G.register({ name: 'islands', order: 25, init, reset, save, load, update, frame });
})();
