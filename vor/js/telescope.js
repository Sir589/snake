// telescope.js — the "Dalekohled" tool (ROADMAP 3): hold the left button to zoom in (4×, the right
// button switches to 8×). While looking through it the HUD names what is in the middle of the view
// (islands, the pirate ship, the shark) with its distance, or points to the nearest island.
// Registers the tool handler 'telescope' and module 'telescope' (order 46).
(function () {
  'use strict';

  const ZOOMS = [4, 8];
  const PICK_ANGLE = 0.14;             // rad from the view centre that counts as "looking at it"
  const _eye = new THREE.Vector3(), _fwd = new THREE.Vector3(), _to = new THREE.Vector3();

  let scopeEl = null;
  const T = {
    viewModel: null,
    holding: false,
    level: 0,                          // index into ZOOMS
    zoom: 1,
    seen: -10,
    frameNo: 0,
    hintText: '',

    onEquip() { T.holding = false; },
    onUnequip() { T.holding = false; T.release(); },
    release() {
      T.zoom = 1;
      if (G.player) G.player.zoom = 1;
      showScope(false);
      if (T.viewModel) T.viewModel.visible = true;
    },
    update() {
      T.seen = T.frameNo;
      T.zoom = T.holding ? ZOOMS[T.level] : 1;             // player.js eases the field of view
      if (G.player) G.player.zoom = T.zoom;
      const zoomed = T.zoom > 1;
      showScope(zoomed);
      if (T.viewModel) T.viewModel.visible = !zoomed;
      const L = G.input.touchMode ? '●' : 'Levé tlačítko';
      const R = G.input.touchMode ? '◐' : 'Pravé tlačítko';
      let h;
      if (!T.holding) h = 'Podrž ' + (G.input.touchMode ? L : L.toLowerCase()) + ': přiblížit obzor';
      else h = describeView() + ' · ' + R + ': zvětšení ' + ZOOMS[(T.level + 1) % ZOOMS.length] + '×';
      T.hintText = h;
      G.hud.setToolHint(h);
    },
    primaryDown() { T.holding = true; G.sfx('ui_click', { volume: 0.25 }); },
    primaryUp() { T.holding = false; },
    secondaryDown() { T.level = (T.level + 1) % ZOOMS.length; G.sfx('ui_click', { volume: 0.3 }); },
    secondaryUp() {},
    hint() { return T.hintText; },
  };

  function metres(d) { return d >= 1000 ? (Math.round(d / 100) / 10).toString().replace('.', ',') + ' km' : Math.round(d / 10) * 10 + ' m'; }
  function side(dx, dz) {
    // where (dx, dz) lies relative to the view direction
    const fx = _fwd.x, fz = _fwd.z;
    const deg = Math.atan2(fx * dz - fz * dx, fx * dx + fz * dz) * 180 / Math.PI;   // + = to the right
    if (Math.abs(deg) < 20) return 'před tebou';
    if (Math.abs(deg) > 135) return 'za tebou';
    return deg > 0 ? 'vpravo' : 'vlevo';
  }
  // Things worth spotting: [{ name, pos, radius }]
  function targets() {
    const out = [];
    const I = G.islands;
    if (I && Array.isArray(I.list)) {
      for (const isl of I.list) {
        const p = isl.position || (isl.group && isl.group.position);
        if (p) out.push({ name: isl.name || 'Ostrov', pos: p, radius: isl.radius || 20, island: true });
      }
    }
    const P = G.pirates;
    if (P && P.ship && P.ship.position) out.push({ name: 'Pirátská loď', pos: P.ship.position, radius: 8, danger: true });
    const S = G.shark;
    if (S && S.position && typeof S.present === 'function' && S.present()) out.push({ name: 'Žralok', pos: S.position, radius: 2, danger: true });
    return out;
  }
  function describeView() {
    const P = G.player;
    if (!P || !P.eye) return '';
    P.eye(_eye); P.forward(_fwd);
    let best = null, ba = Infinity;
    const list = targets();
    for (const t of list) {
      _to.set(t.pos.x - _eye.x, 0, t.pos.z - _eye.z);
      const d = _to.length();
      if (d < 1) continue;
      // angular size helps big islands: aim anywhere on them
      const allow = PICK_ANGLE + Math.atan2(t.radius, d);
      const fl = Math.hypot(_fwd.x, _fwd.z) || 1;
      const cos = (_to.x * _fwd.x + _to.z * _fwd.z) / (d * fl);
      const a = Math.acos(Math.max(-1, Math.min(1, cos)));
      if (a < allow && a < ba) { ba = a; best = { t, d }; }
    }
    if (best) {
      const d = Math.max(0, best.d - (best.t.island ? best.t.radius : 0));
      return best.t.name + ' – ' + metres(d) + (best.t.danger ? '!' : '');
    }
    // nothing in view: point to the nearest island
    let near = null, nd = Infinity;
    for (const t of list) {
      if (!t.island) continue;
      const d = Math.hypot(t.pos.x - _eye.x, t.pos.z - _eye.z);
      if (d < nd) { nd = d; near = t; }
    }
    if (near) return 'Nejbližší ostrov je ' + side(near.pos.x - _eye.x, near.pos.z - _eye.z) + ', ' + metres(Math.max(0, nd - near.radius));
    return 'Jen voda, kam až dohlédneš';
  }

  function showScope(on) {
    if (!scopeEl) {
      scopeEl = document.createElement('div');
      scopeEl.id = 'scope';
      scopeEl.setAttribute('aria-hidden', 'true');
      scopeEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;opacity:0;transition:opacity .18s ease;z-index:3;' +
        'background:radial-gradient(circle at 50% 50%, transparent 0, transparent 38vmin, rgba(4,20,25,.55) 39vmin, rgba(2,8,10,.96) 41vmin);';
      const ring = document.createElement('div');
      ring.style.cssText = 'position:absolute;left:50%;top:50%;width:78vmin;height:78vmin;transform:translate(-50%,-50%);' +
        'border-radius:50%;box-shadow:inset 0 0 0 3px rgba(217,164,65,.55), inset 0 0 40px rgba(0,0,0,.45)';
      const h = document.createElement('div');
      h.style.cssText = 'position:absolute;left:calc(50% - 18vmin);width:36vmin;top:50%;height:1px;background:rgba(233,241,234,.35)';
      const v = document.createElement('div');
      v.style.cssText = 'position:absolute;top:calc(50% - 18vmin);height:36vmin;left:50%;width:1px;background:rgba(233,241,234,.35)';
      scopeEl.append(ring, h, v);
      (document.getElementById('game') || document.body).after(scopeEl);
    }
    const o = on ? '1' : '0';
    if (scopeEl.style.opacity !== o) scopeEl.style.opacity = o;
  }

  function buildViewModel() {
    const g = new THREE.Group();
    g.name = 'telescope-view';
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 0.6, roughness: 0.35, flatShading: true });
    const leather = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.9, flatShading: true });
    const glass = new THREE.MeshStandardMaterial({ color: 0x9fd4e6, metalness: 0.2, roughness: 0.1, emissive: 0x1d4a55 });
    const tube = (r0, r1, len, z, mat) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, len, 10), mat);
      m.rotation.x = Math.PI / 2;
      m.position.z = z;
      g.add(m);
      return m;
    };
    tube(0.028, 0.03, 0.2, 0.02, leather);
    tube(0.034, 0.034, 0.03, -0.09, brass);
    tube(0.022, 0.025, 0.14, 0.17, brass);
    tube(0.018, 0.02, 0.1, 0.28, brass);
    const lens = tube(0.033, 0.033, 0.005, -0.106, glass);
    lens.name = 'lens';
    g.position.set(0.02, -0.02, -0.06);
    g.rotation.set(0.05, 0.12, 0);
    g.scale.setScalar(1.3);
    return g;
  }

  G.register({
    name: 'telescope',
    order: 46,
    init() {
      T.viewModel = buildViewModel();
      G.tools.register('telescope', T);
    },
    reset() { T.holding = false; T.level = 0; T.release(); },
    frame() {
      T.frameNo++;
      // the tool stopped updating (unequipped, inventory open, paused): look normally again
      if (T.zoom > 1 && T.seen < T.frameNo - 2) { T.holding = false; T.release(); }
    },
  });

  G.telescope = T;
})();
