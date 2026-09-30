// debris.js — floating debris (planks, plastic, palm leaves, barrels, loot bundles), hand pickup
// and the throwable 'hook' tool. Contract: ../DESIGN.md §2 and §6 "debris.js". Order 40.
//
// Everything that floats is drawn with a handful of InstancedMeshes (one per model variant) plus
// one instanced foam-ring mesh, so 70+ items cost ~10 draw calls. Items drift with
// G.world.driftVelocity, bob and tilt on G.world.waveHeight/waveNormal, slide around the raft
// instead of passing through it, and sink away quietly when they are far downstream.
(function () {
  'use strict';

  const G = window.G;
  if (!G) return;

  const TAU = Math.PI * 2, HALF_PI = Math.PI / 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const R = (a, b) => a + Math.random() * (b - a);
  const smooth01 = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const easeOutBack = (t) => { t = clamp(t, 0, 1) - 1; return 1 + 2.70158 * t * t * t + 1.70158 * t * t; };

  // ---------------------------------------------------------------------------
  // Tuning
  // ---------------------------------------------------------------------------
  const MAX_ALIVE = 70;               // natural debris cap (loot bundles are always allowed)
  const SPAWN_MIN = 55, SPAWN_MAX = 70, SPAWN_LATERAL = 30;
  const SPAWN_EVERY_MIN = 1.1, SPAWN_EVERY_MAX = 2.4;
  const DESPAWN = 90;                 // removed this far downstream (m)
  const FADE_LEN = 14;                // ...after sinking away over the last metres
  const PICK_RANGE = 2.2;             // hand pickup reach (m, to the item surface)
  const CAP = 128;                    // instances per model variant
  const FOAM_CAP = 640;

  const HOOK_MIN_D = 6, HOOK_MAX_D = 22;
  const HOOK_GRAV = 16;               // a little floaty so the arc reads well
  const HOOK_REEL = 5;                // m/s
  const HOOK_ATTACH = 1.3;            // m
  const HOOK_CATCH = 1.5;             // m from the player → collected
  const HOOK_ROPE_MAX = 28;           // the hook trails behind when drifting further
  const HOOK_MAX_ATTACHED = 8;
  const HOOK_SCALE = 1.5;             // world hook head vs. view-model head
  const ROPE_SEG = 24;

  // type → behaviour. radius: footprint (m), size: interaction angular size, float: height of the
  // model origin above the wave surface, lift: interaction point above the origin.
  const TYPES = {
    prkno: { item: 'prkno', weight: 34, radius: 0.6, size: 0.55, float: 0.025, lift: 0.1, tilt: 1.0, rock: 0.05, spin: 0.22, bVariant: 0.3 },
    plast: { item: 'plast', weight: 34, radius: 0.36, size: 0.42, float: 0.05, lift: 0.12, tilt: 0.9, rock: 0.09, spin: 0.35, bVariant: 0.3 },
    list: { item: 'list', weight: 20, radius: 0.6, size: 0.5, float: 0.02, lift: 0.08, tilt: 1.0, rock: 0.04, spin: 0.18, bVariant: 0.3 },
    sud: { item: null, weight: 12, radius: 0.42, size: 0.5, float: 0.07, lift: 0.35, tilt: 0.75, rock: 0.12, spin: 0.12, bVariant: 0 },
    bundle: { item: null, weight: 0, radius: 0.4, size: 0.5, float: 0.09, lift: 0.3, tilt: 0.8, rock: 0.07, spin: 0.16, bVariant: 0 },
  };
  const SPAWN_WEIGHTS = [['prkno', 34], ['plast', 34], ['list', 20], ['sud', 12]];

  function rollBarrelLoot() {
    const out = [['prkno', G.randInt(2, 4)], ['plast', G.randInt(2, 4)], ['list', G.randInt(1, 3)]];
    if (G.chance(0.40)) out.push(['kov', G.randInt(1, 2)]);
    if (G.chance(0.30)) out.push(['provaz', 1]);
    if (G.chance(0.20)) out.push(['sardinka', 1]);
    if (G.chance(0.15)) out.push(['kokos', 1]);
    if (G.chance(0.08)) out.push(['kelimek', 1]);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Scratch objects (no allocations in hot paths)
  // ---------------------------------------------------------------------------
  const UP = new THREE.Vector3(0, 1, 0);
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _n = new THREE.Vector3();
  const _tip = new THREE.Vector3(), _feet = new THREE.Vector3(), _cam = new THREE.Vector3(), _dir = new THREE.Vector3();
  const _land = new THREE.Vector3(), _ra = new THREE.Vector3(), _rb = new THREE.Vector3();
  const _qt = new THREE.Quaternion(), _qs = new THREE.Quaternion(), _qr = new THREE.Quaternion(), _qq = new THREE.Quaternion();
  const _eul = new THREE.Euler();
  const _scl = new THREE.Vector3();
  const _white = new THREE.Color(1, 1, 1);
  const _bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  const DEFAULT_WIND = new THREE.Vector3(1, 0, 0);
  const DEFAULT_DRIFT = new THREE.Vector3(-0.9, 0, 0);

  // ---------------------------------------------------------------------------
  // Small world / raft / player helpers (defensive: other modules may be missing)
  // ---------------------------------------------------------------------------
  function waveH(x, z) {
    const W = G.world;
    if (W && typeof W.waveHeight === 'function') {
      const h = W.waveHeight(x, z);
      if (Number.isFinite(h)) return h;
    }
    return 0;
  }
  function waveN(x, z, out) {
    const W = G.world;
    if (W && typeof W.waveNormal === 'function') {
      W.waveNormal(x, z, out);
      if (Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z)) return out;
    }
    return out.set(0, 1, 0);
  }
  function windDir() { const W = G.world; return W && W.windDir ? W.windDir : DEFAULT_WIND; }
  function driftVel() { const W = G.world; return W && W.driftVelocity ? W.driftVelocity : DEFAULT_DRIFT; }
  function lightLevel() { const W = G.world; return W && Number.isFinite(W.lightLevel) ? W.lightLevel : 1; }

  let raftOn = false;
  const raftC = { x: 0, z: 0 };
  function refreshRaft() {
    const T = G.raft;
    raftOn = !!(T && typeof T.tileAt === 'function' && typeof T.bounds === 'function' &&
      (typeof T.count !== 'function' || T.count() > 0));
    if (raftOn) {
      T.bounds(_bounds);
      raftC.x = (_bounds.minX + _bounds.maxX) * 0.5;
      raftC.z = (_bounds.minZ + _bounds.maxZ) * 0.5;
    }
  }
  function onTile(x, z) {
    if (!raftOn || x < _bounds.minX || x > _bounds.maxX || z < _bounds.minZ || z > _bounds.maxZ) return false;
    return !!G.raft.tileAt(x, z);
  }
  // Is a disc of radius r at (x, z) touching a raft tile?
  function onRaft(x, z, r) {
    if (!raftOn) return false;
    if (x < _bounds.minX - r || x > _bounds.maxX + r || z < _bounds.minZ - r || z > _bounds.maxZ + r) return false;
    const T = G.raft;
    return !!(T.tileAt(x, z) || T.tileAt(x + r, z) || T.tileAt(x - r, z) || T.tileAt(x, z + r) || T.tileAt(x, z - r));
  }
  // Moves p (in place) outwards until it is clear of the raft. Direction defaults to raft centre → p.
  function pushOffRaft(p, r, dx, dz) {
    if (!onRaft(p.x, p.z, r)) return p;
    if (dx === undefined) { dx = p.x - raftC.x; dz = p.z - raftC.z; }
    let len = Math.hypot(dx, dz);
    if (len < 1e-4) { const w = windDir(); dx = w.x; dz = w.z; len = Math.hypot(dx, dz) || 1; }
    dx /= len; dz /= len;
    for (let i = 0; i < 200 && onRaft(p.x, p.z, r + 0.25); i++) { p.x += dx * 0.25; p.z += dz * 0.25; }
    return p;
  }
  // One drift step for a floating thing: moves with (vx, vz) but slides sideways along the raft
  // edge instead of passing through the deck (like water flowing around it).
  function driftStep(obj, pos, r, vx, vz, dt) {
    const nx = pos.x + vx * dt, nz = pos.z + vz * dt;
    if (!onRaft(nx, nz, r)) { pos.x = nx; pos.z = nz; obj.side = 0; return; }
    const sp = Math.hypot(vx, vz);
    // raft edges are axis-aligned: keep the part of the drift that runs along the edge…
    let slid = false;
    if (!onRaft(nx, pos.z, r)) { pos.x = nx; slid = Math.abs(vx) > 0.3 * sp; }
    else if (!onRaft(pos.x, nz, r)) { pos.z = nz; slid = Math.abs(vz) > 0.3 * sp; }
    if (slid) return;
    // …and when it hits the raft head-on, get pushed sideways around it
    let px, pz;
    if (sp > 1e-4) { px = -vz / sp; pz = vx / sp; }
    else { px = pos.x - raftC.x; pz = pos.z - raftC.z; const l = Math.hypot(px, pz) || 1; px /= l; pz /= l; }
    if (!obj.side) obj.side = ((pos.x - raftC.x) * px + (pos.z - raftC.z) * pz) >= 0 ? 1 : -1;
    const deep = onRaft(pos.x, pos.z, r);
    const push = Math.max(sp * 1.25, 0.45) * dt * (deep ? 3 : 1);
    pos.x += px * obj.side * push;
    pos.z += pz * obj.side * push;
  }

  function isInScene(o) {
    for (let p = o; p; p = p.parent) if (p === G.scene) return true;
    return false;
  }
  // Rope start: the tip of the hook handle in the view model (falls back to G.player.hand, then a
  // point lower-right in front of the camera).
  function tipWorld(out) {
    if (vm.tip && isInScene(vm.tip)) return vm.tip.getWorldPosition(out);
    const hand = G.player && G.player.hand;
    if (hand && hand.isObject3D && isInScene(hand)) return hand.getWorldPosition(out);
    if (!G.camera) return out.set(0, 1.5, 0);
    G.camera.updateMatrixWorld();
    return G.camera.localToWorld(out.set(0.22, -0.2, -0.45));
  }
  function aimDir(out) {
    const P = G.player;
    if (P && typeof P.forward === 'function') {
      try { P.forward(out); if (out.lengthSq() > 1e-6) return out.normalize(); } catch (e) { /* fall back */ }
    }
    if (G.camera) return G.camera.getWorldDirection(out);
    return out.set(0, 0, -1);
  }
  function playerFeet(out) {
    const P = G.player;
    if (P && P.position && P.position.isVector3) return out.copy(P.position);
    if (G.camera) { G.camera.getWorldPosition(out); out.y -= G.C.PLAYER_HEIGHT; return out; }
    return out.set(0, 0, 0);
  }
  function btnL() { return G.input && G.input.touchMode ? '●' : 'Levé tlačítko'; }
  function btnR() { return G.input && G.input.touchMode ? '◐' : 'Pravé tlačítko'; }
  function itemDef(id) { return G.items && typeof G.items.def === 'function' ? G.items.def(id) : null; }
  function itemName(id) { const d = itemDef(id); return d ? d.name : String(id); }
  function sfx(name, pos, volume) {
    const o = {};
    if (pos) o.position = pos.clone();
    if (volume != null) o.volume = volume;
    G.sfx(name, o);
  }
  function fx(name, pos, a, b) {
    const F = G.fx;
    if (!F || typeof F[name] !== 'function') return;
    try { F[name](pos, a, b); } catch (err) { /* cosmetic only */ }
  }

  // ---------------------------------------------------------------------------
  // Canvas atlas: wood grain (top half), plain white (bottom-left), rope twist (bottom-right)
  // ---------------------------------------------------------------------------
  const REG = { wood: [0.02, 0.52, 0.98, 0.98], rope: [0.52, 0.02, 0.98, 0.48] };
  function makeAtlas() {
    const S = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, S, S);
    // wood grain: light base with long streaks along u
    g.fillStyle = '#efe9df';
    g.fillRect(0, 0, S, S / 2);
    for (let y = 0; y < S / 2; y++) {
      const a = 0.08 + Math.random() * 0.22;
      g.fillStyle = 'rgba(120,96,70,' + a.toFixed(3) + ')';
      const x0 = Math.random() * 30;
      g.fillRect(x0, y, S - x0 - Math.random() * 30, Math.random() < 0.2 ? 2 : 1);
      y += Math.random() < 0.6 ? 1 : 2;
    }
    for (let k = 0; k < 3; k++) {
      const x = 15 + Math.random() * 98, y = 8 + Math.random() * 48;
      g.strokeStyle = 'rgba(95,70,48,0.45)';
      g.lineWidth = 1.5;
      g.beginPath(); g.ellipse(x, y, 6, 2.2, 0, 0, TAU); g.stroke();
      g.fillStyle = 'rgba(95,70,48,0.35)';
      g.beginPath(); g.ellipse(x, y, 2.5, 1, 0, 0, TAU); g.fill();
    }
    // rope twist
    g.save();
    g.beginPath(); g.rect(S / 2, S / 2, S / 2, S / 2); g.clip();
    g.fillStyle = '#f3ead6';
    g.fillRect(S / 2, S / 2, S / 2, S / 2);
    g.strokeStyle = 'rgba(140,112,70,0.75)';
    g.lineWidth = 3;
    for (let i = -S; i < S * 2; i += 8) { g.beginPath(); g.moveTo(i, S / 2); g.lineTo(i + S / 2, S); g.stroke(); }
    g.restore();
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;
    return tex;
  }

  // ---------------------------------------------------------------------------
  // Geometry builder: transforms primitives, bakes vertex colours + atlas UVs, merges into one
  // non-indexed BufferGeometry.
  // ---------------------------------------------------------------------------
  const _bm = new THREE.Matrix4(), _bp = new THREE.Vector3(), _bq = new THREE.Quaternion(), _bs = new THREE.Vector3();
  const _be = new THREE.Euler(), _bc = new THREE.Color(), _bd = new THREE.Vector3();
  function Builder() { this.parts = []; }
  Builder.prototype.push = function (geo, o) {
    o = o || {};
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    if (o.q) _bq.copy(o.q); else _bq.setFromEuler(_be.set(o.rx || 0, o.ry || 0, o.rz || 0, o.order || 'XYZ'));
    _bm.compose(_bp.set(o.x || 0, o.y || 0, o.z || 0), _bq, _bs.set(o.sx || 1, o.sy || 1, o.sz || 1));
    g.applyMatrix4(_bm);
    if (o.post) g.applyMatrix4(o.post);
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    _bc.set(o.c == null ? 0xffffff : o.c);
    const jit = o.jit == null ? 0.05 : o.jit;
    for (let i = 0; i < n; i += 3) {
      const k = 1 + (Math.random() - 0.5) * 2 * jit;
      for (let j = i; j < i + 3 && j < n; j++) {
        col[j * 3] = _bc.r * k; col[j * 3 + 1] = _bc.g * k; col[j * 3 + 2] = _bc.b * k;
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    let uv = g.attributes.uv;
    if (!uv) { uv = new THREE.BufferAttribute(new Float32Array(n * 2), 2); g.setAttribute('uv', uv); }
    const a = uv.array, reg = o.reg || 'plain';
    for (let i = 0; i < n; i++) {
      let u = a[i * 2], v = a[i * 2 + 1];
      if (reg === 'plain') { u = 0.25; v = 0.25; }
      else {
        if (reg === 'woodV') { const t = u; u = v; v = t; }
        const r = REG[reg === 'woodV' ? 'wood' : reg] || REG.wood;
        u = r[0] + clamp(u, 0, 1) * (r[2] - r[0]);
        v = r[1] + clamp(v, 0, 1) * (r[3] - r[1]);
      }
      a[i * 2] = u; a[i * 2 + 1] = v;
    }
    this.parts.push(g);
    return this;
  };
  Builder.prototype.box = function (w, h, d, o) { return this.push(new THREE.BoxGeometry(w, h, d), o); };
  Builder.prototype.cyl = function (rt, rb, h, seg, o) {
    return this.push(new THREE.CylinderGeometry(rt, rb, h, seg, 1, !!(o && o.open)), o);
  };
  Builder.prototype.cone = function (r, h, seg, o) { return this.push(new THREE.ConeGeometry(r, h, seg), o); };
  Builder.prototype.ball = function (r, detail, o) { return this.push(new THREE.IcosahedronGeometry(r, detail || 0), o); };
  Builder.prototype.torus = function (rr, tube, rs, ts, o) { return this.push(new THREE.TorusGeometry(rr, tube, rs, ts), o); };
  Builder.prototype.lathe = function (pts, seg, o) { return this.push(new THREE.LatheGeometry(pts, seg), o); };
  // Cylinder between two points.
  Builder.prototype.rod = function (ax, ay, az, bx, by, bz, r, seg, o) {
    _bd.set(bx - ax, by - ay, bz - az);
    const len = _bd.length() || 1e-3;
    const q = new THREE.Quaternion().setFromUnitVectors(UP, _bd.multiplyScalar(1 / len));
    const oo = Object.assign({}, o, { x: (ax + bx) / 2, y: (ay + by) / 2, z: (az + bz) / 2, q });
    return this.push(new THREE.CylinderGeometry(r * ((o && o.taper) || 1), r, len, seg || 5, 1), oo);
  };
  Builder.prototype.tris = function (verts, o) {   // raw triangle soup [x,y,z, ...]
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    g.computeVertexNormals();
    return this.push(g, o);
  };
  Builder.prototype.build = function () {
    let total = 0;
    for (const g of this.parts) total += g.attributes.position.count;
    const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2), col = new Float32Array(total * 3);
    let o = 0;
    for (const g of this.parts) {
      const n = g.attributes.position.count;
      pos.set(g.attributes.position.array.subarray(0, n * 3), o * 3);
      nor.set(g.attributes.normal.array.subarray(0, n * 3), o * 3);
      uv.set(g.attributes.uv.array.subarray(0, n * 2), o * 2);
      col.set(g.attributes.color.array.subarray(0, n * 3), o * 3);
      o += n;
      g.dispose();
    }
    this.parts.length = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    return geo;
  };

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------
  const WOOD = 0xb08a5c, WOOD2 = 0xa07b50, WOOD3 = 0xbc9868, BATTEN = 0x8d6a45, NAIL = 0x3d3b39;
  const ALGAE = 0x5f8040, ROPE = 0xd2b47c, IRON = 0x4a4f55;

  function geoPlankA() {
    const b = new Builder();
    b.box(1.02, 0.05, 0.2, { x: -0.08, c: WOOD, reg: 'wood' });
    // splintered end
    b.box(0.22, 0.046, 0.088, { x: 0.53, z: -0.054, c: WOOD2, reg: 'wood' });
    b.box(0.13, 0.042, 0.082, { x: 0.485, z: 0.058, c: WOOD3, reg: 'wood' });
    // weed growing on the wet edge
    b.box(0.62, 0.014, 0.028, { x: -0.22, y: -0.02, z: 0.1, c: ALGAE, jit: 0.2 });
    b.box(0.2, 0.012, 0.022, { x: 0.2, y: -0.02, z: 0.1, c: 0x6d9048, jit: 0.2 });
    // nails, one bent upwards
    b.box(0.026, 0.012, 0.026, { x: -0.52, y: 0.03, z: -0.055, c: NAIL, jit: 0 });
    b.box(0.026, 0.012, 0.026, { x: -0.52, y: 0.03, z: 0.055, c: NAIL, jit: 0 });
    b.box(0.012, 0.07, 0.012, { x: 0.28, y: 0.055, z: 0.02, rz: 0.55, c: 0x6e4b3a, jit: 0 });
    return b.build();
  }
  function geoPlankB() {   // two boards nailed together with battens
    const b = new Builder();
    b.box(1.12, 0.05, 0.19, { z: -0.102, c: WOOD, reg: 'wood' });
    b.box(0.96, 0.05, 0.19, { x: 0.06, z: 0.102, c: WOOD2, reg: 'wood', ry: 0.02 });
    b.box(0.085, 0.04, 0.47, { x: -0.36, y: 0.045, c: BATTEN, reg: 'wood', ry: 0.05 });
    b.box(0.085, 0.04, 0.47, { x: 0.33, y: 0.045, c: 0x94704a, reg: 'wood', ry: -0.08 });
    for (const x of [-0.36, 0.33]) for (const z of [-0.1, 0.1]) b.box(0.022, 0.01, 0.022, { x, y: 0.068, z, c: NAIL, jit: 0 });
    b.box(0.5, 0.012, 0.03, { x: 0.1, y: -0.02, z: -0.19, c: ALGAE, jit: 0.2 });
    return b.build();
  }

  // A bottle lying along +X (built along +Y, then turned), placed with `post`.
  function bottle(b, px, py, pz, ry, L, r, body, cap, label) {
    const post = new THREE.Matrix4().compose(new THREE.Vector3(px, py, pz),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, -HALF_PI, 'XYZ')), new THREE.Vector3(1, 1, 1));
    const bodyL = L * 0.6, shL = L * 0.17, neckL = L * 0.11, capL = L * 0.1;
    let y = -L / 2 + bodyL / 2;
    b.cyl(r, r * 0.94, bodyL, 8, { y, c: body, post, jit: 0.03 });
    if (label != null) b.cyl(r * 1.03, r * 1.03, bodyL * 0.42, 8, { y: y + bodyL * 0.05, c: label, post, open: true, jit: 0 });
    y = -L / 2 + bodyL + shL / 2;
    b.cyl(r * 0.4, r, shL, 8, { y, c: body, post, jit: 0.03 });
    y += shL / 2 + neckL / 2;
    b.cyl(r * 0.34, r * 0.37, neckL, 8, { y, c: body, post, jit: 0.03 });
    y += neckL / 2 + capL / 2;
    b.cyl(r * 0.44, r * 0.44, capL, 8, { y, c: cap, post, jit: 0 });
  }
  function geoPlasticA() {   // a bunch of bottles
    const b = new Builder();
    bottle(b, -0.06, 0.0, -0.08, 0.35, 0.36, 0.078, 0x3b8fd8, 0xf2f2ee, 0xf4f1e6);
    bottle(b, 0.06, 0.0, 0.09, -0.45, 0.32, 0.07, 0xe9efe9, 0xe0452f, 0x3fae5a);
    bottle(b, 0.0, 0.085, 0.0, 1.3, 0.25, 0.056, 0x52b865, 0xf3c33a, null);
    // a scrap of twine holding them
    b.torus(0.12, 0.012, 4, 10, { rx: HALF_PI, sx: 1.2, c: ROPE, reg: 'rope' });
    return b.build();
  }
  function geoPlasticB() {   // jerrycan + bottle
    const b = new Builder();
    const Y = 0xf0b72c, Yd = 0xd99a1c;
    b.box(0.36, 0.26, 0.16, { c: Y, jit: 0.03 });
    // embossed X on both sides
    for (const s of [-1, 1]) {
      b.box(0.3, 0.03, 0.012, { z: s * 0.082, rz: 0.62, c: Yd, jit: 0 });
      b.box(0.3, 0.03, 0.012, { z: s * 0.082, rz: -0.62, c: Yd, jit: 0 });
    }
    // handle bridge
    b.box(0.2, 0.035, 0.05, { y: 0.19, x: -0.04, c: Y, jit: 0.03 });
    b.box(0.035, 0.07, 0.05, { y: 0.155, x: -0.13, c: Y, jit: 0.03 });
    b.box(0.035, 0.07, 0.05, { y: 0.155, x: 0.05, c: Y, jit: 0.03 });
    // spout with red cap
    b.cyl(0.03, 0.035, 0.07, 8, { x: 0.14, y: 0.15, rz: -0.5, c: Y });
    b.cyl(0.038, 0.038, 0.04, 8, { x: 0.165, y: 0.185, rz: -0.5, c: 0xd8412e, jit: 0 });
    bottle(b, -0.02, -0.02, 0.2, 0.2, 0.3, 0.065, 0x4aa3e0, 0xf2f2ee, null);
    return b.build();
  }

  function frond(b, len, ox, oy, oz, ry, seed) {
    const post = new THREE.Matrix4().compose(new THREE.Vector3(ox, oy, oz),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(1, 1, 1));
    const half = len / 2;
    b.rod(-half, 0.0, 0, half, 0.05, 0, 0.022, 5, { c: 0x9fbf55, taper: 0.35, post });
    b.rod(-half - 0.22, -0.01, 0, -half, 0.0, 0, 0.026, 5, { c: 0x8a9a45, post });   // stem
    const N = 11, verts = [];
    for (let k = 0; k < N; k++) {
      const t = k / (N - 1);
      const x = -half + 0.08 + t * (len - 0.16);
      const y = 0.05 * t;
      const L = (0.36 - 0.22 * t) * (0.9 + 0.2 * Math.sin(seed + k * 1.7));
      for (const s of [-1, 1]) {
        const tipX = x + 0.2 + 0.05 * t, tipZ = s * L, tipY = y + 0.07;
        const w = 0.035;
        const mx = (x + tipX) / 2, mz = tipZ / 2, my = y + 0.015;
        // a narrow folded leaflet (two triangles meeting at a crease)
        verts.push(x - w, y, 0, mx, my - 0.012, mz - s * w * 0.4, tipX, tipY, tipZ);
        verts.push(x + w, y, 0, tipX, tipY, tipZ, mx + 0.03, my + 0.01, mz + s * w * 0.6);
      }
    }
    b.tris(verts, { c: 0x5aa33a, jit: 0.12, post });
    // a dry brownish tip
    b.cone(0.03, 0.14, 4, { x: half + 0.06, y: 0.055, rz: -HALF_PI, c: 0xb5a653, post });
  }
  function geoLeafA() {
    const b = new Builder();
    frond(b, 1.2, 0, 0, 0, 0, 1);
    return b.build();
  }
  function geoLeafB() {
    const b = new Builder();
    frond(b, 1.15, -0.05, 0, -0.05, 0.25, 2);
    frond(b, 0.95, 0.08, 0.03, 0.08, -0.9, 5);
    return b.build();
  }

  function geoBarrel() {
    const b = new Builder();
    const H = 0.9, pts = [];
    const prof = [[0.29, -0.45], [0.33, -0.36], [0.36, -0.2], [0.37, 0], [0.36, 0.2], [0.33, 0.36], [0.29, 0.45]];
    for (const p of prof) pts.push(new THREE.Vector2(p[0], p[1]));
    // staves: alternate the colour per segment for a planked look
    const SEG = 12;
    for (let s = 0; s < SEG; s++) {
      const g = new THREE.LatheGeometry(pts, 1, (s / SEG) * TAU, TAU / SEG);
      b.push(g, { c: s % 2 ? 0x9a6a3e : 0x8b5d35, reg: 'woodV', jit: 0.04 });
    }
    // lids (slightly recessed) with plank lines
    b.cyl(0.275, 0.275, 0.03, SEG, { y: H / 2 - 0.035, c: 0xa77a4c, reg: 'wood' });
    b.cyl(0.275, 0.275, 0.03, SEG, { y: -H / 2 + 0.035, c: 0x7e5733 });
    b.box(0.5, 0.008, 0.012, { y: H / 2 - 0.018, z: -0.09, c: 0x5f4127, jit: 0 });
    b.box(0.5, 0.008, 0.012, { y: H / 2 - 0.018, z: 0.09, c: 0x5f4127, jit: 0 });
    b.cyl(0.035, 0.035, 0.02, 6, { y: H / 2 - 0.012, x: 0.12, c: 0x3f2c1d, jit: 0 });
    // iron hoops
    for (const [y, r] of [[-0.37, 0.333], [-0.15, 0.366], [0.15, 0.366], [0.37, 0.333]]) {
      b.cyl(r + 0.008, r + 0.008, 0.05, SEG, { y, c: IRON, open: true, jit: 0.08 });
    }
    // bung and a rope loop
    b.cyl(0.035, 0.035, 0.05, 6, { x: 0.37, rz: HALF_PI, c: 0x4a3220, jit: 0 });
    b.torus(0.375, 0.016, 4, 16, { rx: HALF_PI, y: 0.03, c: ROPE, reg: 'rope', jit: 0.03 });
    return b.build();
  }

  function geoCrate() {
    const b = new Builder();
    const F = 0x6b4a2f;
    b.box(0.5, 0.34, 0.46, { c: 0xa57c4f, reg: 'wood' });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(0.055, 0.36, 0.055, { x: sx * 0.235, z: sz * 0.215, c: F, jit: 0.04 });
    for (const sy of [-1, 1]) {
      b.box(0.52, 0.045, 0.05, { y: sy * 0.16, z: 0.215, c: F });
      b.box(0.52, 0.045, 0.05, { y: sy * 0.16, z: -0.215, c: F });
      b.box(0.05, 0.045, 0.48, { y: sy * 0.16, x: 0.235, c: F });
      b.box(0.05, 0.045, 0.48, { y: sy * 0.16, x: -0.235, c: F });
    }
    b.box(0.6, 0.035, 0.03, { rz: 0.58, z: 0.235, c: F });
    b.box(0.6, 0.035, 0.03, { rz: -0.58, x: 0.0, z: -0.235, c: F });
    // rope net over the tarp
    const r = 0.013;
    b.rod(-0.26, 0.16, 0, -0.12, 0.31, 0, r, 4, { c: ROPE, reg: 'rope' });
    b.rod(-0.12, 0.31, 0, 0.12, 0.31, 0, r, 4, { c: ROPE, reg: 'rope' });
    b.rod(0.12, 0.31, 0, 0.26, 0.16, 0, r, 4, { c: ROPE, reg: 'rope' });
    b.rod(0, 0.16, -0.24, 0, 0.31, -0.11, r, 4, { c: ROPE, reg: 'rope' });
    b.rod(0, 0.31, -0.11, 0, 0.31, 0.11, r, 4, { c: ROPE, reg: 'rope' });
    b.rod(0, 0.31, 0.11, 0, 0.16, 0.24, r, 4, { c: ROPE, reg: 'rope' });
    b.ball(0.03, 0, { y: 0.32, c: ROPE, reg: 'rope' });
    return b.build();
  }
  function geoTarp() {       // the cloth bundle on top of the crate, tinted per item colour
    const b = new Builder();
    b.ball(0.3, 1, { y: 0.2, sx: 0.95, sy: 0.42, sz: 0.9, c: 0xffffff, jit: 0.08 });
    b.ball(0.08, 0, { y: 0.33, x: 0.02, sy: 0.7, c: 0xffffff, jit: 0.05 });
    return b.build();
  }

  // Three-pronged plastic grappling hook. Eye (rope end) at +Y, prongs at the bottom curling up.
  function geoHookHead() {
    const b = new Builder();
    const O = 0xf2761d, Od = 0xd4601a;
    b.cyl(0.016, 0.02, 0.2, 6, { y: 0.11, c: O, jit: 0.03 });
    b.cyl(0.027, 0.027, 0.035, 6, { y: 0.02, c: Od });
    b.torus(0.03, 0.009, 5, 10, { y: 0.235, c: 0x3b3f44, jit: 0 });
    b.cyl(0.022, 0.022, 0.02, 6, { y: 0.205, c: Od });
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * TAU, cx = Math.cos(a), cz = Math.sin(a);
      const P = [[0.0, 0.03], [0.065, -0.012], [0.11, 0.03], [0.115, 0.095]];
      for (let i = 0; i < P.length - 1; i++) {
        b.rod(cx * P[i][0], P[i][1], cz * P[i][0], cx * P[i + 1][0], P[i + 1][1], cz * P[i + 1][0], 0.012, 5, { c: O, jit: 0.03 });
      }
      b.rod(cx * 0.115, 0.095, cz * 0.115, cx * 0.098, 0.145, cz * 0.098, 0.012, 5, { c: 0xffa04a, taper: 0.1, jit: 0 });
    }
    b.ball(0.02, 0, { y: 0.262, c: ROPE, reg: 'rope' });
    return b.build();
  }
  function geoHookHandle() { // plank handle along +Y (0 .. 0.46), grip wrap, rope guide
    const b = new Builder();
    b.box(0.044, 0.46, 0.03, { y: 0.23, c: 0xa77b4f, reg: 'woodV' });
    b.cyl(0.031, 0.031, 0.13, 8, { y: 0.075, c: ROPE, reg: 'rope' });
    b.box(0.05, 0.05, 0.036, { y: 0.27, x: 0.012, c: 0x7a5534 });      // spool bracket
    b.torus(0.014, 0.005, 4, 8, { y: 0.465, c: 0x5a5e64, jit: 0 });   // rope guide eye
    b.rod(0.048, 0.3, 0.0, 0.006, 0.455, 0.0, 0.005, 4, { c: ROPE, reg: 'rope' });   // rope up to the eye
    return b.build();
  }
  function geoSpool() {      // axis along X, rotates about X
    const b = new Builder();
    b.cyl(0.058, 0.058, 0.01, 10, { x: -0.03, rz: HALF_PI, c: 0x6b4a2f });
    b.cyl(0.058, 0.058, 0.01, 10, { x: 0.03, rz: HALF_PI, c: 0x6b4a2f });
    b.cyl(0.045, 0.045, 0.05, 10, { rz: HALF_PI, c: ROPE, reg: 'rope' });
    b.box(0.01, 0.07, 0.014, { x: 0.04, y: 0.03, c: 0x5a5e64, jit: 0 });
    b.cyl(0.009, 0.009, 0.035, 6, { x: 0.058, y: 0.062, rz: HALF_PI, c: 0x3b2a1c, jit: 0 });
    return b.build();
  }

  // ---------------------------------------------------------------------------
  // Foam ring shader (instanced; per-instance phase and "gold" sparkle for barrels)
  // ---------------------------------------------------------------------------
  const FOAM_VERT = `
    #include <common>
    #include <fog_pars_vertex>
    attribute float aPhase;
    attribute float aGold;
    varying vec2 vUv;
    varying float vPhase;
    varying float vGold;
    void main() {
      vUv = uv;
      vPhase = aPhase;
      vGold = aGold;
      vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`;
  const FOAM_FRAG = `
    #include <common>
    #include <fog_pars_fragment>
    uniform float uTime;
    uniform float uLight;
    varying vec2 vUv;
    varying float vPhase;
    varying float vGold;
    void main() {
      vec2 p = vUv * 2.0 - 1.0;
      float r = length(p);
      if (r > 1.0) discard;
      float a = atan(p.y, p.x);
      float rr = r + 0.06 * sin(a * 5.0 + uTime * 1.6 + vPhase * 6.0) + 0.03 * sin(a * 9.0 - uTime * 2.1 + vPhase);
      float ring = smoothstep(0.38, 0.68, rr) * (1.0 - smoothstep(0.7, 0.96, rr));
      float lace = 0.55 + 0.45 * sin(a * 7.0 + vPhase * 3.0 + uTime * 0.7) * sin(r * 17.0 - uTime * 1.3 + vPhase);
      float alpha = ring * (0.18 + 0.3 * lace) * (0.8 + 0.2 * sin(uTime * 1.9 + vPhase * 5.0));
      vec3 col = vec3(1.0);
      if (vGold > 0.5) {
        float s = pow(max(0.0, sin(a * 3.0 - uTime * 2.3 + vPhase)), 36.0) * (1.0 - smoothstep(0.0, 0.2, abs(rr - 0.72)));
        col = mix(col, vec3(1.0, 0.84, 0.42), clamp(s * 1.5, 0.0, 1.0));
        alpha = max(alpha, s * 0.95);
      }
      gl_FragColor = vec4(col * uLight, alpha * 0.9);
      #include <fog_fragment>
    }`;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const list = [];            // every live floating item (public: G.debris.list)
  const models = {};          // key → { parts: [InstancedMesh], items: [], yield }
  const modelList = [];
  let foam = null, foamPhase = null, foamGold = null;
  let mats = null, atlas = null;
  let clock = 0, spawnT = 2, pendingBurst = true, bundleCount = 0, dirty = true;
  const badgeMats = Object.create(null);

  // Hook state
  const hook = {
    state: 'idle',            // idle | charging | flying | water | returning
    pos: new THREE.Vector3(),
    from: new THREE.Vector3(),
    retFrom: new THREE.Vector3(),
    dirX: 1, dirZ: 0, lastDirX: 0, lastDirZ: -1,
    vh: 0, vy0: 0, t: 0, T: 1,
    chargeT: 0, reeling: false, charged: true,
    retT: 0, retDur: 0.4, retArc: 0.8, retCollect: false,
    reelSfxT: 0, splashT: 0, landT: 0, spin: 0, yaw: 0, side: 0,
    attached: [],
    object: null, head: null, rope: null, ropePos: null, ropePts: null, marker: null,
    foamMatrix: new THREE.Matrix4(),
  };
  let lmb = false, equipped = false, progressShown = false;
  const vm = { root: null, pivot: null, spool: null, headHolder: null, head: null, tip: null,
    t: 0, throwT: -1, throwFrom: 0, pop: 1, spoolSpeed: 0 };

  // ---------------------------------------------------------------------------
  // Build (init)
  // ---------------------------------------------------------------------------
  function makeInstanced(geo, mat, name) {
    const m = new THREE.InstancedMesh(geo, mat, CAP);
    m.name = name;
    m.count = 0;
    m.visible = false;
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3).fill(1), 3);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    G.scene.add(m);
    return m;
  }
  function addModel(key, type, yieldN, parts) {
    const model = { key, type, yield: yieldN, parts, items: [] };
    models[key] = model;
    modelList.push(model);
    return model;
  }

  function build() {
    atlas = makeAtlas();
    mats = {
      wood: new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, flatShading: true, roughness: 0.92, metalness: 0 }),
      plastic: new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, flatShading: true, roughness: 0.38, metalness: 0 }),
      leaf: new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, flatShading: true, roughness: 0.7, metalness: 0, side: THREE.DoubleSide }),
      cloth: new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 }),
    };
    addModel('prknoA', 'prkno', 1, [makeInstanced(geoPlankA(), mats.wood, 'debris-plank')]);
    addModel('prknoB', 'prkno', 2, [makeInstanced(geoPlankB(), mats.wood, 'debris-planks')]);
    addModel('plastA', 'plast', 1, [makeInstanced(geoPlasticA(), mats.plastic, 'debris-bottles')]);
    addModel('plastB', 'plast', 2, [makeInstanced(geoPlasticB(), mats.plastic, 'debris-jerrycan')]);
    addModel('listA', 'list', 1, [makeInstanced(geoLeafA(), mats.leaf, 'debris-leaf')]);
    addModel('listB', 'list', 2, [makeInstanced(geoLeafB(), mats.leaf, 'debris-leaves')]);
    addModel('sud', 'sud', 1, [makeInstanced(geoBarrel(), mats.wood, 'debris-barrel')]);
    const tarp = makeInstanced(geoTarp(), mats.cloth, 'debris-bundle-tarp');
    tarp.userData.itemTint = true;
    addModel('bundle', 'bundle', 1, [makeInstanced(geoCrate(), mats.wood, 'debris-bundle'), tarp]);

    // foam rings
    const fg = new THREE.PlaneGeometry(1, 1);
    fg.rotateX(-HALF_PI);
    foamPhase = new THREE.InstancedBufferAttribute(new Float32Array(FOAM_CAP), 1);
    foamGold = new THREE.InstancedBufferAttribute(new Float32Array(FOAM_CAP), 1);
    foamPhase.setUsage(THREE.DynamicDrawUsage);
    foamGold.setUsage(THREE.DynamicDrawUsage);
    fg.setAttribute('aPhase', foamPhase);
    fg.setAttribute('aGold', foamGold);
    const fm = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uLight: { value: 1 } }]),
      vertexShader: FOAM_VERT,
      fragmentShader: FOAM_FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    foam = new THREE.InstancedMesh(fg, fm, FOAM_CAP);
    foam.name = 'debris-foam';
    foam.count = 0;
    foam.visible = false;
    foam.frustumCulled = false;
    foam.renderOrder = 2;
    foam.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    G.scene.add(foam);

    buildHook();
  }

  function buildHook() {
    const headGeo = geoHookHead();
    // world hook
    const obj = new THREE.Group();
    obj.name = 'hook-world';
    const head = new THREE.Mesh(headGeo, mats.plastic);
    head.scale.setScalar(HOOK_SCALE);
    head.castShadow = true;
    obj.add(head);
    obj.visible = false;
    G.scene.add(obj);
    hook.object = obj;
    hook.head = head;

    // rope: a camera-facing ribbon along a sagging curve (buffers reused every frame)
    const n = ROPE_SEG + 1;
    hook.ropePts = new Float32Array(n * 3);
    hook.ropePos = new Float32Array(n * 2 * 3);
    const idx = [];
    for (let i = 0; i < ROPE_SEG; i++) {
      const a = i * 2, b2 = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b2, b2, c, d);
    }
    const rg = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(hook.ropePos, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    rg.setAttribute('position', pa);
    rg.setIndex(idx);
    rg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    const rope = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: 0xd9c08c, side: THREE.DoubleSide }));
    rope.name = 'hook-rope';
    rope.frustumCulled = false;
    rope.visible = false;
    G.scene.add(rope);
    hook.rope = rope;

    // aim marker on the water while charging
    const mg = new THREE.RingGeometry(0.36, 0.54, 28);
    mg.rotateX(-HALF_PI);
    const dot = new THREE.CircleGeometry(0.1, 12);
    dot.rotateX(-HALF_PI);
    const mm = new THREE.MeshBasicMaterial({ color: 0xffe7a8, transparent: true, opacity: 0.85, depthWrite: false });
    const marker = new THREE.Group();
    marker.add(new THREE.Mesh(mg, mm), new THREE.Mesh(dot, mm));
    marker.name = 'hook-marker';
    marker.visible = false;
    marker.renderOrder = 3;
    G.scene.add(marker);
    hook.marker = marker;

    // view model: handle + spool + hook head at the tip
    const root = new THREE.Group();
    root.name = 'hook-view';
    const pivot = new THREE.Group();
    root.add(pivot);
    const handle = new THREE.Mesh(geoHookHandle(), mats.wood);
    pivot.add(handle);
    const spool = new THREE.Mesh(geoSpool(), mats.wood);
    spool.position.set(0.058, 0.27, 0);
    pivot.add(spool);
    const holder = new THREE.Group();
    holder.position.set(0, 0.465, 0);
    pivot.add(holder);
    const vhead = new THREE.Mesh(headGeo, mats.plastic);
    vhead.rotation.x = Math.PI;          // eye at the tip, prongs pointing away
    vhead.position.y = 0.19;
    vhead.rotation.y = 0.4;
    vhead.scale.setScalar(0.72);
    holder.add(vhead);
    const tip = new THREE.Object3D();
    tip.position.set(0, 0.47, 0);
    pivot.add(tip);
    root.position.set(0.01, -0.05, 0);
    root.rotation.set(-0.62, 0.3, 0.16);
    root.scale.setScalar(0.62);
    vm.root = root; vm.pivot = pivot; vm.spool = spool; vm.headHolder = holder; vm.head = vhead; vm.tip = tip;
    handler.viewModel = root;
  }

  // ---------------------------------------------------------------------------
  // Debris items
  // ---------------------------------------------------------------------------
  function pickModel(type) {
    const cfg = TYPES[type];
    if (type === 'bundle') return models.bundle;
    if (type === 'sud') return models.sud;
    return models[type + (cfg.bVariant && G.chance(cfg.bVariant) ? 'B' : 'A')];
  }
  function upstreamPos(out, dMin, dMax, lateral) {
    const w = windDir();
    const len = Math.hypot(w.x, w.z) || 1;
    const wx = w.x / len, wz = w.z / len;
    const d = R(dMin, dMax), l = R(-lateral, lateral);
    return out.set(wx * d - wz * l, 0, wz * d + wx * l);
  }
  function labelFor(d) {
    if (d.type === 'sud') return 'Otevřít sud';
    const n = d.type === 'bundle' ? d.count : d.model.yield;
    return 'Sebrat: ' + itemName(d.type === 'bundle' ? d.id : d.cfg.item) + (n > 1 ? ' ×' + n : '');
  }

  function makeItem(type, model, pos) {
    const cfg = TYPES[type];
    const d = {
      type, cfg, model,
      id: cfg.item, count: model.yield,
      position: new THREE.Vector3(),
      matrix: new THREE.Matrix4(),
      foamMatrix: new THREE.Matrix4(),
      tint: new THREE.Color(),
      itemColor: null,
      retFrom: null,
      spinAngle: R(0, TAU), spinRate: R(-1, 1) * cfg.spin, phase: R(0, TAU),
      rockAmp: cfg.rock * R(0.7, 1.3), driftK: R(0.9, 1.1),
      age: 0, fade: 0, bump: 0, retScale: 1, islandT: R(0, 0.5),
      side: 0, hooked: false, attached: false, flying: false, collected: false, alive: true,
      dying: false, dyingT: 0, hookOffX: 0, hookOffZ: 0,
      sprite: null, it: null, label: '',
    };
    const k = R(0.86, 1.06);
    d.tint.setRGB(k, k * R(0.97, 1.02), k * R(0.95, 1.02));
    refreshRaft();
    if (pos) d.position.set(pos.x, 0, pos.z);
    else upstreamPos(d.position, SPAWN_MIN, SPAWN_MAX, SPAWN_LATERAL);
    pushOffRaft(d.position, cfg.radius + 0.2);
    d.position.y = waveH(d.position.x, d.position.z) + cfg.float;
    list.push(d);
    model.items.push(d);
    d.label = labelFor(d);
    d.it = G.interaction.add({
      getPosition: (out) => out.set(d.position.x, d.position.y + cfg.lift, d.position.z),
      label: () => d.label,
      onInteract: () => { collect(d, null, 'debris'); },
      enabled: () => d.alive && !d.collected && !d.flying,
      range: PICK_RANGE + cfg.radius,
      size: cfg.size,
    });
    dirty = true;
    return d;
  }

  function spawn(type, pos, quiet) {
    if (!foam) return null;
    if (!TYPES[type] || type === 'bundle') type = G.weighted(SPAWN_WEIGHTS);
    const model = pickModel(type);
    if (!model || model.items.length >= CAP) return null;
    const d = makeItem(type, model, pos);
    if (pos && !quiet) nearSplash(d);
    return d;
  }

  function spawnItem(id, count, pos) {
    if (!foam) return null;
    const model = models.bundle;
    if (model.items.length >= CAP) return null;
    count = Math.max(1, Math.floor(Number(count) || 1));
    const d = makeItem('bundle', model, pos || null);
    d.id = String(id);
    d.count = count;
    d.label = labelFor(d);
    const def = itemDef(d.id);
    d.itemColor = new THREE.Color(def && def.color ? def.color : '#e8dcc0').lerp(_white, 0.22);
    bundleCount++;
    // a little floating badge with the item icon
    const sprite = new THREE.Sprite(badgeMat(d.id));
    sprite.scale.setScalar(0.42);
    sprite.renderOrder = 4;
    sprite.position.copy(d.position);
    G.scene.add(sprite);
    d.sprite = sprite;
    if (pos) nearSplash(d);
    return d;
  }

  function nearSplash(d) {
    if (G.state !== 'playing') return;
    if (d.position.x * d.position.x + d.position.z * d.position.z < 30 * 30) fx('splash', d.position, 0.35);
  }

  function badgeMat(id) {
    if (badgeMats[id]) return badgeMats[id];
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    g.fillStyle = 'rgba(6,34,43,0.78)';
    g.beginPath(); g.arc(32, 32, 28, 0, TAU); g.fill();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(230,207,159,0.95)';
    g.stroke();
    const def = itemDef(id);
    g.font = '32px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#e9f1ea';
    g.fillText(def && def.icon ? def.icon : '📦', 32, 35);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    badgeMats[id] = m;
    return m;
  }

  function removeItem(d) {
    if (!d.alive) return;
    d.alive = false;
    d.collected = true;
    let i = list.indexOf(d);
    if (i >= 0) list.splice(i, 1);
    i = d.model.items.indexOf(d);
    if (i >= 0) d.model.items.splice(i, 1);
    i = hook.attached.indexOf(d);
    if (i >= 0) hook.attached.splice(i, 1);
    if (d.it) { G.interaction.remove(d.it); d.it = null; }
    if (d.sprite) { G.scene.remove(d.sprite); d.sprite = null; }
    if (d.type === 'bundle') bundleCount = Math.max(0, bundleCount - 1);
    dirty = true;
  }

  // Loot list for an item: [[id, count], ...]
  function lootOf(d) {
    if (d.type === 'sud') return rollBarrelLoot();
    if (d.type === 'bundle') return [[d.id, d.count]];
    return [[d.cfg.item, d.model.yield]];
  }

  // Collect a floating item into the player inventory (default) or into a storage (net).
  // Returns true if anything was taken. Items that do not fit stay afloat (as a bundle).
  function collect(d, storage, source) {
    if (!d || !d.alive || d.collected) return false;
    const inv = G.inventory;
    if (!inv) return false;
    const toStorage = !!(storage && storage !== inv && storage !== inv.slots);
    const src = source || (toStorage ? 'net' : 'debris');
    const loot = lootOf(d);
    let got = false;
    const left = [];
    for (const [id, n] of loot) {
      let l = n;
      try { l = toStorage ? inv.addTo(storage, id, n) : inv.add(id, n, src); } catch (err) { l = n; }
      l = Math.max(0, Math.floor(Number(l) || 0));
      if (l < n) got = true;
      if (l > 0) left.push([id, l]);
    }
    if (!got) return false;
    const pos = _v2.copy(d.position);
    pos.y += d.flying ? 0 : d.cfg.lift * 0.6;
    if (d.type === 'bundle' && left.length) {
      // partly taken: the rest stays in the bundle
      d.count = left[0][1];
      d.label = labelFor(d);
      sfx('pickup', pos, toStorage ? 0.4 : 0.8);
      fx('sparkle', pos, d.itemColor || 0xffd27a);
      return true;
    }
    const color = d.type === 'bundle' ? (d.itemColor || 0xffd27a) : d.type === 'sud' ? 0xffd27a
      : (itemDef(d.cfg.item) && itemDef(d.cfg.item).color) || 0xffffff;
    removeItem(d);
    sfx('pickup', pos, toStorage ? 0.45 : 1);
    fx('sparkle', pos, color);
    if (d.type === 'sud') {
      fx('debris', pos, 0x93623a, 8);
      sfx('break_wood', pos, 0.45);
    }
    if (d.type === 'bundle' && d.id === 'zlato') sfx('coins', pos, 0.8);
    // what did not fit floats on as bundles
    if (left.length) {
      const fp = _v.copy(d.position);
      if (d.flying) fp.copy(hook.retFrom);
      for (const [id, n] of left) {
        const b = spawnItem(id, n, fp);
        if (b) b.age = 1.5;
      }
    }
    G.stats.debrisCollected = (G.stats.debrisCollected || 0) + 1;
    G.events.emit('debris:collected', { type: d.type, id: d.type === 'bundle' ? d.id : d.cfg.item, count: d.count, source: src, storage: toStorage });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------
  function pickType() { return G.weighted(SPAWN_WEIGHTS); }

  function spawnBurst() {
    refreshRaft();
    const w = windDir();
    const len = Math.hypot(w.x, w.z) || 1;
    const wx = w.x / len, wz = w.z / len;
    const half = raftOn ? Math.max(_bounds.maxX - _bounds.minX, _bounds.maxZ - _bounds.minZ) * 0.5 : 2;
    const plan = [['prkno', 9, half + 0.9], ['plast', 15, -(half + 2.5)], ['list', 21, 1.2], ['prkno', 28, -(half + 5)],
      ['plast', 36, half + 7], ['sud', 45, -0.8]];
    for (const [type, dist, lat] of plan) {
      const d = dist + R(-2, 2), l = lat + R(-0.6, 0.6);
      _v.set(wx * d - wz * l, 0, wz * d + wx * l);
      const it = spawn(type, _v, true);
      if (it) it.age = 3;         // already afloat when the game starts
    }
  }

  function updateIslandCheck(d, dt) {
    d.islandT -= dt;
    if (d.islandT > 0) return false;
    d.islandT = 0.5;
    const provs = G.ground && G.ground.providers;
    if (!provs) return false;
    for (let i = 0; i < provs.length; i++) {
      const p = provs[i];
      if (!p || p.kind !== 'island' || typeof p.heightAt !== 'function') continue;
      let h = null;
      try { h = p.heightAt(d.position.x, d.position.z); } catch (e) { h = null; }
      if (h !== null && h !== undefined && h > 0.12) return true;
    }
    return false;
  }

  function simulate(dt) {
    clock += dt;
    refreshRaft();
    if (pendingBurst) { pendingBurst = false; spawnBurst(); }

    // spawner: one item upstream every 1.1–2.4 s while fewer than MAX_ALIVE are afloat
    spawnT -= dt;
    if (spawnT <= 0) {
      spawnT = R(SPAWN_EVERY_MIN, SPAWN_EVERY_MAX);
      if (list.length - bundleCount < MAX_ALIVE) spawn(pickType());
    }

    const dv = driftVel(), w = windDir();
    const wl = Math.hypot(w.x, w.z) || 1;
    const wx = w.x / wl, wz = w.z / wl;
    // while reeling, hooked items fan out behind the hook (away from the player)
    let awayX = 0, awayZ = 0;
    if (hook.reeling && hook.attached.length) {
      playerFeet(_feet);
      awayX = hook.pos.x - _feet.x; awayZ = hook.pos.z - _feet.z;
      const al = Math.hypot(awayX, awayZ) || 1;
      awayX /= al; awayZ /= al;
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      d.age += dt;
      if (d.bump > 0) d.bump = Math.max(0, d.bump - dt * 3);
      if (d.flying) continue;              // positioned by the hook
      const cfg = d.cfg;
      if (d.attached) {
        if (awayX || awayZ) {
          const k = hook.attached.indexOf(d);
          const back = 0.3 + cfg.radius * 0.5 + 0.22 * (k >> 1), lat = (k & 1 ? 1 : -1) * (0.12 + 0.18 * (k >> 1));
          const ox = awayX * back - awayZ * lat, oz = awayZ * back + awayX * lat;
          const kk = 1 - Math.exp(-3 * dt);
          d.hookOffX += (ox - d.hookOffX) * kk;
          d.hookOffZ += (oz - d.hookOffZ) * kk;
        }
        // follow the hook, trailing a little
        const tx = hook.pos.x + d.hookOffX, tz = hook.pos.z + d.hookOffZ;
        const k = 1 - Math.exp(-7 * dt);
        d.position.x += (tx - d.position.x) * k;
        d.position.z += (tz - d.position.z) * k;
        d.spinAngle += d.spinRate * dt * 0.3;
      } else {
        driftStep(d, d.position, cfg.radius, dv.x * d.driftK, dv.z * d.driftK, dt);
        d.spinAngle += d.spinRate * dt;
        const along = d.position.x * wx + d.position.z * wz;
        const far = d.position.x * d.position.x + d.position.z * d.position.z > 180 * 180;
        if (along < -DESPAWN || far || (d.dying && d.fade <= 0.01)) { removeItem(d); continue; }
        if (!d.dying && updateIslandCheck(d, dt)) d.dying = true;
      }
    }
    for (let i = 0; i < list.length; i++) poseItem(list[i], wx, wz, dt);
    dirty = true;
  }

  function poseItem(d, wx, wz, dt) {
    const cfg = d.cfg;
    const x = d.position.x, z = d.position.z;
    // fade in (rise from below) / out (sink downstream or on a beach)
    const along = x * wx + z * wz;
    let f = Math.min(smooth01(d.age / 1.6), smooth01((along + DESPAWN) / FADE_LEN));
    if (d.dying) {
      d.dyingT += dt;
      f = Math.min(f, 1 - smooth01(d.dyingT / 0.8));
    }
    d.fade = f;
    let s = (0.35 + 0.65 * f) * (1 + 0.14 * Math.sin(d.bump * Math.PI)) * d.retScale;
    if (d.flying) {
      // on its way to the hand: tumble
      _qs.setFromAxisAngle(UP, d.spinAngle += dt * 6);
      _qr.setFromEuler(_eul.set(clock * 5 + d.phase, 0, clock * 3.1));
      _qq.copy(_qs).multiply(_qr);
      d.matrix.compose(d.position, _qq, _scl.set(s, s, s));
      return;
    }
    const h = waveH(x, z);
    d.position.y = h + cfg.float + Math.sin(clock * 1.9 + d.phase) * 0.012 - (1 - f) * 0.55;
    waveN(x, z, _n);
    if (cfg.tilt < 1) _n.lerp(UP, 1 - cfg.tilt).normalize();
    _qt.setFromUnitVectors(UP, _n);
    _qs.setFromAxisAngle(UP, d.spinAngle);
    const ra = d.rockAmp;
    _qr.setFromEuler(_eul.set(Math.sin(clock * 1.3 + d.phase) * ra, 0, Math.cos(clock * 1.07 + d.phase * 1.3) * ra));
    _qq.copy(_qt).multiply(_qs).multiply(_qr);
    d.matrix.compose(d.position, _qq, _scl.set(s, s, s));
    // foam ring lying on the surface
    const fr = (cfg.radius * 2.7 + 0.25) * (0.9 + 0.08 * Math.sin(clock * 1.7 + d.phase)) * f;
    _v.set(x, h + 0.045, z);
    d.foamMatrix.compose(_v, _qt, _scl.set(fr, 1, fr));
  }

  function writeInstances() {
    for (let m = 0; m < modelList.length; m++) {
      const model = modelList[m], items = model.items, n = items.length;
      for (let p = 0; p < model.parts.length; p++) {
        const part = model.parts[p];
        part.count = n;
        part.visible = n > 0;
        if (!n) continue;
        const tinted = part.userData.itemTint;
        for (let i = 0; i < n; i++) {
          const d = items[i];
          part.setMatrixAt(i, d.matrix);
          part.setColorAt(i, tinted && d.itemColor ? d.itemColor : d.tint);
        }
        part.instanceMatrix.needsUpdate = true;
        part.instanceColor.needsUpdate = true;
      }
    }
    // foam rings
    let k = 0;
    for (let i = 0; i < list.length && k < FOAM_CAP - 1; i++) {
      const d = list[i];
      if (d.flying || d.fade < 0.03) continue;
      foam.setMatrixAt(k, d.foamMatrix);
      foamPhase.array[k] = d.phase;
      foamGold.array[k] = d.type === 'sud' ? 1 : 0;
      k++;
    }
    if (hook.state === 'water') {
      foam.setMatrixAt(k, hook.foamMatrix);
      foamPhase.array[k] = 1.7;
      foamGold.array[k] = 0;
      k++;
    }
    foam.count = k;
    foam.visible = k > 0;
    if (k) {
      foam.instanceMatrix.needsUpdate = true;
      foamPhase.needsUpdate = true;
      foamGold.needsUpdate = true;
    }
    // bundle badges
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (!d.sprite) continue;
      d.sprite.position.set(d.position.x, d.position.y + 0.72 + Math.sin(clock * 2.2 + d.phase) * 0.05, d.position.z);
      d.sprite.scale.setScalar(0.42 * d.fade * d.retScale);
      d.sprite.visible = d.fade > 0.05;
    }
  }

  // ---------------------------------------------------------------------------
  // Hook tool
  // ---------------------------------------------------------------------------
  function chargePower(t) { return clamp((t - 0.2) / 0.8, 0, 1); }

  function setProgress(v) {
    G.hud.setProgress(v, 'Síla hodu');
    progressShown = true;
  }
  function clearProgress() {
    if (progressShown) { G.hud.setProgress(null); progressShown = false; }
  }

  // Where a throw with `power` would land (out: world point on the water). Also sets hook.dirX/Z.
  function predictLanding(power, out) {
    aimDir(_dir);
    let hx = _dir.x, hz = _dir.z;
    const hl = Math.hypot(hx, hz);
    if (hl < 0.05) { hx = hook.lastDirX; hz = hook.lastDirZ; }
    else { hx /= hl; hz /= hl; hook.lastDirX = hx; hook.lastDirZ = hz; }
    const pitch = Math.asin(clamp(_dir.y, -1, 1));
    const D = clamp(G.lerp(HOOK_MIN_D, HOOK_MAX_D, power) * clamp(1 + pitch * 0.35, 0.7, 1.15), HOOK_MIN_D, HOOK_MAX_D);
    tipWorld(_tip);
    out.set(_tip.x + hx * D, 0, _tip.z + hz * D);
    refreshRaft();
    // it can't land on the deck: carry on along the throw to just past the raft edge
    for (let i = 0; i < 240 && onRaft(out.x, out.z, 0.45); i++) { out.x += hx * 0.25; out.z += hz * 0.25; }
    out.y = waveH(out.x, out.z);
    hook.dirX = hx; hook.dirZ = hz;
    return out;
  }

  function startCharge() {
    hook.state = 'charging';
    hook.chargeT = 0;
  }
  function abortCharge() {
    if (hook.state === 'charging') hook.state = 'idle';
    hook.chargeT = 0;
    clearProgress();
    if (hook.marker) hook.marker.visible = false;
  }

  function throwHook() {
    const power = chargePower(hook.chargeT);
    predictLanding(power, _land);
    tipWorld(hook.from);
    const dx = _land.x - hook.from.x, dz = _land.z - hook.from.z;
    const D = Math.max(1, Math.hypot(dx, dz));
    hook.dirX = dx / D; hook.dirZ = dz / D;
    const T = 0.42 + D * 0.034;
    hook.T = T;
    hook.vh = D / T;
    hook.vy0 = (_land.y - hook.from.y + 0.5 * HOOK_GRAV * T * T) / T;
    hook.t = 0;
    hook.spin = 0;
    hook.yaw = Math.atan2(hook.dirX, hook.dirZ);
    hook.state = 'flying';
    hook.charged = false;
    hook.reeling = false;
    hook.side = 0;
    hook.pos.copy(hook.from);
    hook.object.visible = true;
    hook.object.scale.setScalar(1);
    clearProgress();
    hook.marker.visible = false;
    vm.throwT = 0;
    vm.throwFrom = vm.pivot ? vm.pivot.rotation.x : 0;
    vm.spoolSpeed = -26;
    sfx('hook_throw', hook.from, 0.9);
  }

  function landHook(h) {
    hook.state = 'water';
    hook.pos.y = h;
    hook.landT = 0;
    hook.reelSfxT = 0;
    hook.splashT = 0.3;
    fx('splash', hook.pos, 0.5);
    sfx('hook_land', hook.pos);
    attachNearby();
  }

  function attachNearby() {
    if (hook.attached.length >= HOOK_MAX_ATTACHED) return;
    const r2 = HOOK_ATTACH * HOOK_ATTACH;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (!d.alive || d.attached || d.flying || d.collected || d.fade < 0.5) continue;
      const dx = d.position.x - hook.pos.x, dz = d.position.z - hook.pos.z;
      if (dx * dx + dz * dz > r2) continue;
      d.attached = d.hooked = true;
      d.side = 0;
      // keep a small offset so a cluster of catches trails behind the hook
      const l = Math.hypot(dx, dz), m = Math.min(l, 0.28 + d.cfg.radius * 0.45);
      d.hookOffX = l > 1e-3 ? (dx / l) * m : 0;
      d.hookOffZ = l > 1e-3 ? (dz / l) * m : 0;
      d.bump = 1;
      hook.attached.push(d);
      fx('splash', d.position, 0.22);
      sfx('splash', d.position, 0.3);
      if (hook.attached.length >= HOOK_MAX_ATTACHED) break;
    }
  }

  function startReturn(collectItems) {
    if (hook.state !== 'flying' && hook.state !== 'water') return;
    hook.state = 'returning';
    hook.retT = 0;
    hook.retFrom.copy(hook.pos);
    hook.retCollect = !!collectItems;
    hook.retDur = collectItems ? 0.45 : 0.28;
    hook.retArc = collectItems ? 0.9 : 0.45;
    hook.reeling = false;
    if (!collectItems) releaseAttached();
    else {
      for (const d of hook.attached) {
        d.flying = true;
        d.retFrom = d.retFrom || new THREE.Vector3();
        d.retFrom.copy(d.position);
      }
    }
    if (hook.pos.y < 0.4) fx('splash', hook.pos, collectItems ? 0.4 : 0.3);
    sfx(collectItems ? 'reel' : 'whoosh', hook.pos, 0.8);
    vm.spoolSpeed = 30;
  }

  function releaseItem(d) {
    d.attached = d.hooked = false;
    d.side = 0;
    if (d.flying) {
      d.flying = false;
      d.position.y = 0;
      refreshRaft();
      pushOffRaft(d.position, d.cfg.radius + 0.2);
    }
    d.retScale = 1;
  }
  function releaseAttached() {
    for (const d of hook.attached) releaseItem(d);
    hook.attached.length = 0;
  }

  function selectedIsHook() {
    const s = G.inventory && G.inventory.getSelected ? G.inventory.getSelected() : null;
    const def = s && itemDef(s.id);
    return !!(def && def.tool === 'hook');
  }

  function finishReturn() {
    const items = hook.attached.slice();
    hook.attached.length = 0;
    const collectIt = hook.retCollect;
    hook.state = 'idle';
    hook.object.visible = false;
    hook.rope.visible = false;
    vm.pop = 0;
    if (collectIt) {
      for (const d of items) {
        d.attached = d.hooked = false;
        if (!collect(d, null, 'hook')) {
          // nothing fitted: it falls back into the sea where the hook left the water
          d.position.copy(hook.retFrom);
          releaseItem(d);
        }
      }
    }
    // durability −1 per throw (charged when the hook comes back, while it is still in hand)
    if (!hook.charged) {
      hook.charged = true;
      if (equipped && selectedIsHook() && G.inventory.damageSelected) G.inventory.damageSelected(1);
    }
  }

  // Instantly resets the hook (unequip, reset, leaving play).
  function cancelHook() {
    releaseAttached();
    hook.state = 'idle';
    hook.reeling = false;
    hook.chargeT = 0;
    if (hook.object) hook.object.visible = false;
    if (hook.rope) hook.rope.visible = false;
    if (hook.marker) hook.marker.visible = false;
    clearProgress();
  }

  function updateHook(dt) {
    const st = hook.state;
    if (st === 'idle') return;
    if (st === 'charging') {
      hook.chargeT += dt;
      setProgress(Math.min(1, hook.chargeT));
      predictLanding(chargePower(hook.chargeT), _land);
      const mk = hook.marker;
      mk.visible = true;
      mk.position.set(_land.x, _land.y + 0.07, _land.z);
      // grows with distance so it stays readable far out, and pulses gently
      const md = Math.hypot(_land.x - _tip.x, _land.z - _tip.z);
      mk.scale.setScalar((0.55 + md * 0.075) * (1 + 0.08 * Math.sin(clock * 7)));
      return;
    }
    if (st === 'flying') {
      hook.t += dt;
      const t = hook.t;
      const x = hook.from.x + hook.dirX * hook.vh * t, z = hook.from.z + hook.dirZ * hook.vh * t;
      const y = hook.from.y + hook.vy0 * t - 0.5 * HOOK_GRAV * t * t;
      hook.pos.set(x, y, z);
      hook.spin += dt * 11;
      const h = waveH(x, z);
      if ((t > hook.T * 0.5 && y <= h) || t > hook.T + 1.5) {
        refreshRaft();
        if (onRaft(x, z, 0.3)) {
          for (let i = 0; i < 240 && onRaft(hook.pos.x, hook.pos.z, 0.45); i++) { hook.pos.x += hook.dirX * 0.25; hook.pos.z += hook.dirZ * 0.25; }
        }
        landHook(waveH(hook.pos.x, hook.pos.z));
      }
    } else if (st === 'water') {
      hook.landT += dt;
      hook.reeling = lmb && equipped;
      playerFeet(_feet);
      const dx = _feet.x - hook.pos.x, dz = _feet.z - hook.pos.z;
      const dist = Math.hypot(dx, dz) || 1e-6;
      if (hook.reeling) {
        const step = Math.min(HOOK_REEL * dt, dist);
        const nx = hook.pos.x + (dx / dist) * step, nz = hook.pos.z + (dz / dist) * step;
        if (dist <= HOOK_CATCH || onRaft(nx, nz, 0.25)) { startReturn(true); return; }
        hook.pos.x = nx; hook.pos.z = nz;
        hook.reelSfxT -= dt;
        if (hook.reelSfxT <= 0) { hook.reelSfxT = 0.3; sfx('reel', hook.pos, 0.6); }
        hook.splashT -= dt;
        if (hook.splashT <= 0) { hook.splashT = 0.35; fx('splash', hook.pos, 0.14); }
      } else {
        const dv = driftVel();
        driftStep(hook, hook.pos, 0.2, dv.x * 0.9, dv.z * 0.9, dt);
        if (dist > HOOK_ROPE_MAX) {
          // the rope is taut: the hook trails behind the player
          hook.pos.x = _feet.x - (dx / dist) * HOOK_ROPE_MAX;
          hook.pos.z = _feet.z - (dz / dist) * HOOK_ROPE_MAX;
        }
      }
      const h = waveH(hook.pos.x, hook.pos.z);
      // a little dip right after landing, then it floats
      const dip = hook.landT < 0.6 ? Math.sin((hook.landT / 0.6) * Math.PI) * 0.18 : 0;
      hook.pos.y = h - dip;
      attachNearby();
    } else if (st === 'returning') {
      hook.retT += dt;
      const k = Math.min(1, hook.retT / hook.retDur);
      const e = smooth01(k);
      tipWorld(_tip);
      hook.pos.lerpVectors(hook.retFrom, _tip, e);
      hook.pos.y += Math.sin(Math.PI * k) * hook.retArc;
      hook.spin += dt * 8;
      for (const d of hook.attached) {
        d.position.lerpVectors(d.retFrom, _tip, e);
        d.position.y += Math.sin(Math.PI * k) * (hook.retArc + 0.2);
        d.retScale = 1 - 0.55 * e;
      }
      if (k >= 1) { finishReturn(); return; }
    }
    poseHook();
  }

  function poseHook() {
    const o = hook.object;
    if (!o) return;
    const st = hook.state;
    if (st === 'water') {
      const x = hook.pos.x, z = hook.pos.z;
      waveN(x, z, _n);
      _qt.setFromUnitVectors(UP, _n);
      _qs.setFromAxisAngle(UP, hook.yaw + Math.sin(clock * 0.6) * 0.3);
      _qr.setFromEuler(_eul.set(0.35 + Math.sin(clock * 1.4) * 0.08, 0, Math.cos(clock * 1.1) * 0.08));
      o.quaternion.copy(_qt).multiply(_qs).multiply(_qr);
      o.position.set(x, hook.pos.y - 0.14, z);
      o.scale.setScalar(1);
      const fr = 1.1 + 0.08 * Math.sin(clock * 2);
      _v.set(x, waveH(x, z) + 0.05, z);
      hook.foamMatrix.compose(_v, _qt, _scl.set(fr, 1, fr));
    } else {
      // tumbling through the air around the axis across the throw
      _v.set(-hook.dirZ, 0, hook.dirX);
      o.quaternion.setFromAxisAngle(_v, hook.spin);
      o.position.copy(hook.pos);
      const sc = st === 'returning' ? G.lerp(1, 0.5, smooth01(hook.retT / hook.retDur)) : 1;
      o.scale.setScalar(sc);
    }
  }

  // Rope from the handle tip to the hook eye: a sagging curve that rests on the water / deck.
  function updateRope() {
    const rope = hook.rope;
    if (!rope) return;
    const st = hook.state;
    if (st === 'idle' || st === 'charging' || !G.camera) { rope.visible = false; return; }
    rope.visible = true;
    tipWorld(_ra);
    _rb.copy(hook.pos);
    if (st === 'water') _rb.y += 0.26;
    const dist = _ra.distanceTo(_rb);
    let sag = st === 'flying' ? 0.05 : st === 'returning' ? 0.03 : hook.reeling ? 0.04 : 0.13;
    sag = Math.min(3, sag * dist);
    const deck = raftOn && G.raft.deckY ? G.raft.deckY() : -99;
    const P = hook.ropePts, N = ROPE_SEG;
    for (let i = 0; i <= N; i++) {
      const s = i / N;
      let x = _ra.x + (_rb.x - _ra.x) * s, y = _ra.y + (_rb.y - _ra.y) * s, z = _ra.z + (_rb.z - _ra.z) * s;
      y -= sag * 4 * s * (1 - s);
      let floor = waveH(x, z) + 0.02;
      if (onTile(x, z)) floor = Math.max(floor, deck + 0.02);
      if (y < floor && i > 0) y = floor;
      P[i * 3] = x; P[i * 3 + 1] = y; P[i * 3 + 2] = z;
    }
    G.camera.getWorldPosition(_cam);
    const V = hook.ropePos;
    for (let i = 0; i <= N; i++) {
      const a = Math.max(0, i - 1) * 3, b = Math.min(N, i + 1) * 3, c = i * 3;
      const tx = P[b] - P[a], ty = P[b + 1] - P[a + 1], tz = P[b + 2] - P[a + 2];
      const vx = P[c] - _cam.x, vy = P[c + 1] - _cam.y, vz = P[c + 2] - _cam.z;
      let sx = ty * vz - tz * vy, sy = tz * vx - tx * vz, sz = tx * vy - ty * vx;
      const sl = Math.hypot(sx, sy, sz);
      const wdt = 0.5 * (0.008 + 0.0011 * Math.hypot(vx, vy, vz));
      if (sl > 1e-6) { sx *= wdt / sl; sy *= wdt / sl; sz *= wdt / sl; } else { sx = wdt; sy = 0; sz = 0; }
      V[i * 6] = P[c] - sx; V[i * 6 + 1] = P[c + 1] - sy; V[i * 6 + 2] = P[c + 2] - sz;
      V[i * 6 + 3] = P[c] + sx; V[i * 6 + 4] = P[c + 1] + sy; V[i * 6 + 5] = P[c + 2] + sz;
    }
    rope.geometry.attributes.position.needsUpdate = true;
    const L = 0.3 + 0.7 * lightLevel();
    rope.material.color.setRGB(0.69 * L, 0.53 * L, 0.26 * L);
  }

  function animateVM(dt) {
    const p = vm.pivot;
    if (!p) return;
    vm.t += dt;
    const t = vm.t, st = hook.state;
    let rx = Math.sin(t * 1.3) * 0.015, rz = 0, py = Math.sin(t * 1.8) * 0.004, pz = 0, spoolTarget = 0;
    if (st === 'charging') {
      const k = 1 - Math.pow(1 - Math.min(1, hook.chargeT), 2);
      rx = 0.85 * k;
      py = 0.03 * k;
      pz = 0.07 * k;
      if (hook.chargeT >= 1) { rz += Math.sin(t * 43) * 0.014; rx += Math.sin(t * 37) * 0.012; }
    } else if (st === 'water') {
      rx = -0.12;
      if (hook.reeling) {
        spoolTarget = 16;
        rz = Math.sin(t * 15) * 0.05;
        py = Math.sin(t * 30) * 0.006;
        rx = -0.2 + Math.sin(t * 7.5) * 0.04;
      }
    } else if (st === 'flying') {
      rx = -0.3;
    } else if (st === 'returning') {
      rx = -0.25;
      spoolTarget = 30;
    }
    if (vm.throwT >= 0) {
      vm.throwT += dt;
      const k = vm.throwT / 0.45;
      if (k < 0.3) rx = G.lerp(vm.throwFrom, -0.85, 1 - Math.pow(1 - k / 0.3, 3));
      else rx = G.lerp(-0.85, rx, smooth01((k - 0.3) / 0.7));
      p.rotation.x = rx;
      if (k >= 1) vm.throwT = -1;
    } else {
      p.rotation.x = G.damp(p.rotation.x, rx, st === 'charging' ? 20 : 12, dt);
    }
    p.rotation.z = G.damp(p.rotation.z, rz, 14, dt);
    p.position.y = G.damp(p.position.y, py, 14, dt);
    p.position.z = G.damp(p.position.z, pz, 14, dt);
    vm.spoolSpeed = G.damp(vm.spoolSpeed, spoolTarget, st === 'flying' ? 2.5 : 5, dt);
    vm.spool.rotation.x += vm.spoolSpeed * dt;
    // the hook head: on the handle while in hand, pops back when it returns
    const inHand = st === 'idle' || st === 'charging';
    vm.headHolder.visible = inHand;
    if (vm.pop < 1) vm.pop = Math.min(1, vm.pop + dt / 0.3);
    vm.headHolder.scale.setScalar(Math.max(0.01, easeOutBack(vm.pop)));
    vm.headHolder.rotation.z = Math.sin(t * 2.2) * 0.07 + (st === 'charging' ? Math.sin(t * 9) * 0.05 * Math.min(1, hook.chargeT) : 0);
  }

  let hintKey = '', hintCache = '';
  function hintText() {
    const key = hook.state + (G.input && G.input.touchMode ? ':t' : ':m');
    if (key !== hintKey) { hintKey = key; hintCache = buildHint(); }
    return hintCache;
  }
  function buildHint() {
    const L = btnL(), Rb = btnR();
    switch (hook.state) {
      case 'charging': return 'Pusť ' + L.toLowerCase() + ': hodit hák · ' + Rb + ': zrušit';
      case 'flying': return Rb + ': zrušit';
      case 'water': return 'Drž ' + L.toLowerCase() + ': navíjet · ' + Rb + ': zrušit';
      case 'returning': return '';
      default: return 'Drž ' + L.toLowerCase() + ' a pusť: hodit hák';
    }
  }

  const handler = {
    viewModel: null,
    onEquip() {
      equipped = true;
      lmb = false;
      if (hook.state === 'charging') abortCharge();
      vm.throwT = -1;
      vm.pop = 0.4;
    },
    onUnequip() {
      equipped = false;
      lmb = false;
      cancelHook();
      vm.throwT = -1;
      G.hud.setToolHint('');
    },
    update(dt) {
      equipped = true;
      animateVM(dt);
      G.hud.setToolHint(hintText());
    },
    primaryDown() {
      equipped = true;
      lmb = true;
      if (hook.state === 'idle') startCharge();
    },
    primaryUp() {
      lmb = false;
      hook.reeling = false;
      if (hook.state === 'charging') {
        if (G.uiBlocking && G.uiBlocking()) abortCharge();
        else throwHook();
      }
    },
    secondaryDown() {
      if (hook.state === 'charging') abortCharge();
      else if (hook.state === 'flying' || hook.state === 'water') startReturn(false);
    },
    secondaryUp() {},
    hint() { return hintText(); },
  };
  G.tools.register('hook', handler);

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  G.debris = {
    list,
    types: ['prkno', 'plast', 'list', 'sud'],
    MAX_ALIVE,
    spawn: (type, pos) => spawn(type, pos, false),
    spawnItem: (id, count, pos) => spawnItem(id, count, pos),
    collect: (d, storage, source) => collect(d, storage, source),
    // --- extras ---
    remove: (d) => { if (d) removeItem(d); },
    clear() { for (let i = list.length - 1; i >= 0; i--) removeItem(list[i]); },
    hookState() {
      return { state: hook.state, x: hook.pos.x, y: hook.pos.y, z: hook.pos.z, attached: hook.attached.length,
        charge: hook.chargeT, reeling: hook.reeling };
    },
    handler,
  };

  G.debug.debrisRain = () => {
    refreshRaft();
    const base = raftOn ? Math.max(_bounds.maxX - _bounds.minX, _bounds.maxZ - _bounds.minZ) * 0.5 : 2;
    let n = 0;
    for (let i = 0; i < 20; i++) {
      const a = R(0, TAU), r = base + R(1.5, 11);
      _v.set(raftC.x + Math.cos(a) * r, 0, raftC.z + Math.sin(a) * r);
      const d = spawn(pickType(), _v);
      if (d) { d.age = R(0, 0.6); n++; }
    }
    return n;
  };

  // ---------------------------------------------------------------------------
  // Module
  // ---------------------------------------------------------------------------
  G.register({
    name: 'debris',
    order: 40,

    init() {
      build();
    },

    reset() {
      cancelHook();
      for (let i = list.length - 1; i >= 0; i--) removeItem(list[i]);
      list.length = 0;
      for (const m of modelList) m.items.length = 0;
      bundleCount = 0;
      spawnT = R(1.5, 2.5);
      pendingBurst = true;
      lmb = false;
      vm.throwT = -1;
      vm.pop = 1;
      dirty = true;
      if (foam) writeInstances();
    },

    update(dt) {
      simulate(dt);
      updateHook(dt);
    },

    frame(dt) {
      if (!foam) return;
      if (G.state === 'menu') simulate(dt);           // debris drifts past the menu camera too
      if (G.state !== 'playing' && hook.state !== 'idle') cancelHook();
      if (dirty || hook.state !== 'idle') { writeInstances(); dirty = false; }
      foam.material.uniforms.uTime.value = clock;
      foam.material.uniforms.uLight.value = 0.3 + 0.7 * lightLevel();
      updateRope();
    },
  });
})();
