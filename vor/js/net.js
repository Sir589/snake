// net.js — co-op, phase 1 (ROADMAP 10). One player hosts, friends join as guests:
//   * LAN: the desktop app of the host runs a small hub (desktop/net-hub.js, port 47810); everybody,
//     the host page too, talks to it over a WebSocket. Guests type the host's IP (browser works too).
//   * Steam: the host opens a friends-only lobby and invites friends via the Steam overlay; the same
//     messages travel as Steam P2P packets (desktop/steam.js).
// The host owns the world: the raft (tiles, blocks, pieces, equipment, holds), time and weather,
// islands and floating debris. Guests see all of it, walk / swim / build on the same raft (their
// building actions are sent to the host as "ops") and pick up debris; everyone sees everyone.
// Not shared yet (phase 2): sharks and pirates for guests, chests / grills / purifiers / nets / beds
// and animals on the host's raft, player inventories (each player keeps their own).
// API: G.net = { role 'off'|'host'|'guest', guest, host, via 'lan'|'steam', peers (Map), hostLan(),
//   hostSteam(), hostAt(addr) (host through an already running hub — tests), joinLan(ip),
//   joinSteam(lobby), leave(), op(o), openPanel() }.  Registers module 'net' (order 3).
(function () {
  'use strict';

  const PORT = 47810;
  const STATE_EVERY = 0.1, WORLD_EVERY = 0.5, RAFT_MIN_GAP = 0.4, HP_EVERY = 0.5;
  const COLORS = [0xd9a441, 0x4fc3f7, 0xef6f6c, 0x9be15d, 0xc56cf0, 0xffd166, 0x5ec2a8, 0xf78fb3];
  const bridge = window.siremoreDesktop || null;
  const netBridge = bridge && bridge.net ? bridge.net : null;

  const N = (G.net = {
    role: 'off', guest: false, host: false, via: '', me: '', hostId: '', lobby: '', lanIps: [],
    peers: new Map(),            // id -> { name, color, av, st, seen }
    applying: 0,
    hostLan, hostSteam, hostAt, joinLan, joinSteam, leave, op, openPanel,
    playerCount: () => (N.role === 'off' ? 1 : N.peers.size + 1),
  });

  let transport = null;
  let stateT = 0, worldT = 0, raftT = 0, hpT = 0, raftDirty = false, welcomed = false;
  const hpQueue = new Map();
  let myName = '';
  const _v = new THREE.Vector3();

  function nameDefault() {
    try { const s = localStorage.getItem('siremore-name'); if (s) return s; } catch (e) { /* ignore */ }
    const st = G.desktop && G.desktop.steam;
    return st && st.running && st.name ? String(st.name).slice(0, 20) : 'Námořník';
  }
  function setName(n) {
    myName = String(n || '').replace(/[<>]/g, '').trim().slice(0, 20) || 'Námořník';
    try { localStorage.setItem('siremore-name', myName); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Transports
  // ---------------------------------------------------------------------------
  function wsTransport(addr, role) {
    const url = 'ws://' + addr + ':' + PORT + '/?role=' + role + '&name=' + encodeURIComponent(myName);
    let ws;
    try { ws = new WebSocket(url); } catch (e) { fail('Nepodařilo se připojit (' + addr + ').'); return null; }
    const t = {
      kind: 'lan', ws,
      send(to, m) { if (ws.readyState === 1) ws.send(JSON.stringify({ to, m })); },
      close() { try { ws.close(); } catch (e) { /* ignore */ } },
    };
    ws.onmessage = (ev) => { let o; try { o = JSON.parse(ev.data); } catch (e) { return; } onWire(o); };
    ws.onclose = () => { if (transport === t) fail(N.role === 'guest' ? 'Spojení s hostitelem se přerušilo.' : 'Spojení se přerušilo.'); };
    ws.onerror = () => {};
    return t;
  }
  function onWire(o) {
    if (o.t === 'hub') {
      N.me = o.you; N.hostId = o.host;
      for (const p of o.peers || []) if (p.id !== N.me) addPeer(p.id, p.name);
      connected();
    } else if (o.t === 'join') addPeer(o.id, o.name);
    else if (o.t === 'leave') removePeer(o.id, true);
    else if (o.t === 'error') {
      const why = { 'no-host': 'Na té adrese nikdo nehraje.', 'host-taken': 'Tady už někdo hostuje.', full: 'Hra je plná.', 'host-left': 'Hostitel ukončil hru.' };
      fail(why[o.reason] || 'Spojení se přerušilo.');
    } else if (o.from) handle(o.from, o.m);
  }
  function steamTransport() {
    return {
      kind: 'steam',
      send(to, m) { netBridge.steamSend(to, JSON.stringify(m)); },
      close() { netBridge.steamLeave(); },
    };
  }
  if (netBridge) {
    netBridge.onSteamMsg((p) => {
      if (!transport || transport.kind !== 'steam') return;
      let m; try { m = JSON.parse(p.data); } catch (e) { return; }
      handle(String(p.from), m);
    });
    netBridge.onSteamPeers((p) => {
      if (!transport || transport.kind !== 'steam') return;
      N.me = p.me; N.hostId = p.host;
      const ids = new Set((p.members || []).map((m) => m.id));
      for (const m of p.members || []) if (m.id !== N.me && !N.peers.has(m.id)) addPeer(m.id, m.name || 'Hráč');
      for (const id of Array.from(N.peers.keys())) if (!ids.has(id)) removePeer(id, true);
      if (N.role === 'guest' && N.hostId && !ids.has(N.hostId) && welcomed) fail('Hostitel ukončil hru.');
    });
    netBridge.onSteamInvite((p) => { if (p && p.lobby) joinSteam(p.lobby); });
  }

  // ---------------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------------
  function startHostingGame() {
    if (G.state === 'playing') return;
    if (G.save && G.save.exists && G.save.exists()) G.continueGame(); else G.newGame();
  }
  async function hostLan() {
    if (N.role !== 'off') return false;
    if (!netBridge) { G.notify('Hostovat jde jen v aplikaci Širé moře pro Windows. Připojit se jde i z prohlížeče.', 'warn'); return false; }
    const r = await netBridge.lanHost();
    if (!r || !r.ok) { G.notify('Nepodařilo se otevřít hru pro přátele: ' + ((r && r.error) || '?'), 'danger'); return false; }
    N.lanIps = r.ips || [];
    startHostingGame();
    return hostAt('127.0.0.1');
  }
  function hostAt(addr) {
    if (N.role !== 'off') return false;
    if (!myName) setName(nameDefault());
    N.role = 'host'; N.host = true; N.guest = false; N.via = 'lan';
    transport = wsTransport(addr || '127.0.0.1', 'host');
    return !!transport;
  }
  async function hostSteam() {
    if (N.role !== 'off') return false;
    if (!netBridge || !(G.desktop && G.desktop.steam && G.desktop.steam.running)) { G.notify('Steam neběží. Zapni Steam, nebo hraj přes Wi-Fi (LAN).', 'warn'); return false; }
    if (!myName) setName(nameDefault());
    const r = await netBridge.steamHost();
    if (!r || !r.ok) { G.notify('Steam lobby se nepodařilo založit: ' + ((r && r.error) || '?'), 'danger'); return false; }
    startHostingGame();
    N.role = 'host'; N.host = true; N.guest = false; N.via = 'steam';
    N.me = r.me; N.hostId = r.me; N.lobby = r.lobby;
    transport = steamTransport();
    connected();
    netBridge.steamInvite();
    return true;
  }
  function joinLan(addr) {
    if (N.role !== 'off') leave(true);
    addr = String(addr || '').trim();
    if (!/^[\w.:-]{1,64}$/.test(addr)) { G.notify('Zadej adresu hostitele, třeba 192.168.1.20.', 'warn'); return false; }
    if (!myName) setName(nameDefault());
    N.role = 'guest'; N.guest = false; N.host = false; N.via = 'lan';   // .guest turns on with the welcome
    welcomed = false;
    transport = wsTransport(addr, 'guest');
    if (transport) G.notify('Připojuji se k ' + addr + '…', 'info');
    return !!transport;
  }
  async function joinSteam(lobby) {
    if (!netBridge) return false;
    if (N.role !== 'off') leave(true);
    if (!myName) setName(nameDefault());
    const r = await netBridge.steamJoin(lobby);
    if (!r || !r.ok) { G.notify('Do hry přes Steam se nepodařilo připojit.', 'danger'); return false; }
    N.role = 'guest'; N.host = false; N.via = 'steam';
    N.me = r.me; N.hostId = r.host; N.lobby = r.lobby;
    welcomed = false;
    transport = steamTransport();
    connected();
    return true;
  }
  function connected() {
    if (N.role === 'guest') send('host', { t: 'hello', name: myName });
    if (N.role === 'host') {
      G.notify(N.via === 'steam' ? 'Hra je otevřená. Pozvi přátele ve Steamu.'
        : 'Hra je otevřená pro přátele na stejné Wi-Fi. Adresa: ' + (N.lanIps[0] || 'tvoje IP adresa'), 'good');
    }
    refreshPanel();
  }
  function leave(silent) {
    const wasGuest = N.role === 'guest' && welcomed;
    if (transport) { const t = transport; transport = null; try { t.send('*', { t: 'bye' }); } catch (e) { /* ignore */ } t.close(); }
    if (N.role === 'host' && N.via === 'lan' && netBridge) netBridge.lanStop();
    for (const id of Array.from(N.peers.keys())) removePeer(id, false);
    N.role = 'off'; N.guest = false; N.host = false; N.via = ''; N.me = ''; N.hostId = ''; N.lobby = '';
    welcomed = false; raftDirty = false;
    if (wasGuest && G.state !== 'menu') { G.state = 'playing'; G.toMenu(); }
    if (!silent) G.notify('Odpojeno od společné hry.', 'info');
    refreshPanel();
  }
  function fail(text) {
    const had = N.role !== 'off';
    leave(true);
    if (had) G.notify(text, 'warn');
  }
  function send(to, m) { if (transport) transport.send(to, m); }

  // ---------------------------------------------------------------------------
  // Peers & avatars
  // ---------------------------------------------------------------------------
  function addPeer(id, name) {
    if (!id || id === N.me || N.peers.has(id)) { if (N.peers.has(id) && name) setPeerName(id, name); return; }
    const color = COLORS[(N.peers.size + 1) % COLORS.length];
    const p = { name: name || 'Hráč', color, av: null, st: null, seen: 0 };
    N.peers.set(id, p);
    refreshPanel();
  }
  function setPeerName(id, name) {
    const p = N.peers.get(id);
    if (!p || !name || p.name === name) return;
    p.name = String(name).slice(0, 20);
    if (p.av) { p.av.label.material.map = nameTex(p.name); p.av.label.material.needsUpdate = true; }
    refreshPanel();
  }
  function removePeer(id, notify) {
    const p = N.peers.get(id);
    if (!p) return;
    if (p.av && p.av.g.parent) p.av.g.parent.remove(p.av.g);
    N.peers.delete(id);
    if (notify && G.state === 'playing') G.notify('Hráč ' + p.name + ' odešel.', 'info');
    refreshPanel();
  }
  const texCache = new Map();
  function nameTex(text) {
    if (texCache.has(text)) return texCache.get(text);
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const x = c.getContext('2d');
    x.font = 'bold 30px "Alegreya Sans", "Segoe UI", sans-serif';
    const w = Math.min(240, x.measureText(text).width + 24);
    x.fillStyle = 'rgba(6,34,43,0.78)';
    x.beginPath(); x.roundRect ? x.roundRect(128 - w / 2, 10, w, 44, 14) : x.rect(128 - w / 2, 10, w, 44); x.fill();
    x.fillStyle = '#e6cf9f'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, 128, 33, 230);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    texCache.set(text, t);
    return t;
  }
  function makeAvatar(p) {
    const g = new THREE.Group();
    g.name = 'coop-avatar';
    const m = (c) => new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.85 });
    const bx = (parent, w, h, d, x, y, z, mat) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); o.position.set(x, y, z); o.castShadow = true; parent.add(o); return o; };
    const shirt = m(p.color), skin = m(0xf0c9a0), pants = m(0x2d4a6b), hair = m(0x5a3b22);
    bx(g, 0.46, 0.62, 0.26, 0, 1.08, 0, shirt);
    bx(g, 0.3, 0.3, 0.3, 0, 1.56, 0, skin);
    bx(g, 0.32, 0.09, 0.32, 0, 1.73, 0, hair);
    bx(g, 0.06, 0.05, 0.02, -0.07, 1.6, 0.155, m(0x111111));
    bx(g, 0.06, 0.05, 0.02, 0.07, 1.6, 0.155, m(0x111111));
    const limb = (x, y, w, h, mat) => { const pv = new THREE.Group(); pv.position.set(x, y, 0); bx(pv, w, h, w, 0, -h / 2, 0, mat); g.add(pv); return pv; };
    const legs = [limb(-0.11, 0.78, 0.17, 0.76, pants), limb(0.11, 0.78, 0.17, 0.76, pants)];
    const arms = [limb(-0.3, 1.36, 0.13, 0.6, shirt), limb(0.3, 1.36, 0.13, 0.6, shirt)];
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: nameTex(p.name), transparent: true, depthWrite: false }));
    label.scale.set(1.3, 0.33, 1);
    label.position.y = 2.1;
    g.add(label);
    G.scene.add(g);
    return { g, legs, arms, label, walk: 0, pos: new THREE.Vector3(), tgt: new THREE.Vector3(), yaw: 0, tyaw: 0, first: true };
  }
  function updateAvatars(dt) {
    for (const [, p] of N.peers) {
      if (!p.st) continue;
      if (!p.av) p.av = makeAvatar(p);
      const a = p.av, s = p.st;
      a.tgt.set(s.p[0], s.p[1], s.p[2]);
      a.tyaw = s.y;
      if (a.first) { a.pos.copy(a.tgt); a.yaw = a.tyaw; a.first = false; }
      const before = _v.copy(a.pos);
      const bx = before.x, bz = before.z;
      a.pos.lerp(a.tgt, 1 - Math.exp(-12 * dt));
      const dy = Math.atan2(Math.sin(a.tyaw - a.yaw), Math.cos(a.tyaw - a.yaw));
      a.yaw += dy * Math.min(1, dt * 12);
      const sp = Math.hypot(a.pos.x - bx, a.pos.z - bz) / Math.max(dt, 1e-3);
      a.walk += dt * Math.min(9, sp * 2.4);
      const sw = sp > 0.3 ? Math.sin(a.walk) * 0.6 : 0;
      a.legs[0].rotation.x = sw; a.legs[1].rotation.x = -sw;
      a.arms[0].rotation.x = s.w ? Math.sin(a.walk * 0.7) * 1.2 - 1.4 : -sw * 0.8;
      a.arms[1].rotation.x = s.w ? -Math.sin(a.walk * 0.7) * 1.2 - 1.4 : sw * 0.8;
      a.g.position.copy(a.pos);
      a.g.rotation.y = a.yaw;
    }
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------
  const mod = (n) => G.mod(n);
  function r2(v) { return Math.round(v * 100) / 100; }
  function debrisEntry(d) { return [d.nid, d.type, d.id || '', d.count || 0, r2(d.position.x), r2(d.position.z)]; }
  function islandEntry(isl) {
    const all = mod('islands').save().islands || [];
    return all.find((e) => e.seed === isl.seed && e.name === isl.name) || null;
  }
  function snapshot() {
    return {
      time: G.time,
      world: G.world.netState(),
      raft: mod('raft').save(),
      build: mod('build').save(),
      islands: (mod('islands').save().islands || []),
      debris: (G.debris.list || []).filter((d) => d.alive && !d.collected && !d.flying).map(debrisEntry),
      names: namesList(),
    };
  }
  function namesList() {
    const out = [{ id: N.me, name: myName }];
    for (const [id, p] of N.peers) out.push({ id, name: p.name });
    return out;
  }
  function apply(fn) { N.applying++; try { fn(); } catch (e) { console.error('[net]', e); } finally { N.applying--; } }

  function handle(from, m) {
    if (!m || typeof m !== 'object') return;
    const p = N.peers.get(from);
    if (p) p.seen = performance.now();
    switch (m.t) {
      case 'ps':
        if (!p && from !== N.me) addPeer(from, m.n);
        if (N.peers.has(from)) { const q = N.peers.get(from); q.st = m; if (m.n) setPeerName(from, m.n); }
        return;
      case 'bye': removePeer(from, true); return;
      case 'hello':
        if (N.role !== 'host') return;
        addPeer(from, m.name);
        setPeerName(from, m.name);
        send(from, { t: 'welcome', snap: snapshot() });
        send('*', { t: 'names', list: namesList() });
        G.notify('Připojil se hráč ' + (m.name || 'Hráč') + '.', 'good');
        return;
      case 'op': if (N.role === 'host') { applyOp(m.o); } return;
      case 'grab':
        if (N.role !== 'host') return;
        apply(() => { const d = (G.debris.list || []).find((x) => x.nid === m.nid); if (d) G.debris.remove(d); });
        send('*', { t: 'd-', nid: m.nid });
        return;
    }
    if (N.role !== 'guest') return;
    // host → guest
    switch (m.t) {
      case 'welcome': welcome(m.snap); break;
      case 'names': for (const e of m.list || []) if (e.id !== N.me) { addPeer(e.id, e.name); setPeerName(e.id, e.name); } break;
      case 'raft': apply(() => { mod('raft').load(m.raft); G.build.netLoad(m.build); }); break;
      case 'hp': apply(() => { for (const e of m.tiles || []) G.raft.netSetTile(e[0], e[1], undefined, e[2]); }); break;
      case 'world':
        apply(() => {
          G.world.netApply(m.w);
          if (Number.isFinite(m.time) && Math.abs(G.time - m.time) > 2) G.time = m.time;
          for (const e of m.isl || []) {
            const isl = G.islands.list.find((i) => i.seed === e[0]);
            if (isl) { isl.position.x += (e[1] - isl.position.x) * 0.5; isl.position.z += (e[2] - isl.position.z) * 0.5; }
          }
        });
        break;
      case 'isl+': apply(() => spawnIslandFrom(m.isl)); break;
      case 'isl-': apply(() => { const isl = G.islands.list.find((i) => i.seed === m.seed); if (isl) G.islands.remove(isl); }); break;
      case 'd+': apply(() => spawnDebrisFrom(m.d)); break;
      case 'd-': apply(() => { const d = (G.debris.list || []).find((x) => x.nid === m.nid); if (d) G.debris.remove(d); }); break;
      case 'wave': G.events.emit('world:bigwave', m.e); if (m.e && m.e.warn && G.ui && G.ui.banner) G.ui.banner('Velká vlna! Drž se dál od okraje!', 'danger', 2); break;
    }
  }
  function welcome(snap) {
    if (!snap) return;
    N.guest = true;
    welcomed = true;
    G.startGuest();
    apply(() => {
      G.world.netApply(snap.world);
      if (Number.isFinite(snap.time)) G.time = snap.time;
      mod('raft').load(snap.raft);
      G.build.netLoad(snap.build);
      for (const e of snap.islands || []) spawnIslandFrom(e);
      for (const e of snap.debris || []) spawnDebrisFrom(e);
    });
    for (const e of snap.names || []) if (e.id !== N.me) { addPeer(e.id, e.name); setPeerName(e.id, e.name); }
    // step onto another part of the raft than the host (everybody starts at the centre)
    const t = G.raft.randomTile();
    if (t && G.player && G.player.teleport) G.player.teleport((t.i + 0.5) * G.C.TILE + G.rand(-0.5, 0.5), (t.j + 0.5) * G.C.TILE + G.rand(-0.5, 0.5));
    const host = N.peers.get(N.hostId);
    G.notify('Jsi na voru hráče ' + (host ? host.name : 'hostitele') + '. Stavějte spolu!', 'good');
    closePanel();
    refreshPanel();
  }
  function spawnIslandFrom(e) {
    if (!e || G.islands.list.some((i) => i.seed === e.seed)) return;
    const opts = Object.assign({}, e.gen || {}, { seed: e.seed, name: e.name, position: { x: e.x, z: e.z }, restored: true });
    const isl = G.islands.spawnIsland(opts);
    if (isl) { isl.near = !!e.near; }
  }
  function spawnDebrisFrom(e) {
    if (!e || (G.debris.list || []).some((d) => d.nid === e[0])) return;
    const pos = new THREE.Vector3(e[4], 0, e[5]);
    const d = e[1] === 'bundle' ? G.debris.spawnItem(e[2], e[3], pos) : G.debris.spawn(e[1], pos, true);
    if (d) d.nid = e[0];
  }
  function findPiece(x, y, z) {
    for (const p of G.build.pieces) if (Math.abs(p.x0 - x) < 1e-3 && Math.abs(p.y0 - y) < 1e-3 && Math.abs(p.z0 - z) < 1e-3) return p;
    return null;
  }
  function applyOp(o) {
    if (!o || typeof o !== 'object') return;
    const R = G.raft, B = G.build;
    apply(() => {
      switch (o.o) {
        case 'tile': if (!R.canBuildAt(o.i, o.j)) R.addTile(o.i, o.j); break;
        case 'lvl': R.netSetTile(o.i, o.j, Number.isInteger(o.lv) ? o.lv : undefined, o.hp); break;
        case 's+': R.placeStructure(String(o.type), null, 0, undefined, { x: +o.x, y: +o.y, z: +o.z, angle: +o.a }); break;
        case 's-': { const s = R.findStructure(o.type, +o.x, +o.z); if (s) R.removeStructure(s, false); break; }
        case 'hold': { const t = R.getTile(o.i, o.j); if (t) { if (o.on) R.addHold(t, true); else R.removeHold(t, true); } break; }
        case 'use': { const s = R.findStructure(o.type, +o.x, +o.z); if (s && /^(sail|bigsail|anchor)$/.test(s.type)) R.useStructure(s); break; }
        case 'b+': B.add(String(o.type), o.x | 0, o.y | 0, o.z | 0, o.r | 0); break;
        case 'b-': { const b = B.blockAt(o.x | 0, o.y | 0, o.z | 0); if (b) B.remove(b, false); break; }
        case 'door': { const b = B.blockAt(o.x | 0, o.y | 0, o.z | 0); if (b && b.t.shape === 'door') b.open = !!o.open; break; }
        case 'p+': B.addPiece(String(o.type), +o.x, +o.y, +o.z, o.r | 0); break;
        case 'p-': { const p = findPiece(+o.x, +o.y, +o.z); if (p) B.removePiece(p, false); break; }
      }
    });
    raftDirty = true;
  }
  // Building hooks (raft.js / build.js call this for every change made by this player).
  function op(o) {
    if (N.role === 'host') { raftDirty = true; return; }
    if (N.guest && !N.applying && transport) send('host', { t: 'op', o });
  }

  // ---------------------------------------------------------------------------
  // Host-side event forwarding
  // ---------------------------------------------------------------------------
  function hostOn(ev, fn) { G.events.on(ev, (e) => { if (N.role === 'host' && transport) fn(e); }); }
  function bindEvents() {
    for (const ev of ['build:tile', 'build:reinforce', 'build:repair', 'build:metal', 'build:structure', 'structure:removed', 'tile:destroyed',
      'build:block', 'build:hold', 'hold:removed', 'sail:toggled', 'anchor:toggled']) hostOn(ev, () => { raftDirty = true; });
    hostOn('tile:damaged', (e) => { if (e && e.tile) hpQueue.set(e.tile.i + ',' + e.tile.j, [e.tile.i, e.tile.j, Math.round(e.tile.hp * 10) / 10]); });
    hostOn('debris:spawned', (e) => { if (e && e.d) send('*', { t: 'd+', d: debrisEntry(e.d) }); });
    hostOn('debris:removed', (e) => { if (e && e.nid && !N.applying) send('*', { t: 'd-', nid: e.nid }); });
    hostOn('island:spawned', (e) => { const x = e && e.island && islandEntry(e.island); if (x) send('*', { t: 'isl+', isl: x }); });
    hostOn('island:removed', (e) => { if (e) send('*', { t: 'isl-', seed: e.seed }); });
    hostOn('world:bigwave', (e) => { if (e) send('*', { t: 'wave', e }); });
    // guests: picked up / hooked debris → tell the host
    G.events.on('debris:removed', (e) => { if (N.guest && transport && e && e.nid && !N.applying) send('host', { t: 'grab', nid: e.nid }); });
    G.events.on('game:menu', () => { if (N.role !== 'off') leave(true); });
  }

  // ---------------------------------------------------------------------------
  // Menu panel: "Hrát s přáteli"
  // ---------------------------------------------------------------------------
  let panel = null;
  function openPanel() {
    if (panel) return;
    if (!myName) setName(nameDefault());
    const host = document.getElementById('ui-root') || document.body;
    const el = document.createElement('div');
    el.className = 'coop-panel';
    el.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:30;pointer-events:auto;width:min(460px,calc(100vw - 32px));' +
      'max-height:calc(100vh - 32px);overflow:auto;background:rgba(6,34,43,.95);border:2px double rgba(230,207,159,.6);border-radius:14px;padding:18px 20px;' +
      'color:#e9f1ea;font-family:var(--font-body,system-ui);box-shadow:0 12px 40px rgba(0,0,0,.55)';
    const steamOk = !!(netBridge && G.desktop && G.desktop.steam && G.desktop.steam.running);
    el.innerHTML =
      '<div style="font-family:var(--font-display,serif);font-size:30px;color:#e6cf9f;text-align:center">Hrát s přáteli</div>' +
      '<p style="margin:6px 0 12px;font-size:15px;opacity:.85;text-align:center">Jeden hraje jako hostitel, ostatní se připojí na jeho vor.</p>' +
      '<label style="display:block;font-size:14px;color:#e6cf9f">Tvoje jméno<input data-k="name" maxlength="20" style="' + inputCss() + '"></label>' +
      '<div data-k="status" style="margin:10px 0;font-size:15px;min-height:20px;color:#9be15d"></div>' +
      '<div style="font-weight:800;margin:10px 0 6px;color:#e6cf9f">Založit hru</div>' +
      (netBridge ? '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button type="button" class="btn btn-primary" data-k="steam"' + (steamOk ? '' : ' disabled title="Steam neběží"') + '>Přes Steam (pozvat přátele)</button>' +
        '<button type="button" class="btn" data-k="lan">Na stejné Wi-Fi (LAN)</button></div>'
        : '<p style="font-size:14px;opacity:.8;margin:0">Hostovat jde v aplikaci Širé moře pro Windows.</p>') +
      '<div style="font-weight:800;margin:14px 0 6px;color:#e6cf9f">Připojit se</div>' +
      '<div style="display:flex;gap:8px"><input data-k="ip" placeholder="adresa hostitele, např. 192.168.1.20" style="' + inputCss() + ';flex:1;margin:0">' +
      '<button type="button" class="btn" data-k="join">Připojit</button></div>' +
      '<p style="font-size:13px;opacity:.75;margin:6px 0 0">Přes Steam: přijmi pozvánku od kamaráda ve Steamu a hra se připojí sama.</p>' +
      '<div style="display:flex;gap:8px;justify-content:center;margin-top:14px">' +
      '<button type="button" class="btn" data-k="leave" style="display:none">Odpojit</button>' +
      '<button type="button" class="btn" data-k="close">Zavřít</button></div>';
    host.appendChild(el);
    panel = el;
    const $ = (k) => el.querySelector('[data-k="' + k + '"]');
    $('name').value = myName;
    $('name').addEventListener('change', () => setName($('name').value));
    try { $('ip').value = localStorage.getItem('siremore-last-ip') || ''; } catch (e) { /* ignore */ }
    if ($('steam')) $('steam').addEventListener('click', () => { setName($('name').value); hostSteam().then(refreshPanel); });
    if ($('lan')) $('lan').addEventListener('click', () => { setName($('name').value); hostLan().then(refreshPanel); });
    $('join').addEventListener('click', () => {
      setName($('name').value);
      const ip = $('ip').value.trim();
      try { localStorage.setItem('siremore-last-ip', ip); } catch (e) { /* ignore */ }
      joinLan(ip);
      refreshPanel();
    });
    $('ip').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join').click(); if (e.key === 'Escape') closePanel(); });
    $('leave').addEventListener('click', () => { leave(false); refreshPanel(); });
    $('close').addEventListener('click', closePanel);
    if (G.state === 'playing') G.setUIBlock('coop-panel', true);
    refreshPanel();
  }
  function inputCss() {
    return 'display:block;width:100%;box-sizing:border-box;margin-top:4px;font:600 17px var(--font-body,system-ui);padding:7px 9px;border-radius:8px;' +
      'border:2px solid rgba(217,164,65,.8);background:#041419;color:#e9f1ea;outline:none';
  }
  function closePanel() {
    if (!panel) return;
    panel.remove();
    panel = null;
    G.setUIBlock('coop-panel', false);
  }
  function statusText() {
    if (N.role === 'off') return '';
    const names = Array.from(N.peers.values()).map((p) => p.name);
    if (N.role === 'host') {
      const addr = N.via === 'lan' ? 'Adresa pro přátele: ' + (N.lanIps.join(', ') || 'tvoje IP') + '. ' : 'Hra přes Steam. ';
      return addr + (names.length ? 'Na voru: ' + names.join(', ') : 'Zatím nikdo nepřišel.');
    }
    return welcomed ? 'Jsi na voru hostitele. Hráči: ' + names.join(', ') : 'Připojuji se…';
  }
  function refreshPanel() {
    updatePauseInfo();
    if (!panel) return;
    const $ = (k) => panel.querySelector('[data-k="' + k + '"]');
    $('status').textContent = statusText();
    $('leave').style.display = N.role === 'off' ? 'none' : '';
    for (const k of ['steam', 'lan', 'join']) if ($(k)) $(k).disabled = N.role !== 'off' || (k === 'steam' && !(G.desktop && G.desktop.steam && G.desktop.steam.running));
  }
  // a line in the pause card + buttons (invite / leave)
  function updatePauseInfo() {
    const card = document.querySelector('#scr-pause .card');
    if (!card) return;
    let box = card.querySelector('.coop-pause');
    if (!box) {
      box = document.createElement('div');
      box.className = 'coop-pause';
      box.style.cssText = 'margin-top:12px;font-size:15px;text-align:center';
      box.innerHTML = '<div data-k="txt" style="opacity:.9"></div><div style="display:flex;gap:8px;justify-content:center;margin-top:8px">' +
        '<button type="button" class="btn" data-k="coop">Hrát s přáteli</button>' +
        '<button type="button" class="btn" data-k="inv" style="display:none">Pozvat přátele (Steam)</button></div>';
      card.appendChild(box);
      box.querySelector('[data-k="coop"]').addEventListener('click', () => openPanel());
      box.querySelector('[data-k="inv"]').addEventListener('click', () => { if (netBridge) netBridge.steamInvite(); });
    }
    box.querySelector('[data-k="txt"]').textContent = statusText();
    box.querySelector('[data-k="inv"]').style.display = N.role === 'host' && N.via === 'steam' ? '' : 'none';
  }

  // ---------------------------------------------------------------------------
  // Module
  // ---------------------------------------------------------------------------
  G.register({
    name: 'net',
    order: 3,
    init() {
      bindEvents();
      // "Hrát s přáteli" in the main menu (after ui.js built it)
      setTimeout(() => {
        const nav = document.querySelector('#scr-menu .menu-buttons');
        if (nav && !document.getElementById('btn-coop')) {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'btn'; b.id = 'btn-coop'; b.textContent = 'Hrát s přáteli';
          b.addEventListener('click', () => openPanel());
          const settings = document.getElementById('btn-menu-settings');
          nav.insertBefore(b, settings || null);
        }
        updatePauseInfo();
      }, 0);
      G.events.on('game:paused', updatePauseInfo);
      // launched by accepting a Steam invite while the game was closed
      if (netBridge) netBridge.launchLobby().then((id) => { if (id) setTimeout(() => joinSteam(id), 1500); }).catch(() => {});
    },
    frame(dt) {
      if (N.role === 'off' || !transport) { if (N.peers.size) updateAvatars(dt); return; }
      updateAvatars(dt);
      if (G.state !== 'playing') return;
      const P = G.player;
      stateT -= dt;
      if (stateT <= 0 && P && P.position && (N.role === 'host' || welcomed)) {
        stateT = STATE_EVERY;
        const sel = G.inventory && G.inventory.getSelected ? G.inventory.getSelected() : null;
        send('*', { t: 'ps', n: myName, p: [r2(P.position.x), r2(P.position.y), r2(P.position.z)], y: r2(P.yaw), w: P.inWater ? 1 : 0, h: sel ? sel.id : '' });
      }
      if (N.role !== 'host') return;
      worldT -= dt;
      if (worldT <= 0) {
        worldT = WORLD_EVERY;
        send('*', { t: 'world', time: G.time, w: G.world.netState(), isl: G.islands.list.filter((i) => !i.decor).map((i) => [i.seed, r2(i.position.x), r2(i.position.z)]) });
      }
      raftT -= dt;
      if (raftDirty && raftT <= 0) {
        raftT = RAFT_MIN_GAP;
        raftDirty = false;
        hpQueue.clear();
        send('*', { t: 'raft', raft: mod('raft').save(), build: mod('build').save() });
      }
      hpT -= dt;
      if (hpT <= 0 && hpQueue.size) {
        hpT = HP_EVERY;
        send('*', { t: 'hp', tiles: Array.from(hpQueue.values()) });
        hpQueue.clear();
      }
    },
  });
})();
