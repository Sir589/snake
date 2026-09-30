// animals.js — animals on the raft (ROADMAP 8): cow, goat, sheep, pig and chicken give milk, wool,
// truffles and eggs when fed; a parrot flies around the raft, can be named and talks.
// Wild animals live on some islands (deterministic per island seed); a rope (or a banana for the
// parrot) catches them into the inventory, the 'animal' tool lets them loose on the deck.
// API: G.animals = { list (raft animals), wild(isl), spawn(kind, x, z), populate(isl), rename(a, name),
//   say(a, text), KINDS }. Registers module 'animals' (order 52).
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const KINDS = {
    krava: { name: 'Kráva', acc: 'krávu', pro: 'ji', g: 'f', catch: [{ provaz: 3 }], food: ['list'], product: 'mleko', take: 'Podojit krávu', time: [100, 150], speed: 0.45, ready: '🥛', h: 1.35 },
    koza: { name: 'Koza', acc: 'kozu', pro: 'ji', g: 'f', catch: [{ provaz: 2 }], food: ['list'], product: 'mleko', take: 'Podojit kozu', time: [80, 120], speed: 0.6, ready: '🥛', h: 1 },
    ovce: { name: 'Ovce', acc: 'ovci', pro: 'ji', g: 'f', catch: [{ provaz: 2 }], food: ['list'], product: 'vlna', take: 'Ostříhat ovci', time: [90, 140], speed: 0.5, ready: '🧶', count: [1, 2], h: 1 },
    prase: { name: 'Prase', acc: 'prase', pro: 'ho', g: 'n', catch: [{ provaz: 2 }], food: ['kokos', 'banan', 'list'], product: 'lanyz', take: 'Vzít lanýž, co prase vyhrabalo', time: [110, 170], speed: 0.55, ready: '🍄', h: 0.85 },
    slepice: { name: 'Slepice', acc: 'slepici', pro: 'ji', g: 'f', catch: [{ provaz: 1 }], food: ['list'], product: 'vejce', take: 'Sebrat vejce', time: [60, 100], speed: 0.7, ready: '🥚', count: [1, 2], h: 0.6 },
    papousek: { name: 'Papoušek', acc: 'papouška', pro: 'ho', g: 'm', catch: [{ banan: 1 }, { kokos: 1 }], food: ['banan', 'kokos'], product: null, speed: 2.4, flies: true, h: 0.5 },
  };
  const HUNGER_TIME = 300;          // s from full to hungry
  const PARROT_LINES = ['Krrr! Ahoj, námořníku!', 'Vor je náš domov!', 'Krrr, moře je velké!', 'Kde je ostrov?', 'Chci banán!', 'Krrr! Hezký den!'];

  const list = [];                   // animals on the raft
  const wildByIsland = new Map();    // island -> [wild animals]
  const caught = Object.create(null); // island seed -> bitmask of caught wild animals
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _eye = new THREE.Vector3(), _dir = new THREE.Vector3();
  let clock = 0;
  let dialog = null;

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------
  const matCache = new Map(), geoCache = new Map();
  function mat(c) {
    let m = matCache.get(c);
    if (!m) { m = new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.9 }); matCache.set(c, m); }
    return m;
  }
  function boxGeo(w, h, d) {
    const k = w + ',' + h + ',' + d;
    let g = geoCache.get(k);
    if (!g) { g = new THREE.BoxGeometry(w, h, d); geoCache.set(k, g); }
    return g;
  }
  function box(parent, w, h, d, x, y, z, c, rx, ry, rz) {
    const m = new THREE.Mesh(boxGeo(w, h, d), mat(c));
    m.position.set(x, y, z);
    m.rotation.set(rx || 0, ry || 0, rz || 0);
    m.castShadow = true;
    parent.add(m);
    return m;
  }
  // leg pivoted at its top so it can swing
  function leg(parent, w, h, x, y, z, c, foot) {
    const p = new THREE.Group();
    p.position.set(x, y, z);
    box(p, w, h, w, 0, -h / 2, 0, c);
    if (foot) box(p, w * 1.05, 0.06, w * 1.05, 0, -h + 0.03, 0, foot);
    parent.add(p);
    return p;
  }
  function blob(parent, sx, sy, sz, x, y, z, c) {
    let g = geoCache.get('ico');
    if (!g) { g = new THREE.IcosahedronGeometry(1, 1); geoCache.set('ico', g); }
    const m = new THREE.Mesh(g, mat(c));
    m.scale.set(sx, sy, sz); m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  }
  function buildModel(kind) {
    const g = new THREE.Group(), body = new THREE.Group();
    g.add(body);
    const legs = [];
    let head = null, wings = null;
    if (kind === 'krava') {
      box(body, 0.78, 0.68, 1.38, 0, 0.98, 0, 0xf4f1ea);
      box(body, 0.8, 0.3, 0.42, 0, 1.08, 0.2, 0x2b2622);
      box(body, 0.8, 0.26, 0.34, 0, 0.9, -0.38, 0x2b2622);
      box(body, 0.3, 0.12, 0.28, 0, 0.6, -0.28, 0xf2a7b0);          // udder
      box(body, 0.06, 0.55, 0.06, 0, 0.9, -0.72, 0x2b2622, 0.25);   // tail
      head = new THREE.Group(); head.position.set(0, 1.22, 0.78); body.add(head);
      box(head, 0.44, 0.44, 0.5, 0, 0, 0.1, 0xf4f1ea);
      box(head, 0.4, 0.22, 0.16, 0, -0.12, 0.38, 0xf2a7b0);
      box(head, 0.36, 0.1, 0.1, 0, 0.3, 0.02, 0xd9c7a0);
      for (const s of [-1, 1]) { box(head, 0.06, 0.18, 0.06, s * 0.2, 0.36, 0.02, 0xe8dcc0, 0, 0, s * 0.4); box(head, 0.2, 0.08, 0.1, s * 0.3, 0.12, -0.02, 0x2b2622); }
      for (const [x, z] of [[-0.26, 0.5], [0.26, 0.5], [-0.26, -0.5], [0.26, -0.5]]) legs.push(leg(body, 0.16, 0.64, x, 0.66, z, 0xf4f1ea, 0x3a302a));
    } else if (kind === 'koza') {
      box(body, 0.44, 0.44, 0.84, 0, 0.72, 0, 0xb89a74);
      box(body, 0.05, 0.22, 0.05, 0, 0.9, -0.45, 0xb89a74, -0.6);
      head = new THREE.Group(); head.position.set(0, 0.95, 0.48); body.add(head);
      box(head, 0.28, 0.3, 0.36, 0, 0, 0.06, 0xc9ae88);
      box(head, 0.12, 0.16, 0.06, 0, -0.2, 0.18, 0xf2efe6);        // beard
      for (const s of [-1, 1]) { box(head, 0.05, 0.26, 0.05, s * 0.09, 0.22, -0.06, 0x6b5a44, -0.6); box(head, 0.14, 0.05, 0.08, s * 0.18, 0.06, -0.02, 0xb89a74); }
      for (const [x, z] of [[-0.14, 0.3], [0.14, 0.3], [-0.14, -0.3], [0.14, -0.3]]) legs.push(leg(body, 0.09, 0.5, x, 0.52, z, 0xb89a74, 0x3a302a));
    } else if (kind === 'ovce') {
      blob(body, 0.42, 0.36, 0.55, 0, 0.72, 0, 0xf6f3ea);
      blob(body, 0.3, 0.26, 0.3, 0, 0.9, 0.18, 0xfaf8f1);
      head = new THREE.Group(); head.position.set(0, 0.84, 0.5); body.add(head);
      box(head, 0.24, 0.28, 0.32, 0, 0, 0.04, 0x3b3530);
      blob(head, 0.16, 0.1, 0.14, 0, 0.16, -0.04, 0xf6f3ea);
      for (const s of [-1, 1]) box(head, 0.14, 0.05, 0.08, s * 0.16, 0.06, -0.04, 0x3b3530);
      for (const [x, z] of [[-0.16, 0.26], [0.16, 0.26], [-0.16, -0.26], [0.16, -0.26]]) legs.push(leg(body, 0.08, 0.42, x, 0.44, z, 0x3b3530));
    } else if (kind === 'prase') {
      box(body, 0.54, 0.48, 0.92, 0, 0.55, 0, 0xf2aeb3);
      head = new THREE.Group(); head.position.set(0, 0.62, 0.58); body.add(head);
      box(head, 0.4, 0.38, 0.32, 0, 0, 0, 0xf2aeb3);
      box(head, 0.2, 0.15, 0.08, 0, -0.04, 0.2, 0xe08a93);
      for (const s of [-1, 1]) { box(head, 0.12, 0.12, 0.04, s * 0.14, 0.22, 0.04, 0xe8969e, 0.5); box(head, 0.04, 0.04, 0.02, s * 0.05, -0.04, 0.245, 0x7a3b40); }
      box(body, 0.04, 0.04, 0.16, 0, 0.66, -0.5, 0xe8969e, 0.8);
      for (const [x, z] of [[-0.17, 0.3], [0.17, 0.3], [-0.17, -0.3], [0.17, -0.3]]) legs.push(leg(body, 0.12, 0.32, x, 0.33, z, 0xf2aeb3, 0x7a4a45));
    } else if (kind === 'slepice') {
      box(body, 0.24, 0.24, 0.32, 0, 0.3, 0, 0xfaf7ef);
      box(body, 0.2, 0.18, 0.12, 0, 0.36, -0.2, 0xfaf7ef, 0.6);
      head = new THREE.Group(); head.position.set(0, 0.5, 0.14); body.add(head);
      box(head, 0.14, 0.16, 0.14, 0, 0, 0, 0xfaf7ef);
      box(head, 0.04, 0.08, 0.1, 0, 0.11, 0, 0xd83a2e);
      box(head, 0.05, 0.04, 0.07, 0, -0.01, 0.1, 0xf2b53a);
      box(head, 0.04, 0.06, 0.03, 0, -0.08, 0.07, 0xd83a2e);
      for (const x of [-0.06, 0.06]) legs.push(leg(body, 0.03, 0.2, x, 0.2, 0, 0xf2b53a));
    } else if (kind === 'papousek') {
      box(body, 0.14, 0.24, 0.14, 0, 0.2, 0, 0xe23b2e);
      box(body, 0.05, 0.26, 0.03, 0, 0.06, -0.1, 0x2f6fd0, -0.5);
      head = new THREE.Group(); head.position.set(0, 0.37, 0.03); body.add(head);
      box(head, 0.13, 0.13, 0.14, 0, 0, 0, 0xe23b2e);
      box(head, 0.06, 0.08, 0.06, 0, -0.03, 0.09, 0xf5d24a, 0.3);
      for (const s of [-1, 1]) box(head, 0.02, 0.03, 0.03, s * 0.066, 0.02, 0.03, 0x111111);
      wings = [];
      for (const s of [-1, 1]) {
        const w = new THREE.Group(); w.position.set(s * 0.075, 0.28, 0); body.add(w);
        box(w, 0.03, 0.2, 0.18, s * 0.02, -0.08, 0, 0x2f6fd0);
        box(w, 0.031, 0.08, 0.16, s * 0.021, -0.02, 0.01, 0xf5d24a);
        wings.push(w);
      }
      for (const x of [-0.04, 0.04]) legs.push(leg(body, 0.02, 0.08, x, 0.08, 0.01, 0x6b6b6b));
    }
    return { g, body, legs, head, wings };
  }

  // ---------------------------------------------------------------------------
  // Sprites: emoji icons and speech bubbles
  // ---------------------------------------------------------------------------
  const texCache = new Map();
  function canvasTex(c) { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; }
  function emojiTex(e) {
    const k = 'e:' + e;
    if (texCache.has(k)) return texCache.get(k);
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d');
    x.fillStyle = 'rgba(6,34,43,0.78)';
    x.beginPath(); x.arc(64, 64, 58, 0, TAU); x.fill();
    x.strokeStyle = '#d9a441'; x.lineWidth = 6; x.stroke();
    x.font = '72px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(e, 64, 70);
    const t = canvasTex(c);
    texCache.set(k, t);
    return t;
  }
  function textTex(text, bubble) {
    const k = (bubble ? 'b:' : 't:') + text;
    if (texCache.has(k)) return texCache.get(k);
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const x = c.getContext('2d');
    x.font = 'bold 40px "Alegreya Sans", "Segoe UI", sans-serif';
    const tw = Math.min(470, x.measureText(text).width), w = tw + 40, h = bubble ? 70 : 56, px = (512 - w) / 2, py = bubble ? 8 : 36;
    const rr = (x0, y0, ww, hh, r) => { x.beginPath(); x.moveTo(x0 + r, y0); x.arcTo(x0 + ww, y0, x0 + ww, y0 + hh, r); x.arcTo(x0 + ww, y0 + hh, x0, y0 + hh, r); x.arcTo(x0, y0 + hh, x0, y0, r); x.arcTo(x0, y0, x0 + ww, y0, r); x.closePath(); };
    x.fillStyle = bubble ? '#fbf6ea' : 'rgba(6,34,43,0.72)';
    rr(px, py, w, h, 24); x.fill();
    if (bubble) {
      x.beginPath(); x.moveTo(256 - 12, py + h - 2); x.lineTo(256, py + h + 22); x.lineTo(256 + 14, py + h - 2); x.closePath(); x.fill();
      x.strokeStyle = '#3a2a1c'; x.lineWidth = 4; rr(px, py, w, h, 24); x.stroke();
      x.fillStyle = '#fbf6ea'; x.fillRect(256 - 10, py + h - 4, 22, 6);
    }
    x.fillStyle = bubble ? '#2a1c12' : '#e6cf9f';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, 256, py + h / 2 + 2, 470);
    const t = canvasTex(c);
    texCache.set(k, t);
    return t;
  }
  function sprite(tex, w, h, y) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    s.scale.set(w, h, 1);
    s.position.y = y;
    s.renderOrder = 6;
    return s;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function def(kind) { return KINDS[kind]; }
  function content(g) { return g === 'm' ? 'spokojený' : g === 'n' ? 'spokojené' : 'spokojená'; }
  function hungry(g) { return g === 'm' ? 'hladový' : g === 'n' ? 'hladové' : 'hladová'; }
  function needs(n) { return G.items.needsText ? G.items.needsText(n) : Object.keys(n).map((k) => n[k] + '× ' + G.items.name(k)).join(', '); }
  function foodIn(K) { for (const id of K.food) if (G.inventory.count(id) > 0) return id; return null; }
  function catchCost(K) { for (const c of K.catch) if (G.inventory.hasAll(c)) return c; return null; }
  function worldOf(a, out) { return a.obj.getWorldPosition(out); }

  // ---------------------------------------------------------------------------
  // Raft animals
  // ---------------------------------------------------------------------------
  function spawn(kind, x, z, st) {
    const K = def(kind);
    if (!K || !G.raft) return null;
    const m = buildModel(kind);
    const a = {
      kind, K, obj: m.g, body: m.body, legs: m.legs, head: m.head, wings: m.wings,
      x, z, y: 0, yaw: Math.random() * TAU, tx: x, tz: z, ty: 0, wait: 1 + Math.random() * 2, walk: 0,
      fed: 1, prog: 0, T: K.time ? G.rand(K.time[0], K.time[1]) : 0, ready: false,
      name: K.flies ? 'Papoušek' : K.name, fly: 0, fromX: x, fromZ: z, fromY: 0, flyT: 0, flyDur: 1,
      icon: null, iconKey: '', bubble: null, bubbleT: 0, sayT: G.rand(20, 40), label: null,
    };
    if (st) Object.assign(a, st);
    a.obj.name = 'animal-' + kind;
    G.raft.group.add(a.obj);
    a.icon = sprite(emojiTex('🌿'), 0.42, 0.42, K.h + 0.35);
    a.icon.visible = false;
    a.obj.add(a.icon);
    if (K.flies) {
      a.bubble = sprite(textTex('Krrr!', true), 1.9, 0.48, K.h + 0.55);
      a.bubble.visible = false;
      a.obj.add(a.bubble);
      a.label = sprite(textTex(a.name, false), 1.2, 0.3, K.h + 0.18);
      a.obj.add(a.label);
    }
    a.it = G.interaction.add({
      getPosition: (out) => worldOf(a, out).add(_v2.set(0, K.h * 0.6, 0)),
      size: K.flies ? 0.4 : 0.7,
      label: () => labelOf(a),
      passive: () => passiveOf(a),
      onInteract: () => useAnimal(a),
    });
    // off it goes to have a look around
    if (!st && !K.flies) { const p = {}; if (pickDeckPoint(p)) { a.tx = p.x; a.tz = p.z; a.wait = 0.4; } }
    placeObj(a);
    list.push(a);
    return a;
  }
  function removeAnimal(a) {
    const i = list.indexOf(a);
    if (i >= 0) list.splice(i, 1);
    if (a.it) { G.interaction.remove(a.it); a.it = null; }
    if (a.obj && a.obj.parent) a.obj.parent.remove(a.obj);
  }
  function labelOf(a) {
    const K = a.K;
    if (K.flies) return 'Papoušek ' + a.name + ' – přejmenovat';
    if (a.ready) return K.take;
    if (a.fed < 0.35) {
      const f = foodIn(K);
      return f ? 'Nakrmit ' + K.acc + ' (1× ' + G.items.name(f) + ')' : K.name + ' je ' + hungry(K.g) + ' – potřebuje ' + K.food.map((id) => G.items.name(id).toLowerCase()).join(' nebo ');
    }
    return K.name + ' je ' + content(K.g);
  }
  function passiveOf(a) {
    if (a.K.flies || a.ready) return false;
    return !(a.fed < 0.35 && foodIn(a.K));
  }
  function useAnimal(a) {
    const K = a.K;
    if (K.flies) { openNameDialog(a); return; }
    if (a.ready) {
      const n = K.count ? G.randInt(K.count[0], K.count[1]) : 1;
      const left = G.inventory.add(K.product, n, 'animal');
      if (left >= n) return;
      a.ready = false; a.prog = 0; a.T = G.rand(K.time[0], K.time[1]);
      a.fed = Math.max(0, a.fed - 0.45);
      G.sfx('pickup', { position: worldOf(a, _v) });
      G.events.emit('animal:product', { kind: a.kind, id: K.product, count: n - left });
      return;
    }
    if (a.fed < 0.35) {
      const f = foodIn(K);
      if (!f) { G.notify(K.name + ' má hlad. Potřebuje ' + K.food.map((id) => G.items.name(id).toLowerCase()).join(' nebo ') + '.', 'warn'); return; }
      G.inventory.remove(f, 1);
      a.fed = 1;
      G.sfx('eat', { position: worldOf(a, _v), volume: 0.6 });
      if (G.fx && G.fx.sparkle) G.fx.sparkle(_v.add(_v2.set(0, K.h, 0)), 0x9bd35a);
      G.events.emit('animal:fed', { kind: a.kind, food: f });
    }
  }
  // A deck point on a tile, free of blocks and equipment.
  function pickDeckPoint(out) {
    const R = G.raft, T = G.C.TILE;
    for (let k = 0; k < 14; k++) {
      const t = R.randomTile();
      if (!t) break;
      const x = (t.i + 0.5) * T + G.rand(-0.75, 0.75), z = (t.j + 0.5) * T + G.rand(-0.75, 0.75);
      if (freeAt(x, z)) { out.x = x; out.z = z; return true; }
    }
    return false;
  }
  function freeAt(x, z) {
    const R = G.raft, B = G.build, d = R.deckY();
    if (!R.tileAt(x, z)) return false;
    if (B && B.blocked && B.blocked(x, z, d + 0.1, d + 1.2, 0.25)) return false;
    if (R.structureAt && R.structureAt(x, z)) return false;
    return true;
  }
  // Perches for the parrot: equipment tops and the deck.
  function pickPerch(a) {
    const R = G.raft;
    const opts = [];
    for (const s of R.structures) {
      const f = R.footprint ? R.footprint(s.type) : null;
      if (!f || s.y < -0.5) continue;
      opts.push({ x: s.x, z: s.z, y: s.y + Math.min(f.h, s.type === 'mast' ? R.NEST_Y + 0.9 : f.h) });
    }
    if (opts.length && Math.random() < 0.65) return G.pick(opts);
    const p = {};
    if (pickDeckPoint(p)) return { x: p.x, z: p.z, y: 0 };
    return { x: a.x, z: a.z, y: 0 };
  }
  function placeObj(a) {
    a.obj.position.set(a.x, G.C.DECK_Y + a.y, a.z);
    a.obj.rotation.y = a.yaw;
  }
  function updateRaftAnimal(a, dt) {
    const K = a.K;
    // needs & products
    a.fed = Math.max(0, a.fed - dt / HUNGER_TIME);
    if (K.product && !a.ready && a.fed > 0.2) { a.prog += dt; if (a.prog >= a.T) a.ready = true; }
    // the tile under it sank: hop onto the nearest one
    if (a.y < 0.5 && !G.raft.tileAt(a.x, a.z)) {
      const p = {};
      if (pickDeckPoint(p)) { a.x = a.tx = p.x; a.z = a.tz = p.z; a.y = 0; }
    }
    if (K.flies) updateParrot(a, dt);
    else updateWalker(a, dt);
    // icon: product ready or hungry
    const key = a.ready ? K.ready : !K.flies && a.fed < 0.35 ? '🌿' : '';
    if (key !== a.iconKey) {
      a.iconKey = key;
      a.icon.visible = !!key;
      if (key) { a.icon.material.map = emojiTex(key); a.icon.material.needsUpdate = true; }
    }
    if (a.icon.visible) a.icon.position.y = K.h + 0.35 + Math.sin(clock * 3) * 0.04;
    if (a.bubble) {
      if (a.bubbleT > 0) { a.bubbleT -= dt; if (a.bubbleT <= 0) a.bubble.visible = false; }
      a.sayT -= dt;
      if (a.sayT <= 0) { a.sayT = G.rand(35, 70); say(a, Math.random() < 0.25 ? a.name + ' chce banán!' : G.pick(PARROT_LINES)); }
    }
  }
  function updateWalker(a, dt) {
    const K = a.K;
    let moving = false;
    if (a.wait > 0) a.wait -= dt;
    else {
      const dx = a.tx - a.x, dz = a.tz - a.z, d = Math.hypot(dx, dz);
      if (d < 0.08) {
        a.wait = G.rand(2, 7);
        const p = {};
        if (pickDeckPoint(p)) { a.tx = p.x; a.tz = p.z; }
      } else {
        const step = Math.min(d, K.speed * dt);
        const nx = a.x + dx / d * step, nz = a.z + dz / d * step;
        if (freeAt(nx, nz)) {
          a.x = nx; a.z = nz; moving = true;
          const want = Math.atan2(dx, dz);
          a.yaw += Math.atan2(Math.sin(want - a.yaw), Math.cos(want - a.yaw)) * Math.min(1, dt * 6);
        } else { a.tx = a.x; a.tz = a.z; }
      }
    }
    a.walk = moving ? a.walk + dt * K.speed * 9 : a.walk * Math.exp(-dt * 6);
    const sw = moving ? Math.sin(a.walk) * 0.55 : 0;
    for (let k = 0; k < a.legs.length; k++) a.legs[k].rotation.x = (k === 0 || k === 3 ? sw : -sw);
    a.body.position.y = moving ? Math.abs(Math.sin(a.walk)) * 0.03 : 0;
    if (a.head) a.head.rotation.x = moving ? 0 : Math.sin(clock * 0.8 + a.x) * 0.12 + 0.1;
    placeObj(a);
  }
  function updateParrot(a, dt) {
    if (a.fly > 0) {
      a.flyT += dt;
      const t = Math.min(1, a.flyT / a.flyDur);
      const e = t * t * (3 - 2 * t);
      a.x = a.fromX + (a.tx - a.fromX) * e;
      a.z = a.fromZ + (a.tz - a.fromZ) * e;
      a.y = a.fromY + (a.ty - a.fromY) * e + Math.sin(Math.PI * t) * 1.4;
      a.yaw = Math.atan2(a.tx - a.fromX, a.tz - a.fromZ);
      const f = Math.sin(clock * 28) * 0.9;
      if (a.wings) { a.wings[0].rotation.z = f; a.wings[1].rotation.z = -f; }
      if (t >= 1) { a.fly = 0; a.wait = G.rand(6, 16); }
    } else {
      if (a.wings) { a.wings[0].rotation.z = 0.05; a.wings[1].rotation.z = -0.05; }
      if (a.head) a.head.rotation.y = Math.sin(clock * 0.9 + a.z) * 0.6;
      a.wait -= dt;
      if (a.wait <= 0) {
        const p = pickPerch(a);
        a.fromX = a.x; a.fromZ = a.z; a.fromY = a.y;
        a.tx = p.x; a.tz = p.z; a.ty = p.y;
        a.flyDur = Math.max(0.8, Math.hypot(p.x - a.x, p.z - a.z, p.y - a.y) / a.K.speed);
        a.flyT = 0; a.fly = 1;
      }
    }
    placeObj(a);
    if (a.label) a.label.visible = !!(G.player && G.player.position && worldOf(a, _v).distanceTo(G.player.position) < 9);
  }
  function say(a, text) {
    if (!a || !a.bubble) return;
    a.bubble.material.map = textTex(String(text).slice(0, 40), true);
    a.bubble.material.needsUpdate = true;
    a.bubble.visible = true;
    a.bubbleT = 3.6;
    G.sfx('gull', { position: worldOf(a, _v), volume: 0.35 });
    G.events.emit('parrot:said', { text });
  }
  function parrots() { return list.filter((a) => a.K.flies); }
  function sayAll(text) { for (const p of parrots()) say(p, text); }

  // ---------------------------------------------------------------------------
  // Naming dialog
  // ---------------------------------------------------------------------------
  function rename(a, name) {
    const n = String(name || '').replace(/[<>]/g, '').trim().slice(0, 16);
    if (!n) return false;
    a.name = n;
    if (a.label) { a.label.material.map = textTex(n, false); a.label.material.needsUpdate = true; }
    return true;
  }
  function openNameDialog(a) {
    if (dialog) return;
    const host = document.getElementById('ui-root') || document.getElementById('ui') || document.body;
    const el = document.createElement('div');
    el.className = 'animal-name';
    el.style.cssText = 'position:fixed;left:50%;top:40%;transform:translate(-50%,-50%);z-index:30;pointer-events:auto;' +
      'background:rgba(6,34,43,.94);border:2px double rgba(230,207,159,.6);border-radius:14px;padding:18px 20px;min-width:280px;' +
      'max-width:calc(100vw - 32px);color:#e9f1ea;font-family:var(--font-body,system-ui);text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.5)';
    el.innerHTML = '<div style="font-family:var(--font-display,serif);font-size:26px;color:#e6cf9f;margin-bottom:10px">Jak se bude papoušek jmenovat?</div>' +
      '<input type="text" maxlength="16" autocomplete="off" spellcheck="false" style="width:100%;box-sizing:border-box;font:600 20px var(--font-body,system-ui);' +
      'padding:8px 10px;border-radius:8px;border:2px solid #d9a441;background:#041419;color:#e9f1ea;outline:none">' +
      '<div style="display:flex;gap:10px;justify-content:center;margin-top:12px">' +
      '<button type="button" class="btn btn-primary" data-k="ok">Uložit</button><button type="button" class="btn" data-k="no">Zrušit</button></div>';
    host.appendChild(el);
    const input = el.querySelector('input');
    input.value = a.name === 'Papoušek' ? '' : a.name;
    input.placeholder = 'např. Kája';
    const close = (save) => {
      if (!dialog) return;
      if (save && rename(a, input.value)) {
        say(a, 'Krrr! Jsem ' + a.name + '!');
        G.notify('Papoušek se teď jmenuje ' + a.name + '.', 'good');
        G.events.emit('parrot:named', { name: a.name });
      }
      el.remove();
      dialog = null;
      G.setUIBlock('animal-name', false);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
    });
    el.querySelector('[data-k="ok"]').addEventListener('click', () => close(true));
    el.querySelector('[data-k="no"]').addEventListener('click', () => close(false));
    dialog = { el, close, a };
    G.setUIBlock('animal-name', true);
    try { input.focus(); } catch (e) { /* ignore */ }
    setTimeout(() => { try { input.focus(); } catch (e) { /* ignore */ } }, 30);
  }

  // ---------------------------------------------------------------------------
  // Wild animals on islands
  // ---------------------------------------------------------------------------
  function mulberry(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function populate(isl, force) {
    if (!isl || wildByIsland.has(isl)) return wildByIsland.get(isl) || [];
    const rnd = mulberry((Number(isl.seed) || 1) * 13 + 5);
    const theme = isl.theme || 'tropical';
    const pool = theme === 'pines' ? ['koza', 'ovce', 'koza'] : theme === 'jungle' ? ['prase', 'slepice', 'papousek'] :
      theme === 'bananas' ? ['slepice', 'prase', 'papousek'] : ['slepice', 'koza', 'prase', 'ovce'];
    if (isl.size === 'large') pool.push('krava', 'krava');
    const kinds = [];
    if (force || rnd() < 0.55) {
      const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) kinds.push(pool[Math.floor(rnd() * pool.length)]);
    }
    if ((theme === 'jungle' || theme === 'bananas') && rnd() < 0.5 && !kinds.includes('papousek')) kinds.push('papousek');
    const out = [];
    const mask = caught[isl.seed] || 0;
    kinds.forEach((kind, idx) => {
      const a0 = rnd() * TAU, rr = (isl.hillRadius || 10) * (0.3 + rnd() * 0.5);
      if (mask & (1 << idx)) return;
      const lx = Math.cos(a0) * rr, lz = Math.sin(a0) * rr;
      const m = buildModel(kind);
      const w = { kind, K: def(kind), isl, idx, obj: m.g, body: m.body, legs: m.legs, head: m.head, wings: m.wings,
        hx: lx, hz: lz, x: lx, z: lz, tx: lx, tz: lz, yaw: rnd() * TAU, wait: rnd() * 4, walk: 0, it: null };
      w.obj.name = 'wild-' + kind;
      isl.group.add(w.obj);
      w.it = G.interaction.add({
        getPosition: (o) => w.obj.getWorldPosition(o).add(_v2.set(0, w.K.h * 0.6, 0)),
        size: w.K.flies ? 0.4 : 0.7,
        range: 3.2,
        enabled: () => !!w.obj.parent && isl.alive !== false,
        label: () => 'Chytit ' + w.K.acc + ' (' + w.K.catch.map(needs).join(' nebo ') + ')',
        onInteract: () => catchWild(w),
      });
      placeWild(w);
      out.push(w);
    });
    wildByIsland.set(isl, out);
    return out;
  }
  function islandY(isl, lx, lz) {
    const h = isl.provider && isl.provider.heightAt ? isl.provider.heightAt(isl.position.x + lx, isl.position.z + lz) : null;
    return h === null ? null : h - isl.position.y;
  }
  function placeWild(w) {
    const y = islandY(w.isl, w.x, w.z);
    w.obj.position.set(w.x, (y === null ? 0 : y) + (w.K.flies ? 2.4 : 0), w.z);
    w.obj.rotation.y = w.yaw;
  }
  function updateWild(w, dt) {
    if (w.K.flies) {
      w.x = w.hx + Math.cos(clock * 0.5 + w.idx) * 2.2; w.z = w.hz + Math.sin(clock * 0.5 + w.idx) * 2.2;
      w.yaw = clock * 0.5 + w.idx + Math.PI;
      const f = Math.sin(clock * 26) * 0.9;
      if (w.wings) { w.wings[0].rotation.z = f; w.wings[1].rotation.z = -f; }
      placeWild(w);
      return;
    }
    let moving = false;
    if (w.wait > 0) w.wait -= dt;
    else {
      const dx = w.tx - w.x, dz = w.tz - w.z, d = Math.hypot(dx, dz);
      if (d < 0.1) { w.wait = G.rand(2, 6); const a = Math.random() * TAU, r = Math.random() * 3; w.tx = w.hx + Math.cos(a) * r; w.tz = w.hz + Math.sin(a) * r; }
      else {
        const step = Math.min(d, w.K.speed * dt), nx = w.x + dx / d * step, nz = w.z + dz / d * step;
        const y = islandY(w.isl, nx, nz);
        if (y !== null && y > 0.4) { w.x = nx; w.z = nz; moving = true; w.yaw = Math.atan2(dx, dz); }
        else w.wait = 1;
      }
    }
    w.walk = moving ? w.walk + dt * w.K.speed * 9 : 0;
    const sw = moving ? Math.sin(w.walk) * 0.55 : 0;
    for (let k = 0; k < w.legs.length; k++) w.legs[k].rotation.x = (k === 0 || k === 3 ? sw : -sw);
    placeWild(w);
  }
  function catchWild(w) {
    const cost = catchCost(w.K);
    if (!cost) { G.notify('Na chycení potřebuješ ' + w.K.catch.map(needs).join(' nebo ') + '.', 'warn'); G.sfx('error'); return; }
    if (G.inventory.add(w.kind, 1, 'animal') > 0) return;
    G.inventory.removeAll ? G.inventory.removeAll(cost) : Object.keys(cost).forEach((k) => G.inventory.remove(k, cost[k]));
    caught[w.isl.seed] = (caught[w.isl.seed] || 0) | (1 << w.idx);
    removeWild(w);
    G.sfx('pickup');
    G.notify('Máš ' + w.K.acc + '! Vyber ' + w.K.pro + ' v liště a pusť ' + w.K.pro + ' na vor.', 'good');
    G.events.emit('animal:caught', { kind: w.kind });
  }
  function removeWild(w) {
    if (w.it) { G.interaction.remove(w.it); w.it = null; }
    if (w.obj.parent) w.obj.parent.remove(w.obj);
    const arr = wildByIsland.get(w.isl);
    if (arr) { const i = arr.indexOf(w); if (i >= 0) arr.splice(i, 1); }
  }
  function dropIsland(isl) {
    const arr = wildByIsland.get(isl);
    if (arr) for (const w of arr.slice()) removeWild(w);
    wildByIsland.delete(isl);
  }

  // ---------------------------------------------------------------------------
  // The 'animal' tool: let the held animal loose on the deck
  // ---------------------------------------------------------------------------
  const tool = {
    hintText: '', ok: false, x: 0, z: 0,
    onEquip() {}, onUnequip() { G.hud.setToolHint(''); },
    update(dt, slot) {
      const K = slot && def(slot.id);
      tool.ok = false;
      if (!K) return;
      const P = G.player;
      P.eye(_eye); P.forward(_dir);
      const d = G.raft.deckY();
      let h;
      if (_dir.y < -1e-3) {
        const t = (d - _eye.y) / _dir.y;
        if (t > 0 && t < 6) { tool.x = _eye.x + _dir.x * t; tool.z = _eye.z + _dir.z * t; tool.ok = freeAt(tool.x, tool.z); }
      }
      const L = G.input.touchMode ? '●' : 'Levé tlačítko';
      h = tool.ok ? L + ': Pustit ' + K.acc + ' na vor' : 'Namiř na volné místo na palubě.';
      tool.hintText = h;
      G.hud.setToolHint(h);
    },
    primaryDown(slot) {
      if (!tool.ok || !slot || !def(slot.id)) { G.sfx('error', { volume: 0.4 }); return; }
      const kind = slot.id;
      if (!G.inventory.consumeSelected(1)) return;
      const a = spawn(kind, tool.x, tool.z);
      if (!a) { G.inventory.add(kind, 1, 'refund'); return; }
      G.sfx('place', { position: worldOf(a, _v) });
      const K = a.K;
      G.notify(K.flies ? 'Papoušek je na voru! Zmáčkni u něj E a dej mu jméno.'
        : K.name + ' je na voru. Nakrm ' + K.pro + ' (' + K.food.map((id) => G.items.name(id).toLowerCase()).join(' nebo ') + ') a dá ti ' + G.items.name(K.product).toLowerCase() + '.', 'good');
      G.events.emit('animal:released', { kind });
    },
    primaryUp() {}, secondaryDown() {}, secondaryUp() {},
    hint() { return tool.hintText; },
  };

  // ---------------------------------------------------------------------------
  // Module
  // ---------------------------------------------------------------------------
  const A = (G.animals = {
    list, KINDS, caught,
    wild: (isl) => wildByIsland.get(isl) || [],
    spawn: (kind, x, z) => spawn(kind, x, z),
    populate: (isl, force) => populate(isl, force),
    rename, say,
    remove: removeAnimal,
  });

  function clearAll() {
    for (const a of list.slice()) removeAnimal(a);
    for (const isl of Array.from(wildByIsland.keys())) dropIsland(isl);
    for (const k in caught) delete caught[k];
    if (dialog) dialog.close(false);
  }

  G.register({
    name: 'animals',
    order: 52,
    init() {
      G.tools.register('animal', tool);
      G.events.on('shark:attack', () => sayAll('Krrr! Žralok! Žralok!'));
      G.events.on('pirates:sighted', () => sayAll('Piráti! Piráti! Krrr!'));
      G.events.on('island:near', () => sayAll('Země na obzoru!'));
      G.events.on('world:storm', (e) => { if (e && e.active) sayAll('Bouřka! Krrr!'); });
      G.events.on('world:day', () => sayAll('Dobré ráno! Krrr!'));
      G.debug.animal = (kind) => { const p = {}; if (!pickDeckPoint(p)) { p.x = 0.5; p.z = 0.5; } return spawn(kind || 'slepice', p.x, p.z); };
    },
    reset() { clearAll(); },
    save() {
      return {
        raft: list.map((a) => [a.kind, Math.round(a.x * 100) / 100, Math.round(a.z * 100) / 100, Math.round(a.fed * 100) / 100,
          Math.round(a.prog), Math.round(a.T), a.ready ? 1 : 0, a.K.flies ? a.name : '']),
        caught: Object.assign({}, caught),
      };
    },
    load(d) {
      if (!d) return;
      if (d.caught && typeof d.caught === 'object') for (const k in d.caught) caught[k] = Number(d.caught[k]) | 0;
      if (Array.isArray(d.raft)) {
        for (const e of d.raft) {
          if (!Array.isArray(e) || !def(e[0])) continue;
          const x = Number(e[1]), z = Number(e[2]);
          if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
          const a = spawn(e[0], x, z, { fed: G.clamp(Number(e[3]) || 0, 0, 1), prog: Number(e[4]) || 0, ready: !!e[6] });
          if (a && Number(e[5]) > 0) a.T = Number(e[5]);
          if (a && e[7]) rename(a, e[7]);
        }
      }
    },
    update(dt) {
      for (let k = list.length - 1; k >= 0; k--) updateRaftAnimal(list[k], dt);
      // islands: meet their animals when they come near, forget them when they are gone
      const I = G.islands;
      if (I && I.list) {
        for (const isl of I.list) {
          if (isl.decor || !isl.alive) continue;
          if (!wildByIsland.has(isl) && Math.hypot(isl.position.x, isl.position.z) - (isl.radius || 20) < 120) populate(isl);
        }
        for (const isl of Array.from(wildByIsland.keys())) if (!I.list.includes(isl) || isl.alive === false) dropIsland(isl);
        const P = G.player && G.player.position;
        for (const [isl, arr] of wildByIsland) {
          if (P && Math.hypot(isl.position.x - P.x, isl.position.z - P.z) > (isl.radius || 20) + 90) continue;
          for (const w of arr) updateWild(w, dt);
        }
      }
    },
    frame(dt) { clock += dt; },
  });
})();
