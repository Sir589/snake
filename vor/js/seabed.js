// seabed.js — the sea floor for diving (ROADMAP 6): sand dunes ~13 m down, corals, sea grass, rocks,
// shells, little reef fish and now and then a sunken treasure chest to open.
// Everything is ground-fixed: the whole seabed group sits at G.world.groundOffset, so it streams past
// as the raft sails, exactly like the wave pattern. Decorations come from a deterministic hash of
// 16 m ground cells around the camera, so the same place always looks the same.
// API: G.seabed = { heightAt(x, z), chests (visible), openChest(c), opened (Set), group }.
// Registers module 'seabed' (order 27).
(function () {
  'use strict';

  const CELL = 16;               // decoration cell (m, ground coordinates)
  const RANGE = 3;               // cells around the camera cell (7 × 7)
  const FLOOR_SIZE = 150, FLOOR_SEG = 60, FLOOR_SNAP = FLOOR_SIZE / FLOOR_SEG;
  const CHEST_CHANCE = 0.13;
  const TAU = Math.PI * 2;

  const _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _e = new THREE.Euler();
  const _c = new THREE.Color();

  let group = null, floor = null, floorCx = NaN, floorCz = NaN;
  let cellCx = NaN, cellCz = NaN;
  const kinds = {};             // decoration InstancedMeshes
  let fish = null;
  const fishState = [];
  const chestPool = [];          // Group objects for chests
  const opened = new Set();      // "cx,cz" of opened chests

  // ---------------------------------------------------------------------------
  // Terrain: deterministic height in ground coordinates
  // ---------------------------------------------------------------------------
  function groundH(gx, gz) {
    return -13 + 1.6 * Math.sin(gx * 0.07 + 1.3) * Math.cos(gz * 0.05 - 0.7) +
      0.9 * Math.sin(gx * 0.19 + gz * 0.13) + 0.35 * Math.sin(gx * 0.51 - gz * 0.37);
  }
  function go() { return G.world && G.world.groundOffset ? G.world.groundOffset : { x: 0, y: 0 }; }
  // Sea-bed height under a raft-space point.
  function heightAt(x, z) { const o = go(); return groundH(x - o.x, z - o.y); }

  function hash(a, b, k) {
    let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(k | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // ---------------------------------------------------------------------------
  // Meshes
  // ---------------------------------------------------------------------------
  function mat(color, extra) {
    return new THREE.MeshStandardMaterial(Object.assign({ color, flatShading: true, roughness: 0.85, metalness: 0 }, extra || {}));
  }
  function mergeGeos(list) {
    const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
    let n = 0;
    for (const g of parts) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
    let o = 0;
    for (const g of parts) {
      pos.set(g.attributes.position.array, o * 3);
      nor.set(g.attributes.normal.array, o * 3);
      o += g.attributes.position.count;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    return out;
  }
  function branchCoral() {
    const parts = [];
    const add = (r0, r1, h, x, y, z, rx, rz) => {
      const g = new THREE.CylinderGeometry(r1, r0, h, 5);
      g.translate(0, h / 2, 0);
      g.rotateX(rx); g.rotateZ(rz); g.translate(x, y, z);
      parts.push(g);
    };
    add(0.09, 0.06, 0.6, 0, 0, 0, 0, 0);
    add(0.06, 0.03, 0.55, 0, 0.45, 0, 0.5, 0.3);
    add(0.06, 0.03, 0.5, 0, 0.4, 0, -0.4, -0.5);
    add(0.05, 0.025, 0.45, 0, 0.5, 0, 0.1, 0.8);
    add(0.05, 0.02, 0.4, 0, 0.3, 0, -0.7, 0.1);
    return mergeGeos(parts);
  }
  function fanCoral() {
    const g = new THREE.CircleGeometry(0.55, 7, 0, Math.PI);
    g.translate(0, 0.05, 0);
    const back = g.clone().rotateY(Math.PI);
    const stem = new THREE.CylinderGeometry(0.03, 0.04, 0.12, 4).translate(0, 0.06, 0);
    return mergeGeos([g, back, stem]);
  }
  function seaGrass() {
    const parts = [];
    for (let k = 0; k < 5; k++) {
      const h = 0.9 + (k % 3) * 0.45;
      const g = new THREE.BoxGeometry(0.05, h, 0.012);
      g.translate(0, h / 2, 0);
      g.rotateZ((k - 2) * 0.12);
      g.rotateY(k * 1.3);
      g.translate((k - 2) * 0.07, 0, ((k * 7) % 5 - 2) * 0.05);
      parts.push(g);
    }
    return mergeGeos(parts);
  }
  function makeKind(name, geo, material, cap) {
    const m = new THREE.InstancedMesh(geo, material, cap);
    m.name = 'seabed-' + name;
    m.count = 0;
    m.frustumCulled = false;
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    group.add(m);
    kinds[name] = m;
    return m;
  }
  function chestModel() {
    const g = new THREE.Group();
    const wood = mat(0x6b4526), band = mat(0x8a7a3a, { metalness: 0.5, roughness: 0.4 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.45, 0.55), wood);
    body.position.y = 0.225;
    g.add(body);
    for (const x of [-0.3, 0.3]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.47, 0.57), band);
      b.position.set(x, 0.225, 0);
      g.add(b);
    }
    const pivot = new THREE.Group();
    pivot.position.set(0, 0.45, -0.275);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.275, 0.275, 0.9, 8, 1, false, 0, Math.PI), wood);
    lid.rotation.z = Math.PI / 2;
    lid.position.z = 0.275;
    pivot.add(lid);
    g.add(pivot);
    const glow = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 0),
      new THREE.MeshBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0.85 }));
    glow.position.set(0, 0.55, 0);
    g.add(glow);
    g.userData = { pivot, glow };
    return g;
  }

  // ---------------------------------------------------------------------------
  // Floor: a grid that follows the camera in whole grid steps (heights from groundH)
  // ---------------------------------------------------------------------------
  function buildFloor() {
    const geo = new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE, FLOOR_SEG, FLOOR_SEG);
    geo.rotateX(-Math.PI / 2);
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3));
    floor = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }));
    floor.name = 'seabed-floor';
    floor.frustumCulled = false;
    floor.receiveShadow = false;
    group.add(floor);
    floor.userData.base = Float32Array.from(geo.attributes.position.array);
  }
  function updateFloor(gcx, gcz) {
    const sx = Math.round(gcx / FLOOR_SNAP) * FLOOR_SNAP, sz = Math.round(gcz / FLOOR_SNAP) * FLOOR_SNAP;
    if (sx === floorCx && sz === floorCz) return;
    floorCx = sx; floorCz = sz;
    const pos = floor.geometry.attributes.position, col = floor.geometry.attributes.color, base = floor.userData.base;
    for (let i = 0; i < pos.count; i++) {
      const gx = base[i * 3] + sx, gz = base[i * 3 + 2] + sz;
      const h = groundH(gx, gz);
      pos.setXYZ(i, gx, h, gz);
      const t = 0.5 + 0.5 * Math.sin(gx * 0.31 + gz * 0.17) * Math.cos(gz * 0.23 - gx * 0.11);
      _c.setRGB(0.78 + 0.1 * t, 0.7 + 0.08 * t, 0.52 + 0.05 * t).multiplyScalar(0.8 + 0.2 * ((h + 16) / 6));
      col.setXYZ(i, _c.r, _c.g, _c.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    floor.geometry.computeVertexNormals();
  }

  // ---------------------------------------------------------------------------
  // Decorations & chests per cell
  // ---------------------------------------------------------------------------
  const CORAL_COLS = [0xff7a8a, 0xff9f45, 0xc56cf0, 0xffd166, 0x4ecdc4, 0xef476f, 0xf78fb3];
  const visibleChests = [];
  function put(kind, gx, gz, scale, rotY, tilt, color) {
    const m = kinds[kind];
    if (!m || m.count >= m.instanceMatrix.count) return;
    _v.set(gx, groundH(gx, gz) - 0.05, gz);
    _e.set(tilt, rotY, tilt * 0.5);
    _q.setFromEuler(_e);
    _s.set(scale, scale, scale);
    _m.compose(_v, _q, _s);
    m.setMatrixAt(m.count, _m);
    _c.setHex(color);
    m.setColorAt(m.count, _c);
    m.count++;
  }
  function rebuildCells(ccx, ccz) {
    for (const k in kinds) kinds[k].count = 0;
    visibleChests.length = 0;
    let used = 0;
    for (let cx = ccx - RANGE; cx <= ccx + RANGE; cx++) {
      for (let cz = ccz - RANGE; cz <= ccz + RANGE; cz++) {
        const x0 = cx * CELL, z0 = cz * CELL;
        const r = (k) => hash(cx, cz, k);
        // a reef patch: corals clustered around a centre
        const px = x0 + 3 + r(1) * 10, pz = z0 + 3 + r(2) * 10;
        const nCoral = 4 + Math.floor(r(3) * 9);
        for (let k = 0; k < nCoral; k++) {
          const a = r(10 + k) * TAU, d = r(30 + k) * 3.2;
          const x = px + Math.cos(a) * d, z = pz + Math.sin(a) * d;
          const col = CORAL_COLS[Math.floor(r(50 + k) * CORAL_COLS.length)];
          const t = r(70 + k);
          if (t < 0.45) put('branch', x, z, 0.8 + r(90 + k) * 1.1, r(110 + k) * TAU, 0, col);
          else if (t < 0.75) put('brain', x, z, 0.35 + r(90 + k) * 0.45, r(110 + k) * TAU, 0, col);
          else put('fan', x, z, 0.8 + r(90 + k) * 0.9, r(110 + k) * TAU, 0.15, col);
        }
        const nGrass = 3 + Math.floor(r(4) * 8);
        for (let k = 0; k < nGrass; k++) {
          put('grass', x0 + r(130 + k) * CELL, z0 + r(150 + k) * CELL, 0.8 + r(170 + k) * 0.9, r(190 + k) * TAU, 0,
            r(210 + k) < 0.5 ? 0x3f8f4a : 0x6aa84f);
        }
        const nRock = Math.floor(r(5) * 4);
        for (let k = 0; k < nRock; k++) {
          put('rock', x0 + r(230 + k) * CELL, z0 + r(250 + k) * CELL, 0.5 + r(270 + k) * 1.4, r(290 + k) * TAU, r(300 + k) * 0.4, 0x7d7a72);
        }
        const nShell = Math.floor(r(6) * 4);
        for (let k = 0; k < nShell; k++) {
          put('shell', x0 + r(320 + k) * CELL, z0 + r(340 + k) * CELL, 0.8 + r(360 + k) * 0.6, r(380 + k) * TAU, 1.2, r(400 + k) < 0.5 ? 0xf3e1c6 : 0xe8a0a8);
        }
        // sunken treasure
        if (r(7) < CHEST_CHANCE) {
          const key = cx + ',' + cz;
          const gx = px + 2.2 * Math.cos(r(8) * TAU), gz = pz + 2.2 * Math.sin(r(8) * TAU);
          if (used < chestPool.length) {
            const obj = chestPool[used++];
            obj.visible = true;
            obj.position.set(gx, groundH(gx, gz) - 0.05, gz);
            obj.rotation.set(0, r(9) * TAU, 0);
            const isOpen = opened.has(key);
            obj.userData.pivot.rotation.x = isOpen ? -1.9 : 0;
            obj.userData.glow.visible = !isOpen;
            obj.userData.key = key;
            obj.updateMatrixWorld(true);
            visibleChests.push(obj);
          }
        }
      }
    }
    for (let i = used; i < chestPool.length; i++) { chestPool[i].visible = false; chestPool[i].userData.key = null; }
    for (const k in kinds) { kinds[k].instanceMatrix.needsUpdate = true; if (kinds[k].instanceColor) kinds[k].instanceColor.needsUpdate = true; }
  }

  function chestWorld(obj, out) { return obj.getWorldPosition(out); }
  function lootChest(obj) {
    const key = obj.userData.key;
    if (!key || opened.has(key)) return;
    opened.add(key);
    obj.userData.pivot.rotation.x = -1.9;
    obj.userData.glow.visible = false;
    const I = G.inventory;
    const got = [];
    const give = (id, n) => { if (n > 0 && G.items.def(id)) { I.add(id, n, 'loot'); got.push(n + '× ' + G.items.name(id)); } };
    give('zlato', G.randInt(8, 22));
    give('kov', G.randInt(2, 5));
    give(G.pick(['provaz', 'plast', 'kamen', 'koule']), G.randInt(2, 4));
    if (G.chance(0.25)) give('kelimek_sladky', 1);
    G.sfx('coins', { volume: 0.8 });
    if (G.fx && G.fx.sparkle) G.fx.sparkle(chestWorld(obj, _v).add(_s.set(0, 0.6, 0)), 0xffd76a);
    G.notify('Poklad z mořského dna! ' + got.join(', '), 'good');
    G.events.emit('treasure:opened', { key, items: got });
  }

  // ---------------------------------------------------------------------------
  // Reef fish (cosmetic, only drawn while diving)
  // ---------------------------------------------------------------------------
  function buildFish() {
    const body = new THREE.ConeGeometry(0.07, 0.26, 5);
    body.rotateZ(-Math.PI / 2);
    const tail = new THREE.ConeGeometry(0.06, 0.1, 3);
    tail.rotateZ(Math.PI / 2);
    tail.translate(-0.17, 0, 0);
    fish = new THREE.InstancedMesh(mergeGeos([body, tail]), mat(0xffffff, { roughness: 0.5 }), 48);
    fish.name = 'seabed-fish';
    fish.frustumCulled = false;
    fish.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(48 * 3), 3);
    const cols = [0xffc93c, 0x4fc3f7, 0xff6f91, 0x9be15d, 0xffffff, 0xff9a3c];
    for (let i = 0; i < 48; i++) {
      fishState.push({ a: Math.random() * TAU, r: 1.5 + Math.random() * 4, h: 0.6 + Math.random() * 2.5, sp: (0.4 + Math.random() * 0.6) * (Math.random() < 0.5 ? -1 : 1), school: i % 6 });
      _c.setHex(cols[i % cols.length]);
      fish.setColorAt(i, _c);
    }
    fish.visible = false;
    G.scene.add(fish);
  }
  const schoolCentre = [];
  function updateFish(dt, cam) {
    if (!fish) return;
    const show = !!(G.world && G.world.underwater) && G.state === 'playing';
    fish.visible = show;
    if (!show) { schoolCentre.length = 0; return; }
    if (!schoolCentre.length) {
      for (let k = 0; k < 6; k++) {
        const a = Math.random() * TAU, d = 4 + Math.random() * 9;
        const x = cam.x + Math.cos(a) * d, z = cam.z + Math.sin(a) * d;
        schoolCentre.push({ x, z });
      }
    }
    for (let i = 0; i < fishState.length; i++) {
      const f = fishState[i], c = schoolCentre[f.school];
      // keep schools near the diver
      if (Math.hypot(c.x - cam.x, c.z - cam.z) > 16) { const a = Math.random() * TAU; c.x = cam.x + Math.cos(a) * 8; c.z = cam.z + Math.sin(a) * 8; }
      f.a += f.sp * dt;
      const x = c.x + Math.cos(f.a) * f.r, z = c.z + Math.sin(f.a) * f.r;
      const y = heightAt(x, z) + f.h + Math.sin(f.a * 3) * 0.15;
      _v.set(x, y, z);
      _e.set(0, -f.a + (f.sp > 0 ? -Math.PI / 2 : Math.PI / 2), Math.sin(f.a * 9) * 0.15);
      _q.setFromEuler(_e);
      _s.set(1, 1, 1);
      _m.compose(_v, _q, _s);
      fish.setMatrixAt(i, _m);
    }
    fish.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // Module
  // ---------------------------------------------------------------------------
  const S = (G.seabed = {
    heightAt,
    groundH,
    chests: visibleChests,
    opened,
    group: null,
    openChest: lootChest,
    CELL,
  });

  const _cam = new THREE.Vector3();
  G.register({
    name: 'seabed',
    order: 27,
    init() {
      group = new THREE.Group();
      group.name = 'seabed';
      S.group = group;
      G.scene.add(group);
      buildFloor();
      makeKind('branch', branchCoral(), mat(0xffffff), 1400);
      makeKind('brain', new THREE.IcosahedronGeometry(1, 1).scale(1, 0.62, 1), mat(0xffffff, { roughness: 0.95 }), 1000);
      makeKind('fan', fanCoral(), mat(0xffffff, { side: THREE.DoubleSide }), 700);
      makeKind('grass', seaGrass(), mat(0xffffff, { side: THREE.DoubleSide }), 900);
      makeKind('rock', new THREE.DodecahedronGeometry(0.5, 0), mat(0xffffff, { roughness: 1 }), 300);
      makeKind('shell', new THREE.ConeGeometry(0.12, 0.2, 7), mat(0xffffff, { roughness: 0.6 }), 300);
      for (let i = 0; i < 8; i++) {
        const c = chestModel();
        c.visible = false;
        group.add(c);
        chestPool.push(c);
        // one interactable per pooled chest; enabled only while it stands on the sea bed
        G.interaction.add({
          object: c.userData.glow,
          size: 0.8,
          getPosition(out) { return c.getWorldPosition(out).add(_s.set(0, 0.35, 0)); },
          enabled: () => c.visible && !!c.userData.key && !opened.has(c.userData.key) && !!(G.player && G.player.inWater),
          label: () => 'Otevřít truhlu s pokladem',
          onInteract() { lootChest(c); },
        });
      }
      buildFish();
      group.visible = false;
      G.debug.seabedChest = () => {
        // the nearest closed chest (raft space), or null
        let best = null, bd = Infinity;
        const P = G.player && G.player.position;
        for (const c of visibleChests) {
          if (opened.has(c.userData.key)) continue;
          c.getWorldPosition(_v);
          const d = P ? Math.hypot(_v.x - P.x, _v.z - P.z) : 0;
          if (d < bd) { bd = d; best = { x: _v.x, y: _v.y, z: _v.z, key: c.userData.key }; }
        }
        return best;
      };
    },
    reset() {
      opened.clear();
      cellCx = cellCz = NaN;
      floorCx = floorCz = NaN;
    },
    save() { return { opened: Array.from(opened).slice(-400) }; },
    load(d) {
      if (d && Array.isArray(d.opened)) for (const k of d.opened) if (typeof k === 'string' && k.length < 24) opened.add(k);
      cellCx = cellCz = NaN;
    },
    frame(dt) {
      if (!group) return;
      const o = go();
      group.position.set(o.x, 0, o.y);
      G.camera.getWorldPosition(_cam);
      // only drawn when the camera is under the surface (the deep sea hides it from above)
      const show = !!(G.world && G.world.underwater) && G.state !== 'menu';
      group.visible = show;
      // keep the cells / floor around the camera up to date even when hidden (chests stay interactable)
      const gcx = _cam.x - o.x, gcz = _cam.z - o.y;
      const ccx = Math.floor(gcx / CELL), ccz = Math.floor(gcz / CELL);
      if (ccx !== cellCx || ccz !== cellCz) { cellCx = ccx; cellCz = ccz; rebuildCells(ccx, ccz); }
      if (show) updateFloor(gcx, gcz);
      for (const c of visibleChests) {
        if (!opened.has(c.userData.key)) c.userData.glow.rotation.y += dt * 1.5;
      }
      updateFish(dt, _cam);
    },
  });
})();
