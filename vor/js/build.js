// build.js — Minecraft-style free building on the raft: 1 m blocks placed on the deck and on each
// other (any height, overhangs allowed near the raft), stairs, floors, windows, doors, roofs,
// fences, lanterns and painted blocks. Wraps the raft's 'hammer' tool: palette entry 0 keeps the
// original foundation/repair/reinforce behaviour, the others place/remove blocks.
//
// Public: G.build = { blocks, types, selected, add(type,x,y,z,rot), remove(b, refund),
//   heightAt(x,z,maxY), blocked(x,z,yLow,yHigh,r), cellFree(x,y,z), blockAt(x,y,z),
//   solidTop(b), solidAt(x,ly,z), pieces, addPiece(type,x0,y0,z0,rot), removePiece(p, refund),
//   pieceInBox(x0,x1,y0,y1,z0,z1), piecesNear(x0,x1,z0,z1,out), fineStep }
// Fine pieces (ROADMAP 2): planks, beams, posts and half blocks on a 25 cm (or 50 cm) grid. They are
// axis-aligned boxes { t, x0..x1, y0..y1, z0..z1, rot } in the same raft-local space as blocks
// (y in metres above the deck top); x/z snap to the grid, y to 12.5 cm.
// Blocks live in raft-local integer cells: x,z are world metres (the raft never moves in XZ),
// y counts metres above the deck top. They are children of G.raft.group so they bob with it.
(function () {
  'use strict';

  const MAX_Y = 16;          // highest cell index
  const REACH = 6.5;         // metres from the eye
  const OVERHANG = 4;        // how far blocks may reach beyond the raft's tiles
  const MAX_BLOCKS = 3000;
  const HALF_PI = Math.PI / 2;

  // shape: cube | slab | stairs | ramp | pane | door | fence | lantern
  // solid(u) returns the solid height (0..h) at the point u (0..1 along the block's local +z).
  const TYPES = [
    { id: 'zaklad', name: 'Základ voru', icon: '🛟', raft: true },
    { id: 'podpalubi', name: 'Podpalubí', icon: '🕳️', hold: true },
    { id: 'blok', name: 'Dřevěný blok', icon: '🟫', shape: 'cube', cost: { prkno: 1 }, tex: 'planks', color: 0xb98a58 },
    { id: 'deska', name: 'Podlaha', icon: '▬', shape: 'slab', cost: { prkno: 1 }, tex: 'planks', color: 0xc49a66 },
    { id: 'prkenko', name: 'Prkénko', icon: '📏', fine: true, size: [1, 0.125, 0.25], cost: { prkno: 1 }, tex: 'planks', color: 0xcfa36c, rot: true },
    { id: 'tram', name: 'Trám', icon: '🪵', fine: true, size: [1, 0.25, 0.25], cost: { prkno: 1 }, tex: 'planks', color: 0x8c6238, rot: true },
    { id: 'sloup', name: 'Sloup', icon: '🏛️', fine: true, size: [0.25, 1, 0.25], cost: { prkno: 1 }, tex: 'planks', color: 0x9a6a3c },
    { id: 'pulblok', name: 'Půlblok', icon: '🧱', fine: true, size: [0.5, 0.5, 0.5], cost: { prkno: 1 }, tex: 'planks', color: 0xb98a58 },
    { id: 'schody', name: 'Schody', icon: '📶', shape: 'stairs', cost: { prkno: 2 }, tex: 'planks', color: 0xa87a4a, rot: true },
    { id: 'okno', name: 'Okno', icon: '🪟', shape: 'pane', cost: { plast: 2 }, tex: 'glass', color: 0xffffff },
    { id: 'dvere', name: 'Dveře', icon: '🚪', shape: 'door', cost: { prkno: 3 }, tex: 'door', color: 0x9a6a3c, rot: true, h: 2 },
    { id: 'strecha', name: 'Střecha', icon: '🔺', shape: 'ramp', cost: { list: 2 }, tex: 'thatch', color: 0xd9b45a, rot: true },
    { id: 'dosky', name: 'Doškový blok', icon: '🟨', shape: 'cube', cost: { list: 2 }, tex: 'thatch', color: 0xd9b45a },
    { id: 'kamen', name: 'Kamenný blok', icon: '🪨', shape: 'cube', cost: { kamen: 1 }, tex: 'stone', color: 0xa9a49a },
    { id: 'plot', name: 'Zábradlí', icon: '🚧', shape: 'fence', cost: { prkno: 1 }, tex: 'planks', color: 0x8c6238 },
    { id: 'lucerna', name: 'Lucerna', icon: '🏮', shape: 'lantern', cost: { kov: 1, plast: 1 }, tex: 'lantern', color: 0xffd27a },
    { id: 'bila', name: 'Bílý blok', icon: '⬜', shape: 'cube', cost: { prkno: 1 }, tex: 'painted', color: 0xf1ede4 },
    { id: 'cervena', name: 'Červený blok', icon: '🟥', shape: 'cube', cost: { prkno: 1 }, tex: 'painted', color: 0xc8453a },
    { id: 'modra', name: 'Modrý blok', icon: '🟦', shape: 'cube', cost: { prkno: 1 }, tex: 'painted', color: 0x3f6fb8 },
    { id: 'zluta', name: 'Žlutý blok', icon: '🟨', shape: 'cube', cost: { prkno: 1 }, tex: 'painted', color: 0xe8bf3a },
    { id: 'zelena', name: 'Zelený blok', icon: '🟩', shape: 'cube', cost: { prkno: 1 }, tex: 'painted', color: 0x4f9a4a },
  ];
  const TYPE = Object.create(null);
  TYPES.forEach((t, i) => { t.index = i; TYPE[t.id] = t; if (t.fine) t.shape = 'piece_' + t.id; });
  const FINE_STEPS = [0.25, 0.5];
  const MAX_PIECES = 3000;
  const EPS = 0.004;

  const B = (G.build = {
    types: TYPES,
    blocks: new Set(),
    selected: 0,
    rotOffset: 0,
    add: null, remove: null, heightAt: null, blocked: null, cellFree: null, blockAt: null, solidTop: null, solidAt: null,
    pieces: new Set(),
    fineStep: 0.25,
    fineRot: 0,
    addPiece: null, removePiece: null, pieceInBox: null, piecesNear: null,
  });

  // cell occupancy "x,y,z" -> block ; columns "x,z" -> Set(block)
  const cells = new Map();
  const cols = new Map();
  const ck = (x, y, z) => x + ',' + y + ',' + z;
  const colk = (x, z) => x + ',' + z;
  // fine pieces by the 1 m columns they overlap: "x,z" -> Set(piece)
  const pcols = new Map();
  const q8 = (v) => Math.round(v * 8) / 8;          // positions are multiples of 12.5 cm

  let root = null;            // group inside the raft group
  let ghost = null, ghostMat = null, outline = null;
  const meshes = Object.create(null);   // type id -> InstancedMesh (non-door types)
  const geos = Object.create(null);
  const mats = Object.create(null);
  let dirty = new Set();
  let hammer = null;          // raft.js's original hammer handler
  let equipped = false;
  let paletteEl = null, paletteItems = [];
  let lastPaletteKey = '';

  const deckBase = () => (G.raft && G.raft.deckY ? G.raft.deckY() : G.C.DECK_Y);
  const localBase = () => G.C.DECK_Y;
  // deck top at a raft point (follows the raft's tilt in storms)
  const deckAt = (x, z) => (G.raft && G.raft.deckYAt ? G.raft.deckYAt(x, z) : deckBase());

  // ---------------------------------------------------------------------------
  // Shapes: solid height at a point (px,pz in cell-local metres 0..1)
  // ---------------------------------------------------------------------------
  function localU(b, px, pz) {
    // block-local +z coordinate of the point, 0..1 (the block is rotated about the cell centre)
    const a = b.rot * HALF_PI;
    return (px - 0.5) * Math.sin(a) + (pz - 0.5) * Math.cos(a) + 0.5;
  }
  function solidHeight(b, px, pz) {
    switch (b.t.shape) {
      case 'cube': case 'pane': case 'fence': return 1;
      case 'slab': return 0.2;
      case 'stairs': case 'ramp': return G.clamp(localU(b, px, pz), 0.08, 1);
      case 'door': return b.open ? 0 : 2;
      default: return 0;
    }
  }
  function walkable(b) { return b.t.shape !== 'lantern' && !(b.t.shape === 'door'); }

  // ---------------------------------------------------------------------------
  // Queries used by player.js (collision) and G.ground (standing)
  // ---------------------------------------------------------------------------
  // Highest standable block surface under (x, z) that is <= maxY (world Y).
  function heightAt(x, z, maxY) {
    if (!B.blocks.size && !B.pieces.size) return null;
    const base = deckAt(x, z);
    const lim = maxY === undefined ? Infinity : maxY;
    let best = null;
    const col = cols.get(colk(Math.floor(x), Math.floor(z)));
    if (col) {
      const px = x - Math.floor(x), pz = z - Math.floor(z);
      for (const b of col) {
        if (!walkable(b)) continue;
        const top = base + b.y + solidHeight(b, px, pz);
        if (top <= lim && (best === null || top > best)) best = top;
      }
    }
    const pc = pcols.get(colk(Math.floor(x), Math.floor(z)));
    if (pc) {
      for (const p of pc) {
        if (x < p.x0 - EPS || x > p.x1 + EPS || z < p.z0 - EPS || z > p.z1 + EPS) continue;
        const top = base + p.y1;
        if (top <= lim && (best === null || top > best)) best = top;
      }
    }
    return best;
  }

  // Does the vertical slab (yLow..yHigh, world Y) around (x, z) with half-size r hit a solid block?
  const OFFS = [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
  function blocked(x, z, yLow, yHigh, r) {
    if (!B.blocks.size && !B.pieces.size) return false;
    const base = deckAt(x, z);
    r = r === undefined ? 0.3 : r;
    for (let k = 0; k < OFFS.length; k++) {
      const sx = x + OFFS[k][0] * r, sz = z + OFFS[k][1] * r;
      const key = colk(Math.floor(sx), Math.floor(sz));
      const col = cols.get(key);
      if (col) {
        const px = sx - Math.floor(sx), pz = sz - Math.floor(sz);
        for (const b of col) {
          const h = solidHeight(b, px, pz);
          if (h <= 0) continue;
          const lo = base + b.y, hi = lo + h;
          if (hi > yLow && lo < yHigh) return true;
        }
      }
      const pc = pcols.get(key);
      if (pc) {
        for (const p of pc) {
          if (sx <= p.x0 || sx >= p.x1 || sz <= p.z0 || sz >= p.z1) continue;
          if (base + p.y1 > yLow && base + p.y0 < yHigh) return true;
        }
      }
    }
    return false;
  }

  function cellFree(x, y, z) { return !cells.has(ck(x, y, z)); }
  function blockAt(x, y, z) { return cells.get(ck(x, y, z)) || null; }
  // Height of the solid part of a block for collision with furniture (sloped shapes count as full).
  function solidTop(b) {
    switch (b.t.shape) {
      case 'slab': return 0.2;
      case 'lantern': return 0.62;
      case 'door': return 2;
      default: return 1;
    }
  }
  // Is the point (x, ly, z) — ly in metres above the deck top — inside a block? Returns the top of
  // that block's solid part at (x, z) (deck-relative), or null.
  function solidAt(x, ly, z) {
    if (B.pieces.size) {
      const pc = pcols.get(colk(Math.floor(x), Math.floor(z)));
      if (pc) {
        for (const p of pc) {
          if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1 && ly >= p.y0 && ly <= p.y1) return p.y1;
        }
      }
    }
    if (!B.blocks.size) return null;
    const b = cells.get(ck(Math.floor(x), Math.floor(ly), Math.floor(z)));
    if (!b) return null;
    const h = b.t.shape === 'door' ? (b.open ? 0 : 2) : b.t.shape === 'lantern' ? 0.62 : solidHeight(b, x - Math.floor(x), z - Math.floor(z));
    const top = b.y + h;
    return ly >= b.y && ly <= top ? top : null;
  }

  // ---------------------------------------------------------------------------
  // Fine pieces
  // ---------------------------------------------------------------------------
  function pieceSize(t, rot) { const z = t.size; return rot & 1 ? [z[2], z[1], z[0]] : [z[0], z[1], z[2]]; }
  function forPieceCols(p, fn) {
    for (let x = Math.floor(p.x0 + EPS); x <= Math.floor(p.x1 - EPS); x++) {
      for (let z = Math.floor(p.z0 + EPS); z <= Math.floor(p.z1 - EPS); z++) fn(colk(x, z));
    }
  }
  function addPiece(typeId, x0, y0, z0, rot) {
    const t = TYPE[typeId];
    if (!t || !t.fine || B.pieces.size >= MAX_PIECES) return null;
    x0 = q8(Number(x0)); y0 = q8(Number(y0)); z0 = q8(Number(z0));
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(z0) || y0 < 0 || y0 > MAX_Y) return null;
    rot = t.rot ? (rot | 0) & 1 : 0;
    const sz = pieceSize(t, rot);
    const p = { t, rot, x0, y0, z0, x1: x0 + sz[0], y1: y0 + sz[1], z1: z0 + sz[2] };
    if (pieceInBox(p.x0, p.x1, p.y0, p.y1, p.z0, p.z1)) return null;
    B.pieces.add(p);
    forPieceCols(p, (k) => { let set = pcols.get(k); if (!set) pcols.set(k, (set = new Set())); set.add(p); });
    dirty.add(t.id);
    return p;
  }
  function removePiece(p, refund) {
    if (!p || !B.pieces.has(p)) return false;
    B.pieces.delete(p);
    forPieceCols(p, (k) => { const set = pcols.get(k); if (set) { set.delete(p); if (!set.size) pcols.delete(k); } });
    dirty.add(p.t.id);
    if (refund && p.t.cost) for (const id in p.t.cost) G.inventory.add(id, p.t.cost[id], 'refund');
    return true;
  }
  // First piece whose box overlaps (x0..x1, y0..y1, z0..z1) by more than a hair, or null.
  function pieceInBox(x0, x1, y0, y1, z0, z1) {
    if (!B.pieces.size) return null;
    for (let x = Math.floor(x0 + EPS); x <= Math.floor(x1 - EPS); x++) {
      for (let z = Math.floor(z0 + EPS); z <= Math.floor(z1 - EPS); z++) {
        const pc = pcols.get(colk(x, z));
        if (!pc) continue;
        for (const p of pc) {
          if (p.x1 > x0 + EPS && p.x0 < x1 - EPS && p.y1 > y0 + EPS && p.y0 < y1 - EPS && p.z1 > z0 + EPS && p.z0 < z1 - EPS) return p;
        }
      }
    }
    return null;
  }
  // All pieces overlapping the columns of the rect (x0..x1, z0..z1) into out (deduplicated).
  function piecesNear(x0, x1, z0, z1, out) {
    out = out || [];
    out.length = 0;
    if (!B.pieces.size) return out;
    for (let x = Math.floor(x0); x <= Math.floor(x1); x++) {
      for (let z = Math.floor(z0); z <= Math.floor(z1); z++) {
        const pc = pcols.get(colk(x, z));
        if (pc) for (const p of pc) if (out.indexOf(p) < 0) out.push(p);
      }
    }
    return out;
  }
  // Does a solid block overlap the box? (for fine pieces; blocks count with their solid height)
  function blockInBox(x0, x1, y0, y1, z0, z1) {
    if (!B.blocks.size) return null;
    for (let x = Math.floor(x0 + EPS); x <= Math.floor(x1 - EPS); x++) {
      for (let z = Math.floor(z0 + EPS); z <= Math.floor(z1 - EPS); z++) {
        for (let y = Math.max(0, Math.floor(y0 + EPS) - 1); y <= Math.floor(y1 - EPS); y++) {
          const b = cells.get(ck(x, y, z));
          if (!b) continue;
          if (b.y + solidTop(b) > y0 + EPS && b.y < y1 - EPS) return b;
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Textures, materials, geometry
  // ---------------------------------------------------------------------------
  function canvasTex(draw, size = 64) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d'), size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  }
  function noise(g, s, n, a) {
    for (let i = 0; i < n; i++) {
      g.fillStyle = 'rgba(0,0,0,' + (Math.random() * a).toFixed(3) + ')';
      g.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 3, 1);
    }
  }
  function makeTextures() {
    const T = {};
    T.planks = canvasTex((g, s) => {
      g.fillStyle = '#fff'; g.fillRect(0, 0, s, s);
      for (let r = 0; r < 4; r++) {
        const y = r * s / 4;
        g.fillStyle = 'rgba(80,50,20,' + (0.05 + Math.random() * 0.1).toFixed(2) + ')';
        g.fillRect(0, y, s, s / 4);
        g.fillStyle = 'rgba(60,35,15,0.55)'; g.fillRect(0, y, s, 1);
        const off = (r % 2) * s / 2 + 10;
        g.fillRect(off % s, y, 1, s / 4);
        g.fillStyle = 'rgba(40,25,10,0.5)';
        g.fillRect((off + 4) % s, y + 3, 2, 2); g.fillRect((off + 4) % s, y + s / 4 - 5, 2, 2);
      }
      noise(g, s, 260, 0.12);
    });
    T.painted = canvasTex((g, s) => {
      g.fillStyle = '#fff'; g.fillRect(0, 0, s, s);
      for (let r = 0; r < 4; r++) {
        const y = r * s / 4;
        g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, y, s, 1);
        g.fillStyle = 'rgba(0,0,0,0.05)'; g.fillRect(0, y + 1, s, 2);
      }
      noise(g, s, 120, 0.07);
      g.strokeStyle = 'rgba(0,0,0,0.2)'; g.strokeRect(0.5, 0.5, s - 1, s - 1);
    });
    T.thatch = canvasTex((g, s) => {
      g.fillStyle = '#fff'; g.fillRect(0, 0, s, s);
      for (let i = 0; i < 220; i++) {
        const x = Math.random() * s, y = Math.random() * s;
        g.strokeStyle = 'rgba(90,60,10,' + (0.15 + Math.random() * 0.3).toFixed(2) + ')';
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + (Math.random() - 0.5) * 4, y + 6 + Math.random() * 8); g.stroke();
      }
      for (let r = 1; r < 4; r++) { g.fillStyle = 'rgba(70,45,10,0.35)'; g.fillRect(0, r * s / 4, s, 2); }
    });
    T.stone = canvasTex((g, s) => {
      g.fillStyle = '#fff'; g.fillRect(0, 0, s, s);
      const rows = 4, h = s / rows;
      for (let r = 0; r < rows; r++) {
        const off = (r % 2) * 12;
        for (let x = -off; x < s; x += 24) {
          g.fillStyle = 'rgba(0,0,0,' + (0.04 + Math.random() * 0.12).toFixed(2) + ')';
          g.fillRect(x + 1, r * h + 1, 22, h - 2);
          g.strokeStyle = 'rgba(40,40,40,0.55)'; g.strokeRect(x + 0.5, r * h + 0.5, 23, h - 1);
        }
      }
      noise(g, s, 200, 0.12);
    });
    T.glass = canvasTex((g, s) => {
      g.clearRect(0, 0, s, s);
      g.fillStyle = 'rgba(170,220,235,0.28)'; g.fillRect(0, 0, s, s);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.beginPath(); g.moveTo(10, s - 12); g.lineTo(26, 12); g.lineTo(32, 12); g.lineTo(16, s - 12); g.fill();
      g.fillStyle = '#7a5530';
      g.fillRect(0, 0, s, 5); g.fillRect(0, s - 5, s, 5); g.fillRect(0, 0, 5, s); g.fillRect(s - 5, 0, 5, s);
      g.fillRect(s / 2 - 2, 0, 4, s); g.fillRect(0, s / 2 - 2, s, 4);
    });
    T.door = canvasTex((g, s) => {
      g.fillStyle = '#fff'; g.fillRect(0, 0, s, s);
      for (let c = 0; c < 4; c++) { g.fillStyle = 'rgba(60,35,15,0.45)'; g.fillRect(c * s / 4, 0, 1, s); }
      g.fillStyle = 'rgba(60,35,15,0.5)'; g.fillRect(0, 10, s, 5); g.fillRect(0, s - 15, s, 5);
      g.fillStyle = '#3a3a3a'; g.fillRect(s - 14, s / 2 - 3, 8, 6);
      noise(g, s, 150, 0.12);
    });
    T.lantern = canvasTex((g, s) => {
      g.fillStyle = '#ffcf6a'; g.fillRect(0, 0, s, s);
      g.fillStyle = '#fff3c4'; g.fillRect(s * 0.3, s * 0.2, s * 0.4, s * 0.6);
      g.fillStyle = '#3b2c1a';
      g.fillRect(0, 0, s, 6); g.fillRect(0, s - 6, s, 6); g.fillRect(0, 0, 6, s); g.fillRect(s - 6, 0, 6, s);
    });
    return T;
  }

  // Merge simple BufferGeometries (position/normal/uv) into one non-indexed geometry.
  function merge(list) {
    const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
    let n = 0;
    for (const g of parts) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    let o = 0;
    for (const g of parts) {
      pos.set(g.attributes.position.array, o * 3);
      nor.set(g.attributes.normal.array, o * 3);
      uv.set(g.attributes.uv.array, o * 2);
      o += g.attributes.position.count;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return out;
  }
  // Box spanning [x0,x1]x[y0,y1]x[z0,z1] in cell space centred at x/z = 0 (cell -0.5..0.5, y 0..h)
  function box(x0, x1, y0, y1, z0, z1) {
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    return g;
  }
  // Wedge rising toward +z: full height at z = +0.5, zero at z = -0.5.
  function wedge() {
    const v = [], nrm = [], uv = [];
    const A = [-0.5, 0, -0.5], Bv = [0.5, 0, -0.5], C = [0.5, 0, 0.5], D = [-0.5, 0, 0.5];
    const E = [-0.5, 1, 0.5], F = [0.5, 1, 0.5];
    const tri = (p, q, r, uvs) => {
      const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
      const vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      [p, q, r].forEach((pt, i) => { v.push(...pt); nrm.push(nx, ny, nz); uv.push(uvs[i * 2], uvs[i * 2 + 1]); });
    };
    const quad = (p, q, r, s) => { tri(p, q, r, [0, 0, 1, 0, 1, 1]); tri(p, r, s, [0, 0, 1, 1, 0, 1]); };
    quad(D, C, Bv, A);          // bottom
    quad(A, Bv, F, E);          // sloped top
    quad(C, D, E, F);           // back
    tri(A, E, D, [0, 0, 1, 1, 1, 0]);   // left side
    tri(Bv, C, F, [0, 0, 1, 0, 1, 1]);  // right side
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    return g;
  }
  function makeGeometries() {
    geos.cube = box(-0.5, 0.5, 0, 1, -0.5, 0.5);
    geos.slab = box(-0.5, 0.5, 0, 0.2, -0.5, 0.5);
    geos.stairs = merge([box(-0.5, 0.5, 0, 0.5, -0.5, 0.5), box(-0.5, 0.5, 0.5, 1, 0, 0.5)]);
    geos.ramp = wedge();
    geos.pane = box(-0.5, 0.5, 0, 1, -0.06, 0.06);
    geos.fence = merge([
      box(-0.5, -0.38, 0, 1, -0.06, 0.06), box(0.38, 0.5, 0, 1, -0.06, 0.06),
      box(-0.5, 0.5, 0.78, 0.9, -0.05, 0.05), box(-0.5, 0.5, 0.4, 0.5, -0.05, 0.05),
    ]);
    geos.lantern = merge([
      box(-0.16, 0.16, 0.05, 0.45, -0.16, 0.16), box(-0.2, 0.2, 0, 0.06, -0.2, 0.2),
      box(-0.2, 0.2, 0.44, 0.5, -0.2, 0.2), box(-0.03, 0.03, 0.5, 0.62, -0.03, 0.03),
    ]);
    // door panel hinged on its left edge (x = -0.5), 2 m tall, thin in z
    geos.door = box(0, 1, 0, 2, -0.06, 0.06);
    // fine pieces: boxes centred on the origin (instances are placed at the piece centre)
    for (const t of TYPES) if (t.fine) geos[t.shape] = new THREE.BoxGeometry(t.size[0], t.size[1], t.size[2]);
  }
  function makeMaterials(T) {
    for (const t of TYPES) {
      if (t.raft) continue;
      const opts = { map: T[t.tex], color: t.color, flatShading: true, roughness: 0.9, metalness: 0 };
      if (t.tex === 'glass') Object.assign(opts, { transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.2 });
      if (t.tex === 'lantern') Object.assign(opts, { emissive: 0xffb347, emissiveIntensity: 1.6, color: 0xffffff });
      mats[t.id] = new THREE.MeshStandardMaterial(opts);
    }
  }

  // ---------------------------------------------------------------------------
  // Instanced rendering (doors are individual meshes so they can swing)
  // ---------------------------------------------------------------------------
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
  const _up = new THREE.Vector3(0, 1, 0);
  function meshFor(t) {
    let m = meshes[t.id];
    if (!m) {
      m = new THREE.InstancedMesh(geos[t.shape], mats[t.id], 256);
      m.count = 0;
      m.castShadow = t.tex !== 'glass';
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.name = 'build-' + t.id;
      root.add(m);
      meshes[t.id] = m;
    }
    return m;
  }
  function rebuildType(id) {
    const t = TYPE[id];
    if (!t || t.shape === 'door') return;
    const list = [];
    if (t.fine) { for (const p of B.pieces) if (p.t === t) list.push(p); }
    else for (const b of B.blocks) if (b.t === t) list.push(b);
    let m = meshFor(t);
    if (list.length > m.instanceMatrix.count) {
      root.remove(m);
      m.dispose();
      const cap = Math.min(MAX_BLOCKS, Math.max(list.length, m.instanceMatrix.count * 2));
      const n = new THREE.InstancedMesh(geos[t.shape], mats[t.id], cap);
      n.castShadow = m.castShadow; n.receiveShadow = true; n.frustumCulled = false; n.name = m.name;
      root.add(n);
      meshes[t.id] = m = n;
    }
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (t.fine) _p.set((b.x0 + b.x1) / 2, localBase() + (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
      else _p.set(b.x + 0.5, localBase() + b.y, b.z + 0.5);
      _q.setFromAxisAngle(_up, b.rot * HALF_PI);
      _m.compose(_p, _q, _s);
      m.setMatrixAt(i, _m);
    }
    m.count = list.length;
    m.instanceMatrix.needsUpdate = true;
  }

  function makeDoor(b) {
    const pivot = new THREE.Group();
    pivot.position.set(b.x + 0.5, localBase() + b.y, b.z + 0.5);
    pivot.rotation.y = b.rot * HALF_PI;
    const hinge = new THREE.Group();
    hinge.position.x = -0.5;
    const mesh = new THREE.Mesh(geos.door, mats[b.t.id]);
    mesh.castShadow = true; mesh.receiveShadow = true;
    hinge.add(mesh);
    pivot.add(hinge);
    root.add(pivot);
    b.obj = pivot; b.hinge = hinge; b.swing = b.open ? 1 : 0;
    hinge.rotation.y = -b.swing * HALF_PI * 0.95;
    const handle = new THREE.Object3D();
    handle.position.set(0.5, 1.05, 0);
    pivot.add(handle);
    b.inter = G.interaction.add({
      object: handle,
      size: 0.7,
      label: () => (b.open ? 'Zavřít dveře' : 'Otevřít dveře'),
      onInteract: () => toggleDoor(b),
    });
  }
  function toggleDoor(b) {
    if (b.open && playerInside(b)) { G.notify('Nejdřív ze dveří vyjdi.', 'warn'); return; }
    b.open = !b.open;
    G.sfx('hammer', { position: b.obj.getWorldPosition(_p), volume: 0.4 });
  }
  function playerInside(b) {
    const P = G.player;
    if (!P || !P.position) return false;
    const base = deckBase(), px = P.position.x, pz = P.position.z, py = P.position.y;
    return px > b.x - 0.3 && px < b.x + 1.3 && pz > b.z - 0.3 && pz < b.z + 1.3 &&
      py < base + b.y + 2 && py + 1.8 > base + b.y;
  }

  // ---------------------------------------------------------------------------
  // Add / remove
  // ---------------------------------------------------------------------------
  function occupiedCells(t, x, y, z) {
    const h = t.h || 1, out = [];
    for (let k = 0; k < h; k++) out.push(ck(x, y + k, z));
    return out;
  }
  function addBlock(typeId, x, y, z, rot, open) {
    const t = TYPE[typeId];
    if (!t || t.raft || B.blocks.size >= MAX_BLOCKS) return null;
    const keys = occupiedCells(t, x, y, z);
    for (const k of keys) if (cells.has(k)) return null;
    const b = { t, x, y, z, rot: (rot || 0) & 3, open: !!open, keys };
    B.blocks.add(b);
    for (const k of keys) cells.set(k, b);
    const c = colk(x, z);
    if (!cols.has(c)) cols.set(c, new Set());
    cols.get(c).add(b);
    if (t.shape === 'door') makeDoor(b); else dirty.add(t.id);
    return b;
  }
  function removeBlock(b, refund) {
    if (!b || !B.blocks.has(b)) return false;
    B.blocks.delete(b);
    for (const k of b.keys) if (cells.get(k) === b) cells.delete(k);
    const c = cols.get(colk(b.x, b.z));
    if (c) { c.delete(b); if (!c.size) cols.delete(colk(b.x, b.z)); }
    if (b.obj) { root.remove(b.obj); b.obj = null; }
    if (b.inter) { G.interaction.remove(b.inter); b.inter = null; }
    if (b.t.shape !== 'door') dirty.add(b.t.id);
    if (refund && b.t.cost) for (const id in b.t.cost) G.inventory.add(id, b.t.cost[id], 'refund');
    return true;
  }
  function clearAll() {
    for (const b of Array.from(B.blocks)) removeBlock(b, false);
    for (const p of Array.from(B.pieces)) removePiece(p, false);
    for (const id in meshes) { meshes[id].count = 0; meshes[id].instanceMatrix.needsUpdate = true; }
    dirty.clear();
  }
  B.add = addBlock;
  B.remove = removeBlock;
  B.heightAt = heightAt;
  B.blocked = blocked;
  B.cellFree = cellFree;
  B.blockAt = blockAt;
  B.solidTop = solidTop;
  B.solidAt = solidAt;
  B.addPiece = addPiece;
  B.removePiece = removePiece;
  B.pieceInBox = pieceInBox;
  B.piecesNear = piecesNear;

  // ---------------------------------------------------------------------------
  // Aiming: voxel ray march from the eye
  // ---------------------------------------------------------------------------
  const _eye = new THREE.Vector3(), _dir = new THREE.Vector3();
  const aim = { hit: null, place: null, px: 0, py: 0, pz: 0, ok: false, reason: '' };

  function tileUnder(x, z) { return G.raft && G.raft.tileAt ? G.raft.tileAt(x + 0.5, z + 0.5) : null; }
  function nearRaft(x, z) {
    for (let dx = -OVERHANG; dx <= OVERHANG; dx += 2) {
      for (let dz = -OVERHANG; dz <= OVERHANG; dz += 2) if (tileUnder(x + dx, z + dz)) return true;
    }
    return false;
  }
  function supported(x, y, z) {
    if (y === 0 && tileUnder(x, z)) return true;
    return cells.has(ck(x - 1, y, z)) || cells.has(ck(x + 1, y, z)) || cells.has(ck(x, y - 1, z)) ||
      cells.has(ck(x, y + 1, z)) || cells.has(ck(x, y, z - 1)) || cells.has(ck(x, y, z + 1));
  }

  function computeAim(t) {
    aim.hit = null; aim.place = null; aim.ok = false; aim.reason = '';
    const P = G.player;
    if (!P || !P.eye) return aim;
    P.eye(_eye); P.forward(_dir);
    const base = deckBase();
    // march in cell space (y relative to the deck)
    let ox = _eye.x, oy = _eye.y - base, oz = _eye.z;
    let cx = Math.floor(ox), cy = Math.floor(oy), cz = Math.floor(oz);
    const sx = Math.sign(_dir.x), sy = Math.sign(_dir.y), sz = Math.sign(_dir.z);
    const tdx = sx ? Math.abs(1 / _dir.x) : Infinity, tdy = sy ? Math.abs(1 / _dir.y) : Infinity, tdz = sz ? Math.abs(1 / _dir.z) : Infinity;
    let tmx = sx ? ((sx > 0 ? cx + 1 - ox : ox - cx) * tdx) : Infinity;
    let tmy = sy ? ((sy > 0 ? cy + 1 - oy : oy - cy) * tdy) : Infinity;
    let tmz = sz ? ((sz > 0 ? cz + 1 - oz : oz - cz) * tdz) : Infinity;
    let nx = 0, ny = 0, nz = 0, tcur = 0;
    for (let i = 0; i < 64 && tcur <= REACH; i++) {
      const b = cells.get(ck(cx, cy, cz));
      if (b) {
        aim.hit = b;
        if (nx || ny || nz) { aim.px = cx + nx; aim.py = cy + ny; aim.pz = cz + nz; aim.place = true; }
        break;
      }
      // deck: stepping from cell y=0 down to y=-1 over a raft tile hits the deck top
      if (ny === 1 && cy === -1 && tileUnder(cx, cz)) {
        aim.px = cx; aim.py = 0; aim.pz = cz; aim.place = true; break;
      }
      if (tmx < tmy && tmx < tmz) { cx += sx; tcur = tmx; tmx += tdx; nx = -sx; ny = 0; nz = 0; }
      else if (tmy < tmz) { cy += sy; tcur = tmy; tmy += tdy; nx = 0; ny = -sy; nz = 0; }
      else { cz += sz; tcur = tmz; tmz += tdz; nx = 0; ny = 0; nz = -sz; }
      if (cy < -1) break;
    }
    if (!aim.place) { aim.reason = 'Namiř na vor nebo na blok.'; return aim; }
    const x = aim.px, y = aim.py, z = aim.pz, h = t.h || 1;
    if (y < 0 || y + h - 1 > MAX_Y) { aim.reason = 'Tak vysoko stavět nejde.'; return aim; }
    for (let k = 0; k < h; k++) if (cells.has(ck(x, y + k, z))) { aim.reason = 'Tady už něco je.'; return aim; }
    if (pieceInBox(x, x + 1, y, y + (t.shape === 'slab' ? 0.2 : h), z, z + 1)) { aim.reason = 'Tady už něco je.'; return aim; }
    if (!supported(x, y, z)) { aim.reason = 'Blok musí stát na voru nebo u jiného bloku.'; return aim; }
    if (!nearRaft(x, z)) { aim.reason = 'Tak daleko od voru stavět nejde.'; return aim; }
    if (G.raft.structureInBox && G.raft.structureInBox(x, x + 1, y, y + (t.shape === 'slab' ? 0.2 : h), z, z + 1)) { aim.reason = 'Tady stojí vybavení voru.'; return aim; }
    if (t.shape !== 'lantern' && overlapsPlayer(x, y, z, h)) { aim.reason = 'Stojíš v cestě.'; return aim; }
    aim.ok = true;
    return aim;
  }
  function overlapsPlayer(x, y, z, h) {
    const P = G.player;
    if (!P || !P.position || P.inWater) return false;
    const base = deckBase(), p = P.position, r = 0.32;
    return p.x + r > x && p.x - r < x + 1 && p.z + r > z && p.z - r < z + 1 &&
      p.y + 1.8 > base + y && p.y < base + y + h;
  }

  // Ray (_eye, _dir) against the box; entry distance and face normal into fine.t / fine.n*.
  const fine = { ok: false, reason: '', hit: null, hitKind: '', x0: 0, y0: 0, z0: 0, rot: 0, t: 0, nx: 0, ny: 0, nz: 0 };
  const _ray = { t: 0, nx: 0, ny: 0, nz: 0 };
  function rayBox(ox, oy, oz, x0, y0, z0, x1, y1, z1) {
    let tmin = -Infinity, tmax = Infinity, nx = 0, ny = 0, nz = 0;
    const d = [_dir.x, _dir.y, _dir.z], o = [ox, oy, oz], lo = [x0, y0, z0], hi = [x1, y1, z1];
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-9) { if (o[a] < lo[a] || o[a] > hi[a]) return false; continue; }
      let t1 = (lo[a] - o[a]) / d[a], t2 = (hi[a] - o[a]) / d[a], s = -1;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
      if (t1 > tmin) { tmin = t1; nx = a === 0 ? s : 0; ny = a === 1 ? s : 0; nz = a === 2 ? s : 0; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax || tmax < 0) return false;
    }
    if (tmin < 0) return false;
    _ray.t = tmin; _ray.nx = nx; _ray.ny = ny; _ray.nz = nz;
    return true;
  }
  // Nearest thing the eye ray hits: a fine piece, a block (its solid part) or the deck.
  function fineRaycast() {
    const base = deckBase();
    const ox = _eye.x, oy = _eye.y - base, oz = _eye.z;
    let best = REACH, kind = '', obj = null, nx = 0, ny = 0, nz = 0;
    for (const p of B.pieces) {
      if (rayBox(ox, oy, oz, p.x0, p.y0, p.z0, p.x1, p.y1, p.z1) && _ray.t < best) {
        best = _ray.t; kind = 'piece'; obj = p; nx = _ray.nx; ny = _ray.ny; nz = _ray.nz;
      }
    }
    // blocks: march the cells, test each block's solid box
    let cx = Math.floor(ox), cy = Math.floor(oy), cz = Math.floor(oz);
    const sx = Math.sign(_dir.x), sy = Math.sign(_dir.y), sz = Math.sign(_dir.z);
    const tdx = sx ? Math.abs(1 / _dir.x) : Infinity, tdy = sy ? Math.abs(1 / _dir.y) : Infinity, tdz = sz ? Math.abs(1 / _dir.z) : Infinity;
    let tmx = sx ? ((sx > 0 ? cx + 1 - ox : ox - cx) * tdx) : Infinity;
    let tmy = sy ? ((sy > 0 ? cy + 1 - oy : oy - cy) * tdy) : Infinity;
    let tmz = sz ? ((sz > 0 ? cz + 1 - oz : oz - cz) * tdz) : Infinity;
    let tcur = 0;
    for (let i = 0; i < 64 && tcur < best; i++) {
      const b = cells.get(ck(cx, cy, cz));
      if (b && rayBox(ox, oy, oz, b.x, b.y, b.z, b.x + 1, b.y + solidTop(b), b.z + 1) && _ray.t < best) {
        best = _ray.t; kind = 'block'; obj = b; nx = _ray.nx; ny = _ray.ny; nz = _ray.nz;
        break;
      }
      if (tmx < tmy && tmx < tmz) { cx += sx; tcur = tmx; tmx += tdx; }
      else if (tmy < tmz) { cy += sy; tcur = tmy; tmy += tdy; }
      else { cz += sz; tcur = tmz; tmz += tdz; }
      if (cy < -1) break;
    }
    // deck top (y = 0) over a raft tile
    if (_dir.y < -1e-4) {
      const td = -oy / _dir.y;
      if (td > 0 && td < best && tileUnder(Math.floor(ox + _dir.x * td), Math.floor(oz + _dir.z * td))) {
        best = td; kind = 'deck'; obj = null; nx = 0; ny = 1; nz = 0;
      }
    }
    fine.hitKind = kind; fine.hit = obj; fine.t = best; fine.nx = nx; fine.ny = ny; fine.nz = nz;
    return kind;
  }
  function computeFineAim(t) {
    fine.ok = false; fine.reason = '';
    const P = G.player;
    if (!P || !P.eye) return fine;
    P.eye(_eye); P.forward(_dir);
    const kind = fineRaycast();
    if (!kind) { fine.reason = 'Namiř na vor, blok nebo díl.'; return fine; }
    const base = deckBase();
    const hx = _eye.x + _dir.x * fine.t, hy = _eye.y - base + _dir.y * fine.t, hz = _eye.z + _dir.z * fine.t;
    const rot = t.rot ? B.fineRot & 1 : 0;
    const sz = pieceSize(t, rot), st = B.fineStep;
    const snap = (v) => q8(Math.round(v / st) * st);
    let x0, y0, z0;
    if (fine.ny > 0) { y0 = hy; x0 = snap(hx - sz[0] / 2); z0 = snap(hz - sz[2] / 2); }
    else if (fine.ny < 0) { y0 = hy - sz[1]; x0 = snap(hx - sz[0] / 2); z0 = snap(hz - sz[2] / 2); }
    else if (fine.nx) { x0 = fine.nx > 0 ? hx : hx - sz[0]; y0 = Math.max(0, hy - sz[1] / 2); z0 = snap(hz - sz[2] / 2); }
    else { z0 = fine.nz > 0 ? hz : hz - sz[2]; y0 = Math.max(0, hy - sz[1] / 2); x0 = snap(hx - sz[0] / 2); }
    x0 = q8(x0); y0 = q8(y0); z0 = q8(z0);
    fine.x0 = x0; fine.y0 = y0; fine.z0 = z0; fine.rot = rot;
    const x1 = x0 + sz[0], y1 = y0 + sz[1], z1 = z0 + sz[2];
    if (y0 < 0) { fine.reason = 'Pod palubu se zatím stavět nedá.'; return fine; }
    if (y1 > MAX_Y + 1) { fine.reason = 'Tak vysoko stavět nejde.'; return fine; }
    if (!nearRaft(Math.floor((x0 + x1) / 2), Math.floor((z0 + z1) / 2))) { fine.reason = 'Tak daleko od voru stavět nejde.'; return fine; }
    if (blockInBox(x0, x1, y0, y1, z0, z1) || pieceInBox(x0, x1, y0, y1, z0, z1)) { fine.reason = 'Tady už něco je.'; return fine; }
    if (G.raft.structureInBox && G.raft.structureInBox(x0, x1, y0, y1, z0, z1)) { fine.reason = 'Tady stojí vybavení voru.'; return fine; }
    if (!fineSupported(x0, x1, y0, y1, z0, z1)) { fine.reason = 'Díl musí stát na voru nebo se dotýkat jiného dílu či bloku.'; return fine; }
    if (overlapsPlayerBox(x0, x1, y0, y1, z0, z1)) { fine.reason = 'Stojíš v cestě.'; return fine; }
    fine.ok = true;
    return fine;
  }
  // Touches the deck, a block or another piece (face contact is enough).
  function fineSupported(x0, x1, y0, y1, z0, z1) {
    const e = 0.02;
    if (y0 < 0.01) {
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      if (tileUnder(Math.floor(mx), Math.floor(mz)) || tileUnder(Math.floor(x0 + e), Math.floor(z0 + e)) ||
        tileUnder(Math.floor(x1 - e), Math.floor(z1 - e)) || tileUnder(Math.floor(x0 + e), Math.floor(z1 - e)) ||
        tileUnder(Math.floor(x1 - e), Math.floor(z0 + e))) return true;
    }
    return !!(blockInBox(x0 - e, x1 + e, y0 - e, y1 + e, z0 - e, z1 + e) || pieceInBox(x0 - e, x1 + e, y0 - e, y1 + e, z0 - e, z1 + e));
  }
  function overlapsPlayerBox(x0, x1, y0, y1, z0, z1) {
    const P = G.player;
    if (!P || !P.position || P.inWater) return false;
    const base = deckBase(), p = P.position, r = 0.32;
    return p.x + r > x0 && p.x - r < x1 && p.z + r > z0 && p.z - r < z1 && p.y + 1.8 > base + y0 && p.y < base + y1;
  }

  function defaultRot() {
    const P = G.player;
    let yaw = P ? P.yaw : 0;
    // camera forward = (-sin yaw, -cos yaw); block local +z should point along it
    const a = Math.atan2(-Math.sin(yaw), -Math.cos(yaw));
    return (((Math.round(a / HALF_PI) % 4) + 4) % 4 + B.rotOffset) & 3;
  }

  // ---------------------------------------------------------------------------
  // Ghost & outline
  // ---------------------------------------------------------------------------
  function makeGhost() {
    ghostMat = new THREE.MeshBasicMaterial({ color: 0x6dff8e, transparent: true, opacity: 0.35, depthWrite: false });
    ghost = new THREE.Mesh(geos.cube, ghostMat);
    ghost.visible = false;
    ghost.renderOrder = 5;
    root.add(ghost);
    const eg = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 1.02));
    eg.translate(0, 0.5, 0);
    outline = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
    outline.visible = false;
    root.add(outline);
  }
  function showGhost(t, a, afford) {
    if (!ghost) return;
    if (a.hit) {
      outline.visible = true;
      const b = a.hit;
      outline.position.set(b.x + 0.5, localBase() + b.y, b.z + 0.5);
      outline.scale.set(1, b.t.h || 1, 1);
    } else outline.visible = false;
    if (a.place && a.ok) {
      ghost.visible = true;
      ghost.geometry = t.shape === 'door' ? geos.pane : geos[t.shape];
      const rot = defaultRot();
      ghost.position.set(aim.px + 0.5, localBase() + aim.py, aim.pz + 0.5);
      ghost.rotation.set(0, rot * HALF_PI, 0);
      ghost.scale.set(1, t.h || 1, 1);
      ghostMat.color.setHex(afford ? 0x6dff8e : 0xff5a4a);
    } else ghost.visible = false;
  }
  function hideGhost() { if (ghost) ghost.visible = false; if (outline) outline.visible = false; }
  function showFineGhost(t, afford) {
    if (!ghost) return;
    const h = fine.hit;
    if (h && (fine.hitKind === 'piece' || fine.hitKind === 'block')) {
      outline.visible = true;
      if (fine.hitKind === 'piece') {
        outline.position.set((h.x0 + h.x1) / 2, localBase() + h.y0, (h.z0 + h.z1) / 2);
        outline.scale.set(h.x1 - h.x0, h.y1 - h.y0, h.z1 - h.z0);
      } else {
        outline.position.set(h.x + 0.5, localBase() + h.y, h.z + 0.5);
        outline.scale.set(1, h.t.h || 1, 1);
      }
    } else outline.visible = false;
    if (!fine.ok) { ghost.visible = false; return; }
    const sz = pieceSize(t, fine.rot);
    ghost.visible = true;
    ghost.geometry = geos[t.shape];
    ghost.position.set(fine.x0 + sz[0] / 2, localBase() + fine.y0 + sz[1] / 2, fine.z0 + sz[2] / 2);
    ghost.rotation.set(0, fine.rot * HALF_PI, 0);
    ghost.scale.set(1, 1, 1);
    ghostMat.color.setHex(afford ? 0x6dff8e : 0xff5a4a);
  }

  // ---------------------------------------------------------------------------
  // Palette strip (shown while the hammer is held)
  // ---------------------------------------------------------------------------
  const CSS = `
  #bp-strip{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(114px + env(safe-area-inset-bottom,0px));
    display:flex;gap:4px;max-width:calc(100vw - 32px);overflow-x:auto;padding:6px;border-radius:12px;
    background:rgba(6,34,43,.78);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
    border:2px double rgba(230,207,159,.35);pointer-events:auto;scrollbar-width:none;z-index:5}
  #bp-strip::-webkit-scrollbar{display:none}
  #bp-strip[hidden]{display:none}
  .bp-it{flex:0 0 auto;width:52px;height:52px;border-radius:9px;border:2px solid transparent;
    background:rgba(13,59,71,.85);color:var(--foam,#e9f1ea);display:grid;place-items:center;position:relative;
    font:600 20px/1 var(--font-body,system-ui);cursor:pointer;padding:0}
  .bp-it small{position:absolute;bottom:2px;left:0;right:0;font-size:9px;font-weight:700;color:var(--sand,#e6cf9f);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 2px}
  .bp-it.sel{border-color:var(--brass,#d9a441);background:rgba(217,164,65,.22)}
  .bp-it.no{opacity:.45}
  #bp-name{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(186px + env(safe-area-inset-bottom,0px));
    font:700 14px/1.2 var(--font-body,system-ui);color:var(--foam,#e9f1ea);text-shadow:0 1px 3px #000;
    pointer-events:none;white-space:nowrap}
  #bp-name[hidden]{display:none}
  @media (max-width:600px){#bp-strip{bottom:calc(150px + env(safe-area-inset-bottom,0px))}
    #bp-name{bottom:calc(212px + env(safe-area-inset-bottom,0px))} .bp-it{width:46px;height:46px}}
  `;
  let nameEl = null;
  function buildPalette() {
    const host = document.getElementById('ui') || document.body;
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    paletteEl = document.createElement('div');
    paletteEl.id = 'bp-strip';
    paletteEl.hidden = true;
    TYPES.forEach((t, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bp-it';
      btn.id = 'bp-' + t.id;
      btn.title = t.name;
      btn.innerHTML = '<span>' + t.icon + '</span><small>' + (t.raft ? 'Vor' : t.hold ? 'Podpal.' : shortName(t.name)) + '</small>';
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); select(i); });
      paletteEl.appendChild(btn);
      paletteItems.push(btn);
    });
    nameEl = document.createElement('div');
    nameEl.id = 'bp-name';
    nameEl.hidden = true;
    host.appendChild(paletteEl);
    host.appendChild(nameEl);
  }
  function costOf(t) { return t.hold ? (G.raft && G.raft.HOLD_COST) || {} : t.cost || {}; }
  function shortName(n) { return n.replace(' blok', '').replace('Dřevěný', 'Dřevo').replace('Kamenný', 'Kámen'); }
  function costText(cost) {
    const parts = [];
    for (const id in cost) parts.push(cost[id] + '× ' + (G.items && G.items.name ? G.items.name(id) : id));
    return parts.join(', ');
  }
  function select(i) {
    const n = TYPES.length;
    const next = ((i % n) + n) % n;
    if (next === B.selected) return;
    if (TYPES[B.selected].raft && hammer) { hammer.hideVisuals && hammer.hideVisuals(); }
    B.selected = next;
    if (!TYPES[next].raft) hideGhost();
    G.sfx('ui_click', { volume: 0.4 });
  }
  function updatePalette(show) {
    if (!paletteEl) return;
    if (paletteEl.hidden === show) { paletteEl.hidden = !show; nameEl.hidden = !show; }
    if (!show) return;
    let key = B.selected + '|';
    const inv = G.inventory;
    for (const t of TYPES) key += t.raft || !inv ? '1' : inv.hasAll(costOf(t)) ? '1' : '0';
    if (key === lastPaletteKey) return;
    lastPaletteKey = key;
    TYPES.forEach((t, i) => {
      const el = paletteItems[i];
      el.classList.toggle('sel', i === B.selected);
      el.classList.toggle('no', !t.raft && inv && !inv.hasAll(costOf(t)));
    });
    const t = TYPES[B.selected];
    const keys = G.input.touchMode ? '' : '  (Z / X přepíná)';
    nameEl.textContent = t.raft ? 'Základ voru – rozšiřování a opravy' + keys
      : t.hold ? 'Podpalubí – suchá místnost pod dílem voru, ' + costText(costOf(t)) + keys
        : t.name + ' – ' + costText(t.cost) + keys;
    const sel = paletteItems[B.selected];
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ---------------------------------------------------------------------------
  // The wrapped hammer tool
  // ---------------------------------------------------------------------------
  const wrap = {
    hintText: '',
    onEquip(slot) {
      equipped = true;
      lastPaletteKey = '';
      if (hammer && hammer.onEquip) hammer.onEquip(slot);
    },
    onUnequip() {
      equipped = false;
      hideGhost();
      updatePalette(false);
      if (hammer && hammer.onUnequip) hammer.onUnequip();
    },
    update(dt, slot) {
      if (G.input.pressed('KeyZ')) select(B.selected - 1);
      if (G.input.pressed('KeyX')) select(B.selected + 1);
      updatePalette(true);
      const t = TYPES[B.selected];
      if (t.raft) {
        hideGhost();
        if (hammer) { hammer.update(dt, slot); wrap.hintText = hammer.hintText || ''; }
        return;
      }
      if (hammer && hammer.hideVisuals && hammer.shown) hammer.hideVisuals();
      if (t.fine) { updateFine(t, dt); return; }
      if (t.hold) { updateHold(dt); return; }
      if (G.input.pressed('KeyR')) B.rotOffset = (B.rotOffset + 1) & 3;
      if (hammer && hammer.cooldown > 0) hammer.cooldown -= dt;
      if (hammer && hammer.animate) hammer.animate(dt);
      const a = computeAim(t);
      const afford = G.inventory.hasAll(t.cost);
      showGhost(t, a, afford);
      const L = G.input.touchMode ? '●' : 'Levé tl.';
      const R = G.input.touchMode ? '◐' : 'Pravé tl.';
      let h;
      if (a.ok) h = afford ? L + ': Postavit ' + t.name.toLowerCase() + ' (' + costText(t.cost) + ')'
        : t.name + ' – chybí materiál (' + costText(t.cost) + ')';
      else h = a.reason;
      if (a.hit) h += ' · ' + R + ': Rozbít';
      if (t.rot && a.ok) h += G.input.touchMode ? ' · ⟳ otočit' : ' · R: otočit';
      wrap.hintText = h;
      G.hud.setToolHint(h);
    },
    swing() { if (hammer) { hammer.swingT = 0; hammer.pending = null; } },
    fineMode() { return !!TYPES[B.selected].fine; },
    primaryDown(slot) {
      const t = TYPES[B.selected];
      if (t.raft) return hammer && hammer.primaryDown(slot);
      if (t.fine) { placeFine(t); return; }
      if (t.hold) { buildHold(); return; }
      if (!aim.ok) { G.sfx('error', { volume: 0.4 }); return; }
      if (!G.inventory.hasAll(t.cost)) { G.sfx('error'); G.notify('Chybí ti: ' + costText(t.cost), 'warn'); return; }
      const b = addBlock(t.id, aim.px, aim.py, aim.pz, defaultRot(), false);
      if (!b) { G.sfx('error'); return; }
      for (const id in t.cost) G.inventory.remove(id, t.cost[id]);
      wrap.swing();
      _p.set(aim.px + 0.5, deckBase() + aim.py + 0.5, aim.pz + 0.5);
      G.sfx('build', { position: _p, volume: 0.7 });
      if (G.fx && G.fx.debris) G.fx.debris(_p, 0xc49a66, 4);
      G.events.emit('build:block', { type: t.id });
    },
    primaryUp(slot) { if (TYPES[B.selected].raft && hammer) hammer.primaryUp(slot); },
    secondaryDown(slot) {
      const t = TYPES[B.selected];
      if (t.fine) { removeFine(); return; }
      if (t.hold) { unbuildHold(); return; }
      if (!t.raft && aim.hit) {
        const b = aim.hit;
        if (b.t.shape === 'door' && playerInside(b) && !b.open) return;
        _p.set(b.x + 0.5, deckBase() + b.y + 0.5, b.z + 0.5);
        removeBlock(b, true);
        wrap.swing();
        G.sfx('break_wood', { position: _p, volume: 0.6 });
        if (G.fx && G.fx.debris) G.fx.debris(_p, 0x9b6b3d, 6);
        return;
      }
      if (hammer) hammer.secondaryDown(slot);
    },
    secondaryUp(slot) { if (hammer) hammer.secondaryUp(slot); },
    hint() { return wrap.hintText; },
  };

  // "Podpalubí": aim at a raft tile from the deck; LMB builds a hold under it, RMB takes it away.
  const holdAim = { tile: null };
  function updateHold(dt) {
    if (hammer && hammer.cooldown > 0) hammer.cooldown -= dt;
    if (hammer && hammer.animate) hammer.animate(dt);
    const P = G.player, R = G.raft;
    holdAim.tile = null;
    if (P && P.eye) {
      P.eye(_eye); P.forward(_dir);
      const base = deckBase();
      if (_dir.y < -1e-4 && _eye.y > base) {
        const t = (base - _eye.y) / _dir.y;
        if (t > 0 && t <= REACH) holdAim.tile = R.tileAt(_eye.x + _dir.x * t, _eye.z + _dir.z * t);
      }
    }
    const tl = holdAim.tile, cost = costOf(TYPES[B.selected]);
    const L = G.input.touchMode ? '●' : 'Levé tl.';
    const Rb = G.input.touchMode ? '◐' : 'Pravé tl.';
    let h;
    if (!tl) h = 'Namiř na díl voru, pod který chceš podpalubí.';
    else if (tl.hold) h = 'Pod tímto dílem už podpalubí je · ' + Rb + ': Zrušit (vrátí materiál)';
    else if (G.inventory.hasAll(cost)) h = L + ': Postavit podpalubí pod tento díl (' + costText(cost) + ')';
    else h = 'Podpalubí – chybí materiál (' + costText(cost) + ')';
    if (ghost) {
      if (tl) {
        const T = G.C.TILE;
        ghost.visible = true;
        ghost.geometry = geos.cube;
        ghost.position.set((tl.i + 0.5) * T, localBase() + 0.01, (tl.j + 0.5) * T);
        ghost.rotation.set(0, 0, 0);
        ghost.scale.set(T, 0.06, T);
        ghostMat.color.setHex(tl.hold ? 0x7fc8ff : G.inventory.hasAll(cost) ? 0x6dff8e : 0xff5a4a);
      } else ghost.visible = false;
    }
    if (outline) outline.visible = false;
    wrap.hintText = h;
    G.hud.setToolHint(h);
  }
  function buildHold() {
    const tl = holdAim.tile, cost = costOf(TYPES[B.selected]);
    if (!tl || tl.hold) { G.sfx('error', { volume: 0.4 }); return; }
    if (!G.inventory.hasAll(cost)) { G.sfx('error'); G.notify('Chybí ti: ' + costText(cost), 'warn'); return; }
    if (G.raft.addHold(tl)) {
      wrap.swing();
      G.notify('Podpalubí je hotové. Vstoupíš do něj poklopem v palubě.', 'good');
    }
  }
  function unbuildHold() {
    const tl = holdAim.tile;
    if (!tl || !tl.hold) return;
    const why = G.raft.removeHold(tl);
    if (why) { G.sfx('error'); G.notify(why, 'warn'); return; }
    wrap.swing();
    G.sfx('break_wood', { volume: 0.6 });
  }

  function updateFine(t, dt) {
    const I = G.input;
    if (I.pressed('KeyR') && t.rot) { B.fineRot = (B.fineRot + 1) & 1; G.sfx('ui_click', { volume: 0.3 }); }
    if (I.pressed('KeyG')) {
      B.fineStep = FINE_STEPS[(FINE_STEPS.indexOf(B.fineStep) + 1) % FINE_STEPS.length];
      G.sfx('ui_click', { volume: 0.3 });
      G.notify('Mřížka pro jemné díly: ' + Math.round(B.fineStep * 100) + ' cm', 'info');
    }
    if (hammer && hammer.cooldown > 0) hammer.cooldown -= dt;
    if (hammer && hammer.animate) hammer.animate(dt);
    computeFineAim(t);
    const afford = G.inventory.hasAll(t.cost);
    showFineGhost(t, afford);
    const L = I.touchMode ? '●' : 'Levé tl.';
    const R = I.touchMode ? '◐' : 'Pravé tl.';
    let h;
    if (fine.ok) h = afford ? L + ': Postavit ' + t.name.toLowerCase() + ' (' + costText(t.cost) + ')'
      : t.name + ' – chybí materiál (' + costText(t.cost) + ')';
    else h = fine.reason;
    if (fine.hitKind === 'piece' || fine.hitKind === 'block') h += ' · ' + R + ': Rozbít';
    if (!I.touchMode) h += (t.rot ? ' · R: otočit' : '') + ' · G: mřížka ' + Math.round(B.fineStep * 100) + ' cm';
    else if (t.rot) h += ' · ⟳ otočit';
    wrap.hintText = h;
    G.hud.setToolHint(h);
  }
  function placeFine(t) {
    if (!fine.ok) { G.sfx('error', { volume: 0.4 }); return; }
    if (!G.inventory.hasAll(t.cost)) { G.sfx('error'); G.notify('Chybí ti: ' + costText(t.cost), 'warn'); return; }
    const p = addPiece(t.id, fine.x0, fine.y0, fine.z0, fine.rot);
    if (!p) { G.sfx('error'); return; }
    for (const id in t.cost) G.inventory.remove(id, t.cost[id]);
    wrap.swing();
    _p.set((p.x0 + p.x1) / 2, deckBase() + (p.y0 + p.y1) / 2, (p.z0 + p.z1) / 2);
    G.sfx('build', { position: _p, volume: 0.6 });
    if (G.fx && G.fx.debris) G.fx.debris(_p, 0xc49a66, 3);
    G.events.emit('build:block', { type: t.id });
  }
  function removeFine() {
    const h = fine.hit;
    if (fine.hitKind === 'piece' && h) {
      _p.set((h.x0 + h.x1) / 2, deckBase() + (h.y0 + h.y1) / 2, (h.z0 + h.z1) / 2);
      removePiece(h, true);
    } else if (fine.hitKind === 'block' && h) {
      if (h.t.shape === 'door' && playerInside(h) && !h.open) return;
      _p.set(h.x + 0.5, deckBase() + h.y + 0.5, h.z + 0.5);
      removeBlock(h, true);
    } else return;
    fine.hit = null; fine.hitKind = '';
    wrap.swing();
    G.sfx('break_wood', { position: _p, volume: 0.5 });
    if (G.fx && G.fx.debris) G.fx.debris(_p, 0x9b6b3d, 4);
  }

  // ---------------------------------------------------------------------------
  // Module
  // ---------------------------------------------------------------------------
  const groundProvider = { kind: 'blocks', heightAt };

  function onTileDestroyed(e) {
    if (!e) return;
    const T = G.C.TILE;
    for (let x = e.i * T; x < (e.i + 1) * T; x++) {
      for (let z = e.j * T; z < (e.j + 1) * T; z++) {
        const col = cols.get(colk(x, z));
        if (!col) continue;
        for (const b of Array.from(col)) {
          if (b.y !== 0) continue;
          _p.set(b.x + 0.5, deckBase() + 0.5, b.z + 0.5);
          if (G.fx && G.fx.debris) G.fx.debris(_p, 0x9b6b3d, 5);
          removeBlock(b, false);
        }
      }
    }
    const x0 = e.i * T, z0 = e.j * T;
    for (const p of Array.from(B.pieces)) {
      if (p.y0 > 0.01) continue;
      const mx = (p.x0 + p.x1) / 2, mz = (p.z0 + p.z1) / 2;
      if (mx >= x0 && mx < x0 + T && mz >= z0 && mz < z0 + T) removePiece(p, false);
    }
  }

  G.register({
    name: 'build',
    order: 22,
    init() {
      root = new THREE.Group();
      root.name = 'build';
      (G.raft && G.raft.group ? G.raft.group : G.scene).add(root);
      makeGeometries();
      makeMaterials(makeTextures());
      makeGhost();
      buildPalette();
      hammer = G.tools.get('hammer');
      // anything the wrapper doesn't define (viewModel, aim, cooldown, …) falls through to the raft hammer
      if (hammer) Object.setPrototypeOf(wrap, hammer);
      G.tools.register('hammer', wrap);
      G.ground.add(groundProvider);
      G.events.on('tile:destroyed', onTileDestroyed);
      G.events.on('ui:blocking', (on) => { if (on) updatePalette(false); });
      G.events.on('game:paused', () => updatePalette(false));
      G.events.on('game:over', () => updatePalette(false));
      G.events.on('game:menu', () => updatePalette(false));
      G.debug.house = () => {
        // a small two-storey demo house on the raft's first tile row
        const T = G.C.TILE;
        const tiles = Array.from(G.raft.tiles.values());
        const minI = Math.min(...tiles.map((t) => t.i)), minJ = Math.min(...tiles.map((t) => t.j));
        const x0 = minI * T, z0 = minJ * T;
        for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) {
          const edge = x === 0 || x === 3 || z === 0 || z === 3;
          if (!edge) continue;
          if (z === 0 && x === 1) { if (y === 0) addBlock('dvere', x0 + x, 0, z0 + z, 0, false); continue; }
          addBlock(y === 1 && (x === 2 || z === 2) ? 'okno' : 'blok', x0 + x, y, z0 + z, 0);
        }
        for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) addBlock('deska', x0 + x, 2, z0 + z, 0);
        for (let x = 0; x < 4; x++) { addBlock('strecha', x0 + x, 3, z0, 0); addBlock('strecha', x0 + x, 3, z0 + 3, 2); addBlock('dosky', x0 + x, 3, z0 + 1); addBlock('dosky', x0 + x, 3, z0 + 2); }
        addBlock('lucerna', x0 + 2, 1, z0 + 2, 0);
      };
    },
    reset() {
      clearAll();
      B.selected = 0;
      B.rotOffset = 0;
      B.fineRot = 0;
      B.fineStep = FINE_STEPS[0];
    },
    save() {
      const out = [];
      for (const b of B.blocks) out.push([b.t.id, b.x, b.y, b.z, b.rot, b.open ? 1 : 0]);
      const fp = [];
      for (const p of B.pieces) fp.push([p.t.id, p.x0, p.y0, p.z0, p.rot]);
      return { blocks: out, pieces: fp, selected: B.selected, fineStep: B.fineStep };
    },
    load(d) {
      if (!d || !Array.isArray(d.blocks)) return;
      for (const e of d.blocks) {
        if (!Array.isArray(e)) continue;
        addBlock(String(e[0]), e[1] | 0, e[2] | 0, e[3] | 0, e[4] | 0, !!e[5]);
      }
      if (Array.isArray(d.pieces)) {
        for (const e of d.pieces) {
          if (!Array.isArray(e) || Math.abs(Number(e[1])) > 80 || Math.abs(Number(e[3])) > 80) continue;
          addPiece(String(e[0]), e[1], e[2], e[3], e[4] | 0);
        }
      }
      if (FINE_STEPS.includes(d.fineStep)) B.fineStep = d.fineStep;
      if (typeof d.selected === 'number' && TYPES[d.selected]) B.selected = d.selected;
    },
    update(dt) {
      if (!equipped) updatePalette(false);
    },
    frame(dt) {
      if (dirty.size) { for (const id of dirty) rebuildType(id); dirty.clear(); }
      // door swing animation
      for (const b of B.blocks) {
        if (!b.hinge) continue;
        const target = b.open ? 1 : 0;
        if (b.swing !== target) {
          b.swing = G.damp(b.swing, target, 10, dt);
          if (Math.abs(b.swing - target) < 0.01) b.swing = target;
          b.hinge.rotation.y = -b.swing * HALF_PI * 0.95;
        }
      }
      if (!G.isPlaying() && paletteEl && !paletteEl.hidden) updatePalette(false);
    },
  });
})();
