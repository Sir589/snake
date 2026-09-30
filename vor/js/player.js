// player.js — first-person controller, survival stats, camera, held-item dispatch and the tools
// 'consume', 'cup' and 'spear'. Contract: ../DESIGN.md §4 and §6 "player.js".
// Registers as module 'player' (order 30).
(function () {
  'use strict';

  const G = window.G;
  if (!G) return;

  // ---------------------------------------------------------------------------
  // Tuning
  // ---------------------------------------------------------------------------
  const EYE_H = G.C.PLAYER_HEIGHT;       // eye above feet
  const RAD = G.C.PLAYER_RADIUS;
  const TILE = G.C.TILE;
  const WALK = 4.2, SPRINT = 6.5, JUMP_V = 7, SWIM = 2.8;
  const STEP_UP = 0.45;                  // step-up height on land / deck
  const SHORE_UP = 1.25;                 // how far above the sea a swimmer can walk out onto land
  const WADE = 1.05;                     // water deeper than this over the ground → swimming
  const SWIM_EYE = 0.24;                 // eye above the local wave surface while swimming
  const CLIMB_REACH = 0.8 + RAD;         // centre distance to a raft tile edge for climbing
  const CLIMB_TIME = 0.62;
  const PITCH_MAX = (85 * Math.PI) / 180;
  const LOOK_K = 0.0022;                 // rad per mouse pixel at sensitivity 1
  const HUNGER_RATE = 100 / 540;         // −100 per 9 min
  const THIRST_RATE = 100 / 390;         // −100 per 6.5 min
  const STARVE_DPS = 1.5;
  const REGEN_HPS = 0.6;
  const INVULN_TIME = 0.3;
  const FAR_SWIM = 60;
  const HAND_X = 0.27, HAND_Y = -0.27, HAND_Z = -0.46;   // held-item anchor in camera space

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));
  const ease = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const easeOut = (t) => { t = clamp(t, 0, 1); return 1 - (1 - t) * (1 - t); };

  // Scratch objects (no per-frame allocations)
  const _v = new THREE.Vector3(), _n = new THREE.Vector3();
  const _ae = new THREE.Vector3(), _af = new THREE.Vector3();
  const _se = new THREE.Vector3(), _sf = new THREE.Vector3(), _sp = new THREE.Vector3();
  const _cupHit = new THREE.Vector3();
  const _gs = { h: 0, p: null };

  // ---------------------------------------------------------------------------
  // Public API (exists at load time)
  // ---------------------------------------------------------------------------
  const P = (G.player = {
    position: new THREE.Vector3(0, G.C.DECK_Y, 0),   // feet, world
    velocity: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    health: 100,
    hunger: 100,
    thirst: 100,
    maxHealth: 100,
    alive: true,
    inWater: false,
    onGround: true,
    groundKind: 'raft',          // 'raft' | 'island' | … | 'water' (swimming) | null (in the air)
    // --- extras ---
    groundProvider: null,        // the G.ground provider under the feet (or null)
    sprinting: false,
    climbing: false,             // climbing from the sea onto the raft
    god: false,
    lastDamageSource: null,
    controlOverride: null,
    hand: new THREE.Group(),     // parented to the camera in init(); held view models live here

    eye(out) {
      out = out || new THREE.Vector3();
      return out.set(P.position.x, P.position.y + EYE_H, P.position.z);
    },
    forward(out) {
      out = out || new THREE.Vector3();
      const cp = Math.cos(P.pitch);
      return out.set(-Math.sin(P.yaw) * cp, Math.sin(P.pitch), -Math.cos(P.yaw) * cp);
    },
    right(out) {
      out = out || new THREE.Vector3();
      return out.set(Math.cos(P.yaw), 0, -Math.sin(P.yaw));
    },
    damage(amount, source, dir) { return hurt(Number(amount) || 0, source, dir, false); },
    heal(n) {
      if (!P.alive) return P.health;
      P.health = clamp(P.health + (Number(n) || 0), 0, P.maxHealth);
      return P.health;
    },
    eat(id) { return eat(id); },
    applyFood(id) { return applyFood(id); },
    setControlOverride(o) { setOverride(o || null); },
    teleport(x, z) { placeAt(Number(x) || 0, Number(z) || 0); },
    canClimb() { return canClimbNow; },
  });
  P.hand.name = 'player-hand';

  // ---------------------------------------------------------------------------
  // Internal state
  // ---------------------------------------------------------------------------
  let baseFov = 70, fovCur = 70;
  let bobPhase = 0, bobAmp = 0, stepIdx = 0, stepOffset = 0, landDip = 0;
  let shake = 0, hurtRoll = 0, rollS = 0, pitchS = 0, clock = 0;
  let coyote = 0, jumpBuf = 0, invuln = 0;
  let strokeT = 0, strokePulse = 0;
  let lookDX = 0, lookDY = 0, lagX = 0, lagY = 0, handVy = 0, lowK = 0, swimK = 0, equipT = 1;
  let climbT = -1, climbTX = 0, climbTZ = 0;
  const climbFrom = new THREE.Vector3();
  let canClimbNow = false, climbHintShown = false;
  let farWarned = false, farNow = false, farCheckT = 0, waterTipShown = false;
  let warnH = false, warnT = false, warnH0 = false, warnT0 = false;
  let starveH = 0, starveT = 0;
  let deathT = 0, deathY0 = 0, deathPitch0 = 0, deathRoll0 = 0, diedInWater = false;

  // What the player holds: the selected hotbar index + item id and the dispatched handler.
  const held = { index: -1, id: null, toolId: null, handler: null, vm: null, lmb: false, rmb: false };
  let genericHolder = null;       // Group for items whose handler has no viewModel

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function waveH(x, z) {
    const W = G.world;
    if (W && typeof W.waveHeight === 'function') {
      const h = W.waveHeight(x, z);
      return Number.isFinite(h) ? h : 0;
    }
    return 0;
  }
  function raftOK() { const R = G.raft; return R && typeof R.tileAt === 'function' ? R : null; }
  function deckY() { const R = G.raft; return R && typeof R.deckY === 'function' ? R.deckY() : G.C.DECK_Y; }
  function tileAtCell(i, j) { const R = raftOK(); return R ? R.tileAt((i + 0.5) * TILE, (j + 0.5) * TILE) : null; }
  function btnL() { return G.input && G.input.touchMode ? '●' : 'Levé tlačítko'; }
  function btnJump() { return G.input && G.input.touchMode ? '⤒' : 'Mezerník'; }
  function itemDef(id) { return id && G.items && typeof G.items.def === 'function' ? G.items.def(id) : null; }

  // Highest walkable surface under (x, z) at or below maxY. Returns a shared scratch object
  // { h, p } (copy the values before sampling again) or null. skipRaft ignores the raft deck.
  function sampleGround(x, z, maxY, skipRaft) {
    const list = G.ground.providers;
    let best = null, bh = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (skipRaft && p.kind === 'raft') continue;
      let h;
      try { h = p.heightAt(x, z); } catch (e) { continue; }
      if (h === null || h === undefined || !(h <= maxY)) continue;
      if (h > bh) { bh = h; best = p; }
    }
    if (!best) return null;
    _gs.h = bh; _gs.p = best;
    return _gs;
  }
  function wallAt(x, z, limitY, skipRaft) {
    const g = sampleGround(x, z, Infinity, skipRaft);
    return !!g && g.h > limitY;
  }

  // Tool handler calls never break the controller; each failure is reported once.
  const failed = new Set();
  function hcall(h, name, a, b) {
    const fn = h && h[name];
    if (typeof fn !== 'function') return undefined;
    try { return fn.call(h, a, b); }
    catch (err) {
      const key = (held.toolId || '?') + '.' + name;
      if (!failed.has(key)) { failed.add(key); console.error('[player] tool ' + key + ' failed', err); }
      return undefined;
    }
  }

  function setWater(b) {
    if (P.inWater === b) return;
    P.inWater = b;
    G.events.emit('player:water', b);
  }

  // Distance to the nearest island's shore (Infinity when unknown / none).
  function islandDist() {
    const I = G.islands;
    if (!I || typeof I.nearest !== 'function') return Infinity;
    let isl = null;
    try { isl = I.nearest(P.position); } catch (e) { return Infinity; }
    if (!isl) return Infinity;
    const p = (isl.position && isl.position.isVector3 && isl.position) ||
      (isl.group && isl.group.position) || (isl.object && isl.object.position) ||
      (isl.mesh && isl.mesh.position) || (Number.isFinite(isl.x) ? isl : null);
    if (!p) return Infinity;
    const r = Number(isl.radius) || 0;
    return Math.max(0, Math.hypot(p.x - P.position.x, p.z - P.position.z) - r);
  }

  // ---------------------------------------------------------------------------
  // Damage, food, death
  // ---------------------------------------------------------------------------
  function reasonFor(src) {
    const s = String(src || '').toLowerCase();
    if (s === 'hunger' || s === 'starve' || s === 'starving') return 'Hlad tě přemohl.';
    if (s === 'thirst' || s === 'dehydration') return 'Žízeň tě přemohla.';
    if (s.indexOf('shark') >= 0) return 'Sežral tě žralok.';
    if (s.indexOf('cannon') >= 0 || s === 'ball') return 'Zasáhla tě dělová koule.';
    if (s.indexOf('pira') >= 0 || s.indexOf('board') >= 0 || s === 'sword' || s === 'melee') return 'Porazili tě piráti.';
    if (s === 'saltwater') return 'Slaná voda ti ublížila.';
    if (s === 'food' || s === 'raw') return 'Syrové jídlo ti ublížilo.';
    if (s === 'lightning' || s === 'storm') return 'Zasáhl tě blesk.';
    return 'Moře tě přemohlo.';
  }

  function hurt(amount, source, dir, bypass) {
    if (!P.alive || P.god || !(amount > 0)) return false;
    if (!bypass && invuln > 0) return false;
    if (G.state !== 'playing') return false;
    P.health = Math.max(0, P.health - amount);
    P.lastDamageSource = source || null;
    if (!bypass) invuln = INVULN_TIME;
    shake = Math.min(1, shake + 0.3 + amount * 0.02);
    if (dir && Number.isFinite(dir.x) && Number.isFinite(dir.z) && !P.climbing) {
      const l = Math.hypot(dir.x, dir.z);
      if (l > 1e-4) {
        const kx = dir.x / l, kz = dir.z / l;
        const push = P.inWater ? 1.6 : 2.4;
        P.velocity.x += kx * push;
        P.velocity.z += kz * push;
        if (P.onGround) { P.velocity.y = 1.6; P.onGround = false; }
        const side = kx * Math.cos(P.yaw) - kz * Math.sin(P.yaw);
        hurtRoll = clamp(hurtRoll + (side >= 0 ? -1 : 1) * 0.12, -0.2, 0.2);
      }
    } else hurtRoll = clamp(hurtRoll + (Math.random() < 0.5 ? -1 : 1) * 0.05, -0.2, 0.2);
    G.sfx('hurt', { volume: bypass ? 0.55 : 1 });
    G.events.emit('player:damaged', { amount, source: source || null });
    if (P.health <= 0) die(source);
    return true;
  }

  function die(source) {
    if (!P.alive) return;
    P.alive = false;
    P.health = 0;
    releaseButtons();
    unequip();
    P.hand.visible = false;
    P.sprinting = false;
    diedInWater = P.inWater;
    deathT = 0;
    const cam = G.camera;
    if (cam) { deathY0 = cam.position.y; deathPitch0 = cam.rotation.x; deathRoll0 = cam.rotation.z; }
    G.sfx('death');
    G.gameOver(reasonFor(source));
  }

  function isDrink(def) { return !!def && def.category === 'water'; }
  function isRaw(def) { return !!def && !def.cooked && !!(G.items && G.items.cookResult && G.items.cookResult(def.id)); }

  // Apply an item's food values without touching the inventory.
  function applyFood(id) {
    const def = itemDef(id);
    if (!def || !def.food || !P.alive) return false;
    const f = def.food;
    P.hunger = clamp(P.hunger + (Number(f.hunger) || 0), 0, 100);
    P.thirst = clamp(P.thirst + (Number(f.thirst) || 0), 0, 100);
    const hp = Number(f.health) || 0;
    const drink = isDrink(def);
    G.sfx(drink ? 'drink' : 'eat');
    G.events.emit(drink ? 'player:drank' : 'player:ate', { id });
    if (hp > 0) P.heal(hp);
    if (id === 'kelimek_slany') G.notify('Fuj, slaná! Mořská voda žízeň nezažene.', 'warn');
    else if (hp < 0 && isRaw(def)) {
      G.notify(/^(sardinka|makrela|tunak)/.test(id) ? 'Syrová ryba ti moc nesedla.' : 'Syrové maso ti moc nesedlo.', 'warn');
    }
    if (hp < 0) hurt(-hp, id === 'kelimek_slany' ? 'saltwater' : 'food', null, true);
    return true;
  }

  // Eat / drink one `id` from the inventory (the held stack first) and give back the cup.
  function eat(id) {
    const def = itemDef(id);
    if (!def || !def.food || !P.alive) return false;
    const inv = G.inventory;
    const ret = def.food.returns;
    if (inv) {
      const sel = inv.getSelected();
      if (sel && sel.id === id) {
        if (ret) inv.replaceSelected(ret, 'return');
        else inv.consumeSelected(1);
      } else {
        if (!inv.remove(id, 1)) return false;
        if (ret) {
          const left = inv.add(ret, 1, 'return');
          if (left > 0 && G.debris && typeof G.debris.spawnItem === 'function') {
            P.forward(_v);
            _n.set(P.position.x + _v.x * 1.2, 0, P.position.z + _v.z * 1.2);
            try { G.debris.spawnItem(ret, left, _n.clone()); } catch (e) { /* lost cup */ }
          }
        }
      }
    }
    return applyFood(id);
  }

  // ---------------------------------------------------------------------------
  // Movement
  // ---------------------------------------------------------------------------
  function wishDir(ctl, out) {
    let ax = 0, ay = 0;
    if (ctl) { const a = G.input.axes(); ax = a.x; ay = a.y; }
    const sy = Math.sin(P.yaw), cy = Math.cos(P.yaw);
    out.x = -sy * ay + cy * ax;
    out.z = -cy * ay - sy * ax;
    out.y = ay;               // forward component (for sprint)
    return ax * ax + ay * ay > 0.01;
  }
  const _wish = { x: 0, y: 0, z: 0 };

  // Keep the swimmer's circle out of raft tiles. Returns true if the centre is inside a tile.
  function pushOutOfRaft() {
    const R = raftOK();
    if (!R) return false;
    const pos = P.position, vel = P.velocity;
    if (tileAtCell(Math.floor(pos.x / TILE), Math.floor(pos.z / TILE))) return true;
    for (let pass = 0; pass < 2; pass++) {
      const i0 = Math.floor((pos.x - RAD) / TILE), i1 = Math.floor((pos.x + RAD) / TILE);
      const j0 = Math.floor((pos.z - RAD) / TILE), j1 = Math.floor((pos.z + RAD) / TILE);
      let moved = false;
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          if (!tileAtCell(i, j)) continue;
          const cx = clamp(pos.x, i * TILE, (i + 1) * TILE), cz = clamp(pos.z, j * TILE, (j + 1) * TILE);
          const dx = pos.x - cx, dz = pos.z - cz, d2 = dx * dx + dz * dz;
          if (d2 >= RAD * RAD || d2 < 1e-12) continue;
          const d = Math.sqrt(d2), nx = dx / d, nz = dz / d, push = RAD - d;
          pos.x += nx * push; pos.z += nz * push;
          const vn = vel.x * nx + vel.z * nz;
          if (vn < 0) { vel.x -= vn * nx; vel.z -= vn * nz; }
          moved = true;
        }
      }
      if (!moved) break;
    }
    return false;
  }

  // Nearest raft tile edge within `reach` of (x, z); sets the climb target. Returns bool.
  function raftEdgeNear(x, z, reach) {
    const R = raftOK();
    if (!R) return false;
    const i0 = Math.floor((x - reach) / TILE), i1 = Math.floor((x + reach) / TILE);
    const j0 = Math.floor((z - reach) / TILE), j1 = Math.floor((z + reach) / TILE);
    let best = Infinity, bi = 0, bj = 0, bx = 0, bz = 0;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        if (!tileAtCell(i, j)) continue;
        const cx = clamp(x, i * TILE, (i + 1) * TILE), cz = clamp(z, j * TILE, (j + 1) * TILE);
        const d = Math.hypot(x - cx, z - cz);
        if (d < best) { best = d; bi = i; bj = j; bx = cx; bz = cz; }
      }
    }
    if (best > reach) return false;
    let dx = bx - x, dz = bz - z;
    let l = Math.hypot(dx, dz);
    if (l < 1e-4) { dx = (bi + 0.5) * TILE - x; dz = (bj + 0.5) * TILE - z; l = Math.hypot(dx, dz) || 1; }
    dx /= l; dz /= l;
    climbTX = clamp(bx + dx * 0.65, bi * TILE + 0.3, (bi + 1) * TILE - 0.3);
    climbTZ = clamp(bz + dz * 0.65, bj * TILE + 0.3, (bj + 1) * TILE - 0.3);
    return true;
  }

  function landed(speed) {
    if (speed > 2.5) {
      landDip = -clamp(speed * 0.017, 0, 0.17);
      G.sfx('step', { volume: clamp(speed / 10, 0.3, 0.8) });
    }
  }

  function enterWater(vy) {
    const pos = P.position;
    P.onGround = false;
    P.groundProvider = null;
    P.groundKind = 'water';
    P.sprinting = false;
    const s = waveH(pos.x, pos.z);
    _v.set(pos.x, s, pos.z);
    const impact = Math.max(0, -vy);
    if (G.fx) G.fx.splash(_v, clamp(0.7 + impact * 0.12, 0.7, 2.2));
    G.sfx('splash_big', { position: _v, volume: clamp(0.55 + impact * 0.07, 0.55, 1) });
    P.velocity.y = Math.min(0, P.velocity.y) * 0.6;
    strokeT = 0;
    setWater(true);
    if (!waterTipShown) {
      waterTipShown = true;
      const R = raftOK();
      if (R && Math.hypot(pos.x, pos.z) < 25) {
        G.notify('Žbluňk! Jsi v moři. U okraje voru vylezeš ' + (G.input.touchMode ? 'tlačítkem ⤒.' : 'mezerníkem.'), 'info');
      }
    }
  }

  function startClimb() {
    const pos = P.position;
    climbT = 0;
    climbFrom.copy(pos);
    P.climbing = true;
    P.velocity.set(0, 0, 0);
    setWater(false);
    P.groundKind = null;
    _v.set(pos.x, waveH(pos.x, pos.z), pos.z);
    if (G.fx) G.fx.splash(_v, 0.6);
    G.sfx('splash', { position: _v, volume: 0.7 });
  }

  function moveClimb(dt) {
    const pos = P.position;
    climbT += dt / CLIMB_TIME;
    const t = Math.min(1, climbT);
    const d = deckY();
    const up = easeOut(t / 0.55), mv = ease((t - 0.3) / 0.7);
    pos.y = climbFrom.y + (d - climbFrom.y) * up + Math.sin(Math.PI * t) * 0.14;
    pos.x = climbFrom.x + (climbTX - climbFrom.x) * mv;
    pos.z = climbFrom.z + (climbTZ - climbFrom.z) * mv;
    if (t >= 1) {
      climbT = -1;
      P.climbing = false;
      pos.y = d;
      P.velocity.set(0, 0, 0);
      const g = sampleGround(pos.x, pos.z, d + 0.1, false);
      P.onGround = !!g;
      P.groundProvider = g ? g.p : null;
      P.groundKind = g ? g.p.kind || 'ground' : null;
      landDip = -0.07;
      G.sfx('step', { volume: 0.6 });
    }
  }

  function moveWalk(dt, ctl) {
    const inp = G.input, pos = P.position, vel = P.velocity;
    const moving = wishDir(ctl, _wish);
    const sprintIn = ctl && (inp.down('ShiftLeft') || inp.down('ShiftRight') ||
      (inp.touchMode && Math.hypot(inp.move.x, inp.move.y) > 0.95));
    P.sprinting = !!(sprintIn && moving && _wish.y > 0.3);
    let speed = P.sprinting ? SPRINT : WALK;
    const wade = waveH(pos.x, pos.z) - pos.y;
    if (wade > 0.25) speed *= clamp(1 - (wade - 0.25) * 0.6, 0.5, 1);
    const k = P.onGround ? 12 : 2.2;
    vel.x = damp(vel.x, _wish.x * speed, k, dt);
    vel.z = damp(vel.z, _wish.z * speed, k, dt);

    // jump (with a little coyote time and input buffering)
    if (P.onGround) coyote = 0.1; else coyote -= dt;
    if (ctl && inp.pressed('Space')) jumpBuf = 0.15; else jumpBuf -= dt;
    if (jumpBuf > 0 && coyote > 0 && vel.y <= 0.5) {
      vel.y = JUMP_V;
      jumpBuf = 0; coyote = 0;
      P.onGround = false;
      G.sfx('jump', { volume: 0.5 });
    }
    vel.y = Math.max(-40, vel.y - G.C.GRAVITY * dt);

    // ride moving ground (islands)
    const prov = P.onGround ? P.groundProvider : null;
    if (prov && prov.velocity && Number.isFinite(prov.velocity.x)) {
      pos.x += prov.velocity.x * dt;
      pos.z += prov.velocity.z * dt;
    }

    // horizontal move; terrain higher than a step blocks (slide along the other axis)
    const ox = pos.x, oz = pos.z, prevY = pos.y;
    let nx = ox + vel.x * dt, nz = oz + vel.z * dt;
    const lim = prevY + STEP_UP;
    if (wallAt(nx, nz, lim, false)) {
      if (!wallAt(nx, oz, lim, false)) { nz = oz; vel.z = 0; }
      else if (!wallAt(ox, nz, lim, false)) { nx = ox; vel.x = 0; }
      else { nx = ox; nz = oz; vel.x = 0; vel.z = 0; }
    }
    pos.x = nx; pos.z = nz;
    if (pos.y < deckY() - STEP_UP && pushOutOfRaft()) {
      // somehow inside the raft body: put back on the deck
      pos.y = deckY();
      vel.y = 0;
    }

    // vertical + ground
    pos.y += vel.y * dt;
    const wasOn = P.onGround;
    const g = sampleGround(pos.x, pos.z, Math.max(prevY, pos.y) + STEP_UP, false);
    const gh = g ? g.h : -Infinity, gp = g ? g.p : null;
    if (gp && vel.y <= 0 && pos.y <= gh + (wasOn ? 0.08 : 0)) {
      const rise = gh - prevY;
      if (wasOn && rise > 0.06) stepOffset = Math.max(-0.5, stepOffset - rise);
      if (!wasOn) landed(-vel.y);
      pos.y = gh;
      vel.y = 0;
      P.onGround = true;
      P.groundProvider = gp;
      P.groundKind = gp.kind || 'ground';
    } else {
      P.onGround = false;
      P.groundProvider = null;
      P.groundKind = null;
    }

    // into the sea?
    const surf = waveH(pos.x, pos.z);
    const depth = surf - pos.y;
    if (P.onGround) {
      if (depth > WADE + 0.12 && gp && gp.kind !== 'raft') enterWater(vel.y);
    } else if (depth > 0.08 && (!gp || gh < surf - WADE)) {
      enterWater(vel.y);
    }
  }

  function moveSwim(dt, ctl) {
    const inp = G.input, pos = P.position, vel = P.velocity;
    const moving = wishDir(ctl, _wish);
    P.sprinting = false;
    const dv = G.world && G.world.driftVelocity;
    const dx = dv ? dv.x * 0.5 : 0, dz = dv ? dv.z * 0.5 : 0;
    vel.x = damp(vel.x, _wish.x * SWIM + dx, 3.2, dt);
    vel.z = damp(vel.z, _wish.z * SWIM + dz, 3.2, dt);

    // spring the head to the (moving) surface; a hard entry dips you under for a moment
    const surf = waveH(pos.x, pos.z);
    const ty = surf + SWIM_EYE - EYE_H;
    vel.y += ((ty - pos.y) * 30 - vel.y * 7.5) * dt;

    const ox = pos.x, oz = pos.z;
    let nx = ox + vel.x * dt, nz = oz + vel.z * dt;
    const lim = surf + SHORE_UP;
    if (wallAt(nx, nz, lim, true)) {
      if (!wallAt(nx, oz, lim, true)) { nz = oz; vel.z = 0; }
      else if (!wallAt(ox, nz, lim, true)) { nx = ox; vel.x = 0; }
      else { nx = ox; nz = oz; vel.x = 0; vel.z = 0; }
    }
    pos.x = nx; pos.z = nz;
    pos.y += vel.y * dt;

    // never under the raft: push out of tiles; a tile right under the centre → climb onto it
    if (pushOutOfRaft()) {
      climbTX = pos.x; climbTZ = pos.z;
      startClimb();
      return;
    }

    // walk out onto a shore (islands): ground close enough under the surface
    const g = sampleGround(pos.x, pos.z, lim, true);
    if (g && g.h > surf - WADE) {
      const gh = g.h, gp = g.p;
      setWater(false);
      if (gh > pos.y) { stepOffset = Math.max(-0.9, stepOffset - (gh - pos.y)); pos.y = gh; }
      vel.y = 0;
      P.onGround = true;
      P.groundProvider = gp;
      P.groundKind = gp.kind || 'ground';
      canClimbNow = false;
      return;
    }

    // climb onto the raft
    canClimbNow = raftEdgeNear(pos.x, pos.z, CLIMB_REACH);
    if (ctl && canClimbNow && inp.pressed('Space')) { startClimb(); return; }

    // swim strokes
    strokeT += dt;
    if (moving && strokeT > 0.85) {
      strokeT = 0;
      strokePulse = 1;
      _v.set(pos.x, surf, pos.z);
      G.sfx('swim', { position: _v, volume: 0.5 });
    }
  }

  // Put the player at (x, z): on the ground there if any, otherwise swimming at the surface.
  function placeAt(x, z) {
    const pos = P.position;
    pos.set(x, pos.y, z);
    P.velocity.set(0, 0, 0);
    climbT = -1;
    P.climbing = false;
    const surf = waveH(x, z);
    const g = sampleGround(x, z, Infinity, false);
    if (g && g.h > surf - WADE) {
      pos.y = g.h;
      P.onGround = true;
      P.groundProvider = g.p;
      P.groundKind = g.p.kind || 'ground';
      setWater(false);
    } else {
      pos.y = surf + SWIM_EYE - EYE_H;
      P.onGround = false;
      P.groundProvider = null;
      P.groundKind = 'water';
      setWater(true);
    }
    stepOffset = 0; landDip = 0;
  }

  // ---------------------------------------------------------------------------
  // Camera & hand
  // ---------------------------------------------------------------------------
  function updateCamera(dt) {
    const cam = G.camera;
    if (!cam) return;
    const pos = P.position, vel = P.velocity;
    const hs = Math.hypot(vel.x, vel.z);

    if (P.onGround && hs > 0.4) {
      bobPhase += dt * hs * 1.95;
      bobAmp = damp(bobAmp, Math.min(1.25, hs / WALK), 8, dt);
      const si = Math.floor((bobPhase - Math.PI * 0.75) / Math.PI);
      if (si !== stepIdx) {
        stepIdx = si;
        if (waveH(pos.x, pos.z) - pos.y > 0.2) G.sfx('swim', { volume: 0.3 });    // wading
        else G.sfx('step', { volume: P.sprinting ? 0.42 : 0.28 });
      }
    } else bobAmp = damp(bobAmp, 0, 7, dt);
    const bobY = Math.sin(bobPhase * 2) * 0.03 * bobAmp;
    const bobX = Math.sin(bobPhase) * 0.028 * bobAmp;
    landDip = damp(landDip, 0, 6, dt);
    stepOffset = damp(stepOffset, 0, 12, dt);
    strokePulse = Math.max(0, strokePulse - dt * 2.2);

    // sway with the waves (on the raft a little, in the water more)
    let k = 0;
    if (P.inWater) k = 0.5;
    else if (P.onGround && P.groundKind === 'raft') k = 0.16;
    let rollT = 0, pitchT = 0;
    if (k > 0 && G.world && typeof G.world.waveNormal === 'function') {
      G.world.waveNormal(pos.x, pos.z, _n);
      const sy = Math.sin(P.yaw), cy = Math.cos(P.yaw);
      rollT = -(_n.x * cy - _n.z * sy) * k;
      pitchT = (-_n.x * sy - _n.z * cy) * k * 0.4;
    }
    rollS = damp(rollS, rollT, 2.5, dt);
    pitchS = damp(pitchS, pitchT, 2.5, dt);

    shake *= Math.exp(-5 * dt);
    hurtRoll = damp(hurtRoll, 0, 5, dt);
    const sh = shake * shake;
    const shx = (Math.sin(clock * 61) + Math.sin(clock * 37 + 1.3) * 0.6) * 0.035 * sh;
    const shy = (Math.sin(clock * 53 + 0.7) + Math.sin(clock * 29 + 2.1) * 0.6) * 0.035 * sh;
    const climbPitch = P.climbing ? -0.32 * Math.sin(Math.PI * clamp(climbT, 0, 1)) : 0;
    const swimLift = P.inWater ? Math.sin(strokePulse * Math.PI) * 0.035 : 0;

    const rx = Math.cos(P.yaw), rz = -Math.sin(P.yaw);
    cam.position.set(
      pos.x + rx * (bobX + shx),
      pos.y + EYE_H + bobY + landDip + stepOffset + swimLift + shy,
      pos.z + rz * (bobX + shx));
    cam.rotation.set(
      clamp(P.pitch + pitchS + climbPitch + shy * 0.6, -1.55, 1.55),
      P.yaw + shx * 0.5,
      rollS + hurtRoll + Math.sin(bobPhase) * 0.008 * bobAmp);

    const fovT = baseFov + (P.sprinting && hs > WALK + 0.2 ? 6 : 0);
    fovCur = damp(fovCur, fovT, 5, dt);
    if (Math.abs(cam.fov - fovCur) > 0.01) { cam.fov = fovCur; cam.updateProjectionMatrix(); }
  }

  function updateHand(dt) {
    const hand = P.hand;
    equipT = Math.min(1, equipT + dt / 0.28);
    const ek = ease(equipT);
    lagX = damp(lagX, clamp(-lookDX * 0.0011, -0.07, 0.07), 10, dt);
    lagY = damp(lagY, clamp(-lookDY * 0.0011, -0.07, 0.07), 10, dt);
    handVy = damp(handVy, P.onGround || P.inWater ? 0 : clamp(-P.velocity.y * 0.005, -0.035, 0.035), 8, dt);
    lowK = damp(lowK, P.climbing ? 1 : 0, 10, dt);
    swimK = damp(swimK, P.inWater ? 1 : 0, 4, dt);
    const bx = Math.sin(bobPhase) * 0.012 * bobAmp;
    const by = -Math.abs(Math.cos(bobPhase)) * 0.012 * bobAmp;
    const ix = Math.sin(clock * 0.9) * 0.003, iy = Math.sin(clock * 1.7) * 0.004;
    const sw = swimK * (Math.sin(clock * 2.4) * 0.012 - Math.sin(strokePulse * Math.PI) * 0.03);
    // narrow (portrait phone) screens: pull the held item in so it stays on screen, and make it
    // smaller so it does not cover the crosshair
    const aspect = G.camera ? G.camera.aspect : 1.78;
    const hx = Math.min(HAND_X, 0.21 * aspect);
    const hs = clamp(aspect / 1.2, 0.62, 1);
    if (Math.abs(hand.scale.x - hs) > 1e-3) hand.scale.setScalar(hs);
    hand.position.set(
      hx + lagX * 0.4 + bx + ix,
      HAND_Y + lagY * 0.4 + by + iy + handVy + landDip * 0.35 - (1 - ek) * 0.3 - lowK * 0.45 - swimK * 0.04 + sw,
      HAND_Z);
    hand.rotation.set(
      lagY * 1.1 - (1 - ek) * 0.7 + swimK * 0.08,
      lagX * 1.4,
      lagX * 0.5 + Math.sin(bobPhase) * 0.02 * bobAmp);
    hand.visible = true;
  }

  function deathCamera(dt) {
    const cam = G.camera;
    if (!cam) return;
    deathT += dt;
    const k = ease(deathT / 1.8);
    const pos = P.position;
    let ty;
    if (diedInWater) ty = waveH(cam.position.x, cam.position.z) - 0.9 - Math.min(2.5, deathT * 0.25);
    else {
      const g = sampleGround(pos.x, pos.z, pos.y + 0.6, false);
      ty = (g ? g.h : pos.y) + 0.28;
    }
    cam.position.y = deathY0 + (ty - deathY0) * k;
    cam.rotation.x = deathPitch0 + ((diedInWater ? 0.45 : 0.05) - deathPitch0) * k;
    cam.rotation.z = deathRoll0 + (0.6 - deathRoll0) * k;
  }

  // ---------------------------------------------------------------------------
  // Held items: equip / dispatch
  // ---------------------------------------------------------------------------
  function toolIdFor(def) {
    if (!def) return null;
    if (def.category === 'placeable' || def.place) return 'place';
    if (def.food) return 'consume';
    return def.tool || null;
  }

  function equip(index, slot) {
    held.index = index;
    held.id = slot ? slot.id : null;
    held.lmb = held.rmb = false;
    equipT = 0;
    G.hud.setToolHint('');
    if (!slot) return;
    const def = itemDef(slot.id);
    const toolId = toolIdFor(def);
    const h = toolId ? G.tools.get(toolId) : null;
    held.toolId = toolId;
    held.handler = h;
    if (h) hcall(h, 'onEquip', slot);
    const vm = h && h.viewModel && h.viewModel.isObject3D ? h.viewModel : null;
    if (vm) {
      P.hand.add(vm);
      held.vm = vm;
    } else if (genericHolder) {
      const m = heldModelFor(slot.id);
      genericHolder.add(m);
      P.hand.add(genericHolder);
      held.vm = genericHolder;
    }
  }

  function unequip() {
    const h = held.handler;
    if (h) {
      releaseButtons();
      hcall(h, 'onUnequip');
    }
    if (held.vm) {
      P.hand.remove(held.vm);
      if (held.vm === genericHolder) genericHolder.clear();
    }
    if (h || held.id) G.hud.setToolHint('');
    held.index = -1;
    held.id = null;
    held.toolId = null;
    held.handler = null;
    held.vm = null;
    held.lmb = held.rmb = false;
    climbHintShown = false;
  }

  function releaseButtons() {
    const h = held.handler;
    const s = G.inventory && G.inventory.getSelected ? G.inventory.getSelected() : null;
    if (held.lmb) { held.lmb = false; hcall(h, 'primaryUp', s); }
    if (held.rmb) { held.rmb = false; hcall(h, 'secondaryUp', s); }
  }

  function syncEquip() {
    const inv = G.inventory;
    if (!inv || typeof inv.getSelected !== 'function') return null;
    const slot = inv.getSelected();
    const idx = inv.selected;
    const id = slot ? slot.id : null;
    if (idx !== held.index || id !== held.id) {
      unequip();
      equip(idx, slot);
    }
    return slot;
  }

  function updateHeld(dt, ctl) {
    const inp = G.input;
    let slot = syncEquip();
    const h = held.handler;
    if (h) {
      const active = ctl && !P.climbing;
      let dispatched = false;
      if (active && inp.mousePressed(0) && !held.lmb) { held.lmb = true; hcall(h, 'primaryDown', slot); dispatched = true; }
      if (active && inp.mousePressed(2) && !held.rmb) { held.rmb = true; hcall(h, 'secondaryDown', slot); dispatched = true; }
      if (held.lmb && (!active || !inp.mouseDown(0))) { held.lmb = false; hcall(h, 'primaryUp', slot); }
      if (held.rmb && (!active || !inp.mouseDown(2))) { held.rmb = false; hcall(h, 'secondaryUp', slot); }
      if (dispatched) slot = syncEquip();     // the action may have used up / replaced the item
    }
    const h2 = held.handler;
    if (h2) {
      hcall(h2, 'update', dt, slot);
      if (!P.alive || held.handler !== h2) return;
      if (typeof h2.hint === 'function') {
        const t = hcall(h2, 'hint', slot);
        if (typeof t === 'string') G.hud.setToolHint(t);
      }
    }
    // swimming next to the raft: the climb prompt wins
    const showClimb = P.inWater && canClimbNow && !P.climbing;
    if (showClimb) {
      G.hud.setToolHint(btnJump() + ': Vylézt na vor');
      climbHintShown = true;
    } else if (P.inWater && farNow) {
      G.hud.setToolHint('Vor je daleko – plav zpátky!');
      climbHintShown = true;
    } else if (climbHintShown) {
      climbHintShown = false;
      if (!h2 || typeof h2.hint !== 'function') G.hud.setToolHint('');
    }
  }

  function setOverride(o) {
    if (o === P.controlOverride) return;
    if (o) {
      releaseButtons();
      unequip();
      P.hand.visible = false;
      P.velocity.x = P.velocity.z = 0;
      P.sprinting = false;
    }
    P.controlOverride = o;
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------
  function updateStats(dt) {
    if (P.god || !P.alive) return;
    const moving = Math.hypot(P.velocity.x, P.velocity.z) > 0.5;
    const mult = P.inWater || (P.sprinting && moving) ? 1.5 : 1;
    P.hunger = Math.max(0, P.hunger - HUNGER_RATE * mult * dt);
    P.thirst = Math.max(0, P.thirst - THIRST_RATE * mult * dt);

    if (P.hunger <= 0) {
      starveH += dt;
      if (starveH >= 1) { starveH -= 1; hurt(STARVE_DPS, 'hunger', null, true); }
    } else starveH = 0;
    if (!P.alive) return;
    if (P.thirst <= 0) {
      starveT += dt;
      if (starveT >= 1) { starveT -= 1; hurt(STARVE_DPS, 'thirst', null, true); }
    } else starveT = 0;
    if (!P.alive) return;

    if (P.hunger > 50 && P.thirst > 50 && P.health < P.maxHealth) {
      P.health = Math.min(P.maxHealth, P.health + REGEN_HPS * dt);
    }

    if (!warnH && P.hunger < 20) { warnH = true; G.notify('Máš hlad. Sněz něco!', 'warn'); }
    else if (warnH && P.hunger > 30) warnH = false;
    if (!warnT && P.thirst < 20) { warnT = true; G.notify('Máš žízeň. Napij se!', 'warn'); }
    else if (warnT && P.thirst > 30) warnT = false;
    if (!warnH0 && P.hunger <= 0) { warnH0 = true; G.notify('Umíráš hlady! Rychle něco sněz.', 'danger'); }
    else if (warnH0 && P.hunger > 5) warnH0 = false;
    if (!warnT0 && P.thirst <= 0) { warnT0 = true; G.notify('Umíráš žízní! Rychle se napij.', 'danger'); }
    else if (warnT0 && P.thirst > 5) warnT0 = false;
  }

  // Swimming far from the raft with no island around: warn once (re-armed back on the raft).
  function checkFar(dt) {
    const pos = P.position;
    farCheckT -= dt;
    if (P.inWater) {
      if (farCheckT > 0) return;
      farCheckT = 0.5;
      const R = raftOK();
      const r = R && typeof R.radius === 'function' ? R.radius() : 3;
      const d = Math.hypot(pos.x, pos.z) - r;
      farNow = d > FAR_SWIM && islandDist() > 40;
      if (farNow && !farWarned) {
        farWarned = true;
        G.notify('Plav zpátky k voru!', 'warn');
      }
    } else {
      farNow = false;
      farCheckT = 0;
      if (P.onGround && P.groundKind === 'raft') farWarned = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Main update
  // ---------------------------------------------------------------------------
  function update(dt) {
    if (!P.alive) return;
    clock += dt;
    if (invuln > 0) invuln -= dt;
    const inp = G.input;
    const ov = P.controlOverride;
    const ctl = !ov && !G.uiBlocking();

    // look
    lookDX = lookDY = 0;
    if (!ov && inp.looking()) {
      const k = LOOK_K * (Number(G.settings.sensitivity) || 1);
      lookDX = inp.mouse.dx; lookDY = inp.mouse.dy;
      P.yaw -= lookDX * k;
      P.pitch -= lookDY * k * (G.settings.invertY ? -1 : 1);
      P.pitch = clamp(P.pitch, -PITCH_MAX, PITCH_MAX);
      if (P.yaw > Math.PI) P.yaw -= Math.PI * 2;
      else if (P.yaw < -Math.PI) P.yaw += Math.PI * 2;
    }

    // move (an active control override suspends movement entirely)
    canClimbNow = false;
    if (ov) { P.velocity.set(0, 0, 0); P.sprinting = false; }
    else if (P.climbing) moveClimb(dt);
    else if (P.inWater) moveSwim(dt, ctl);
    else moveWalk(dt, ctl);

    const pos = P.position;
    if (!Number.isFinite(pos.x + pos.y + pos.z) || pos.y < -40) {
      pos.set(0, deckY(), 0);
      P.velocity.set(0, 0, 0);
      placeAt(0, 0);
    }

    // camera / override
    if (ov) {
      P.hand.visible = false;
      if (typeof ov.update === 'function') {
        try { ov.update(dt); } catch (err) {
          if (!failed.has('override')) { failed.add('override'); console.error('[player] control override failed', err); }
        }
      }
    } else {
      updateCamera(dt);
    }

    // held item
    if (!ov && P.alive) {
      updateHeld(dt, ctl);
      if (P.alive) updateHand(dt);
    } else if (held.handler || held.id) unequip();

    updateStats(dt);
    if (P.alive) checkFar(dt);
  }

  function frame(dt) {
    const st = G.state;
    if (st === 'menu' || st === 'boot') {
      P.hand.visible = false;
      const cam = G.camera;
      if (cam && Math.abs(cam.fov - baseFov) > 0.01) { cam.fov = baseFov; cam.updateProjectionMatrix(); }
      return;
    }
    if (st === 'dead') {
      P.hand.visible = false;
      if (!P.alive && !G.paused) deathCamera(dt);
    }
  }

  // ---------------------------------------------------------------------------
  // Held models (shared, built once per item id)
  // ---------------------------------------------------------------------------
  const GEO = {};
  const MAT = {};
  const matCache = new Map();
  const modelCache = new Map();

  function std(color, opts) {
    return new THREE.MeshStandardMaterial(Object.assign({ color, flatShading: true, roughness: 0.8, metalness: 0 }, opts || null));
  }
  function matFor(color) {
    const key = String(color);
    let m = matCache.get(key);
    if (!m) { m = std(new THREE.Color(color)); matCache.set(key, m); }
    return m;
  }
  function part(geo, material, sx, sy, sz, x, y, z, rx, ry, rz) {
    const m = new THREE.Mesh(geo, material);
    m.scale.set(sx, sy, sz);
    m.position.set(x || 0, y || 0, z || 0);
    m.rotation.set(rx || 0, ry || 0, rz || 0);
    return m;
  }

  function buildShared() {
    GEO.sphere = new THREE.SphereGeometry(1, 8, 6);
    GEO.ico = new THREE.IcosahedronGeometry(1, 1);
    GEO.dodeca = new THREE.DodecahedronGeometry(1, 0);
    GEO.cone4 = new THREE.ConeGeometry(1, 1, 4);
    GEO.cone3 = new THREE.ConeGeometry(1, 1, 3);
    GEO.cyl6 = new THREE.CylinderGeometry(1, 1, 1, 6);
    GEO.cyl10 = new THREE.CylinderGeometry(1, 1, 1, 10);
    GEO.box = new THREE.BoxGeometry(1, 1, 1);
    GEO.card = new THREE.BoxGeometry(0.15, 0.15, 0.024);
    // a plastic cup: outer wall, rim, inner wall
    const pts = [
      [0, 0], [0.033, 0], [0.036, 0.004], [0.05, 0.112], [0.054, 0.116], [0.052, 0.12],
      [0.047, 0.118], [0.044, 0.112], [0.031, 0.009], [0, 0.009],
    ].map((p) => new THREE.Vector2(p[0], p[1]));
    GEO.cup = new THREE.LatheGeometry(pts, 12);
    GEO.cupStripe = new THREE.CylinderGeometry(0.0478, 0.0462, 0.02, 12, 1, true);
    GEO.water = new THREE.CylinderGeometry(0.043, 0.043, 0.004, 12);
    GEO.spearShaft = new THREE.CylinderGeometry(0.016, 0.02, 1.5, 6);

    MAT.wood = std(0xa4774a);
    MAT.woodDark = std(0x6e4b2c);
    MAT.rope = std(0xcfae72, { roughness: 0.95 });
    MAT.grip = std(0x5a3a22, { roughness: 0.9 });
    MAT.metal = std(0xc3cad0, { metalness: 0.6, roughness: 0.35, emissive: 0x20262c, emissiveIntensity: 0.6 });
    MAT.cloth = std(0xc8503a, { side: THREE.DoubleSide });
    MAT.cup = std(0xf0e8d6, { roughness: 0.5, side: THREE.DoubleSide });
    MAT.cupStripe = std(0x3a8fb0, { roughness: 0.5, side: THREE.DoubleSide });
    MAT.salt = std(0x2c7f9e, { roughness: 0.15, metalness: 0.1 });
    MAT.fresh = std(0x9fe0f7, { roughness: 0.1, metalness: 0.1, emissive: 0x1d4a5a, emissiveIntensity: 0.4 });
    MAT.black = std(0x111111, { roughness: 0.4 });
    MAT.bone = std(0xefe6d2);
    MAT.fat = std(0xf2d6c8);
    MAT.grill = std(0x4a2c16);
    MAT.coco = std(0x6b4a2b, { roughness: 1 });
    MAT.cocoIn = std(0xf4efe2);
    MAT.straw = std(0xe8643c);
  }

  function cupModel(waterMat) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(GEO.cup, MAT.cup));
    const st = new THREE.Mesh(GEO.cupStripe, MAT.cupStripe);
    st.position.y = 0.085;
    g.add(st);
    if (waterMat) {
      const w = new THREE.Mesh(GEO.water, waterMat);
      w.position.y = 0.097;
      g.add(w);
    }
    g.position.set(-0.01, 0.01, 0);
    g.rotation.set(0.38, 0, -0.08);
    g.scale.setScalar(0.8);
    const outer = new THREE.Group();
    outer.add(g);
    return outer;
  }

  function fishModel(def, s, cooked) {
    const g = new THREE.Group();
    const body = matFor(def.color);
    g.add(part(GEO.sphere, body, 0.12 * s, 0.042 * s, 0.026 * s));
    g.add(part(GEO.cone4, body, 0.05 * s, 0.075 * s, 0.012 * s, 0.148 * s, 0, 0, 0, 0, Math.PI / 2));
    g.add(part(GEO.cone3, body, 0.022 * s, 0.05 * s, 0.006 * s, 0.01 * s, 0.045 * s, 0, 0, 0, -0.5));
    g.add(part(GEO.sphere, MAT.black, 0.008 * s, 0.008 * s, 0.008 * s, -0.082 * s, 0.01 * s, 0.021 * s));
    if (cooked) {
      g.add(part(GEO.box, MAT.grill, 0.007 * s, 0.042 * s, 0.049 * s, -0.035 * s, 0.004 * s, 0, 0, 0, 0.3));
      g.add(part(GEO.box, MAT.grill, 0.007 * s, 0.036 * s, 0.045 * s, 0.035 * s, 0.003 * s, 0, 0, 0, 0.3));
    }
    g.rotation.set(0.15, 0.3, -0.35);
    g.position.set(-0.02, 0.03, 0);
    const outer = new THREE.Group();
    outer.add(g);
    return outer;
  }

  function coconutModel() {
    const g = new THREE.Group();
    g.add(part(GEO.ico, MAT.coco, 0.065, 0.06, 0.065));
    g.add(part(GEO.cyl10, MAT.cocoIn, 0.034, 0.008, 0.034, 0, 0.055, 0));
    g.add(part(GEO.cyl6, MAT.straw, 0.0055, 0.13, 0.0055, 0.018, 0.1, 0, 0, 0, -0.32));
    g.rotation.set(0.35, 0.2, 0);
    g.position.set(-0.01, 0.02, 0);
    const outer = new THREE.Group();
    outer.add(g);
    return outer;
  }

  function meatModel(def, cooked) {
    const g = new THREE.Group();
    const m = matFor(def.color);
    if (cooked) {
      g.add(part(GEO.dodeca, m, 0.07, 0.05, 0.055));
      g.add(part(GEO.cyl6, MAT.bone, 0.011, 0.12, 0.011, 0.1, 0, 0, 0, 0, Math.PI / 2));
      g.add(part(GEO.sphere, MAT.bone, 0.017, 0.017, 0.017, 0.16, 0.012, 0));
      g.add(part(GEO.sphere, MAT.bone, 0.017, 0.017, 0.017, 0.16, -0.012, 0));
    } else {
      g.add(part(GEO.dodeca, m, 0.078, 0.042, 0.06));
      g.add(part(GEO.dodeca, MAT.fat, 0.05, 0.02, 0.046, 0.02, 0.026, 0.004));
    }
    g.rotation.set(0.45, 0.4, -0.2);
    g.position.set(-0.02, 0.03, 0);
    const outer = new THREE.Group();
    outer.add(g);
    return outer;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // Generic held model: a small tinted card with the item's emoji.
  function cardModel(id, def) {
    const color = new THREE.Color(def && def.color ? def.color : '#8a8a8a');
    const icon = def && def.icon ? def.icon : '❔';
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const hi = color.clone().offsetHSL(0, 0, 0.14), lo = color.clone().offsetHSL(0, -0.05, -0.2);
    ctx.fillStyle = '#' + lo.clone().offsetHSL(0, 0, -0.12).getHexString();
    ctx.fillRect(0, 0, 128, 128);
    const grd = ctx.createLinearGradient(0, 0, 0, 128);
    grd.addColorStop(0, '#' + hi.getHexString());
    grd.addColorStop(1, '#' + lo.getHexString());
    ctx.fillStyle = grd;
    roundRect(ctx, 6, 6, 116, 116, 18);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255, 248, 230, 0.55)';
    roundRect(ctx, 12, 12, 104, 104, 14);
    ctx.stroke();
    ctx.font = '74px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 3;
    ctx.fillText(icon, 64, 70);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const face = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex,
      emissiveIntensity: 0.22, roughness: 0.75 });
    const edge = matFor('#' + lo.getHexString());
    const mesh = new THREE.Mesh(GEO.card, [edge, edge, edge, edge, face, edge]);
    mesh.rotation.set(-0.12, -0.42, 0.06);
    mesh.position.set(-0.03, 0.05, 0);
    const outer = new THREE.Group();
    outer.name = 'card-' + id;
    outer.add(mesh);
    return outer;
  }

  function heldModelFor(id) {
    let m = modelCache.get(id);
    if (m) return m;
    const def = itemDef(id);
    if (def) {
      if (id === 'kelimek') m = cupModel(null);
      else if (id === 'kelimek_slany') m = cupModel(MAT.salt);
      else if (id === 'kelimek_sladky') m = cupModel(MAT.fresh);
      else if (/^sardinka/.test(id)) m = fishModel(def, 0.8, !!def.cooked);
      else if (/^makrela/.test(id)) m = fishModel(def, 1.05, !!def.cooked);
      else if (/^tunak/.test(id)) m = fishModel(def, 1.3, !!def.cooked);
      else if (id === 'kokos') m = coconutModel();
      else if (id === 'zralok_maso') m = meatModel(def, false);
      else if (id === 'zralok_peceny') m = meatModel(def, true);
    }
    if (!m) m = cardModel(id, def);
    modelCache.set(id, m);
    return m;
  }

  // ---------------------------------------------------------------------------
  // Aim helpers for tools
  // ---------------------------------------------------------------------------
  // Ray from the eye along the view: does it reach the sea within maxDist (before the deck or
  // land)? Writes the hit point on the surface into `out`.
  function aimAtSea(maxDist, out) {
    P.eye(_ae);
    P.forward(_af);
    const R = raftOK();
    const dk = deckY();
    for (let t = 0.25; t <= maxDist; t += 0.1) {
      const x = _ae.x + _af.x * t, y = _ae.y + _af.y * t, z = _ae.z + _af.z * t;
      if (R && y <= dk + 0.05 && R.tileAt(x, z)) return false;
      const w = waveH(x, z);
      if (y < w + 3) {
        const g = sampleGround(x, z, Infinity, true);
        if (g && g.h >= y && g.h >= w - 0.02) return false;
      }
      if (y <= w) { out.set(x, w, z); return true; }
    }
    return false;
  }
  function seaInFront(out) {
    P.forward(_af);
    const l = Math.hypot(_af.x, _af.z) || 1;
    const x = P.position.x + (_af.x / l) * 0.6, z = P.position.z + (_af.z / l) * 0.6;
    out.set(x, waveH(x, z), z);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Tool: consume (food and drinks)
  // ---------------------------------------------------------------------------
  const consume = {
    viewModel: null,
    pivot: null,
    content: null,
    id: null,
    t: -1,
    itemId: null,
    done: false,

    setItem(id) {
      if (id === consume.id && consume.content && consume.content.parent === consume.pivot) return;
      if (consume.content && consume.content.parent === consume.pivot) consume.pivot.remove(consume.content);
      consume.id = id;
      consume.content = id ? heldModelFor(id) : null;
      if (consume.content) consume.pivot.add(consume.content);
    },
    onEquip(slot) {
      consume.t = -1;
      consume.done = false;
      if (consume.pivot) { consume.pivot.position.set(0, 0, 0); consume.pivot.rotation.set(0, 0, 0); }
      if (consume.pivot) consume.setItem(slot ? slot.id : null);
    },
    onUnequip() {
      consume.t = -1;
      if (consume.pivot) { consume.pivot.position.set(0, 0, 0); consume.pivot.rotation.set(0, 0, 0); }
      G.hud.setToolHint('');
    },
    primaryDown(slot) {
      if (consume.t >= 0 || !slot) return;
      const def = itemDef(slot.id);
      if (!def || !def.food) return;
      const f = def.food;
      const bad = f.thirst < 0 || f.health < 0;
      const useful = (f.hunger > 0 && P.hunger < 99) || (f.thirst > 0 && P.thirst < 99) ||
        (f.health > 0 && P.health < P.maxHealth - 1);
      if (!bad && !useful) {
        G.notify(isDrink(def) ? 'Teď nemáš žízeň.' : 'Teď nemáš hlad.', 'info');
        G.sfx('error', { volume: 0.35 });
        return;
      }
      consume.t = 0;
      consume.itemId = slot.id;
      consume.done = false;
    },
    primaryUp() {},
    secondaryDown() {},
    secondaryUp() {},
    update(dt, slot) {
      if (slot && slot.id !== consume.id) consume.setItem(slot.id);
      const p = consume.pivot;
      if (!p) return;
      if (consume.t >= 0) {
        consume.t += dt;
        const t = consume.t;
        const drink = isDrink(itemDef(consume.itemId));
        const k = ease(t / 0.38) * (1 - ease((t - 0.64) / 0.24));
        const chew = t > 0.36 && t < 0.62 ? Math.sin((t - 0.36) * 42) * 0.012 : 0;
        p.position.set(-0.19 * k, 0.13 * k + chew, 0.13 * k);
        p.rotation.set(drink ? 1.05 * k : 0.25 * k + chew * 4, drink ? 0.1 * k : 0.55 * k, drink ? -0.25 * k : chew * 3);
        if (!consume.done && t >= 0.6) {
          consume.done = true;
          if (slot && slot.id === consume.itemId) eat(consume.itemId);
        }
        if (t >= 0.9) consume.t = -1;
      } else {
        p.position.x = damp(p.position.x, 0, 12, dt);
        p.position.y = damp(p.position.y, Math.sin(clock * 2) * 0.004, 12, dt);
        p.position.z = damp(p.position.z, 0, 12, dt);
        p.rotation.x = damp(p.rotation.x, 0, 12, dt);
        p.rotation.y = damp(p.rotation.y, 0, 12, dt);
        p.rotation.z = damp(p.rotation.z, 0, 12, dt);
      }
    },
    hint(slot) {
      const def = slot && itemDef(slot.id);
      if (!def || !def.food) return '';
      if (slot.id === 'kelimek_slany') return btnL() + ': Vypít slanou vodu (škodí!) · vyčisti ji v čističce';
      if (isDrink(def)) return btnL() + ': Vypít';
      if (isRaw(def)) return btnL() + ': Sníst syrové · lepší je upéct na grilu';
      return btnL() + ': Sníst';
    },
  };

  // ---------------------------------------------------------------------------
  // Tool: cup (empty cup → scoop sea water)
  // ---------------------------------------------------------------------------
  const cup = {
    viewModel: null,
    pivot: null,
    t: -1,
    filled: false,
    valid: false,

    onEquip() {
      cup.t = -1;
      cup.valid = false;
      if (cup.pivot) { cup.pivot.position.set(0, 0, 0); cup.pivot.rotation.set(0, 0, 0); }
    },
    onUnequip() {
      cup.t = -1;
      if (cup.pivot) { cup.pivot.position.set(0, 0, 0); cup.pivot.rotation.set(0, 0, 0); }
      G.hud.setToolHint('');
    },
    primaryDown(slot) {
      if (cup.t >= 0 || !slot || slot.id !== 'kelimek') return;
      if (!cup.valid) { G.sfx('error', { volume: 0.3 }); return; }
      cup.t = 0;
      cup.filled = false;
    },
    primaryUp() {},
    secondaryDown() {},
    secondaryUp() {},
    update(dt, slot) {
      if (cup.t < 0) cup.valid = P.inWater ? seaInFront(_cupHit) : aimAtSea(4, _cupHit);
      const p = cup.pivot;
      if (!p) return;
      if (cup.t >= 0) {
        cup.t += dt;
        const t = cup.t;
        const k = t < 0.22 ? ease(t / 0.22) : 1 - ease((t - 0.3) / 0.3);
        p.position.set(-0.07 * k, -0.15 * k, -0.2 * k);
        p.rotation.set(-1.15 * k, 0, 0.3 * k);
        if (!cup.filled && t >= 0.22) {
          cup.filled = true;
          cup.fill(slot);
        }
        if (t >= 0.62) cup.t = -1;
      } else {
        p.position.set(0, Math.sin(clock * 2) * 0.004, 0);
        p.rotation.set(0, 0, 0);
      }
    },
    fill(slot) {
      const inv = G.inventory;
      if (!inv || !slot || slot.id !== 'kelimek') return;
      const sel = inv.getSelected();
      if (!sel || sel.id !== 'kelimek') return;
      inv.replaceSelected('kelimek_slany', 'sea');
      G.sfx('splash', { position: _cupHit, volume: 0.6 });
      if (G.fx) G.fx.splash(_cupHit, 0.3);
      G.events.emit('cup:filled', { id: 'kelimek_slany' });
    },
    hint() {
      return cup.valid ? btnL() + ': Nabrat mořskou vodu' : 'Zamiř kelímkem na moře kousek od sebe';
    },
  };

  // ---------------------------------------------------------------------------
  // Tool: spear
  // ---------------------------------------------------------------------------
  const spear = {
    viewModel: null,
    pivot: null,
    ribbon: null,
    t: -1,
    cd: 0,
    hold: false,
    hitDone: false,

    onEquip() {
      spear.t = -1;
      spear.cd = 0.1;
      spear.hold = false;
      if (spear.pivot) { spear.pivot.position.set(0, 0, 0); spear.pivot.rotation.set(0, 0, 0); }
    },
    onUnequip() {
      spear.t = -1;
      spear.hold = false;
      if (spear.pivot) { spear.pivot.position.set(0, 0, 0); spear.pivot.rotation.set(0, 0, 0); }
      G.hud.setToolHint('');
    },
    primaryDown() { spear.hold = true; spear.thrust(); },
    primaryUp() { spear.hold = false; },
    secondaryDown() {},
    secondaryUp() {},
    thrust() {
      if (spear.cd > 0 || spear.t >= 0 || !P.alive) return;
      spear.t = 0;
      spear.cd = 0.6;
      spear.hitDone = false;
      G.sfx('whoosh', { volume: 0.55 });
    },
    update(dt) {
      if (spear.cd > 0) spear.cd -= dt;
      if (spear.hold && spear.cd <= 0 && spear.t < 0) spear.thrust();
      const p = spear.pivot;
      if (!p) return;
      if (spear.t >= 0) {
        spear.t += dt;
        const t = spear.t;
        const k = t < 0.07 ? easeOut(t / 0.07) : 1 - ease((t - 0.1) / 0.28);
        p.position.set(-0.03 * k, 0.03 * k, -0.45 * k);
        p.rotation.set(0.05 * k, 0.07 * k, -0.25 * k);
        if (!spear.hitDone && t >= 0.06) { spear.hitDone = true; spear.strike(); }
        if (t >= 0.4) spear.t = -1;
      } else {
        p.position.set(0, Math.sin(clock * 1.8) * 0.004, 0);
        p.rotation.set(0, 0, 0);
      }
      if (spear.ribbon) {
        spear.ribbon.rotation.x = Math.sin(clock * 3.1) * 0.3 + (spear.t >= 0 ? 0.7 : 0.15);
        spear.ribbon.rotation.z = Math.sin(clock * 2.3 + 1) * 0.15;
      }
    },
    strike() {
      P.eye(_se);
      P.forward(_sf);
      const C = G.combat;
      const tgt = C && typeof C.findInFront === 'function' ? C.findInFront(_se, _sf, 3.2) : null;
      if (tgt) {
        if (typeof tgt.getPosition === 'function') tgt.getPosition(_sp);
        else _sp.copy(_se).addScaledVector(_sf, 2);
        try { if (typeof tgt.onHit === 'function') tgt.onHit(25, _sf.clone(), 'spear'); }
        catch (err) { console.error('[player] spear target onHit failed', err); }
        G.sfx('hit', { position: _sp });
        const kind = String(tgt.kind || '');
        if (G.fx) {
          if (/shark|pira|board/.test(kind) && !/ship/.test(kind) && G.fx.blood) G.fx.blood(_sp);
          else if (G.fx.debris) G.fx.debris(_sp, '#8b6a45', 6);
        }
        shake = Math.min(1, shake + 0.2);
        if (G.inventory) G.inventory.damageSelected(1);
      } else if (P.inWater ? seaInFront(_sp) : aimAtSea(3.2, _sp)) {
        if (G.fx) G.fx.splash(_sp, 0.35);
        G.sfx('splash', { position: _sp, volume: 0.45 });
      }
    },
    hint() { return btnL() + ': Bodnout oštěpem'; },
  };

  function buildToolModels() {
    // consume
    consume.viewModel = new THREE.Group();
    consume.viewModel.name = 'consume-view';
    consume.viewModel.scale.setScalar(0.72);        // food held at a natural size in the hand
    consume.pivot = new THREE.Group();
    consume.viewModel.add(consume.pivot);

    // cup
    cup.viewModel = new THREE.Group();
    cup.viewModel.name = 'cup-view';
    cup.pivot = new THREE.Group();
    cup.viewModel.add(cup.pivot);
    cup.pivot.add(heldModelFor('kelimek'));

    // spear: wooden shaft, rope grip, lashed metal tip and a little red ribbon
    const vm = new THREE.Group();
    vm.name = 'spear-view';
    const pv = new THREE.Group();
    vm.add(pv);
    const shaft = new THREE.Mesh(GEO.spearShaft, MAT.wood);
    shaft.rotation.x = Math.PI / 2;
    shaft.position.z = -0.05;
    pv.add(shaft);
    pv.add(part(GEO.cyl6, MAT.grip, 0.023, 0.2, 0.023, 0, 0, 0, Math.PI / 2, 0, 0));
    pv.add(part(GEO.cyl6, MAT.rope, 0.024, 0.07, 0.024, 0, 0, -0.77, Math.PI / 2, 0, 0));
    // leaf-shaped metal blade with two small barbs
    pv.add(part(GEO.cone4, MAT.metal, 0.07, 0.34, 0.022, 0, 0, -0.97, -Math.PI / 2, 0, 0));
    pv.add(part(GEO.cone4, MAT.metal, 0.034, 0.06, 0.022, 0, 0, -0.79, Math.PI / 2, 0, 0));
    pv.add(part(GEO.cone3, MAT.metal, 0.024, 0.07, 0.01, 0.036, 0, -0.83, Math.PI / 2, 0, 0.5));
    pv.add(part(GEO.cone3, MAT.metal, 0.024, 0.07, 0.01, -0.036, 0, -0.83, Math.PI / 2, 0, -0.5));
    const rib = new THREE.Group();
    rib.position.set(0, -0.012, -0.74);
    rib.add(part(GEO.box, MAT.cloth, 0.004, 0.12, 0.028, 0, -0.06, 0));
    pv.add(rib);
    vm.rotation.set(0.12, 0.3, -0.12);
    vm.position.set(0.05, -0.03, -0.1);
    spear.viewModel = vm;
    spear.pivot = pv;
    spear.ribbon = rib;
  }

  // ---------------------------------------------------------------------------
  // Save / load
  // ---------------------------------------------------------------------------
  const r2 = (v) => Math.round(v * 100) / 100;
  function save() {
    const p = P.position;
    return {
      pos: [r2(p.x), r2(p.y), r2(p.z)],
      yaw: r2(P.yaw),
      pitch: r2(P.pitch),
      health: r2(P.health),
      hunger: r2(P.hunger),
      thirst: r2(P.thirst),
    };
  }
  function num(v, def) { v = Number(v); return Number.isFinite(v) ? v : def; }
  function load(d) {
    if (!d || typeof d !== 'object') return;
    P.health = clamp(num(d.health, 100), 1, P.maxHealth);
    P.hunger = clamp(num(d.hunger, 100), 0, 100);
    P.thirst = clamp(num(d.thirst, 100), 0, 100);
    P.yaw = num(d.yaw, P.yaw);
    P.pitch = clamp(num(d.pitch, P.pitch), -PITCH_MAX, PITCH_MAX);
    if (Array.isArray(d.pos) && d.pos.length >= 3) {
      const x = num(d.pos[0], 0), z = num(d.pos[2], 0);
      const g = sampleGround(x, z, Infinity, false);
      if (g || Math.hypot(x, z) < 30) placeAt(x, z);
      else placeAt(0, 0);
    }
    warnH = P.hunger < 30; warnT = P.thirst < 30;
    snapCamera();
  }

  function snapCamera() {
    const cam = G.camera;
    if (!cam || G.state === 'menu') return;
    cam.position.set(P.position.x, P.position.y + EYE_H, P.position.z);
    cam.rotation.set(P.pitch, P.yaw, 0);
  }

  function reset() {
    releaseButtons();
    unequip();
    P.controlOverride = null;
    P.alive = true;
    P.god = false;
    P.health = P.maxHealth;
    P.hunger = 100;
    P.thirst = 100;
    P.lastDamageSource = null;
    P.inWater = false;
    P.climbing = false;
    P.sprinting = false;
    climbT = -1;
    P.velocity.set(0, 0, 0);
    P.position.set(0, deckY(), 0);
    const g = sampleGround(0, 0, Infinity, false);
    if (g) {
      P.position.y = g.h;
      P.onGround = true; P.groundProvider = g.p; P.groundKind = g.p.kind || 'raft';
    } else {
      P.onGround = true; P.groundProvider = null; P.groundKind = 'raft';
    }
    const w = G.world && G.world.windDir;
    P.yaw = w && (w.x || w.z) ? Math.atan2(-w.x, -w.z) : 0;
    P.pitch = -0.1;
    bobPhase = 0; bobAmp = 0; stepIdx = 0; stepOffset = 0; landDip = 0;
    shake = 0; hurtRoll = 0; rollS = 0; pitchS = 0;
    coyote = 0; jumpBuf = 0; invuln = 0;
    strokeT = 0; strokePulse = 0;
    lookDX = lookDY = 0; lagX = lagY = 0; handVy = 0; lowK = 0; swimK = 0; equipT = 1;
    canClimbNow = false; climbHintShown = false;
    farWarned = false; farNow = false; farCheckT = 0; waterTipShown = false;
    warnH = warnT = warnH0 = warnT0 = false;
    starveH = starveT = 0;
    deathT = 0; diedInWater = false;
    fovCur = baseFov;
    const cam = G.camera;
    if (cam && Math.abs(cam.fov - baseFov) > 0.01) { cam.fov = baseFov; cam.updateProjectionMatrix(); }
    P.hand.visible = false;
    G.hud.setToolHint('');
    snapCamera();
  }

  // ---------------------------------------------------------------------------
  // Module
  // ---------------------------------------------------------------------------
  G.register({
    name: 'player',
    order: 30,
    init() {
      baseFov = fovCur = G.camera ? G.camera.fov : 70;
      buildShared();
      genericHolder = new THREE.Group();
      genericHolder.name = 'held-generic';
      buildToolModels();
      P.hand.position.set(HAND_X, HAND_Y, HAND_Z);
      P.hand.visible = false;
      if (G.camera) G.camera.add(P.hand);
      G.tools.register('consume', consume);
      G.tools.register('cup', cup);
      G.tools.register('spear', spear);
      G.events.on('ui:blocking', (on) => { if (on) releaseButtons(); });
      G.events.on('game:paused', () => releaseButtons());
      G.events.on('game:menu', () => { releaseButtons(); unequip(); P.hand.visible = false; });
      G.events.on('game:over', () => { releaseButtons(); unequip(); P.hand.visible = false; });
    },
    reset,
    save,
    load,
    update,
    frame,
  });

  // ---------------------------------------------------------------------------
  // Debug
  // ---------------------------------------------------------------------------
  G.debug.god = (on) => {
    P.god = on === undefined ? !P.god : !!on;
    if (P.god) { P.health = P.maxHealth; P.hunger = Math.max(P.hunger, 100); P.thirst = Math.max(P.thirst, 100); }
    G.notify(P.god ? 'Nesmrtelnost zapnutá' : 'Nesmrtelnost vypnutá', 'info');
    return P.god;
  };
  G.debug.teleport = (x, z) => { placeAt(Number(x) || 0, Number(z) || 0); snapCamera(); return P.position.clone(); };
})();
