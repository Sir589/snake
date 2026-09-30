// raft.js — the raft: tile grid, tile visuals & damage, bobbing, drift speed, the structures
// framework (purifier, grill, chest, net, sail, anchor) and the 'hammer' and 'place' tools.
// Contract: ../DESIGN.md §2 and §6 "raft.js". Registers as module 'raft' (order 20).
(function () {
  'use strict';

  const G = window.G;
  const PI = Math.PI, HALF_PI = PI / 2, TAU = PI * 2;
  const TILE = G.C.TILE;

  // ---------------------------------------------------------------------------
  // Tunables
  // ---------------------------------------------------------------------------
  const MAX_SPAN = 12;                          // max raft size in tiles along each axis
  const HP_NORMAL = 100, HP_REINFORCED = 150;
  const COST = {
    foundation: { prkno: 2, plast: 2 },
    reinforce: { prkno: 2, kov: 1 },
    repair: { prkno: 1 },
  };
  const SPEED_DRIFT = 0.35, SPEED_SAIL = 2.2;
  const BUILD_RANGE = 6, PLACE_RANGE = 5.5, DISMANTLE_RANGE = 4.5;
  const DISMANTLE_TIME = 0.6;
  const SWING_TIME = 0.42, SWING_IMPACT = 0.2;
  const PURIFY_TIME = 20, COOK_TIME = 15;
  const NET_RADIUS = 2.5, NET_SLOTS = 10, CHEST_SLOTS = 20;
  const STORM_LEVEL = 0.6, STORM_EVERY = 20;
  const WOOD_CHIP = 0xb48a58;

  // ---------------------------------------------------------------------------
  // Scratch objects (no per-frame allocations)
  // ---------------------------------------------------------------------------
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _n = new THREE.Vector3();
  const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
  const _eye = new THREE.Vector3(), _dir = new THREE.Vector3(), _hit = new THREE.Vector3();
  const _m4 = new THREE.Matrix4(), _m3 = new THREE.Matrix3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
  const _c = new THREE.Color(), _c2 = new THREE.Color();
  const raycaster = new THREE.Raycaster();
  const _hits = [];
  let _rayDist = Infinity;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const group = new THREE.Group();              // raft root; only position.y ever changes
  group.name = 'raft';
  const tiles = new Map();                      // "i,j" -> tile (contract)
  const grid = new Map();                       // numeric key -> tile (hot lookups)
  const structures = [];
  const structureObjects = [];                  // for raycasts
  const structureDefs = Object.create(null);
  const velocity = new THREE.Vector3(SPEED_DRIFT, 0, 0);
  const cache = { edges: [], frontier: [], minI: 0, maxI: -1, minJ: 0, maxJ: -1, radius: 0 };
  let dirty = true;
  let quiet = 0;                                // > 0 while resetting/loading: no events, stats or effects
  let speed = SPEED_DRIFT;
  let stormTimer = 12, extStormHitAt = -1e9, stormNotifyAt = -1e9, critNotifyAt = -1e9;
  let clock = 0, frameNo = 0;
  let stormInternal = false;                    // true while raft.js itself applies storm damage
  const netCaught = new WeakSet();              // debris already handed to a net

  const nkey = (i, j) => (i + 4096) * 8192 + (j + 4096);
  const skey = (i, j) => i + ',' + j;

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function fxCall(name, a, b, c) {
    const fx = G.fx;
    const f = fx && fx[name];
    if (typeof f !== 'function') return;
    try { f.call(fx, a, b, c); } catch (err) { /* cosmetic only */ }
  }
  function snd(name, pos, volume) {
    const o = {};
    if (pos) o.position = pos.clone();
    if (volume != null) o.volume = volume;
    G.sfx(name, o);
  }
  function plural(n, one, few, many) { return n === 1 ? one : n >= 2 && n <= 4 ? few : many; }
  function itemsText(n) { return n + ' ' + plural(n, 'věc', 'věci', 'věcí'); }
  function btnL() { return G.input && G.input.touchMode ? '●' : 'Levé tlačítko'; }
  function btnR() { return G.input && G.input.touchMode ? '◐' : 'Pravé tlačítko'; }
  function itemName(id) { return G.items && G.items.name ? G.items.name(id) : String(id); }
  function itemColor(id, fallback) { const d = G.items && G.items.def(id); return d && d.color ? d.color : fallback; }
  function smooth01(t) { t = G.clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function costText(needs) {
    if (G.items && G.items.needsText) return G.items.needsText(needs);
    const parts = [];
    for (const k in needs) parts.push(needs[k] + '× ' + itemName(k));
    return parts.join(', ');
  }
  function missingText(needs) {
    const parts = [];
    for (const k in needs) {
      const have = G.inventory.count(k);
      if (have < needs[k]) parts.push((needs[k] - have) + '× ' + itemName(k));
    }
    return parts.join(', ');
  }
  function pay(needs) {
    const I = G.inventory;
    if (typeof I.removeAll === 'function') return I.removeAll(needs);
    if (!I.hasAll(needs)) return false;
    for (const k in needs) I.remove(k, needs[k]);
    return true;
  }
  // Take one `id`, preferring the held stack.
  function takeOne(id) {
    const I = G.inventory;
    const sel = I.getSelected();
    if (sel && sel.id === id) return I.consumeSelected(1);
    return I.remove(id, 1);
  }
  function storageSlots(st) { return st && Array.isArray(st.slots) ? st.slots : []; }
  function storageCount(st) {
    let n = 0;
    for (const s of storageSlots(st)) if (s) n += s.count;
    return n;
  }
  function storageFree(st) {
    let n = 0;
    for (const s of storageSlots(st)) if (!s) n++;
    return n;
  }
  function storageFilled(st) {
    let n = 0;
    for (const s of storageSlots(st)) if (s) n++;
    return n;
  }
  // Put items back into the sea as a floating bundle (hook-able), if debris.js offers it.
  function floatItem(id, count, pos) {
    if (!(count > 0) || !G.debris || typeof G.debris.spawnItem !== 'function') return false;
    try {
      _v2.set(pos.x + G.rand(-0.8, 0.8), 0, pos.z + G.rand(-0.8, 0.8));
      G.debris.spawnItem(id, count, _v2.clone());
      return true;
    } catch (err) { return false; }
  }
  function seeded(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash2(i, j) {
    let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }
  // Structure-local offset -> raft group space (structures only rotate in 90° steps).
  function toGroup(s, lx, ly, lz, out) {
    const r = s.rotation * HALF_PI, c = Math.cos(r), sn = Math.sin(r);
    const o = s.object.position;
    return out.set(o.x + lx * c + lz * sn, o.y + ly, o.z - lx * sn + lz * c);
  }
  function toWorld(s, lx, ly, lz, out) {
    toGroup(s, lx, ly, lz, out);
    out.y += group.position.y;
    return out;
  }

  // ---------------------------------------------------------------------------
  // Procedural textures (one wood/rope/metal atlas shared by nearly everything)
  // ---------------------------------------------------------------------------
  function region(px0, py0, px1, py1) {
    const S = 256, ins = 3;
    return [(px0 + ins) / S, 1 - (py1 - ins) / S, (px1 - ins) / S, 1 - (py0 + ins) / S];
  }
  const REG = {
    wood: region(0, 0, 256, 64),
    crack: region(0, 64, 256, 128),
    bark: region(0, 128, 256, 192),
    rope: region(0, 192, 128, 256),
    rings: region(128, 192, 192, 256),
    plain: region(192, 192, 256, 256),
  };
  function maxAniso(n) {
    try { return Math.min(n, G.renderer.capabilities.getMaxAnisotropy()); } catch (e) { return 1; }
  }
  function makeAtlas() {
    const S = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const x = cv.getContext('2d');
    const r = seeded(11);
    const clip = (px, py, w, h, fn) => { x.save(); x.beginPath(); x.rect(px, py, w, h); x.clip(); fn(); x.restore(); };
    const speck = (px, py, w, h, n, dark, light) => {
      for (let k = 0; k < n; k++) {
        x.fillStyle = r() < 0.5 ? dark : light;
        x.fillRect(px + r() * w, py + r() * h, 1 + r() * 2, 1);
      }
    };
    const wood = (py, cracked) => clip(0, py, S, 64, () => {
      x.fillStyle = '#f3ece0';
      x.fillRect(0, py, S, 64);
      for (let k = 0; k < 18; k++) {
        const y0 = py + r() * 64, ph = r() * 6, amp = 0.8 + r() * 2;
        x.strokeStyle = 'rgba(110,72,40,' + (0.08 + r() * 0.16).toFixed(3) + ')';
        x.lineWidth = 0.6 + r() * 1.8;
        x.beginPath();
        for (let px = 0; px <= S; px += 8) {
          const yy = y0 + Math.sin(px * 0.025 + ph) * amp;
          if (px === 0) x.moveTo(px, yy); else x.lineTo(px, yy);
        }
        x.stroke();
      }
      for (let k = 0; k < 3; k++) {
        const kx = r() * S, ky = py + 10 + r() * 44;
        x.fillStyle = 'rgba(95,60,32,0.32)';
        x.beginPath(); x.ellipse(kx, ky, 4 + r() * 5, 2 + r() * 2, 0, 0, TAU); x.fill();
        x.strokeStyle = 'rgba(95,60,32,0.2)'; x.lineWidth = 1;
        x.beginPath(); x.ellipse(kx, ky, 9 + r() * 4, 4 + r() * 2, 0, 0, TAU); x.stroke();
      }
      speck(0, py, S, 64, 320, 'rgba(90,60,30,0.10)', 'rgba(255,255,255,0.14)');
      if (cracked) {
        for (let k = 0; k < 6; k++) {
          x.fillStyle = 'rgba(60,45,30,0.13)';
          x.beginPath(); x.arc(r() * S, py + r() * 64, 6 + r() * 12, 0, TAU); x.fill();
        }
        x.strokeStyle = 'rgba(38,22,12,0.85)';
        for (let k = 0; k < 8; k++) {
          x.lineWidth = 1 + r() * 1.6;
          let cx = r() * S, cy = py + 6 + r() * 52;
          x.beginPath(); x.moveTo(cx, cy);
          const n = 4 + ((r() * 5) | 0);
          for (let q = 0; q < n; q++) { cx += 6 + r() * 16; cy += (r() - 0.5) * 9; x.lineTo(cx, cy); }
          x.stroke();
        }
      }
    });
    wood(0, false);
    wood(64, true);
    clip(0, 128, S, 64, () => {                        // bark: streaks along the log (v)
      x.fillStyle = '#ddd2c2';
      x.fillRect(0, 128, S, 64);
      for (let k = 0; k < 46; k++) {
        const x0 = r() * S;
        x.strokeStyle = 'rgba(70,45,25,' + (0.12 + r() * 0.25).toFixed(3) + ')';
        x.lineWidth = 1 + r() * 2.5;
        x.beginPath(); x.moveTo(x0, 128); x.lineTo(x0 + (r() - 0.5) * 6, 160); x.lineTo(x0 + (r() - 0.5) * 6, 192); x.stroke();
      }
    });
    clip(0, 192, 128, 64, () => {                      // twisted rope
      x.fillStyle = '#efe2c6';
      x.fillRect(0, 192, 128, 64);
      x.strokeStyle = 'rgba(115,82,45,0.45)'; x.lineWidth = 3;
      for (let k = -64; k < 192; k += 9) { x.beginPath(); x.moveTo(k, 256); x.lineTo(k + 40, 192); x.stroke(); }
    });
    clip(128, 192, 64, 64, () => {                     // end grain
      x.fillStyle = '#f0e2c8';
      x.fillRect(128, 192, 64, 64);
      x.strokeStyle = 'rgba(140,95,55,0.45)'; x.lineWidth = 1.3;
      for (let rr = 3; rr < 34; rr += 3.5 + r() * 2) { x.beginPath(); x.arc(160, 224, rr, 0, TAU); x.stroke(); }
    });
    clip(192, 192, 64, 64, () => {                     // plain (metal, plastic, paint)
      x.fillStyle = '#f4f4f4';
      x.fillRect(192, 192, 64, 64);
      speck(192, 192, 64, 64, 120, 'rgba(0,0,0,0.05)', 'rgba(255,255,255,0.2)');
    });
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAniso(4);
    return tex;
  }
  function makeClothTex() {
    const S = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const x = cv.getContext('2d');
    const r = seeded(5);
    x.fillStyle = '#f1e8d2';
    x.fillRect(0, 0, S, S);
    for (let k = 0; k < 24; k++) {
      x.fillStyle = 'rgba(150,125,90,0.06)';
      x.beginPath(); x.arc(r() * S, r() * S, 4 + r() * 14, 0, TAU); x.fill();
    }
    x.strokeStyle = 'rgba(140,115,80,0.5)'; x.lineWidth = 1.5;
    for (const px of [32, 64, 96]) { x.beginPath(); x.moveTo(px, 0); x.lineTo(px, S); x.stroke(); }
    x.fillStyle = 'rgba(160,130,90,0.2)';
    x.fillRect(0, 12, S, 5);
    // a patch
    x.fillStyle = '#e0cfa9';
    x.fillRect(84, 80, 22, 20);
    x.setLineDash([2, 2]); x.strokeStyle = 'rgba(110,80,50,0.75)'; x.lineWidth = 1;
    x.strokeRect(84.5, 80.5, 21, 19);
    x.setLineDash([]);
    // a painted sun
    x.fillStyle = '#e39a3b';
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * TAU;
      x.beginPath();
      x.moveTo(56 + Math.cos(a - 0.16) * 17, 58 + Math.sin(a - 0.16) * 17);
      x.lineTo(56 + Math.cos(a) * 27, 58 + Math.sin(a) * 27);
      x.lineTo(56 + Math.cos(a + 0.16) * 17, 58 + Math.sin(a + 0.16) * 17);
      x.fill();
    }
    x.beginPath(); x.arc(56, 58, 15, 0, TAU); x.fill();
    x.fillStyle = '#f6c56b';
    x.beginPath(); x.arc(56, 58, 9, 0, TAU); x.fill();
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAniso(4);
    return tex;
  }
  function makeNetTex() {
    const S = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const x = cv.getContext('2d');
    x.clearRect(0, 0, S, S);
    x.strokeStyle = '#d9c9a0'; x.lineWidth = 3; x.lineCap = 'round';
    x.beginPath(); x.moveTo(0, 0); x.lineTo(S, S); x.moveTo(S, 0); x.lineTo(0, S); x.stroke();
    x.fillStyle = '#bda878';
    for (const p of [[0, 0], [S, 0], [0, S], [S, S], [S / 2, S / 2]]) { x.beginPath(); x.arc(p[0], p[1], 3.5, 0, TAU); x.fill(); }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(6, 6.5);
    return tex;
  }

  // ---------------------------------------------------------------------------
  // Geometry builder: merges primitives into one vertex-coloured, atlas-mapped geometry
  // o = { x,y,z, rx,ry,rz | q, sx,sy,sz, c (hex), shade, reg, cap (cap region), capC (cap colour) }
  // ---------------------------------------------------------------------------
  function Builder() { this.p = []; this.n = []; this.u = []; this.c = []; }
  Builder.prototype.part = function (geo, o) {
    o = o || {};
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (o.q) _q.copy(o.q); else _q.setFromEuler(_e.set(o.rx || 0, o.ry || 0, o.rz || 0));
    _p.set(o.x || 0, o.y || 0, o.z || 0);
    _s.set(o.sx == null ? 1 : o.sx, o.sy == null ? 1 : o.sy, o.sz == null ? 1 : o.sz);
    _m4.compose(_p, _q, _s);
    _m3.getNormalMatrix(_m4);
    const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
    const reg = o.reg || REG.plain, cap = o.cap || reg;
    const capStart = (o.cap || o.capC != null) && geo.groups && geo.groups.length > 1 ? geo.groups[1].start : Infinity;
    const base = o.c == null ? 0xffffff : o.c;
    _c.setHex(base);
    _c2.setHex(o.capC == null ? base : o.capC);
    if (o.shade != null) { _c.multiplyScalar(o.shade); _c2.multiplyScalar(o.shade); }
    for (let k = 0; k < P.count; k++) {
      _v.fromBufferAttribute(P, k).applyMatrix4(_m4);
      this.p.push(_v.x, _v.y, _v.z);
      if (N) { _n.fromBufferAttribute(N, k).applyMatrix3(_m3).normalize(); this.n.push(_n.x, _n.y, _n.z); }
      else this.n.push(0, 1, 0);
      const isCap = k >= capStart, rg = isCap ? cap : reg;
      const uu = U ? U.getX(k) : 0, vv = U ? U.getY(k) : 0;
      this.u.push(rg[0] + (rg[2] - rg[0]) * uu, rg[1] + (rg[3] - rg[1]) * vv);
      const cc = isCap ? _c2 : _c;
      this.c.push(cc.r, cc.g, cc.b);
    }
    if (g !== geo) g.dispose();
    geo.dispose();
    return this;
  };
  Builder.prototype.box = function (w, h, d, o) { return this.part(new THREE.BoxGeometry(w, h, d), o); };
  Builder.prototype.cyl = function (rt, rb, h, seg, o, arc) {
    return this.part(new THREE.CylinderGeometry(rt, rb, h, seg || 8, 1, false, 0, arc || TAU), o);
  };
  Builder.prototype.cone = function (r, h, seg, o) { return this.part(new THREE.ConeGeometry(r, h, seg || 6), o); };
  // Upward-facing flat quad (nail heads, decals): 2 triangles.
  Builder.prototype.quad = function (w, d, o) { return this.part(new THREE.PlaneGeometry(w, d).rotateX(-HALF_PI), o); };
  Builder.prototype.ico = function (r, o) { return this.part(new THREE.IcosahedronGeometry(r, 0), o); };
  Builder.prototype.sphere = function (r, ws, hs, o) { return this.part(new THREE.SphereGeometry(r, ws || 8, hs || 6), o); };
  Builder.prototype.torus = function (R, r, rs, ts, arc, o) {
    return this.part(new THREE.TorusGeometry(R, r, rs || 5, ts || 10, arc || TAU), o);
  };
  // Cylinder between two points (ropes, pipes, braces).
  Builder.prototype.rod = function (ax, ay, az, bx, by, bz, r, seg, o) {
    _v2.set(bx - ax, by - ay, bz - az);
    const len = _v2.length() || 0.001;
    _v2.divideScalar(len);
    const q = new THREE.Quaternion().setFromUnitVectors(_up, _v2);
    return this.cyl(r, r, len, seg || 5, Object.assign({}, o, { x: (ax + bx) / 2, y: (ay + by) / 2, z: (az + bz) / 2, q }));
  };
  Builder.prototype.build = function () {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  };

  // ---------------------------------------------------------------------------
  // Palette, shared materials and geometries
  // ---------------------------------------------------------------------------
  const COL = {
    plank: [0xc9a171, 0xbf9464, 0xd2ac7c, 0xb98d5e, 0xc59b6a],
    plankR: [0xa87a4c, 0x9d7045, 0xb08253, 0xa27548, 0xab7c4e],
    beam: 0x8a6240, log: 0x8f6b48, logEnd: 0xc9a574,
    barrel: 0x93623a, barrelEnd: 0xa77a4c, band: 0x4b5157, drum: 0x2f73a0, drumRim: 0x25608a,
    rope: 0xd2b47c, nail: 0x5b5a55, frame: 0x5a3e25, plate: 0x8d959c, rivet: 0x5d646b,
    metal: 0x6b7279, dark: 0x3b3f44, grate: 0x9aa0a6, brass: 0xd4a043, stone: 0x8e8b82,
    plastic: 0xece4cf, handle: 0x6d4c2e, table: 0xb88d5d,
  };
  let M = null;                 // materials
  const SH = {};                // shared small geometries
  const GEO = {};               // lazily built structure geometries
  const tileGeoCache = [];

  function assets() {
    if (M) return M;
    const atlas = makeAtlas();
    M = {
      atlas: new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0 }),
      metal: new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.5, metalness: 0.28 }),
      cloth: new THREE.MeshStandardMaterial({ map: makeClothTex(), side: THREE.DoubleSide, flatShading: true, roughness: 0.95 }),
      net: new THREE.MeshStandardMaterial({ map: makeNetTex(), side: THREE.DoubleSide, alphaTest: 0.45, roughness: 1 }),
      water: new THREE.MeshStandardMaterial({ color: 0x4fb8dc, roughness: 0.15, metalness: 0.1, emissive: 0x0b3a4a, emissiveIntensity: 0.5 }),
      flame: new THREE.MeshBasicMaterial({ color: 0xff7a22, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }),
      flameCore: new THREE.MeshBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending }),
      emberOff: new THREE.MeshStandardMaterial({ color: 0x2c2522, flatShading: true, roughness: 1 }),
      emberOn: new THREE.MeshStandardMaterial({ color: 0x3a2418, emissive: 0xff4a12, emissiveIntensity: 1.1, flatShading: true, roughness: 1 }),
      marker: new THREE.MeshBasicMaterial({ color: 0xffd66b }),
      ghostOk: new THREE.MeshBasicMaterial({ color: 0x6dff8e, transparent: true, opacity: 0.38, depthWrite: false }),
      ghostBad: new THREE.MeshBasicMaterial({ color: 0xff5a4a, transparent: true, opacity: 0.38, depthWrite: false }),
      outline: new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }),
      steam: new THREE.MeshLambertMaterial({ color: 0xf4f7f8, emissive: 0x6d7478, transparent: true, opacity: 0.38, depthWrite: false, flatShading: true }),
      smoke: new THREE.MeshLambertMaterial({ color: 0x77736e, transparent: true, opacity: 0.34, depthWrite: false, flatShading: true }),
      spark: new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending }),
    };
    SH.puff = new THREE.IcosahedronGeometry(1, 0);
    SH.flame = new THREE.ConeGeometry(0.045, 0.13, 5).translate(0, 0.065, 0);
    SH.marker = new THREE.OctahedronGeometry(0.075, 0);
    SH.waterDisc = new THREE.CylinderGeometry(0.058, 0.058, 0.008, 12);
    SH.drip = new THREE.SphereGeometry(0.013, 5, 4);
    SH.ropeUnit = new Builder().cyl(0.018, 0.018, 1, 5, { y: -0.5, c: COL.rope, reg: REG.plain }).build();
    SH.fish = new Builder()
      .sphere(0.1, 8, 5, { sx: 1.9, sy: 0.75, sz: 0.5, c: 0xffffff })
      .cone(0.07, 0.12, 4, { x: -0.23, rz: -HALF_PI, sz: 0.3, c: 0xe6e6e6 })
      .cone(0.035, 0.08, 3, { y: 0.07, sz: 0.3, c: 0xdddddd })
      .ico(0.018, { x: 0.13, y: 0.025, z: 0.043, c: 0x151515 })
      .ico(0.018, { x: 0.13, y: 0.025, z: -0.043, c: 0x151515 })
      .build();
    SH.steak = new Builder()
      .ico(0.11, { sx: 1.35, sy: 0.95, sz: 0.42, c: 0xffffff })
      .box(0.2, 0.03, 0.02, { z: -0.043, c: 0xf6ece2 })
      .build();
    SH.tokens = [
      new Builder().box(0.34, 0.035, 0.09, { y: 0.018, c: 0xb48a58, reg: REG.wood }).build(),
      new Builder().cyl(0.035, 0.04, 0.16, 7, { y: 0.04, rz: HALF_PI, c: 0x7cc0d8 }).cyl(0.015, 0.015, 0.04, 6, { x: 0.1, y: 0.04, rz: HALF_PI, c: 0x3f7fa6 }).build(),
      new Builder().cone(0.07, 0.34, 4, { y: 0.015, rz: HALF_PI, sz: 0.25, c: 0x6fae4a }).build(),
      new Builder().cyl(0.07, 0.07, 0.05, 9, { y: 0.025, c: COL.rope, reg: REG.rope }).build(),
    ];
    return M;
  }

  // ---------------------------------------------------------------------------
  // Tile visuals: planks over logs / barrels with rope lashings. Shared per
  // (float variant, reinforced, damage state); all tiles with the same key are drawn by one
  // InstancedMesh ("bucket"), so tile draw calls stay at 2 × (keys in use) however big the raft gets.
  // ---------------------------------------------------------------------------
  const MISS = [{ a: 1, b: 4, br: 2 }, { a: 3, b: 0, br: 2 }, { a: 2, b: 4, br: 1 }];
  const PLANK_Z = [-0.8, -0.4, 0, 0.4, 0.8];

  function tileGeometry(variant, reinforced, state) {
    const key = variant * 8 + (reinforced ? 4 : 0) + state;
    if (tileGeoCache[key]) return tileGeoCache[key];
    const b = new Builder();
    const rnd = seeded(97 + variant * 31);
    const shade = [1, 0.93, 0.84, 0.72][state];
    // floats
    if (variant === 0) {
      for (const z of [-0.55, 0.55]) {
        b.cyl(0.21, 0.21, 1.98, 9, { y: 0.06, z, rz: HALF_PI, c: COL.log, shade: shade * (0.92 + rnd() * 0.12), reg: REG.bark, cap: REG.rings, capC: COL.logEnd });
        for (const x of [-0.62, 0.62]) {
          if (state >= 2 && x > 0 && z > 0) continue;           // a lashing came loose
          if (reinforced) b.cyl(0.228, 0.228, 0.08, 9, { x, y: 0.06, z, rz: HALF_PI, c: COL.plate });
          else b.cyl(0.232, 0.232, 0.13, 9, { x, y: 0.06, z, rz: HALF_PI, c: COL.rope, reg: REG.rope });
        }
      }
    } else {
      const wood = variant === 1;
      for (const z of [-0.55, 0.55]) {
        for (const x of [-0.49, 0.49]) {
          b.cyl(0.23, 0.23, 0.86, 10, { x, y: 0.02, z, rz: HALF_PI, c: wood ? COL.barrel : COL.drum, shade,
            reg: wood ? REG.bark : REG.plain, cap: wood ? REG.rings : REG.plain, capC: wood ? COL.barrelEnd : COL.drumRim });
          for (const dx of [-0.3, 0.3]) {
            b.cyl(0.238, 0.238, 0.05, 10, { x: x + dx, y: 0.02, z, rz: HALF_PI, c: wood ? COL.band : COL.drumRim, shade });
          }
        }
        for (const x of [-0.62, 0.62]) {
          if (state >= 2 && x > 0 && z > 0) continue;
          if (reinforced) b.cyl(0.244, 0.244, 0.07, 10, { x, y: 0.02, z, rz: HALF_PI, c: COL.plate });
          else b.cyl(0.25, 0.25, 0.1, 10, { x, y: 0.02, z, rz: HALF_PI, c: COL.rope, reg: REG.rope });
        }
      }
    }
    // cross beams
    for (const x of [-0.62, 0.62]) b.box(1.94, 0.075, 0.16, { x, y: 0.2425, ry: HALF_PI, c: COL.beam, shade, reg: REG.wood });
    // planks (+ nails)
    const miss = MISS[variant];
    for (let k = 0; k < 5; k++) {
      const tone = (reinforced ? COL.plankR : COL.plank)[(k + variant * 2) % 5];
      const len = 1.97 + (rnd() - 0.5) * 0.04, jx = (rnd() - 0.5) * 0.03, jry = (rnd() - 0.5) * 0.025, jy = (rnd() - 0.5) * 0.006;
      if (state >= 2 && k === miss.a) continue;
      if (state >= 3 && k === miss.b) continue;
      // dark sub-deck strip under each board (hides the sea in the plank gaps and tile seams;
      // a missing board leaves a real hole). Top at 0.265, below the beam tops (0.28).
      b.box(2.0, 0.02, 0.4, { y: 0.255, z: PLANK_Z[k], c: COL.beam, shade: shade * 0.45 });
      const cracked = state === 1 ? (k === miss.b || k === miss.br) : state >= 2;
      const reg = cracked ? REG.crack : REG.wood;
      const z = PLANK_Z[k];
      if (state >= 3 && k === miss.br) {
        b.box(0.95, 0.07, 0.375, { x: -0.52, y: 0.29, z, rz: -0.12, c: tone, shade, reg });
        b.box(0.95, 0.07, 0.375, { x: 0.52, y: 0.29, z, rz: 0.12, c: tone, shade, reg });
        continue;
      }
      b.box(len, 0.07, 0.375, { x: jx, y: 0.315 + jy, z, ry: jry, c: tone, shade, reg });
      for (const x of [-0.62, 0.62]) {
        b.quad(0.026, 0.026, { x, y: 0.3516 + jy, z: z - 0.1, ry: 0.4, c: COL.nail });
        b.quad(0.026, 0.026, { x, y: 0.3516 + jy, z: z + 0.1, ry: -0.3, c: COL.nail });
      }
    }
    if (reinforced) {
      // darker frame around the tile + metal corner plates with rivets
      b.box(2.0, 0.17, 0.06, { y: 0.26, z: 0.97, c: COL.frame, shade, reg: REG.wood });
      b.box(2.0, 0.17, 0.06, { y: 0.26, z: -0.97, c: COL.frame, shade, reg: REG.wood });
      b.box(2.0, 0.17, 0.06, { x: 0.97, y: 0.26, ry: HALF_PI, c: COL.frame, shade, reg: REG.wood });
      b.box(2.0, 0.17, 0.06, { x: -0.97, y: 0.26, ry: HALF_PI, c: COL.frame, shade, reg: REG.wood });
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          b.box(0.4, 0.016, 0.11, { x: sx * 0.78, y: 0.357, z: sz * 0.925, c: COL.plate });
          b.box(0.11, 0.016, 0.4, { x: sx * 0.925, y: 0.357, z: sz * 0.78, c: COL.plate });
          b.quad(0.03, 0.03, { x: sx * 0.925, y: 0.3655, z: sz * 0.925, c: COL.rivet });
          b.quad(0.03, 0.03, { x: sx * 0.66, y: 0.3655, z: sz * 0.925, c: COL.rivet });
          b.quad(0.03, 0.03, { x: sx * 0.925, y: 0.3655, z: sz * 0.66, c: COL.rivet });
          b.box(0.12, 0.2, 0.014, { x: sx * 0.9, y: 0.25, z: sz * 1.004, c: COL.plate });
          b.box(0.014, 0.2, 0.12, { x: sx * 1.004, y: 0.25, z: sz * 0.9, c: COL.plate });
        }
      }
    }
    tileGeoCache[key] = b.build();
    return tileGeoCache[key];
  }

  function tileState(t) {
    const r = t.hp / t.maxHp;
    return r > 0.75 ? 0 : r > 0.5 ? 1 : r > 0.25 ? 2 : 3;
  }
  // Instanced tile buckets: key (variant, reinforced, state) -> { mesh: InstancedMesh, list: [tile] }.
  // A tile's instance index is t.slot; t.mesh is its bucket's InstancedMesh.
  const buckets = [];
  const _tp = new THREE.Vector3(), _ts = new THREE.Vector3(), _tq = new THREE.Quaternion(), _tm = new THREE.Matrix4();
  const _qFlip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), PI), _qId = new THREE.Quaternion();

  function makeBucketMesh(geo, cap) {
    const mesh = new THREE.InstancedMesh(geo, M.atlas, cap);
    mesh.count = 0;
    mesh.visible = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'raft-tiles';
    return mesh;
  }
  function tileMatrix(t, ox, oy, oz, sc) {
    _tp.set((t.i + 0.5) * TILE + ox, oy, (t.j + 0.5) * TILE + oz);
    _ts.set(sc, sc, sc);
    _tq.copy(t.flip ? _qFlip : _qId);
    t.mesh.setMatrixAt(t.slot, _tm.compose(_tp, _tq, _ts));
    t.mesh.instanceMatrix.needsUpdate = true;
  }
  function bucketChanged(bk) {
    bk.mesh.count = bk.list.length;
    bk.mesh.visible = bk.list.length > 0;
    bk.mesh.instanceMatrix.needsUpdate = true;
    bk.mesh.boundingSphere = null;                // recomputed lazily by the frustum test
  }
  function bucketInsert(t, key, geo) {
    let bk = buckets[key];
    if (!bk) {
      bk = buckets[key] = { mesh: makeBucketMesh(geo, MAX_SPAN * MAX_SPAN), list: [] };
      group.add(bk.mesh);
    }
    if (bk.list.length >= bk.mesh.instanceMatrix.count) {        // grow (only for odd saves)
      const old = bk.mesh, mesh = makeBucketMesh(geo, old.instanceMatrix.count * 2);
      mesh.instanceMatrix.array.set(old.instanceMatrix.array);
      group.remove(old);
      old.dispose();
      group.add(mesh);
      bk.mesh = mesh;
      for (const o of bk.list) o.mesh = mesh;
    }
    t.bucket = bk;
    t.slot = bk.list.length;
    t.mesh = bk.mesh;
    bk.list.push(t);
    tileMatrix(t, 0, 0, 0, 1);
    bucketChanged(bk);
  }
  function bucketRemove(t) {
    const bk = t.bucket;
    if (!bk) return;
    const last = bk.list.pop();
    if (last !== t) {
      bk.list[t.slot] = last;
      last.slot = t.slot;
      bk.mesh.getMatrixAt(bk.list.length, _tm);   // the moved tile keeps its current (animated) matrix
      bk.mesh.setMatrixAt(last.slot, _tm);
    }
    t.bucket = null;
    t.slot = -1;
    bucketChanged(bk);
  }

  function refreshTile(t) {
    const st = tileState(t);
    const code = st + (t.reinforced ? 4 : 0);
    if (code !== t.dmg) {
      t.dmg = code;
      bucketRemove(t);
      bucketInsert(t, t.variant * 8 + code, tileGeometry(t.variant, t.reinforced, st));
    }
    return st;
  }

  // ---------------------------------------------------------------------------
  // Derived caches: edges, frontier (buildable empty cells), bounds, radius
  // ---------------------------------------------------------------------------
  function hasNeighbour(i, j) {
    return grid.has(nkey(i + 1, j)) || grid.has(nkey(i - 1, j)) || grid.has(nkey(i, j + 1)) || grid.has(nkey(i, j - 1));
  }
  function spanOk(i, j) {
    if (!tiles.size) return true;
    return Math.max(cache.maxI, i) - Math.min(cache.minI, i) + 1 <= MAX_SPAN &&
      Math.max(cache.maxJ, j) - Math.min(cache.minJ, j) + 1 <= MAX_SPAN;
  }
  const DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0]];     // rotation r faces DIRS[r] (local +Z)
  function refresh() {
    if (!dirty) return;
    dirty = false;
    cache.edges.length = 0;
    cache.frontier.length = 0;
    let minI = Infinity, maxI = -Infinity, minJ = Infinity, maxJ = -Infinity, rad = 0;
    for (const t of tiles.values()) {
      if (t.i < minI) minI = t.i;
      if (t.i > maxI) maxI = t.i;
      if (t.j < minJ) minJ = t.j;
      if (t.j > maxJ) maxJ = t.j;
      let nb = 0;
      for (const d of DIRS) if (grid.has(nkey(t.i + d[0], t.j + d[1]))) nb++;
      if (nb < 4) cache.edges.push(t);
      const fx = Math.max(Math.abs(t.i * TILE), Math.abs((t.i + 1) * TILE));
      const fz = Math.max(Math.abs(t.j * TILE), Math.abs((t.j + 1) * TILE));
      rad = Math.max(rad, Math.hypot(fx, fz));
    }
    if (!tiles.size) { minI = 0; maxI = -1; minJ = 0; maxJ = -1; }
    cache.minI = minI; cache.maxI = maxI; cache.minJ = minJ; cache.maxJ = maxJ; cache.radius = rad;
    const seen = new Set();
    for (const t of cache.edges) {
      for (const d of DIRS) {
        const i = t.i + d[0], j = t.j + d[1], k = nkey(i, j);
        if (grid.has(k) || seen.has(k)) continue;
        seen.add(k);
        if (spanOk(i, j)) cache.frontier.push({ i, j });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tiles
  // ---------------------------------------------------------------------------
  function addTile(i, j) {
    i = Math.floor(Number(i));
    j = Math.floor(Number(j));
    if (!Number.isFinite(i) || !Number.isFinite(j)) return null;
    const k = nkey(i, j);
    if (grid.has(k)) return grid.get(k);
    assets();
    const h = hash2(i, j), v = h % 10;
    const t = {
      i, j, hp: HP_NORMAL, maxHp: HP_NORMAL, reinforced: false, mesh: null, structure: null,
      variant: v < 6 ? 0 : v < 8 ? 1 : 2, flip: ((h >>> 8) & 1) === 1,
      dmg: -1, pop: 1, shake: 0, fxAt: -1e9, animating: false, bucket: null, slot: -1,
    };
    refreshTile(t);                               // puts the tile into its instanced bucket (sets t.mesh)
    tiles.set(skey(i, j), t);
    grid.set(k, t);
    dirty = true;
    if (!quiet) {
      t.pop = 0;
      t.animating = true;
      G.stats.tilesBuilt = (G.stats.tilesBuilt || 0) + 1;
      G.events.emit('build:tile', { i, j });
    }
    return t;
  }

  function removeTileInternal(t) {
    if (t.structure) removeStructure(t.structure, false);
    bucketRemove(t);
    t.animating = false;
    tiles.delete(skey(t.i, t.j));
    grid.delete(nkey(t.i, t.j));
    dirty = true;
  }

  function isLive(t) { return !!t && grid.get(nkey(t.i, t.j)) === t; }

  function tileCenter(t, out) {
    out = out || new THREE.Vector3();
    if (!t) return out.set(0, raft.deckY(), 0);
    return out.set((t.i + 0.5) * TILE, raft.deckY(), (t.j + 0.5) * TILE);
  }

  const DESTROY_TEXT = {
    shark: 'Žralok ukousl kus voru!',
    cannon: 'Dělová koule rozbila kus voru!',
    storm: 'Bouře utrhla kus voru!',
  };

  function destroyTile(t, source) {
    if (!isLive(t)) return false;
    const c = tileCenter(t, new THREE.Vector3());
    const s = t.structure;
    if (s) {
      if (!quiet) spillStructure(s, c);
      removeStructure(s, false);
    }
    removeTileInternal(t);
    if (!quiet) {
      fxCall('debris', c, WOOD_CHIP, 26);
      fxCall('splash', _v.set(c.x, 0, c.z), 1.6);
      snd('break_wood', c);
      snd('splash_big', c, 0.7);
      G.notify((DESTROY_TEXT[source] || 'Kus voru se rozpadl!') + (s ? ' Věci z něj plavou ve vodě – chyť je hákem!' : ''), 'danger');
      G.events.emit('tile:destroyed', { i: t.i, j: t.j, source });
    }
    return true;
  }

  function damageTile(t, amount, source) {
    if (!isLive(t)) return 0;
    amount = Number(amount) || 0;
    if (!(amount > 0)) return 0;
    if (t.reinforced) {
      if (source === 'shark') return 0;
      if (source === 'cannon') amount *= 0.5;
    }
    if (source === 'storm' && !stormInternal) extStormHitAt = G.time;
    const before = t.hp;
    const stBefore = tileState(t);
    t.hp -= amount;
    if (tiles.size <= 1 && t.hp < 1) t.hp = 1;          // the last tile never sinks
    const dealt = before - Math.max(0, t.hp);
    t.shake = 0.35;
    t.animating = true;
    if (t.hp <= 0) {
      t.hp = 0;
      if (!quiet) G.events.emit('tile:damaged', { tile: t, amount: dealt, source });
      destroyTile(t, source);
      return dealt;
    }
    const st = refreshTile(t);
    if (!quiet) {
      if (st > stBefore || G.time - t.fxAt > 0.6) {
        t.fxAt = G.time;
        const c = tileCenter(t, _v);
        fxCall('debris', c, WOOD_CHIP, st > stBefore ? 10 : 4);
        if (st > stBefore) snd('break_wood', c, 0.55);
      }
      if (source === 'storm' && G.time - stormNotifyAt > 60) {
        stormNotifyAt = G.time;
        G.notify('Bouře trhá okraje voru! Oprav je kladivem.', 'warn');
      } else if (st === 3 && stBefore < 3 && G.time - critNotifyAt > 20) {
        critNotifyAt = G.time;
        G.notify('Vor je hodně poškozený! Oprav ho kladivem (1× Prkno).', 'warn');
      }
      G.events.emit('tile:damaged', { tile: t, amount: dealt, source });
    }
    return dealt;
  }

  function canBuildAt(i, j) {
    i = Math.floor(i); j = Math.floor(j);
    if (grid.has(nkey(i, j))) return 'occupied';
    if (!tiles.size) return '';
    if (!hasNeighbour(i, j)) return 'detached';
    refresh();
    if (!spanOk(i, j)) return 'size';
    return '';
  }

  // Paid hammer actions (also usable directly by scripts/tests). Return true on success.
  function build(i, j) {
    if (canBuildAt(i, j)) return false;
    if (!pay(COST.foundation)) return false;
    const t = addTile(i, j);
    if (!t) return false;
    const c = tileCenter(t, new THREE.Vector3());
    snd('hammer', c);
    snd('build', c);
    fxCall('splash', _v.set(c.x, 0, c.z), 0.9);
    fxCall('debris', c, 0xcaa678, 8);
    return true;
  }
  function repair(t) {
    if (!isLive(t) || t.hp >= t.maxHp) return false;
    if (!pay(COST.repair)) return false;
    t.hp = t.maxHp;
    refreshTile(t);
    t.pop = 0.55;
    t.animating = true;
    const c = tileCenter(t, new THREE.Vector3());
    snd('hammer', c);
    fxCall('debris', c, 0xcaa678, 7);
    fxCall('sparkle', c, 0xffe7a0);
    G.events.emit('build:repair', { i: t.i, j: t.j });
    return true;
  }
  function reinforce(t) {
    if (!isLive(t) || t.reinforced) return false;
    if (!pay(COST.reinforce)) return false;
    t.reinforced = true;
    t.maxHp = HP_REINFORCED;
    t.hp = HP_REINFORCED;
    refreshTile(t);
    t.pop = 0.55;
    t.animating = true;
    const c = tileCenter(t, new THREE.Vector3());
    snd('hammer', c);
    snd('build', c, 0.7);
    fxCall('sparkle', c, 0xcfd8e0);
    G.events.emit('build:reinforce', { i: t.i, j: t.j });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Structures framework
  // ---------------------------------------------------------------------------
  function normRot(r) {
    r = Number(r) || 0;
    if (!Number.isInteger(r)) r = Math.round(r / HALF_PI);   // tolerate radians
    return ((r % 4) + 4) % 4;
  }

  function registerStructure(type, def) {
    if (!type || !def || typeof def.create !== 'function') {
      console.warn('[raft] registerStructure: invalid definition for ' + type);
      return null;
    }
    structureDefs[type] = def;
    return def;
  }

  function resolveTile(tile) {
    if (!tile) return null;
    if (typeof tile === 'string') return tiles.get(tile) || null;
    if (tile.mesh && isLive(tile)) return tile;
    if (tile.i != null && tile.j != null) return grid.get(nkey(Math.floor(tile.i), Math.floor(tile.j))) || null;
    return null;
  }

  function markShadows(obj) {
    obj.traverse((o) => {
      if (o.isMesh && !o.userData.noShadow && !(o.material && o.material.transparent)) { o.castShadow = true; o.receiveShadow = true; }
    });
  }

  // placeStructure(type, tile, rotation[, savedData]) -> s | null. `rotation` = quarter turns 0..3.
  function placeStructure(type, tile, rotation, savedData) {
    const def = structureDefs[type];
    if (!def) return null;
    tile = resolveTile(tile);
    if (!tile || tile.structure) return null;
    const rot = normRot(rotation);
    let data = {};
    if (typeof def.data === 'function') { try { data = def.data() || {}; } catch (err) { data = {}; } }
    const s = { type, tile, object: null, data, rotation: rot };
    const hasSaved = savedData !== undefined && savedData !== null;
    if (hasSaved && !def.load && typeof savedData === 'object') Object.assign(s.data, savedData);
    let obj = null;
    try { obj = def.create(s); } catch (err) { console.error('[raft] create ' + type, err); }
    if (!obj || !obj.isObject3D) return null;
    s.object = obj;
    obj.position.set((tile.i + 0.5) * TILE, G.C.DECK_Y, (tile.j + 0.5) * TILE);
    obj.rotation.y = rot * HALF_PI;
    obj.userData.raftStructure = s;
    if (!def.ownShadows) markShadows(obj);
    group.add(obj);
    obj.updateMatrixWorld(true);                  // aimable right away, before the next render
    structureObjects.push(obj);
    tile.structure = s;
    structures.push(s);
    if (hasSaved && def.load) {
      try { def.load(s, savedData); } catch (err) { console.error('[raft] load ' + type, err); }
    }
    if (def.interact && typeof def.interact.onInteract === 'function') {
      const at = def.interactAt || [0, def.interactY != null ? def.interactY : 0.5, 0];
      const it = {
        structure: s,
        size: def.size || 0.7,
        getPosition(out) { return toWorld(s, at[0], at[1], at[2], out); },
        label() {
          try { return def.interact.label ? def.interact.label(s) : def.name; } catch (err) { return def.name || ''; }
        },
        onInteract() { def.interact.onInteract(s); },
      };
      if (typeof def.interact.enabled === 'function') it.enabled = () => def.interact.enabled(s);
      // true while the label is only information (E does nothing useful) — ui.js may hide the [E] cap
      if (typeof def.interact.passive === 'function') it.passive = () => !!def.interact.passive(s);
      s._it = G.interaction.add(it);
    }
    s._scale = obj.scale.x || 1;
    s._pop = quiet ? 1 : 0;
    updateFlags();
    if (!quiet) G.events.emit('build:structure', { type, tile });
    return s;
  }

  // Items a structure holds right now: [[id, count], ...]
  function contentsOf(s) {
    const def = structureDefs[s.type];
    const out = [];
    try {
      if (def && typeof def.contents === 'function') {
        for (const e of def.contents(s) || []) if (e && e[1] > 0) out.push([e[0], e[1]]);
      } else if (s.data && s.data.storage) {
        for (const sl of storageSlots(s.data.storage)) if (sl) out.push([sl.id, sl.count]);
      }
    } catch (err) { /* ignore */ }
    return out;
  }

  // The structure fell into the sea with its tile: float its contents and the item itself.
  function spillStructure(s, pos) {
    const def = structureDefs[s.type];
    const sum = Object.create(null);
    for (const [id, n] of contentsOf(s)) sum[id] = (sum[id] || 0) + n;
    if (def && def.item) sum[def.item] = (sum[def.item] || 0) + 1;
    for (const id in sum) floatItem(id, sum[id], pos);
  }

  function refundStructure(s) {
    const def = structureDefs[s.type];
    const pos = tileCenter(s.tile, new THREE.Vector3());
    const I = G.inventory;
    if (s.data && s.data.storage && Array.isArray(s.data.storage.slots)) {
      I.takeAll(s.data.storage, 'refund');
      for (const sl of s.data.storage.slots) if (sl) floatItem(sl.id, sl.count, pos);
    } else {
      for (const [id, n] of contentsOf(s)) {
        const left = I.add(id, n, 'refund');
        if (left > 0) floatItem(id, left, pos);
      }
    }
    if (def && def.item) {
      const left = I.add(def.item, 1, 'refund');
      if (left > 0) floatItem(def.item, left, pos);
    }
    fxCall('debris', pos, WOOD_CHIP, 12);
    snd('break_wood', pos, 0.5);
    snd('pickup', pos);
  }

  function removeStructure(s, refund) {
    if (!s) return false;
    const idx = structures.indexOf(s);
    if (idx < 0) return false;
    const def = structureDefs[s.type];
    // a chest that vanishes while its panel is open: close the panel so nothing can be duplicated
    if (!quiet && s.type === 'chest' && s._v && s._v.open && G.uiBlocking() && G.ui && typeof G.ui.closeAll === 'function') {
      try { G.ui.closeAll(); } catch (err) { /* ignore */ }
    }
    if (refund && !quiet) refundStructure(s);
    if (def && typeof def.remove === 'function') {
      try { def.remove(s); } catch (err) { console.error('[raft] remove ' + s.type, err); }
    }
    if (s._it) { G.interaction.remove(s._it); s._it = null; }
    if (s.object) {
      group.remove(s.object);
      const oi = structureObjects.indexOf(s.object);
      if (oi >= 0) structureObjects.splice(oi, 1);
    }
    if (s._own) { for (const r of s._own) if (r && r.dispose) r.dispose(); s._own = null; }
    structures.splice(idx, 1);
    if (s.tile && s.tile.structure === s) s.tile.structure = null;
    updateFlags();
    if (!quiet) G.events.emit('structure:removed', { type: s.type, refund: !!refund });
    return true;
  }

  function updateFlags() {
    let sail = false, anchor = false;
    for (const s of structures) {
      if (s.type === 'sail' && s.data && s.data.up) sail = true;
      else if (s.type === 'anchor' && s.data && s.data.down) anchor = true;
    }
    raft.sailUp = sail;
    raft.anchored = anchor;
  }

  // ---------------------------------------------------------------------------
  // Tiny particle systems in raft space (steam, smoke, sparks) — one InstancedMesh each
  // ---------------------------------------------------------------------------
  function Particles(mat, max) {
    this.max = max;
    this.n = 0;
    this.d = new Float32Array(max * 10);           // x y z vx vy vz age life size spin
    this.mesh = new THREE.InstancedMesh(SH.puff, mat, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.userData.noShadow = true;
  }
  Particles.prototype.emit = function (x, y, z, vx, vy, vz, life, size) {
    if (this.n >= this.max) return;
    const d = this.d, k = this.n++ * 10;
    d[k] = x; d[k + 1] = y; d[k + 2] = z; d[k + 3] = vx; d[k + 4] = vy; d[k + 5] = vz;
    d[k + 6] = 0; d[k + 7] = life; d[k + 8] = size; d[k + 9] = Math.random() * TAU;
  };
  Particles.prototype.update = function (dt, grow) {
    const d = this.d;
    for (let i = 0; i < this.n;) {
      const k = i * 10;
      d[k + 6] += dt;
      if (d[k + 6] >= d[k + 7]) {
        const l = --this.n * 10;
        if (l !== k) for (let q = 0; q < 10; q++) d[k + q] = d[l + q];
        continue;
      }
      d[k] += d[k + 3] * dt; d[k + 1] += d[k + 4] * dt; d[k + 2] += d[k + 5] * dt;
      d[k + 3] *= 0.985; d[k + 5] *= 0.985;
      const f = d[k + 6] / d[k + 7];
      const sc = d[k + 8] * (grow ? (0.5 + 1.4 * f) * Math.min(1, (1 - f) * 3) : (1 - f));
      d[k + 9] += dt * 0.8;
      _e.set(d[k + 9], d[k + 9] * 1.3, 0);
      _q.setFromEuler(_e);
      _s.set(sc, sc * 0.85, sc);
      _p.set(d[k], d[k + 1], d[k + 2]);
      _m4.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m4);
      i++;
    }
    this.mesh.count = this.n;
    if (this.n) this.mesh.instanceMatrix.needsUpdate = true;
  };
  Particles.prototype.clear = function () { this.n = 0; this.mesh.count = 0; };
  const PS = { steam: null, smoke: null, spark: null };

  // Shared bits for structure models
  function mesh(geo, mat, shadow) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow !== false;
    m.receiveShadow = true;
    if (shadow === false) m.userData.noShadow = true;
    return m;
  }
  function addFlames(parent, list) {
    const out = [];
    for (const f of list) {
      const fg = new THREE.Group();
      fg.position.set(f[0], f[1], f[2]);
      const o = new THREE.Mesh(SH.flame, M.flame), c = new THREE.Mesh(SH.flame, M.flameCore);
      c.scale.set(0.55, 0.6, 0.55);
      fg.add(o, c);
      fg.scale.setScalar(f[3]);
      fg.userData.base = f[3];
      fg.userData.ph = Math.random() * 10;
      fg.visible = false;
      parent.add(fg);
      out.push(fg);
    }
    return out;
  }
  function animFlames(list, on) {
    for (const fg of list) {
      fg.visible = on;
      if (!on) continue;
      const b = fg.userData.base, ph = fg.userData.ph;
      const f = 0.8 + 0.25 * Math.sin(clock * 17 + ph) + 0.12 * Math.sin(clock * 29 + ph * 2);
      fg.scale.set(b * (0.9 + 0.1 * Math.sin(clock * 11 + ph)), b * f, b * (0.9 + 0.1 * Math.cos(clock * 13 + ph)));
      fg.rotation.y = clock * 2 + ph;
    }
  }
  function addMarker(parent, x, y, z) {
    const m = new THREE.Mesh(SH.marker, M.marker);
    m.position.set(x, y, z);
    m.visible = false;
    m.userData.y = y;
    m.userData.noShadow = true;
    parent.add(m);
    return m;
  }
  function animMarker(m, on) {
    m.visible = on;
    if (!on) return;
    m.rotation.y = clock * 2.4;
    m.position.y = m.userData.y + Math.sin(clock * 3.2) * 0.04;
  }
  const live = () => !G.paused;

  // ---------------------------------------------------------------------------
  // Purifier (Čistička vody)
  // ---------------------------------------------------------------------------
  function purifierGeo() {
    if (GEO.purifier) return GEO.purifier;
    const w = new Builder(), m = new Builder();
    w.box(0.95, 0.06, 0.68, { y: 0.33, c: COL.table, reg: REG.wood });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) w.box(0.07, 0.3, 0.07, { x: sx * 0.4, y: 0.15, z: sz * 0.27, c: COL.beam, reg: REG.wood });
    w.box(0.84, 0.035, 0.58, { y: 0.09, c: 0xa77e50, reg: REG.wood });
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * TAU;
      w.ico(0.065, { x: -0.14 + Math.cos(a) * 0.17, y: 0.41, z: Math.sin(a) * 0.17, sy: 0.8, c: k % 2 ? 0x8e8b82 : 0x77746c });
    }
    w.cyl(0.025, 0.025, 0.26, 5, { x: -0.14, y: 0.39, rz: HALF_PI, ry: 0.5, c: COL.handle, reg: REG.bark });
    w.cyl(0.025, 0.025, 0.26, 5, { x: -0.14, y: 0.395, rz: HALF_PI, ry: -0.6, c: 0x7a5534, reg: REG.bark });
    w.cyl(0.065, 0.05, 0.14, 10, { x: 0.3, y: 0.43, z: 0.08, c: COL.plastic });              // cup
    w.cyl(0.04, 0.045, 0.16, 7, { x: 0.33, y: 0.44, z: -0.22, c: 0x7cc0d8 });                 // spare bottle
    w.cyl(0.016, 0.02, 0.04, 6, { x: 0.33, y: 0.54, z: -0.22, c: 0x3f7fa6 });
    m.cyl(0.19, 0.16, 0.26, 10, { x: -0.14, y: 0.63, c: COL.metal });                         // pot
    m.cyl(0.205, 0.205, 0.03, 10, { x: -0.14, y: 0.755, c: 0x80878e });
    m.cyl(0.06, 0.2, 0.08, 10, { x: -0.14, y: 0.8, c: 0x80878e });
    m.ico(0.03, { x: -0.14, y: 0.855, c: COL.brass });
    m.box(0.06, 0.025, 0.1, { x: -0.36, y: 0.71, c: COL.dark });
    m.box(0.06, 0.025, 0.1, { x: 0.08, y: 0.71, c: COL.dark });
    m.rod(-0.14, 0.82, 0.02, -0.14, 0.97, 0.02, 0.022, 6, { c: COL.brass });                  // copper pipe
    m.ico(0.034, { x: -0.14, y: 0.97, z: 0.02, c: COL.brass });
    m.rod(-0.14, 0.97, 0.02, 0.3, 0.97, 0.08, 0.022, 6, { c: COL.brass });
    m.ico(0.034, { x: 0.3, y: 0.97, z: 0.08, c: COL.brass });
    m.rod(0.3, 0.97, 0.08, 0.3, 0.62, 0.08, 0.02, 6, { c: COL.brass });
    m.cyl(0.012, 0.024, 0.04, 6, { x: 0.3, y: 0.6, z: 0.08, c: 0xb57a32 });
    GEO.purifier = { wood: w.build(), metal: m.build() };
    return GEO.purifier;
  }
  function createPurifier(s) {
    const g = new THREE.Group(), geo = purifierGeo();
    g.add(mesh(geo.wood, M.atlas), mesh(geo.metal, M.metal));
    const v = (s._v = { emitT: 0, dripT: 0 });
    v.water = mesh(SH.waterDisc, M.water, false);
    v.water.position.set(0.3, 0.504, 0.08);
    v.water.visible = false;
    v.drip = mesh(SH.drip, M.water, false);
    v.drip.visible = false;
    g.add(v.water, v.drip);
    v.flames = addFlames(g, [[-0.19, 0.39, 0.03, 0.8], [-0.09, 0.39, -0.04, 0.95], [-0.14, 0.39, 0.07, 0.7]]);
    v.marker = addMarker(g, 0.3, 0.82, 0.08);
    return g;
  }
  function purifierLabel(s) {
    const d = s.data;
    if (d.state === 'done') return 'Vzít pitnou vodu';
    if (d.state === 'work') return 'Čistí se… ' + Math.max(1, Math.ceil(d.t)) + ' s';
    if (G.inventory.count('kelimek_slany') > 0) return 'Čistit vodu';
    return 'Potřebuješ slanou vodu (nabereš ji kelímkem z moře)';
  }
  function purifierUse(s) {
    const d = s.data;
    const pos = toWorld(s, 0.3, 0.5, 0.08, new THREE.Vector3());
    if (d.state === 'done') {
      if (G.inventory.add('kelimek_sladky', 1, 'purify') > 0) return;
      d.state = 'idle';
      d.t = 0;
      snd('pickup', pos);
      fxCall('sparkle', pos, 0x86d4f2);
      G.events.emit('purify:done', { id: 'kelimek_sladky' });
      return;
    }
    if (d.state === 'work') {
      G.notify('Voda se ještě čistí. Chvilku počkej.', 'info');
      return;
    }
    if (G.inventory.count('kelimek_slany') <= 0 || !takeOne('kelimek_slany')) {
      G.notify(G.inventory.count('kelimek') > 0 ? 'Nejdřív naber kelímkem mořskou vodu.'
        : 'Potřebuješ kelímek se slanou vodou. Kelímek vyrobíš ze 4 plastů.', 'warn');
      G.sfx('error');
      return;
    }
    d.state = 'work';
    d.t = PURIFY_TIME;
    snd('bubble', pos);
  }
  function purifierFrame(s, dt) {
    const v = s._v, d = s.data;
    const work = d.state === 'work', done = d.state === 'done';
    animFlames(v.flames, work);
    animMarker(v.marker, done);
    const level = work ? 1 - d.t / PURIFY_TIME : done ? 1 : 0;
    v.water.visible = level > 0.03;
    if (v.water.visible) { const k = 0.3 + 0.7 * level; v.water.scale.set(k, 1, k); }
    v.drip.visible = work;
    if (work) {
      if (live()) v.dripT = (v.dripT + dt * 1.7) % 1;
      v.drip.position.set(0.3, 0.585 - 0.085 * v.dripT * v.dripT, 0.08);
      v.drip.visible = v.dripT < 0.92;
    }
    if ((work || done) && live()) {
      v.emitT -= dt;
      if (v.emitT <= 0) {
        v.emitT = work ? 0.09 : 0.55;
        toGroup(s, -0.14 + (Math.random() - 0.5) * 0.24, 0.86, (Math.random() - 0.5) * 0.24, _v);
        PS.steam.emit(_v.x, _v.y, _v.z, (Math.random() - 0.5) * 0.12, 0.32 + Math.random() * 0.22, (Math.random() - 0.5) * 0.12,
          1.4 + Math.random(), work ? 0.06 + Math.random() * 0.05 : 0.04);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Grill (Gril)
  // ---------------------------------------------------------------------------
  function grillGeo() {
    if (GEO.grill) return GEO.grill;
    const w = new Builder(), m = new Builder(), coal = new Builder();
    w.box(0.95, 0.05, 0.62, { y: 0.025, c: COL.stone });                                  // stone slab protects the deck
    w.box(0.28, 0.03, 0.38, { x: 0.56, y: 0.5, c: COL.table, reg: REG.wood });             // side shelf
    w.cyl(0.02, 0.02, 0.22, 6, { x: -0.5, y: 0.47, rx: HALF_PI, c: COL.handle, reg: REG.wood });
    w.box(0.02, 0.015, 0.16, { x: 0.58, y: 0.522, z: -0.06, c: COL.handle });                // spatula handle
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.cyl(0.022, 0.018, 0.34, 6, { x: sx * 0.32, y: 0.2, z: sz * 0.19, c: COL.dark });
    m.box(0.8, 0.03, 0.5, { y: 0.35, c: COL.dark });
    m.box(0.8, 0.19, 0.03, { y: 0.45, z: 0.235, c: 0x464b51 });
    m.box(0.8, 0.19, 0.03, { y: 0.45, z: -0.235, c: 0x464b51 });
    m.box(0.03, 0.19, 0.5, { x: 0.385, y: 0.45, c: 0x464b51 });
    m.box(0.03, 0.19, 0.5, { x: -0.385, y: 0.45, c: 0x464b51 });
    for (let k = 0; k < 7; k++) m.cyl(0.009, 0.009, 0.78, 4, { y: 0.548, z: -0.18 + k * 0.06, rz: HALF_PI, c: COL.grate });
    m.box(0.02, 0.02, 0.46, { x: 0.3, y: 0.54, c: COL.grate });
    m.box(0.02, 0.02, 0.46, { x: -0.3, y: 0.54, c: COL.grate });
    m.box(0.18, 0.02, 0.02, { x: 0.48, y: 0.46, z: 0.14, rz: -0.5, c: COL.dark });
    m.box(0.18, 0.02, 0.02, { x: 0.48, y: 0.46, z: -0.14, rz: -0.5, c: COL.dark });
    m.box(0.03, 0.03, 0.06, { x: -0.41, y: 0.47, z: 0.08, c: COL.dark });
    m.box(0.03, 0.03, 0.06, { x: -0.41, y: 0.47, z: -0.08, c: COL.dark });
    m.box(0.07, 0.006, 0.09, { x: 0.58, y: 0.52, z: 0.08, c: COL.grate });                   // spatula blade
    const r = seeded(3);
    for (let k = 0; k < 10; k++) coal.ico(0.045 + r() * 0.02, { x: (r() - 0.5) * 0.6, y: 0.385, z: (r() - 0.5) * 0.34, sy: 0.7 });
    GEO.grill = { wood: w.build(), metal: m.build(), coals: coal.build() };
    return GEO.grill;
  }
  const FISH_SIZE = { sardinka: 0.72, makrela: 0.95, tunak: 1.22, zralok_maso: 1 };
  function createGrill(s) {
    const g = new THREE.Group(), geo = grillGeo();
    g.add(mesh(geo.wood, M.atlas), mesh(geo.metal, M.metal));
    const v = (s._v = { emitT: 0, sparkT: 0, kind: null, raw: new THREE.Color(), cooked: new THREE.Color() });
    v.coals = mesh(geo.coals, M.emberOff);
    g.add(v.coals);
    v.flames = addFlames(g, [[-0.22, 0.37, -0.08, 0.9], [0, 0.37, 0.06, 1.05], [0.2, 0.37, -0.05, 0.85], [0.1, 0.37, 0.13, 0.7], [-0.1, 0.37, 0.13, 0.75]]);
    v.fishMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.6 });
    s._own = [v.fishMat];
    v.fish = new THREE.Mesh(SH.fish, v.fishMat);
    v.fish.position.set(0, 0.575, 0);
    v.fish.rotation.set(HALF_PI, 0, 0.35);
    v.fish.castShadow = true;
    v.fish.visible = false;
    g.add(v.fish);
    v.marker = addMarker(g, 0, 0.95, 0);
    return g;
  }
  function pickCookable() {
    const I = G.inventory;
    const sel = I.getSelected();
    if (sel && G.items.cookResult(sel.id)) return sel.id;
    for (const sl of I.slots) if (sl && G.items.cookResult(sl.id)) return sl.id;
    return null;
  }
  function grillLabel(s) {
    const d = s.data;
    if (d.state === 'done') return 'Vzít: ' + itemName(d.out);
    if (d.state === 'work') return 'Peče se… ' + Math.max(1, Math.ceil(d.t)) + ' s';
    const id = pickCookable();
    return id ? 'Upéct: ' + itemName(id) : 'Potřebuješ syrovou rybu (chytíš ji udicí)';
  }
  function grillUse(s) {
    const d = s.data;
    const pos = toWorld(s, 0, 0.6, 0, new THREE.Vector3());
    if (d.state === 'done') {
      const out = d.out;
      if (G.inventory.add(out, 1, 'cook') > 0) return;
      d.state = 'idle'; d.t = 0; d.input = null; d.out = null;
      snd('pickup', pos);
      fxCall('sparkle', pos, 0xffc36b);
      G.events.emit('cook:done', { id: out });
      return;
    }
    if (d.state === 'work') {
      G.notify('Ještě se to peče. Chvilku vydrž.', 'info');
      return;
    }
    const id = pickCookable();
    const out = id && G.items.cookResult(id);
    if (!id || !out || !takeOne(id)) {
      G.notify('Na gril dej syrovou rybu nebo maso.', 'warn');
      G.sfx('error');
      return;
    }
    d.state = 'work'; d.t = COOK_TIME; d.input = id; d.out = out;
    s._sz = 0.3;
    snd('sizzle', pos);
  }
  function grillFrame(s, dt) {
    const v = s._v, d = s.data;
    const work = d.state === 'work', done = d.state === 'done';
    animFlames(v.flames, work);
    animMarker(v.marker, done);
    v.coals.material = work || done ? M.emberOn : M.emberOff;
    const id = work || done ? d.input : null;
    v.fish.visible = !!id;
    if (id) {
      if (v.kind !== id) {
        v.kind = id;
        v.fish.geometry = id === 'zralok_maso' ? SH.steak : SH.fish;
        v.fish.scale.setScalar(FISH_SIZE[id] || 1);
        v.raw.set(itemColor(id, '#c0a090'));
        v.cooked.set(itemColor(d.out, '#a8632f'));
      }
      const p = work ? 1 - d.t / COOK_TIME : 1;
      v.fishMat.color.copy(v.raw).lerp(v.cooked, smooth01(p));
      v.fish.position.y = 0.575 + (work ? Math.max(0, Math.sin(clock * 9)) * 0.005 : 0);
    }
    if ((work || done) && live()) {
      v.emitT -= dt;
      if (v.emitT <= 0) {
        v.emitT = work ? 0.13 : 0.6;
        toGroup(s, (Math.random() - 0.5) * 0.5, 0.6, (Math.random() - 0.5) * 0.3, _v);
        (work ? PS.smoke : PS.steam).emit(_v.x, _v.y, _v.z, (Math.random() - 0.5) * 0.15, 0.45 + Math.random() * 0.3,
          (Math.random() - 0.5) * 0.15, work ? 2 + Math.random() : 1.3, work ? 0.07 + Math.random() * 0.06 : 0.04);
      }
      if (work) {
        v.sparkT -= dt;
        if (v.sparkT <= 0) {
          v.sparkT = 0.25 + Math.random() * 0.3;
          toGroup(s, (Math.random() - 0.5) * 0.5, 0.5, (Math.random() - 0.5) * 0.3, _v);
          PS.spark.emit(_v.x, _v.y, _v.z, (Math.random() - 0.5) * 0.3, 0.9 + Math.random() * 0.6, (Math.random() - 0.5) * 0.3, 0.6 + Math.random() * 0.4, 0.014);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Chest (Truhla)
  // ---------------------------------------------------------------------------
  function chestGeo() {
    if (GEO.chest) return GEO.chest;
    const w = new Builder(), m = new Builder(), lw = new Builder(), lm = new Builder();
    w.box(0.94, 0.05, 0.6, { y: 0.025, c: 0x6f4a2a, reg: REG.wood });
    w.box(0.9, 0.37, 0.56, { y: 0.235, c: 0x9a6a3c, reg: REG.wood });
    w.box(0.905, 0.012, 0.565, { y: 0.17, c: 0x5e3f22 });
    w.box(0.905, 0.012, 0.565, { y: 0.3, c: 0x5e3f22 });
    w.box(0.8, 0.004, 0.46, { y: 0.4215, c: 0x3a2716 });                                       // dark inside
    for (const sx of [-1, 1]) {
      m.box(0.06, 0.4, 0.575, { x: sx * 0.3, y: 0.22, c: COL.dark });
      for (const sz of [-1, 1]) m.box(0.05, 0.4, 0.05, { x: sx * 0.45, y: 0.22, z: sz * 0.28, c: 0x4a5056 });
    }
    m.box(0.13, 0.12, 0.02, { y: 0.35, z: 0.287, c: COL.brass });
    m.box(0.022, 0.045, 0.006, { y: 0.34, z: 0.298, c: 0x221a12 });
    // lid, pivot at the back top edge; built relative to that pivot
    lw.cyl(0.28, 0.28, 0.9, 10, { z: 0.28, rz: HALF_PI, sx: 0.55, c: 0xa0703f, reg: REG.wood, capC: 0x8a5d33 }, PI);
    lw.box(0.9, 0.025, 0.56, { y: 0.0125, z: 0.28, c: 0x8a5d33, reg: REG.wood });
    for (const sx of [-1, 1]) lm.cyl(0.288, 0.288, 0.065, 10, { x: sx * 0.3, z: 0.28, rz: HALF_PI, sx: 0.57, c: COL.dark }, PI);
    lm.box(0.08, 0.09, 0.02, { y: -0.01, z: 0.567, c: COL.brass });
    GEO.chest = { wood: w.build(), metal: m.build(), lidWood: lw.build(), lidMetal: lm.build() };
    return GEO.chest;
  }
  function createChest(s) {
    const g = new THREE.Group(), geo = chestGeo();
    g.add(mesh(geo.wood, M.atlas), mesh(geo.metal, M.metal));
    const lid = new THREE.Group();
    lid.position.set(0, 0.42, -0.28);
    lid.add(mesh(geo.lidWood, M.atlas), mesh(geo.lidMetal, M.metal));
    g.add(lid);
    s._v = { lid, open: false, amt: 0, openT: 0 };
    return g;
  }
  function chestLabel(s) {
    const n = storageCount(s.data.storage);
    return 'Otevřít truhlu' + (n ? ' (' + itemsText(n) + ')' : ' (prázdná)');
  }
  function chestUse(s) {
    const v = s._v;
    if (G.ui && typeof G.ui.openStorage === 'function') {
      v.open = true;
      v.openT = 0;
      G.ui.openStorage(s.data.storage, 'Truhla');
    } else {
      G.notify('Truhlu teď nejde otevřít.', 'warn');
    }
  }
  function chestFrame(s, dt) {
    const v = s._v;
    if (v.open) {
      v.openT += dt;
      if (v.openT > 0.3 && !G.uiBlocking()) v.open = false;
    }
    v.amt = G.damp(v.amt, v.open ? 1 : 0, v.open ? 10 : 7, dt);
    const a = v.amt;
    v.lid.rotation.x = -1.75 * (a + 0.12 * Math.sin(a * PI));
  }

  // ---------------------------------------------------------------------------
  // Net (Síť na trosky) — hangs off the tile's local +Z edge into the water
  // ---------------------------------------------------------------------------
  function netGeo() {
    if (GEO.net) return GEO.net;
    const w = new Builder();
    for (const sx of [-1, 1]) {
      w.box(0.08, 1.95, 0.08, { x: sx * 0.88, y: 0.35, z: 1.03, c: COL.beam, reg: REG.wood });
      w.rod(sx * 0.88, 0.02, 0.3, sx * 0.88, 1.0, 1.0, 0.03, 5, { c: 0x7a5534, reg: REG.wood });
      w.box(0.1, 0.05, 0.14, { x: sx * 0.88, y: 0.03, z: 0.3, c: COL.frame });
      w.cyl(0.058, 0.058, 0.09, 6, { x: sx * 0.88, y: 1.3, z: 1.03, c: COL.rope, reg: REG.rope });
      w.cyl(0.058, 0.058, 0.09, 6, { x: sx * 0.88, y: 0.36, z: 1.03, c: COL.rope, reg: REG.rope });
    }
    w.cyl(0.035, 0.035, 1.84, 6, { y: 1.3, z: 1.03, rz: HALF_PI, c: 0x9c7248, reg: REG.bark });
    w.cyl(0.03, 0.03, 1.84, 6, { y: -0.58, z: 1.03, rz: HALF_PI, c: COL.rope, reg: REG.rope });
    for (let k = 0; k < 4; k++) w.cyl(0.055, 0.055, 0.1, 8, { x: -0.6 + k * 0.4, y: -0.3, z: 1.03, rx: HALF_PI, c: 0xd9573a });
    GEO.net = { frame: w.build(), panel: new THREE.PlaneGeometry(1.72, 1.86) };
    return GEO.net;
  }
  const TOKEN_POS = [[-0.55, 0.78, 0.3], [-0.18, 0.82, -0.4], [0.22, 0.77, 1.2], [0.56, 0.8, 2.6], [-0.36, 0.62, 2], [0.38, 0.64, -1.1]];
  function createNet(s) {
    const g = new THREE.Group(), geo = netGeo();
    g.add(mesh(geo.frame, M.atlas));
    const panel = mesh(geo.panel, M.net, false);
    panel.position.set(0, 0.36, 1.03);
    g.add(panel);
    const tokens = [];
    for (let k = 0; k < TOKEN_POS.length; k++) {
      const p = TOKEN_POS[k];
      const t = mesh(SH.tokens[k % SH.tokens.length], M.atlas, false);
      t.position.set(p[0], 0.0, p[1]);
      t.rotation.y = p[2];
      t.visible = false;
      g.add(t);
      tokens.push(t);
    }
    s._v = { panel, tokens, wob: 0, marker: addMarker(g, 0, 1.55, 1.03) };
    return g;
  }
  function netLabel(s) {
    const n = storageCount(s.data.storage);
    if (!n) return 'Síť je prázdná – trosky se do ní chytí samy';
    if (storageFree(s.data.storage) === 0) return 'Vybrat síť – je plná! (' + itemsText(n) + ')';
    return 'Vybrat síť (' + itemsText(n) + ')';
  }
  function netUse(s) {
    const pos = toWorld(s, 0, 0.5, 0.9, new THREE.Vector3());
    if (!storageCount(s.data.storage)) {
      G.notify('Síť je zatím prázdná. Trosky do ní připlavou samy.', 'info');
      return;
    }
    const moved = G.inventory.takeAll(s.data.storage, 'net');
    if (moved > 0) {
      snd('pickup', pos);
      fxCall('sparkle', pos, 0xe6cf9f);
      s._v.wob = 1;
    }
  }
  function netFrame(s, dt) {
    const v = s._v;
    const filled = storageFilled(s.data.storage);
    for (let k = 0; k < v.tokens.length; k++) v.tokens[k].visible = k < filled;
    animMarker(v.marker, storageFree(s.data.storage) === 0);
    v.wob = Math.max(0, v.wob - dt * 1.8);
    v.panel.rotation.x = Math.sin(clock * 18) * 0.06 * v.wob + Math.sin(clock * 1.3 + s.tile.i) * 0.015;
  }
  // Debris position, tolerant of how debris.js stores it.
  function debrisPos(d) {
    if (!d) return null;
    if (d.position && d.position.isVector3) return d.position;
    if (d.pos && d.pos.isVector3) return d.pos;
    const o = d.mesh || d.object || d.group || d.obj;
    if (o && o.position) return o.position;
    if (typeof d.x === 'number' && typeof d.z === 'number') return _debrisP.set(d.x, d.y || 0, d.z);
    return null;
  }
  const _debrisP = new THREE.Vector3();
  const _debrisTmp = [];
  function netCatch() {
    const D = G.debris;
    if (!D || typeof D.collect !== 'function' || !D.list) return;
    let nets = 0;
    for (const s of structures) if (s.type === 'net') nets++;
    if (!nets) return;
    let L = D.list;
    if (!Array.isArray(L)) {
      if (typeof L.forEach !== 'function') return;
      _debrisTmp.length = 0;
      L.forEach((d) => _debrisTmp.push(d));
      L = _debrisTmp;
    }
    const R2 = NET_RADIUS * NET_RADIUS;
    for (const s of structures) {
      if (s.type !== 'net' || !storageFree(s.data.storage)) continue;
      const cx = (s.tile.i + 0.5) * TILE, cz = (s.tile.j + 0.5) * TILE;
      for (let k = L.length - 1; k >= 0; k--) {
        const d = L[k];
        if (!d || d.hooked || d.attached || d.collected || d.dead || d.removed || d.alive === false) continue;
        const p = debrisPos(d);
        if (!p) continue;
        const dx = p.x - cx, dz = p.z - cz;
        if (dx * dx + dz * dz > R2) continue;
        if (typeof d === 'object' && netCaught.has(d)) continue;
        try { D.collect(d, s.data.storage); } catch (err) { continue; }
        if (typeof d === 'object') netCaught.add(d);
        s._v.wob = 1;
        if (!storageFree(s.data.storage)) break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Sail (Plachta) — mast, yard and a billowing cloth that turns to the wind
  // ---------------------------------------------------------------------------
  const CLOTH_SEG = 8, CLOTH_TOP = 3.47, CLOTH_H = 1.95, CLOTH_Z = 0.13;
  function sailGeo() {
    if (GEO.sail) return GEO.sail;
    const w = new Builder(), r = new Builder(), p = new Builder();
    w.box(0.5, 0.1, 0.5, { y: 0.05, c: COL.frame, reg: REG.wood });
    for (let k = 0; k < 4; k++) w.box(0.1, 0.12, 0.05, { y: 0.16, x: Math.cos(k * HALF_PI) * 0.12, z: Math.sin(k * HALF_PI) * 0.12, ry: k * HALF_PI, c: COL.beam });
    w.cyl(0.07, 0.09, 4.1, 8, { y: 2.05, c: 0xa77b4d, reg: REG.bark, cap: REG.rings, capC: COL.logEnd });
    w.box(0.17, 0.12, 0.17, { y: 4.1, c: COL.frame, reg: REG.wood });
    w.cyl(0.1, 0.1, 0.12, 8, { y: 0.4, c: COL.rope, reg: REG.rope });
    w.cyl(0.095, 0.095, 0.1, 8, { y: 3.85, c: COL.rope, reg: REG.rope });
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        w.rod(0, 3.95, 0, sx * 0.9, 0.04, sz * 0.9, 0.011, 4, { c: COL.rope, reg: REG.plain });
        w.box(0.1, 0.04, 0.06, { x: sx * 0.9, y: 0.02, z: sz * 0.9, c: COL.dark });
      }
    }
    // rig (rotates with the wind): yard + pennant pole
    r.cyl(0.045, 0.045, 2.2, 6, { y: CLOTH_TOP + 0.06, z: CLOTH_Z, rz: HALF_PI, c: 0x9c7248, reg: REG.bark, capC: COL.logEnd });
    r.cyl(0.05, 0.05, 0.09, 6, { x: -1.02, y: CLOTH_TOP + 0.06, z: CLOTH_Z, rz: HALF_PI, c: COL.rope, reg: REG.rope });
    r.cyl(0.05, 0.05, 0.09, 6, { x: 1.02, y: CLOTH_TOP + 0.06, z: CLOTH_Z, rz: HALF_PI, c: COL.rope, reg: REG.rope });
    r.torus(0.1, 0.018, 4, 8, TAU, { y: CLOTH_TOP + 0.06, rx: HALF_PI, c: COL.rope, reg: REG.plain });
    r.cyl(0.012, 0.012, 0.4, 4, { y: 4.35, c: COL.dark });
    p.cone(0.06, 0.34, 3, { z: 0.17, rx: HALF_PI, sx: 0.25, c: 0xc9472f });
    GEO.sail = {
      mast: w.build(), rig: r.build(), pennant: p.build(),
      furl: new Builder().cyl(0.1, 0.1, 2.0, 8, { rz: HALF_PI, c: 0xefe6d0, reg: REG.plain, capC: 0xd8ccb0 }).build(),
      batten: new Builder().cyl(0.022, 0.022, 2.0, 5, { rz: HALF_PI, c: 0x9c7248, reg: REG.bark }).build(),
    };
    return GEO.sail;
  }
  function createSail(s) {
    const g = new THREE.Group(), geo = sailGeo();
    g.add(mesh(geo.mast, M.atlas));
    const rig = new THREE.Group();
    g.add(rig);
    rig.add(mesh(geo.rig, M.atlas));
    const pennant = mesh(geo.pennant, M.atlas, false);
    pennant.position.set(0, 4.52, 0);
    rig.add(pennant);
    const furl = mesh(geo.furl, M.atlas);
    furl.position.set(0, CLOTH_TOP - 0.02, CLOTH_Z);
    rig.add(furl);
    const batten = mesh(geo.batten, M.atlas);
    rig.add(batten);
    const clothGeo = new THREE.PlaneGeometry(1, 1, CLOTH_SEG, CLOTH_SEG);
    clothGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2.5, 0), 2.6);
    s._own = [clothGeo];
    const cloth = new THREE.Mesh(clothGeo, M.cloth);
    cloth.castShadow = true;
    cloth.receiveShadow = true;
    cloth.frustumCulled = false;
    rig.add(cloth);
    const up = !!(s.data && s.data.up);
    const w = G.world && G.world.windDir;
    const yaw = w ? Math.atan2(w.x, w.z) - s.rotation * HALF_PI : 0;
    s._v = { rig, cloth, furl, batten, pennant, raise: up ? 1 : 0, yaw, still: false };
    rig.rotation.y = yaw;
    updateCloth(s);
    return g;
  }
  function updateCloth(s) {
    const v = s._v;
    const pos = v.cloth.geometry.attributes.position;
    const r = smooth01(v.raise);
    const H = 0.1 + CLOTH_H * r;
    const storm = G.world ? G.world.storm || 0 : 0;
    const flap = 0.022 + 0.03 * storm;
    const N = CLOTH_SEG + 1;
    for (let iy = 0; iy < N; iy++) {
      const vv = iy / CLOTH_SEG;
      for (let ix = 0; ix < N; ix++) {
        const u = ix / CLOTH_SEG;
        const bul = Math.sin(PI * u) * Math.sin(PI * (0.1 + 0.85 * vv));
        const x = (u - 0.5) * 2.0 * (1 - 0.05 * vv);
        const y = CLOTH_TOP - vv * H;
        const z = CLOTH_Z + r * (0.34 * bul + flap * vv * Math.sin(clock * 4.3 + u * 6 + vv * 2.5));
        pos.setXYZ(iy * N + ix, x, y, z);
      }
    }
    pos.needsUpdate = true;
    v.batten.position.set(0, CLOTH_TOP - H, CLOTH_Z + r * 0.03);
    v.batten.visible = r > 0.08;
    const f = 0.3 + 0.7 * (1 - r);
    v.furl.scale.set(1, f, f);
    v.furl.visible = r < 0.97;
  }
  function sailUse(s) {
    s.data.up = !s.data.up;
    updateFlags();
    snd('sail', toWorld(s, 0, 2, 0, _v));
    G.events.emit('sail:toggled', { up: s.data.up });
    if (s.data.up && raft.anchored) G.notify('Kotva je dole – dokud ji nevytáhneš, vor se nepohne.', 'info');
  }
  function sailFrame(s, dt) {
    const v = s._v;
    const target = s.data.up ? 1 : 0;
    const moving = v.raise !== target;
    if (moving) v.raise += Math.sign(target - v.raise) * Math.min(Math.abs(target - v.raise), dt / 1.3);
    const w = G.world && G.world.windDir;
    if (w) {
      const want = Math.atan2(w.x, w.z) - s.rotation * HALF_PI;
      const diff = Math.atan2(Math.sin(want - v.yaw), Math.cos(want - v.yaw));
      v.yaw += diff * (1 - Math.exp(-1.5 * dt));
      v.rig.rotation.y = v.yaw;
    }
    if (moving || v.raise > 0.01 || !v.still) {
      updateCloth(s);
      v.still = !moving && v.raise <= 0.01;
    }
    v.pennant.rotation.y = Math.sin(clock * 7 + s.tile.j) * 0.25;
    v.pennant.rotation.z = Math.sin(clock * 11) * 0.12;
  }

  // ---------------------------------------------------------------------------
  // Anchor (Kotva) — windlass + anchor hanging over the local +Z edge
  // ---------------------------------------------------------------------------
  const ANCHOR_UP_Y = 0.06, ANCHOR_DOWN_Y = -4.6, ANCHOR_Z = 1.03, ROLLER_Y = 0.1;
  function anchorGeo() {
    if (GEO.anchor) return GEO.anchor;
    const w = new Builder(), m = new Builder(), dw = new Builder(), dm = new Builder(), a = new Builder();
    w.box(1.0, 0.05, 0.5, { y: 0.025, c: COL.frame, reg: REG.wood });
    for (const sx of [-1, 1]) {
      w.box(0.1, 0.62, 0.34, { x: sx * 0.42, y: 0.33, c: COL.beam, reg: REG.wood });
      w.box(0.13, 0.04, 0.37, { x: sx * 0.42, y: 0.66, c: COL.frame, reg: REG.wood });
      m.box(0.03, 0.12, 0.08, { x: sx * 0.17, y: 0.08, z: 0.95, c: COL.dark });
    }
    w.box(0.46, 0.05, 0.14, { y: 0.025, z: 0.93, c: COL.frame, reg: REG.wood });
    m.cyl(0.05, 0.05, 0.3, 8, { y: ROLLER_Y, z: 0.95, rz: HALF_PI, c: COL.metal });
    w.rod(0, 0.43, 0.12, 0, ROLLER_Y + 0.045, 0.96, 0.018, 5, { c: COL.rope, reg: REG.plain });
    dw.cyl(0.11, 0.11, 0.74, 10, { rz: HALF_PI, c: 0x9c7248, reg: REG.wood, cap: REG.rings, capC: COL.logEnd });
    dw.cyl(0.17, 0.17, 0.035, 10, { x: 0.3, rz: HALF_PI, c: COL.frame, reg: REG.wood });
    dw.cyl(0.17, 0.17, 0.035, 10, { x: -0.3, rz: HALF_PI, c: COL.frame, reg: REG.wood });
    dw.cyl(0.02, 0.02, 0.16, 6, { x: 0.58, y: 0.24, rz: HALF_PI, c: COL.handle, reg: REG.wood });
    dm.cyl(0.02, 0.02, 0.2, 6, { x: 0.46, rz: HALF_PI, c: COL.dark });
    dm.box(0.03, 0.27, 0.04, { x: 0.52, y: 0.12, c: COL.dark });
    a.torus(0.055, 0.014, 5, 10, TAU, { c: COL.dark });
    a.cyl(0.028, 0.028, 0.62, 6, { y: -0.36, c: COL.dark });
    a.box(0.05, 0.05, 0.42, { y: -0.12, c: COL.dark });
    a.ico(0.03, { y: -0.12, z: 0.22, c: COL.dark });
    a.ico(0.03, { y: -0.12, z: -0.22, c: COL.dark });
    a.torus(0.21, 0.027, 5, 12, PI, { y: -0.45, rz: PI, c: COL.dark });
    a.cone(0.065, 0.13, 3, { x: 0.21, y: -0.4, sz: 0.4, c: COL.dark });
    a.cone(0.065, 0.13, 3, { x: -0.21, y: -0.4, sz: 0.4, c: COL.dark });
    a.ico(0.045, { y: -0.66, c: COL.dark });
    GEO.anchor = {
      frame: w.build(), frameMetal: m.build(), drum: dw.build(), crank: dm.build(), anchor: a.build(),
      coil: new Builder().cyl(0.15, 0.15, 0.54, 10, { rz: HALF_PI, c: COL.rope, reg: REG.rope }).build(),
    };
    return GEO.anchor;
  }
  function createAnchor(s) {
    const g = new THREE.Group(), geo = anchorGeo();
    g.add(mesh(geo.frame, M.atlas), mesh(geo.frameMetal, M.metal));
    const drum = new THREE.Group();
    drum.position.set(0, 0.5, 0);
    drum.add(mesh(geo.drum, M.atlas), mesh(geo.crank, M.metal));
    const coil = mesh(geo.coil, M.atlas);
    drum.add(coil);
    g.add(drum);
    const rope = mesh(SH.ropeUnit, M.atlas, false);
    rope.position.set(0, ROLLER_Y, ANCHOR_Z);
    g.add(rope);
    const anchor = new THREE.Group();
    anchor.add(mesh(geo.anchor, M.metal));
    anchor.position.set(0, ANCHOR_UP_Y, ANCHOR_Z);
    g.add(anchor);
    const down = !!(s.data && s.data.down);
    s._v = { drum, coil, rope, anchor, drop: down ? 1 : 0, prevBottom: 0, prevRing: 0, fresh: true };
    anchorPose(s);
    return g;
  }
  function anchorPose(s) {
    const v = s._v;
    const e = v.drop * v.drop * (3 - 2 * v.drop) * 0.35 + v.drop * 0.65;
    const ringY = ANCHOR_UP_Y + (ANCHOR_DOWN_Y - ANCHOR_UP_Y) * e;
    v.anchor.position.y = ringY;
    const len = ROLLER_Y - ringY;
    v.rope.scale.y = Math.max(0.02, len);
    v.drum.rotation.x = -len / 0.13;
    const k = 1 - 0.22 * v.drop;
    v.coil.scale.set(1, k, k);
    return ringY;
  }
  function anchorUse(s) {
    s.data.down = !s.data.down;
    updateFlags();
    snd('anchor', toWorld(s, 0, 0.5, 0.5, _v));
    G.events.emit('anchor:toggled', { down: s.data.down });
  }
  function anchorFrame(s, dt) {
    const v = s._v;
    if (live()) {
      if (s.data.down) v.drop = Math.min(1, v.drop + dt * (0.3 + v.drop * 1.4));
      else v.drop = Math.max(0, v.drop - dt * 0.38);
    }
    const ringY = anchorPose(s);
    v.anchor.rotation.z = Math.sin(clock * 1.3 + s.tile.i) * 0.05 * (1 - v.drop);
    const wl = -G.C.DECK_Y, bottom = ringY - 0.66;
    if (!v.fresh && !quiet) {
      if (s.data.down && v.prevBottom > wl && bottom <= wl) {
        toWorld(s, 0, wl, ANCHOR_Z, _v);
        fxCall('splash', _v, 1.1);
        snd('splash', _v);
      } else if (!s.data.down && v.prevRing < wl && ringY >= wl) {
        toWorld(s, 0, wl, ANCHOR_Z, _v);
        fxCall('splash', _v, 0.6);
        snd('splash', _v, 0.5);
      }
    }
    v.fresh = false;
    v.prevBottom = bottom;
    v.prevRing = ringY;
  }

  // ---------------------------------------------------------------------------
  // Register the built-in structure types
  // ---------------------------------------------------------------------------
  function storageSave(st) {
    return { slots: storageSlots(st).map((s) => (s ? (s.dur != null ? { id: s.id, count: s.count, dur: s.dur } : { id: s.id, count: s.count }) : null)) };
  }
  function stateOf(v) { return v === 'work' || v === 'done' ? v : 'idle'; }

  registerStructure('purifier', {
    name: 'Čistička vody', item: 'cisticka', ownShadows: true, size: 0.6, interactY: 0.55,
    data: () => ({ state: 'idle', t: 0 }),
    create: createPurifier,
    interact: {
      label: purifierLabel, onInteract: purifierUse,
      passive: (s) => s.data.state === 'work' || (s.data.state === 'idle' && G.inventory.count('kelimek_slany') <= 0),
    },
    update(s, dt) {
      const d = s.data;
      if (d.state !== 'work') return;
      d.t -= dt;
      if (d.t > 0) return;
      d.t = 0;
      d.state = 'done';
      const pos = toWorld(s, 0.3, 0.55, 0.08, new THREE.Vector3());
      snd('bubble', pos);
      fxCall('sparkle', pos, 0x86d4f2);
      G.notify('Pitná voda je hotová!', 'good');
    },
    frame: purifierFrame,
    save: (s) => ({ state: s.data.state, t: Math.round(s.data.t * 10) / 10 }),
    load(s, d) {
      d = d || {};
      s.data.state = stateOf(d.state);
      s.data.t = s.data.state === 'work' ? G.clamp(Number(d.t) || 0, 0, PURIFY_TIME) : 0;
    },
    contents: (s) => (s.data.state === 'work' ? [['kelimek_slany', 1]] : s.data.state === 'done' ? [['kelimek_sladky', 1]] : []),
  });

  registerStructure('grill', {
    name: 'Gril', item: 'gril', ownShadows: true, size: 0.6, interactY: 0.55,
    data: () => ({ state: 'idle', t: 0, input: null, out: null }),
    create: createGrill,
    interact: {
      label: grillLabel, onInteract: grillUse,
      passive: (s) => s.data.state === 'work' || (s.data.state === 'idle' && !pickCookable()),
    },
    update(s, dt) {
      const d = s.data;
      if (d.state !== 'work') return;
      s._sz = (s._sz || 0) - dt;
      if (s._sz <= 0) { s._sz = 2.2 + Math.random() * 0.8; snd('sizzle', toWorld(s, 0, 0.6, 0, _v), 0.5); }
      d.t -= dt;
      if (d.t > 0) return;
      d.t = 0;
      d.state = 'done';
      const pos = toWorld(s, 0, 0.65, 0, new THREE.Vector3());
      fxCall('sparkle', pos, 0xffc36b);
      snd('sizzle', pos, 0.8);
      G.notify('Jídlo na grilu je upečené!', 'good');
    },
    frame: grillFrame,
    save: (s) => ({ state: s.data.state, t: Math.round(s.data.t * 10) / 10, input: s.data.input, out: s.data.out }),
    load(s, d) {
      d = d || {};
      const input = G.items.def(d.input) ? d.input : null;
      const out = input ? G.items.cookResult(input) : null;
      s.data.state = input && out ? stateOf(d.state) : 'idle';
      s.data.input = s.data.state === 'idle' ? null : input;
      s.data.out = s.data.state === 'idle' ? null : out;
      s.data.t = s.data.state === 'work' ? G.clamp(Number(d.t) || 0, 0, COOK_TIME) : 0;
    },
    contents: (s) => (s.data.state === 'work' && s.data.input ? [[s.data.input, 1]] : s.data.state === 'done' && s.data.out ? [[s.data.out, 1]] : []),
  });

  registerStructure('chest', {
    name: 'Truhla', item: 'truhla', ownShadows: true, size: 0.6, interactY: 0.35,
    data: () => ({ storage: G.inventory.createStorage(CHEST_SLOTS) }),
    create: createChest,
    interact: { label: chestLabel, onInteract: chestUse },
    frame: chestFrame,
    save: (s) => ({ storage: storageSave(s.data.storage) }),
    load(s, d) { s.data.storage = G.inventory.sanitize(d && d.storage, CHEST_SLOTS); },
  });

  registerStructure('net', {
    name: 'Síť na trosky', item: 'sit', ownShadows: true, size: 0.9, interactAt: [0, 0.6, 0.85],
    data: () => ({ storage: G.inventory.createStorage(NET_SLOTS) }),
    create: createNet,
    interact: { label: netLabel, onInteract: netUse, passive: (s) => storageCount(s.data.storage) === 0 },
    frame: netFrame,
    save: (s) => ({ storage: storageSave(s.data.storage) }),
    load(s, d) { s.data.storage = G.inventory.sanitize(d && d.storage, NET_SLOTS); },
    facesWater: true,
  });

  registerStructure('sail', {
    name: 'Plachta', item: 'plachta', ownShadows: true, size: 0.5, interactY: 1.2,
    data: () => ({ up: false }),
    create: createSail,
    interact: { label: (s) => (s.data.up ? 'Stáhnout plachtu' : 'Vytáhnout plachtu'), onInteract: sailUse },
    frame: sailFrame,
    save: (s) => ({ up: !!s.data.up }),
    load(s, d) {
      s.data.up = !!(d && d.up);
      s._v.raise = s.data.up ? 1 : 0;
      s._v.still = false;
      updateCloth(s);
    },
  });

  registerStructure('anchor', {
    name: 'Kotva', item: 'kotva', ownShadows: true, size: 0.6, interactY: 0.55,
    data: () => ({ down: false }),
    create: createAnchor,
    interact: { label: (s) => (s.data.down ? 'Vytáhnout kotvu' : 'Spustit kotvu'), onInteract: anchorUse },
    frame: anchorFrame,
    save: (s) => ({ down: !!s.data.down }),
    load(s, d) {
      s.data.down = !!(d && d.down);
      s._v.drop = s.data.down ? 1 : 0;
      s._v.fresh = true;
      anchorPose(s);
    },
    facesWater: true,
  });

  // ---------------------------------------------------------------------------
  // Flag (Vlajka) — a decoration bought with pirate gold; streams with the wind
  // ---------------------------------------------------------------------------
  const FLAG_STRIPS = 4, FLAG_W = 0.2, FLAG_H = 0.46, FLAG_TOP = 2.28;
  function makeFlagTex() {
    const W = 128, H = 80;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const x = cv.getContext('2d');
    x.fillStyle = '#0f5e6e';
    x.fillRect(0, 0, W, H);
    x.fillStyle = '#e8643c';
    x.fillRect(0, 0, W, 12); x.fillRect(0, H - 12, W, 12);
    // a golden sun over a wave
    x.fillStyle = '#e9b949';
    x.beginPath(); x.arc(64, 38, 15, 0, TAU); x.fill();
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      x.beginPath();
      x.moveTo(64 + Math.cos(a - 0.2) * 18, 38 + Math.sin(a - 0.2) * 18);
      x.lineTo(64 + Math.cos(a) * 25, 38 + Math.sin(a) * 25);
      x.lineTo(64 + Math.cos(a + 0.2) * 18, 38 + Math.sin(a + 0.2) * 18);
      x.fill();
    }
    x.strokeStyle = '#e9f1ea'; x.lineWidth = 4;
    x.beginPath();
    for (let px = 20; px <= 108; px += 2) x.lineTo(px, 56 + Math.sin(px * 0.14) * 4);
    x.stroke();
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAniso(4);
    return tex;
  }
  function flagGeo() {
    if (GEO.flag) return GEO.flag;
    const w = new Builder(), m = new Builder();
    w.cyl(0.035, 0.045, FLAG_TOP + 0.05, 7, { y: (FLAG_TOP + 0.05) / 2, c: COL.beam, reg: REG.wood });
    m.cyl(0.15, 0.19, 0.1, 8, { y: 0.05, c: COL.dark });
    m.sphere(0.055, 8, 6, { y: FLAG_TOP + 0.1, c: COL.brass });
    w.rod(0.04, FLAG_TOP - 0.02, 0, 0.04, FLAG_TOP - FLAG_H - 0.2, 0, 0.012, 4, { c: COL.rope, reg: REG.plain });
    const strips = [];
    for (let k = 0; k < FLAG_STRIPS; k++) {
      const g = new THREE.PlaneGeometry(FLAG_W, FLAG_H).translate(FLAG_W / 2, 0, 0);
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setX(i, (k + uv.getX(i)) / FLAG_STRIPS);
      strips.push(g);
    }
    GEO.flag = { wood: w.build(), metal: m.build(), strips };
    return GEO.flag;
  }
  function createFlag(s) {
    const g = new THREE.Group(), geo = flagGeo();
    if (!M.flag) M.flag = new THREE.MeshStandardMaterial({ map: makeFlagTex(), side: THREE.DoubleSide, flatShading: true, roughness: 0.9 });
    g.add(mesh(geo.wood, M.atlas), mesh(geo.metal, M.metal));
    const rig = new THREE.Group();
    rig.position.set(0.04, FLAG_TOP - FLAG_H / 2 - 0.02, 0);
    g.add(rig);
    const parts = [];
    let parent = rig;
    for (let k = 0; k < FLAG_STRIPS; k++) {
      const seg = new THREE.Group();
      if (k) seg.position.x = FLAG_W;
      seg.add(mesh(geo.strips[k], M.flag));
      parent.add(seg);
      parts.push(seg);
      parent = seg;
    }
    s._v = { rig, parts, yaw: 0, t: Math.random() * 10 };
    return g;
  }
  function flagFrame(s, dt) {
    const v = s._v;
    if (!v) return;
    v.t += dt;
    const w = G.world && G.world.windDir;
    if (w) {
      const want = Math.atan2(-w.z, w.x) - s.rotation * HALF_PI;
      const diff = Math.atan2(Math.sin(want - v.yaw), Math.cos(want - v.yaw));
      v.yaw += diff * (1 - Math.exp(-1.2 * dt));
      v.rig.rotation.y = v.yaw;
    }
    const storm = (G.world && G.world.storm) || 0;
    const amp = 0.22 + 0.25 * storm, speed = 4 + 5 * storm;
    for (let k = 0; k < v.parts.length; k++) v.parts[k].rotation.y = Math.sin(v.t * speed - k * 1.3) * amp * (0.5 + k * 0.25);
  }

  registerStructure('flag', {
    name: 'Vlajka', item: 'vlajka', ownShadows: true, size: 0.5, interactY: 1.2,
    data: () => ({}),
    create: createFlag,
    frame: flagFrame,
  });

  // ---------------------------------------------------------------------------
  // Aiming helpers
  // ---------------------------------------------------------------------------
  function eyeRay() {
    const P = G.player;
    if (P && typeof P.eye === 'function' && typeof P.forward === 'function') {
      const e = P.eye(_eye), f = P.forward(_dir);
      if (e && e !== _eye && e.isVector3) _eye.copy(e);
      if (f && f !== _dir && f.isVector3) _dir.copy(f);
    }
    else if (G.camera) { G.camera.getWorldPosition(_eye); G.camera.getWorldDirection(_dir); }
    if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, -1); else _dir.normalize();
  }
  // Ray (_eye, _dir) against the deck plane. Returns the distance or -1.
  function rayDeck(maxDist, out) {
    if (Math.abs(_dir.y) < 1e-4) return -1;
    const t = (raft.deckY() - _eye.y) / _dir.y;
    if (t <= 0 || t > maxDist) return -1;
    out.copy(_dir).multiplyScalar(t).add(_eye);
    return t;
  }
  function raycastStructure(range) {
    _rayDist = Infinity;
    if (!structureObjects.length) return null;
    raycaster.set(_eye, _dir);
    raycaster.near = 0;
    raycaster.far = range;
    _hits.length = 0;
    raycaster.intersectObjects(structureObjects, true, _hits);
    for (let k = 0; k < _hits.length; k++) {
      let o = _hits[k].object;
      if (o.visible === false) continue;
      while (o && !o.userData.raftStructure) o = o.parent;
      if (o) { _rayDist = _hits[k].distance; return o.userData.raftStructure; }
    }
    return null;
  }
  const horiz = (x, z) => Math.hypot(x - _eye.x, z - _eye.z);

  // ---------------------------------------------------------------------------
  // Hammer tool
  // ---------------------------------------------------------------------------
  let ghostTile = null, outline = null;

  function hammerAim(a) {
    a.kind = null; a.tile = null; a.s = null; a.cost = null; a.i = 0; a.j = 0;
    eyeRay();
    a.s = raycastStructure(DISMANTLE_RANGE);
    const t = rayDeck(BUILD_RANGE + 4, _hit);
    if (t < 0) return a;
    const ci = Math.floor(_hit.x / TILE), cj = Math.floor(_hit.z / TILE);
    const tile = grid.get(nkey(ci, cj));
    if (tile) {
      if (horiz(_hit.x, _hit.z) > BUILD_RANGE) return a;
      a.tile = tile; a.i = ci; a.j = cj;
      if (tile.hp < tile.maxHp) { a.kind = 'repair'; a.cost = COST.repair; }
      else if (!tile.reinforced) { a.kind = 'reinforce'; a.cost = COST.reinforce; }
      else a.kind = 'full';
      return a;
    }
    refresh();
    let best = null, bd = 2.1 * 2.1;
    for (const c of cache.frontier) {
      const dx = (c.i + 0.5) * TILE - _hit.x, dz = (c.j + 0.5) * TILE - _hit.z, d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = c; }
    }
    if (best) {
      a.i = best.i; a.j = best.j;
      if (horiz((best.i + 0.5) * TILE, (best.j + 0.5) * TILE) > BUILD_RANGE) { a.kind = 'far'; return a; }
      a.kind = 'build';
      a.cost = COST.foundation;
      return a;
    }
    if (tiles.size && hasNeighbour(ci, cj) && !spanOk(ci, cj) && horiz(_hit.x, _hit.z) <= BUILD_RANGE) a.kind = 'size';
    return a;
  }

  function hammerHint(a, afford, miss) {
    const L = btnL();
    const touch = !!(G.input && G.input.touchMode);     // phones: keep the line short above the buttons
    let h;
    switch (a.kind) {
      case 'build':
        h = afford ? L + ': Postavit základ (' + costText(COST.foundation) + ')'
          : 'Postavit základ (' + costText(COST.foundation) + ') · Chybí: ' + miss;
        break;
      case 'repair': {
        const pct = Math.round((a.tile.hp / a.tile.maxHp) * 100);
        h = (afford ? L + ': Opravit' : 'Opravit') + ' základ (' + costText(COST.repair) + ')' + (touch ? '' : ' · stav ' + pct + ' %') +
          (afford ? '' : ' · Chybí: ' + miss);
        break;
      }
      case 'reinforce':
        h = afford ? L + ': Zpevnit základ (' + costText(COST.reinforce) + ')' + (touch ? '' : ' – žralok ho neukousne')
          : 'Zpevnit základ (' + costText(COST.reinforce) + ') · Chybí: ' + miss;
        break;
      case 'full': h = 'Tenhle základ je zpevněný a v pořádku.'; break;
      case 'size': h = 'Vor už je největší, jaký může být (' + MAX_SPAN + ' × ' + MAX_SPAN + ').'; break;
      case 'far': h = 'Přijď blíž k okraji voru.'; break;
      default: h = 'Namiř na vodu u okraje voru a postav nový základ.';
    }
    if (a.s) {
      const def = structureDefs[a.s.type];
      h += ' · ' + btnR() + ' (drž): Rozebrat' + (touch ? '' : ' – ' + (def ? def.name : a.s.type));
    }
    return h;
  }

  const hammer = {
    viewModel: null,
    pivot: null,
    aim: { kind: null, i: 0, j: 0, tile: null, s: null, cost: null },
    afford: false,
    missing: '',
    swingT: -1,
    pending: null,
    cooldown: 0,
    holdL: false,
    holdKind: null,
    rmb: false,
    disS: null,
    disT: 0,
    progress: false,
    hintText: '',
    seen: -10,
    shown: false,

    onEquip() {
      hammer.swingT = -1; hammer.pending = null; hammer.cooldown = 0;
      hammer.holdL = false; hammer.rmb = false; hammer.disS = null; hammer.disT = 0;
    },
    onUnequip() {
      hammer.hideVisuals();
      hammer.holdL = false; hammer.rmb = false; hammer.disS = null; hammer.disT = 0;
      hammer.pending = null; hammer.swingT = -1;
      if (hammer.pivot) { hammer.pivot.rotation.set(0, 0, 0); hammer.pivot.position.set(0, 0, 0); }
      G.hud.setToolHint('');
      if (hammer.progress) { G.hud.setProgress(null); hammer.progress = false; }
    },
    hideVisuals() {
      if (ghostTile) ghostTile.visible = false;
      if (outline) outline.visible = false;
      hammer.shown = false;
    },
    showVisuals(a) {
      if (!ghostTile) return;
      const bld = a.kind === 'build';
      ghostTile.visible = bld;
      if (bld) {
        ghostTile.position.set((a.i + 0.5) * TILE, 0, (a.j + 0.5) * TILE);
        ghostTile.material = hammer.afford ? M.ghostOk : M.ghostBad;
      }
      const show = bld || a.kind === 'repair' || a.kind === 'reinforce' || a.kind === 'full';
      outline.visible = show;
      if (show) {
        outline.position.set((a.i + 0.5) * TILE, 0.12, (a.j + 0.5) * TILE);
        const col = a.kind === 'full' ? 0xdfe8e0 : !hammer.afford ? 0xff5a4a
          : a.kind === 'repair' ? 0xffd35a : a.kind === 'reinforce' ? 0x8fd8ff : 0x6dff8e;
        outline.material.color.setHex(col);
      }
      hammer.shown = show;
    },
    update(dt, slot) {
      hammer.seen = frameNo;
      if (hammer.cooldown > 0) hammer.cooldown -= dt;
      const a = hammerAim(hammer.aim);
      hammer.afford = a.cost ? G.inventory.hasAll(a.cost) : false;
      hammer.missing = a.cost && !hammer.afford ? missingText(a.cost) : '';
      hammer.showVisuals(a);
      hammer.animate(dt);
      // holding LMB keeps building / repairing (never auto-reinforces: metal is precious)
      if (hammer.holdL && hammer.swingT < 0 && hammer.cooldown <= 0 && (hammer.holdKind === 'build' || hammer.holdKind === 'repair') &&
        a.kind === hammer.holdKind && hammer.afford) hammer.tryAct(false);
      hammer.updateDismantle(dt);
      hammer.hintText = hammerHint(a, hammer.afford, hammer.missing);
      G.hud.setToolHint(hammer.hintText);
    },
    tryAct(click) {
      if (hammer.cooldown > 0 || hammer.swingT >= 0) return;
      const a = hammer.aim;
      const actionable = a.kind === 'build' || a.kind === 'repair' || a.kind === 'reinforce';
      if (!actionable || !hammer.afford) {
        if (click) {
          hammer.swingT = 0; hammer.pending = null; hammer.cooldown = SWING_TIME;
          if (actionable) G.sfx('error');
        }
        return;
      }
      hammer.pending = { kind: a.kind, i: a.i, j: a.j, tile: a.tile };
      hammer.swingT = 0;
      hammer.cooldown = SWING_TIME + 0.05;
    },
    execute(p) {
      let ok = false;
      if (p.kind === 'build') ok = build(p.i, p.j);
      else if (p.kind === 'repair') ok = repair(p.tile);
      else if (p.kind === 'reinforce') ok = reinforce(p.tile);
      if (ok) G.inventory.damageSelected(1);
      else G.sfx('error');
    },
    animate(dt) {
      const p = hammer.pivot;
      if (hammer.swingT >= 0) {
        const before = hammer.swingT;
        hammer.swingT += dt;
        if (hammer.pending && before < SWING_IMPACT && hammer.swingT >= SWING_IMPACT) {
          const pend = hammer.pending;
          hammer.pending = null;
          hammer.execute(pend);
        }
        const t = hammer.swingT;
        let ang;
        if (t < 0.1) ang = 0.55 * (t / 0.1);
        else if (t < SWING_IMPACT) { const k = (t - 0.1) / (SWING_IMPACT - 0.1); ang = 0.55 - 1.9 * k * k; }
        else { const k = Math.min(1, (t - SWING_IMPACT) / (SWING_TIME - SWING_IMPACT)); ang = -1.35 * (1 - k) * (1 - k); }
        if (p) { p.rotation.x = ang; p.rotation.z = 0; p.position.z = ang < 0 ? ang * 0.05 : 0; }
        if (hammer.swingT >= SWING_TIME) { hammer.swingT = -1; if (p) p.rotation.x = 0; }
      } else if (p) {
        if (hammer.rmb && hammer.disS) {
          p.rotation.x = -0.45 + Math.sin(clock * 30) * 0.07;
          p.rotation.z = Math.sin(clock * 23) * 0.06;
        } else {
          p.rotation.x = G.damp(p.rotation.x, 0, 12, dt);
          p.rotation.z = G.damp(p.rotation.z, 0, 12, dt);
          p.position.z = G.damp(p.position.z, 0, 12, dt);
          p.position.y = Math.sin(clock * 1.8) * 0.004;
        }
      }
    },
    updateDismantle(dt) {
      const target = hammer.aim.s;
      if (!hammer.rmb || !target) {
        hammer.disS = null;
        hammer.disT = 0;
        if (hammer.progress) { G.hud.setProgress(null); hammer.progress = false; }
        return;
      }
      if (target !== hammer.disS) { hammer.disS = target; hammer.disT = 0; }
      hammer.disT += dt;
      G.hud.setProgress(Math.min(1, hammer.disT / DISMANTLE_TIME), 'Rozebírám…');
      hammer.progress = true;
      if (hammer.disT >= DISMANTLE_TIME) {
        const s = hammer.disS;
        hammer.disS = null; hammer.disT = 0; hammer.rmb = false;
        G.hud.setProgress(null);
        hammer.progress = false;
        if (removeStructure(s, true)) {
          G.inventory.damageSelected(1);
          hammer.swingT = 0;
        }
      }
    },
    primaryDown() { hammer.holdL = true; hammer.holdKind = hammer.aim.kind; hammer.tryAct(true); },
    primaryUp() { hammer.holdL = false; },
    secondaryDown() { hammer.rmb = true; hammer.disS = null; hammer.disT = 0; },
    secondaryUp() { hammer.rmb = false; hammer.disS = null; hammer.disT = 0; },
    hint() { return hammer.hintText; },
  };

  function buildHammerModel() {
    const w = new Builder(), m = new Builder();
    w.cyl(0.016, 0.019, 0.38, 6, { y: 0.1, c: 0x9b6b3d, reg: REG.wood });
    w.cyl(0.022, 0.022, 0.13, 6, { y: -0.02, c: 0x5a3a22, reg: REG.rope });
    m.box(0.046, 0.05, 0.11, { y: 0.3, z: -0.012, c: 0x7a828a });
    m.cyl(0.029, 0.029, 0.03, 8, { y: 0.3, z: -0.078, rx: HALF_PI, c: 0xa3abb3 });
    m.box(0.016, 0.028, 0.08, { x: -0.011, y: 0.29, z: 0.072, rx: 0.45, c: 0x7a828a });
    m.box(0.016, 0.028, 0.08, { x: 0.011, y: 0.29, z: 0.072, rx: 0.45, c: 0x7a828a });
    m.box(0.028, 0.01, 0.028, { y: 0.328, c: 0xa3abb3 });
    const vm = new THREE.Group();
    vm.name = 'hammer-view';
    const pivot = new THREE.Group();
    const a = new THREE.Mesh(w.build(), M.atlas), b = new THREE.Mesh(m.build(), M.metal);
    pivot.add(a, b);
    vm.add(pivot);
    vm.position.set(0.02, -0.07, 0);
    vm.rotation.set(-0.5, 0.3, 0.22);     // tilted forward so the head sits low-right, clear of the hint text
    vm.scale.setScalar(0.72);
    hammer.viewModel = vm;
    hammer.pivot = pivot;
  }

  // ---------------------------------------------------------------------------
  // Place tool (placeables → structures)
  // ---------------------------------------------------------------------------
  const ghosts = Object.create(null);
  const minis = Object.create(null);
  const previewWarned = Object.create(null);

  function makeInstanceForPreview(type, mini) {
    const def = structureDefs[type];
    if (!def) return null;
    let data = {};
    if (typeof def.data === 'function') { try { data = def.data() || {}; } catch (err) { data = {}; } }
    // previews get a detached dummy tile; registries are sandboxed so a create() with side effects
    // cannot leave phantom interactables / combat targets / ground behind
    const tile = { i: 0, j: 0, hp: HP_NORMAL, maxHp: HP_NORMAL, reinforced: false, mesh: null, structure: null, preview: true };
    const s = { type, tile, object: null, data, rotation: 0, ghost: true, mini: !!mini };
    const regs = [G.interaction, G.combat, G.ground], adds = regs.map((r) => r.add);
    for (const r of regs) r.add = (x) => x;
    let obj = null;
    try { obj = def.create(s); } catch (err) { if (!previewWarned[type]) { previewWarned[type] = true; console.warn('[raft] preview ' + type, err); } }
    finally { regs.forEach((r, k) => { r.add = adds[k]; }); }
    if (!obj || !obj.isObject3D) return null;
    s.object = obj;
    return { s, obj };
  }
  function ghostFor(type) {
    if (ghosts[type]) return ghosts[type];
    const inst = makeInstanceForPreview(type, false);
    if (!inst) return null;
    const meshes = [];
    inst.obj.traverse((o) => {
      if (o.isMesh) { meshes.push(o); o.castShadow = false; o.receiveShadow = false; o.material = M.ghostOk; o.renderOrder = 2; }
    });
    inst.obj.visible = false;
    group.add(inst.obj);
    ghosts[type] = { obj: inst.obj, meshes, ok: true };
    return ghosts[type];
  }
  function miniFor(type) {
    if (minis[type]) return minis[type];
    const inst = makeInstanceForPreview(type, true);
    if (!inst) return null;
    const box = new THREE.Box3().setFromObject(inst.obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const k = 0.2 / Math.max(0.05, size.x, size.y, size.z);
    const wrap = new THREE.Group();
    inst.obj.position.sub(center);
    inst.obj.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    wrap.add(inst.obj);
    wrap.scale.setScalar(k);
    minis[type] = wrap;
    return wrap;
  }
  function facesWater(tile, rot) {
    const d = DIRS[rot];
    return !grid.has(nkey(tile.i + d[0], tile.j + d[1]));
  }

  const placer = {
    viewModel: null,
    inner: null,
    miniObj: null,
    itemId: null,
    type: null,
    rot: 0,
    autoRot: true,
    lastTile: null,
    tile: null,
    ok: false,
    ghost: null,
    hintText: '',
    seen: -10,
    spin: 0,

    onEquip(slot) { placer.sync(slot, true); },
    onUnequip() {
      placer.hideVisuals();
      placer.itemId = null;
      G.hud.setToolHint('');
    },
    sync(slot, force) {
      const id = slot ? slot.id : null;
      if (id === placer.itemId && !force) return;
      placer.itemId = id;
      const def = id && G.items.def(id);
      placer.type = (def && def.place) || null;
      placer.rot = 0;
      placer.autoRot = true;
      placer.lastTile = null;
      placer.hideVisuals();
      placer.setMini(placer.type);
    },
    setMini(type) {
      if (!placer.inner) return;
      if (placer.miniObj) { placer.inner.remove(placer.miniObj); placer.miniObj = null; }
      if (!type || !structureDefs[type]) return;
      const m = miniFor(type);
      if (m) { placer.inner.add(m); placer.miniObj = m; }
    },
    hideVisuals() {
      if (placer.ghost) placer.ghost.obj.visible = false;
      placer.ghost = null;
    },
    rotate() {
      placer.rot = (placer.rot + 1) % 4;
      placer.autoRot = false;
      placer.spin = 1;
      G.sfx('ui_click', { volume: 0.3 });
    },
    update(dt, slot) {
      placer.seen = frameNo;
      placer.sync(slot || G.inventory.getSelected(), false);
      if (G.input.pressed('KeyR')) placer.rotate();
      placer.spin = Math.max(0, placer.spin - dt * 4);
      if (placer.inner) {
        placer.inner.rotation.set(0.25, -0.6 + clock * 0.4 + placer.spin * 0.5, 0);
        placer.inner.position.y = Math.sin(clock * 2) * 0.006;
      }
      const type = placer.type, def = type && structureDefs[type];
      placer.tile = null;
      placer.ok = false;
      if (!def) {
        placer.hideVisuals();
        placer.hintText = 'Tohle se zatím nedá postavit.';
        G.hud.setToolHint(placer.hintText);
        return;
      }
      eyeRay();
      const hitS = raycastStructure(PLACE_RANGE);
      const t = rayDeck(PLACE_RANGE + 2, _hit);
      let tile = null;
      if (hitS && (t < 0 || _rayDist < t)) tile = hitS.tile;
      else if (t >= 0 && horiz(_hit.x, _hit.z) <= PLACE_RANGE) tile = raft.tileAt(_hit.x, _hit.z);
      if (!tile) {
        placer.hideVisuals();
        placer.hintText = 'Namiř na volné místo na voru.';
        G.hud.setToolHint(placer.hintText);
        return;
      }
      if (tile !== placer.lastTile) {
        placer.lastTile = tile;
        if (placer.autoRot && def.facesWater && !facesWater(tile, placer.rot)) {
          for (let r = 0; r < 4; r++) if (facesWater(tile, r)) { placer.rot = r; break; }
        }
      }
      placer.tile = tile;
      placer.ok = !tile.structure;
      const gh = ghostFor(type);
      if (placer.ghost && placer.ghost !== gh) placer.ghost.obj.visible = false;
      placer.ghost = gh;
      if (gh) {
        gh.obj.visible = true;
        gh.obj.position.set((tile.i + 0.5) * TILE, G.C.DECK_Y, (tile.j + 0.5) * TILE);
        gh.obj.rotation.y = placer.rot * HALF_PI - placer.spin * placer.spin * HALF_PI;
        if (gh.ok !== placer.ok) {
          gh.ok = placer.ok;
          for (const m of gh.meshes) m.material = placer.ok ? M.ghostOk : M.ghostBad;
        }
      }
      const rotKey = G.input.touchMode ? btnR() : 'R';
      if (placer.ok) {
        placer.hintText = btnL() + ': Postavit – ' + def.name + ' · ' + rotKey + ': Otočit';
        if (def.facesWater && !facesWater(tile, placer.rot)) placer.hintText += ' · Tip: otoč ji směrem k vodě';
      } else {
        placer.hintText = 'Tady už něco stojí. Najdi volné místo.';
      }
      G.hud.setToolHint(placer.hintText);
    },
    primaryDown() {
      if (!placer.ok || !placer.tile || !placer.type) {
        if (placer.tile) G.sfx('error');
        return;
      }
      const slot = G.inventory.getSelected();
      if (!slot || slot.id !== placer.itemId) return;
      const tile = placer.tile, type = placer.type, id = placer.itemId, rot = placer.rot;
      if (!G.inventory.consumeSelected(1)) return;
      const s = placeStructure(type, tile, rot);
      if (!s) {
        G.inventory.add(id, 1, 'refund');
        G.sfx('error');
        return;
      }
      const pos = tileCenter(tile, new THREE.Vector3());
      snd('place', pos);
      fxCall('debris', pos, 0xcaa678, 6);
      placer.hideVisuals();
      placer.lastTile = null;
    },
    primaryUp() {},
    secondaryDown() { if (placer.type) placer.rotate(); },
    secondaryUp() {},
    hint() { return placer.hintText; },
  };

  // ---------------------------------------------------------------------------
  // Public API (exists at load time)
  // ---------------------------------------------------------------------------
  const raft = (G.raft = {
    group,
    tiles,
    structures,
    velocity,
    sailUp: false,
    anchored: false,
    // --- contract ---
    deckY() { return group.position.y + G.C.DECK_Y; },
    tileAt(x, z) { return grid.get(nkey(Math.floor(x / TILE), Math.floor(z / TILE))) || null; },
    tileCenter,
    count() { return tiles.size; },
    edgeTiles() { refresh(); return cache.edges.slice(); },
    randomTile() {
      if (!tiles.size) return null;
      let k = Math.floor(Math.random() * tiles.size);
      for (const t of tiles.values()) if (k-- <= 0) return t;
      return null;
    },
    randomEdgeTile() {
      refresh();
      return cache.edges.length ? G.pick(cache.edges) : raft.randomTile();
    },
    bounds(out) {
      refresh();
      out = out || {};
      if (!tiles.size) { out.minX = out.maxX = out.minZ = out.maxZ = 0; return out; }
      out.minX = cache.minI * TILE; out.maxX = (cache.maxI + 1) * TILE;
      out.minZ = cache.minJ * TILE; out.maxZ = (cache.maxJ + 1) * TILE;
      return out;
    },
    radius() { refresh(); return cache.radius; },
    damageTile,
    addTile,
    registerStructure,
    findStructures(type) { return structures.filter((s) => s.type === type); },
    placeStructure,
    removeStructure,
    // --- extras ---
    COST,
    MAX_SPAN,
    structureDefs,
    getTile(i, j) { return grid.get(nkey(Math.floor(i), Math.floor(j))) || null; },
    isEdge(t) { return !!t && DIRS.some((d) => !grid.has(nkey(t.i + d[0], t.j + d[1]))); },
    structureAt(x, z) { const t = raft.tileAt(x, z); return t ? t.structure : null; },
    canBuildAt,
    build,
    repair,
    reinforce,
    destroyTile,
    speed() { return speed; },
  });

  // ---------------------------------------------------------------------------
  // Frame helpers
  // ---------------------------------------------------------------------------
  function bob(dt) {
    const W = G.world;
    let target = 0;
    if (W && typeof W.waveHeight === 'function' && tiles.size) {
      refresh();
      const x0 = cache.minI * TILE, x1 = (cache.maxI + 1) * TILE, z0 = cache.minJ * TILE, z1 = (cache.maxJ + 1) * TILE;
      const sum = W.waveHeight(x0, z0) + W.waveHeight(x1, z0) + W.waveHeight(x0, z1) + W.waveHeight(x1, z1) +
        2 * W.waveHeight((x0 + x1) * 0.5, (z0 + z1) * 0.5);
      target = sum / 6;
      if (!Number.isFinite(target)) target = 0;
    }
    group.position.y = dt > 0 ? G.damp(group.position.y, target, 3, dt) : target;
  }

  function animTiles(dt) {
    for (const t of tiles.values()) {
      if (!t.animating) continue;
      let ox = 0, oy = 0, oz = 0, sc = 1;
      if (t.pop < 1) {
        t.pop = Math.min(1, t.pop + dt / 0.45);
        const p = t.pop, back = 1 + 2.4 * Math.pow(p - 1, 3) + 1.4 * Math.pow(p - 1, 2);   // ease-out-back
        oy = -0.3 * (1 - p);
        sc = 0.8 + 0.2 * back;
      }
      if (t.shake > 0) {
        t.shake = Math.max(0, t.shake - dt);
        const a = t.shake * 0.12;
        ox = (Math.random() - 0.5) * a;
        oz = (Math.random() - 0.5) * a;
        oy += (Math.random() - 0.5) * a * 0.5;
      }
      const cx = (t.i + 0.5) * TILE, cz = (t.j + 0.5) * TILE;
      if (t.bucket) tileMatrix(t, ox, oy, oz, sc);
      if (t.structure && t.structure.object && t.structure._pop >= 1) t.structure.object.position.set(cx + ox, G.C.DECK_Y + oy, cz + oz);
      if (t.pop >= 1 && t.shake <= 0) {
        t.animating = false;
        if (t.bucket) { tileMatrix(t, 0, 0, 0, 1); t.mesh.boundingSphere = null; }
        if (t.structure && t.structure.object) t.structure.object.position.set(cx, G.C.DECK_Y, cz);
      }
    }
  }

  function animStructures(dt) {
    for (let k = 0; k < structures.length; k++) {
      const s = structures[k];
      if (s._pop < 1) {
        s._pop = Math.min(1, s._pop + dt / 0.35);
        const p = s._pop, back = 1 + 2.7 * Math.pow(p - 1, 3) + 1.7 * Math.pow(p - 1, 2);
        const base = s._scale || 1;
        s.object.scale.setScalar(Math.max(0.01, back) * base);
        if (s._pop >= 1) s.object.scale.setScalar(base);
      }
      const def = structureDefs[s.type];
      if (def && typeof def.frame === 'function') {
        try { def.frame(s, dt); } catch (err) { if (!s._ferr) { s._ferr = true; console.error('[raft] frame ' + s.type, err); } }
      }
    }
  }

  function updateSpeed(dt) {
    const target = raft.anchored ? 0 : raft.sailUp ? SPEED_SAIL : SPEED_DRIFT;
    speed = G.damp(speed, target, 0.6, dt);
    if (Math.abs(speed - target) < 0.002) speed = target;
    const w = G.world && G.world.windDir;
    if (w && (w.x || w.z)) {
      const len = Math.hypot(w.x, w.z);
      velocity.set((w.x / len) * speed, 0, (w.z / len) * speed);
    } else velocity.set(speed, 0, 0);
  }

  function updateStorm(dt) {
    const storm = G.world ? G.world.storm || 0 : 0;
    if (storm <= STORM_LEVEL) { stormTimer = Math.max(stormTimer, 10); return; }
    stormTimer -= dt;
    if (stormTimer > 0) return;
    stormTimer = STORM_EVERY * G.rand(0.8, 1.2);
    if (G.time - extStormHitAt < STORM_EVERY * 0.7) return;     // world.js already battered the raft
    const t = raft.randomEdgeTile();
    if (!t) return;
    const c = tileCenter(t, new THREE.Vector3());
    fxCall('splash', _v.set(c.x, 0, c.z), 1.8);
    snd('splash_big', c, 0.8);
    stormInternal = true;
    try { damageTile(t, 8, 'storm'); } finally { stormInternal = false; }
  }

  function clearAll() {
    for (let k = structures.length - 1; k >= 0; k--) removeStructure(structures[k], false);
    for (const t of Array.from(tiles.values())) removeTileInternal(t);
    tiles.clear();
    grid.clear();
    dirty = true;
  }
  function addStartTiles() {
    for (const i of [-1, 0]) for (const j of [-1, 0]) addTile(i, j);
  }

  // ---------------------------------------------------------------------------
  // Module
  // ---------------------------------------------------------------------------
  G.register({
    name: 'raft',
    order: 20,

    init() {
      assets();
      G.scene.add(group);
      PS.steam = new Particles(M.steam, 90);
      PS.smoke = new Particles(M.smoke, 70);
      PS.spark = new Particles(M.spark, 30);
      group.add(PS.steam.mesh, PS.smoke.mesh, PS.spark.mesh);

      ghostTile = new THREE.Mesh(tileGeometry(0, false, 0), M.ghostOk);
      ghostTile.visible = false;
      ghostTile.renderOrder = 2;
      group.add(ghostTile);
      const box = new THREE.BoxGeometry(2.02, 0.5, 2.02);
      outline = new THREE.LineSegments(new THREE.EdgesGeometry(box), M.outline.clone());
      box.dispose();
      outline.visible = false;
      outline.renderOrder = 3;
      group.add(outline);

      buildHammerModel();
      placer.viewModel = new THREE.Group();
      placer.viewModel.name = 'place-view';
      placer.inner = new THREE.Group();
      placer.viewModel.add(placer.inner);

      G.tools.register('hammer', hammer);
      G.tools.register('place', placer);

      // walkable deck over every tile
      G.ground.add({
        kind: 'raft',
        heightAt(x, z) { return grid.has(nkey(Math.floor(x / TILE), Math.floor(z / TILE))) ? raft.deckY() : null; },
      });
    },

    reset() {
      quiet++;
      try {
        clearAll();
        addStartTiles();
        for (const k in PS) if (PS[k]) PS[k].clear();
        hammer.onUnequip();
        placer.hideVisuals();
        placer.itemId = null;
        speed = SPEED_DRIFT;
        updateFlags();
        const w = G.world && G.world.windDir;
        if (w && (w.x || w.z)) velocity.set(w.x, 0, w.z).normalize().multiplyScalar(speed);
        else velocity.set(speed, 0, 0);
        group.position.y = 0;
        stormTimer = 12;
        extStormHitAt = -1e9;
        stormNotifyAt = -1e9;
        critNotifyAt = -1e9;
      } finally { quiet--; }
    },

    save() {
      const outTiles = [];
      for (const t of tiles.values()) outTiles.push({ i: t.i, j: t.j, hp: Math.round(t.hp * 10) / 10, reinforced: t.reinforced ? 1 : 0 });
      const outS = [];
      for (const s of structures) {
        const def = structureDefs[s.type];
        let data = null;
        try { data = def && def.save ? def.save(s) : s.data; } catch (err) { data = null; }
        outS.push({ type: s.type, i: s.tile.i, j: s.tile.j, rotation: s.rotation, data: data === undefined ? null : data });
      }
      return { tiles: outTiles, structures: outS, speed: Math.round(speed * 100) / 100 };
    },

    load(d) {
      if (!d || typeof d !== 'object') return;
      quiet++;
      try {
        if (Array.isArray(d.tiles) && d.tiles.length) {
          clearAll();
          for (const o of d.tiles) {
            if (!o) continue;
            const i = Math.floor(Number(o.i)), j = Math.floor(Number(o.j));
            if (!Number.isFinite(i) || !Number.isFinite(j) || grid.has(nkey(i, j))) continue;
            if (Math.abs(i) > MAX_SPAN || Math.abs(j) > MAX_SPAN) continue;   // corrupt / hostile save
            const t = addTile(i, j);
            if (!t) continue;
            const r = !!(o.reinforced || o.r);
            t.reinforced = r;
            t.maxHp = r ? HP_REINFORCED : HP_NORMAL;
            const hp = Number(o.hp);
            t.hp = Number.isFinite(hp) ? G.clamp(hp, 1, t.maxHp) : t.maxHp;
            refreshTile(t);
          }
          if (!tiles.size) addStartTiles();
        }
        if (Array.isArray(d.structures)) {
          for (const o of d.structures) {
            if (!o || !structureDefs[o.type]) continue;
            const t = grid.get(nkey(Math.floor(Number(o.i)), Math.floor(Number(o.j))));
            if (!t || t.structure) continue;
            placeStructure(o.type, t, o.rotation != null ? o.rotation : o.rot, o.data == null ? {} : o.data);
          }
        }
        const sp = Number(d.speed);
        if (Number.isFinite(sp)) speed = G.clamp(sp, 0, SPEED_SAIL);
        updateFlags();
      } finally { quiet--; dirty = true; }
    },

    update(dt) {
      updateFlags();
      updateSpeed(dt);
      updateStorm(dt);
      for (let k = 0; k < structures.length; k++) {
        const s = structures[k];
        const def = structureDefs[s.type];
        if (!def || typeof def.update !== 'function') continue;
        try { def.update(s, dt); } catch (err) { if (!s._uerr) { s._uerr = true; console.error('[raft] update ' + s.type, err); } }
      }
      netCatch();
    },

    frame(dt) {
      frameNo++;
      clock += dt;
      bob(dt);
      animTiles(dt);
      animStructures(dt);
      if (!G.paused) {
        PS.steam.update(dt, true);
        PS.smoke.update(dt, true);
        PS.spark.update(dt, false);
      }
      // ghost pulse; hide tool visuals when their tool stopped updating (unequipped, UI open…)
      const pulse = 0.3 + 0.12 * Math.sin(clock * 5);
      M.ghostOk.opacity = pulse;
      M.ghostBad.opacity = pulse + 0.05;
      if (outline) outline.material.opacity = 0.65 + 0.3 * Math.sin(clock * 5);
      if (hammer.shown && hammer.seen < frameNo - 2) hammer.hideVisuals();
      if (placer.ghost && placer.seen < frameNo - 2) placer.hideVisuals();
    },
  });

  // ---------------------------------------------------------------------------
  // Debug hooks
  // ---------------------------------------------------------------------------
  G.debug.buildRing = () => {
    refresh();
    const cells = cache.frontier.slice();
    let n = 0;
    for (const c of cells) if (!canBuildAt(c.i, c.j) && addTile(c.i, c.j)) n++;
    return n;
  };
  G.debug.damageRaft = () => {
    const list = Array.from(tiles.values());
    let n = 0;
    for (let k = 0; k < Math.min(4, list.length); k++) {
      const t = G.pick(list);
      const amt = Math.min(t.maxHp * G.rand(0.3, 0.8), t.hp - 1);
      if (amt > 0) { damageTile(t, amt, 'storm'); n++; }
    }
    return n;
  };
  // Builds a small showcase: ring of tiles and one of each structure (handy for screenshots).
  G.debug.raftShowcase = () => {
    if (tiles.size < 9) G.debug.buildRing();
    const want = ['sail', 'purifier', 'grill', 'chest', 'net', 'anchor'];
    refresh();
    const free = () => Array.from(tiles.values()).filter((t) => !t.structure);
    const placed = [];
    for (const type of want) {
      if (!structureDefs[type]) continue;
      let cand = free();
      if (structureDefs[type].facesWater) cand = cand.filter((t) => raft.isEdge(t));
      if (type === 'sail') cand.sort((a, b) => Math.hypot(a.i + 0.5, a.j + 0.5) - Math.hypot(b.i + 0.5, b.j + 0.5));
      const t = cand[0];
      if (!t) continue;
      let rot = 0;
      if (structureDefs[type].facesWater) for (let r = 0; r < 4; r++) if (facesWater(t, r)) { rot = r; break; }
      const s = placeStructure(type, t, rot);
      if (s) placed.push(s);
    }
    for (const s of placed) {
      if (s.type === 'purifier') { s.data.state = 'work'; s.data.t = PURIFY_TIME * 0.6; }
      if (s.type === 'grill') { s.data.state = 'work'; s.data.t = COOK_TIME * 0.4; s.data.input = 'makrela'; s.data.out = 'makrela_pecena'; }
      if (s.type === 'sail') { s.data.up = true; }
    }
    updateFlags();
    return placed.length;
  };
})();
