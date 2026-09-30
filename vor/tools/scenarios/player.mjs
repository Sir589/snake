// Scenario for player.js: walking, jumping, falling off the raft into the sea, swimming back and
// climbing on (Space), the cup / consume / spear tools, stat drain, damage & death, save/load.
// Uses real keyboard / mouse input where it matters. Throws on the first failed assertion.
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/player.mjs --shot /tmp/p.png
// Set PLAYER_SHOTS=<dir> to also save a few screenshots along the way.
export default async (page, h) => {
  const note = (t) => process.stderr.write('[player scenario] ' + t + '\n');
  const shots = process.env.PLAYER_SHOTS || '';
  const shot = async (name) => { if (shots) await h.shot(shots + '/' + name + '.png'); };
  const fail = (m) => { throw new Error('[player] ' + m); };
  const ok = (c, m) => { if (!c) fail(m); };
  const st = () => h.eval(() => {
    const P = G.player;
    const s = G.inventory.getSelected();
    return {
      x: P.position.x, y: P.position.y, z: P.position.z, vy: P.velocity.y,
      yaw: P.yaw, pitch: P.pitch, inWater: P.inWater, onGround: P.onGround, groundKind: P.groundKind,
      climbing: P.climbing, health: P.health, hunger: P.hunger, thirst: P.thirst, alive: P.alive,
      deck: G.raft.deckY(), surf: G.world.waveHeight(P.position.x, P.position.z),
      camY: G.camera.position.y, hint: G.hud.toolHint, state: G.state,
      sel: s ? { id: s.id, count: s.count, dur: s.dur } : null,
      handKids: G.player.hand.children.length, handVisible: G.player.hand.visible,
    };
  });
  // Put `id` into hotbar slot 7 and select it.
  const hold = (id, n = 1) => h.eval(([id, n]) => {
    const I = G.inventory;
    I.slots[7] = null;
    I.slots[7] = { id, count: n };
    const d = G.items.def(id);
    if (d && d.maxDur) I.slots[7].dur = d.maxDur;
    I.select(7, true);
    G.events.emit('inventory:changed');
    return I.getSelected();
  }, [id, n]);
  // Wait for `sec` seconds of *game* time (headless frames are slow; dt is clamped to 0.05 s).
  const gw = async (sec) => {
    const target = await h.eval((sec) => G.time + sec, sec);
    await page.waitForFunction((t) => G.state !== 'playing' || G.paused || G.time >= t, target, { timeout: 240000 });
  };
  const lookAt = (yaw, pitch) => h.eval(([y, p]) => { G.player.yaw = y; G.player.pitch = p; }, [yaw, pitch]);

  await h.eval(() => {
    const b = document.getElementById('boot-msg');
    if (b) b.style.display = 'none';
    window.__pev = [];
    for (const n of ['player:damaged', 'player:ate', 'player:drank', 'player:water', 'game:over', 'cup:filled']) {
      G.events.on(n, (d) => window.__pev.push({ n, d }));
    }
  });
  const events = (n) => h.eval((n) => window.__pev.filter((e) => e.n === n).map((e) => e.d), n);
  await gw(0.4);

  // --- spawn ------------------------------------------------------------------------------------
  let s = await st();
  ok(s.alive && s.state === 'playing', 'alive & playing');
  ok(Math.abs(s.x) < 0.01 && Math.abs(s.z) < 0.01, 'spawn at raft centre');
  ok(s.onGround && s.groundKind === 'raft', 'standing on the raft, got ' + s.groundKind);
  ok(Math.abs(s.y - s.deck) < 0.1, 'feet on deck: ' + s.y + ' vs ' + s.deck);
  ok(Math.abs(s.camY - (s.y + 1.7)) < 0.25, 'camera at eye height');
  const face = await h.eval(() => {
    const f = G.player.forward(new THREE.Vector3()), w = G.world.windDir;
    return (f.x * w.x + f.z * w.z) / Math.hypot(f.x, f.z);
  });
  ok(face > 0.95, 'facing upstream (windDir), dot=' + face);
  ok(s.health === 100 && s.hunger > 99 && s.thirst > 99, 'fresh stats');
  ok(s.handVisible && s.handKids > 0, 'held item model in the hand');
  note('spawn ok');
  // h.mouse() moves the cursor to the centre first; in the free-look fallback that first move would
  // turn the view, so park the cursor there before any aiming.
  await page.mouse.move(640, 360);
  await gw(0.2);

  // --- walk & jump ------------------------------------------------------------------------------
  await lookAt(0, -0.1);                    // face -Z
  await h.hold('KeyD');
  await gw(0.25);
  await h.release('KeyD');
  await gw(0.3);
  s = await st();
  ok(s.x > 0.4 && s.x < 1.9 && s.onGround && !s.inWater, 'strafe right on the deck, x=' + s.x);
  const y0 = s.y;
  await h.key('Space', 60);
  await gw(0.16);
  s = await st();
  ok(s.y > y0 + 0.5 && !s.onGround, 'jumped: y=' + s.y);
  await gw(0.7);
  s = await st();
  ok(s.onGround && s.groundKind === 'raft' && Math.abs(s.y - s.deck) < 0.1, 'landed back on deck');
  note('walk & jump ok');

  // --- walk off the edge into the sea -----------------------------------------------------------
  await h.eval(() => { G.player.position.x = 0.5; G.player.position.z = 0; });
  await lookAt(0, 0);                       // forward = -Z, raft edge at z = -2
  await h.hold('KeyW');
  await gw(0.9);
  await h.release('KeyW');
  await gw(0.9);
  s = await st();
  ok(s.inWater && !s.onGround && s.groundKind === 'water', 'fell into the water');
  ok(s.z < -2.2, 'outside the raft, z=' + s.z);
  ok(Math.abs(s.y + 1.7 - (s.surf + 0.24)) < 0.35, 'head at the surface: eye=' + (s.y + 1.7) + ' surf=' + s.surf);
  ok((await events('player:water')).some((d) => d === true), 'player:water true emitted');
  await shot('swim');

  // try to swim under the raft: blocked by the logs
  await lookAt(Math.PI, 0);                 // face +Z (towards the raft)
  await h.hold('KeyW');
  for (let i = 0; i < 40; i++) {           // swim until the edge is within reach
    await gw(0.2);
    if (await h.eval(() => G.player.canClimb())) break;
  }
  await gw(0.8);                            // keep pushing against the logs
  s = await st();
  ok(s.inWater && s.z < -2 - 0.3 && s.z > -2.6, 'swimmer stopped at the raft edge, z=' + s.z);
  ok(s.hint.includes('Vylézt'), 'climb hint shown: ' + s.hint);
  await h.release('KeyW');
  await h.key('Space', 60);
  await gw(0.1);
  s = await st();
  ok(s.climbing, 'climbing');
  await gw(0.8);
  s = await st();
  ok(!s.inWater && s.onGround && s.groundKind === 'raft' && s.z > -1.95, 'climbed onto the deck, z=' + s.z);
  ok((await events('player:water')).some((d) => d === false), 'player:water false emitted');
  note('water & climb ok');

  // --- cup: scoop sea water ----------------------------------------------------------------------
  await h.eval(() => { G.player.position.set(0.5, G.raft.deckY(), -1.6); G.player.velocity.set(0, 0, 0); });
  await hold('kelimek', 2);
  await lookAt(0, -0.95);                   // look down at the sea past the edge
  await gw(0.2);
  s = await st();
  ok(s.hint.includes('Nabrat'), 'cup hint: ' + s.hint);
  await shot('cup');
  await h.mouse('left', 60);
  await gw(0.7);
  const cnt = await h.eval(() => ({ salt: G.inventory.count('kelimek_slany'), empty: G.inventory.count('kelimek') }));
  ok(cnt.salt === 1 && cnt.empty === 1, 'scooped one cup from a stack of 2: ' + JSON.stringify(cnt));
  // aiming at the deck does nothing
  await lookAt(Math.PI, -1.2);
  await gw(0.15);
  s = await st();
  ok(!s.hint.includes('Nabrat'), 'no scoop when aiming at the deck');
  await h.mouse('left', 60);
  await gw(0.5);
  ok((await h.eval(() => G.inventory.count('kelimek_slany'))) === 1, 'still one salt water');

  // --- consume: drink salt water, drink fresh water, eat ----------------------------------------
  await h.eval(() => { const I = G.inventory; for (let i = 0; i < 28; i++) if (I.slots[i] && I.slots[i].id.startsWith('kelimek')) I.slots[i] = null; G.events.emit('inventory:changed'); });
  await h.eval(() => { G.player.thirst = 50; G.player.health = 80; G.player.hunger = 60; });
  await hold('kelimek_slany', 1);
  await gw(0.1);
  await h.mouse('left', 60);
  await gw(0.9);
  s = await st();
  ok(Math.abs(s.thirst - 38) < 1, 'salt water thirst -12: ' + s.thirst);
  ok(s.health < 75, 'salt water hurts: ' + s.health);
  ok(s.sel && s.sel.id === 'kelimek', 'empty cup returned in the same slot: ' + JSON.stringify(s.sel));
  ok((await events('player:drank')).some((d) => d.id === 'kelimek_slany'), 'player:drank emitted');

  await hold('kelimek_sladky', 2);
  await gw(0.1);
  await h.mouse('left', 60);
  await gw(0.9);
  s = await st();
  ok(Math.abs(s.thirst - 78) < 1.5, 'fresh water +40: ' + s.thirst);
  const cups = await h.eval(() => ({ fresh: G.inventory.count('kelimek_sladky'), empty: G.inventory.count('kelimek') }));
  ok(cups.fresh === 1 && cups.empty === 1, 'stack drink returns a cup: ' + JSON.stringify(cups));

  await hold('makrela_pecena', 3);
  await gw(0.1);
  await shot('food');
  await h.mouse('left', 60);
  await gw(0.9);
  s = await st();
  ok(Math.abs(s.hunger - 92) < 1.5, 'cooked mackerel +32: ' + s.hunger);
  ok(s.sel && s.sel.id === 'makrela_pecena' && s.sel.count === 2, 'one eaten from the stack');
  ok((await events('player:ate')).some((d) => d.id === 'makrela_pecena'), 'player:ate emitted');

  const notes = [];
  await h.eval(() => { window.__notes = []; G.events.on('notify', (d) => window.__notes.push(d.text)); G.player.hunger = 40; });
  await hold('sardinka', 1);
  await gw(0.1);
  await h.mouse('left', 60);
  await gw(0.9);
  notes.push(...(await h.eval(() => window.__notes)));
  ok(notes.includes('Syrová ryba ti moc nesedla.'), 'raw fish notify: ' + JSON.stringify(notes));
  s = await st();
  ok(!s.sel, 'last fish eaten, slot empty');
  // full → refuses
  await h.eval(() => { G.player.hunger = 100; });
  await hold('sardinka_pecena', 1);
  await gw(0.1);
  await h.mouse('left', 60);
  await gw(0.8);
  ok((await h.eval(() => G.inventory.count('sardinka_pecena'))) === 1, 'not hungry → nothing eaten');
  // eat() API from the backpack (not held)
  await h.eval(() => { G.inventory.select(0, true); G.inventory.slots[20] = { id: 'kokos', count: 1 }; G.events.emit('inventory:changed'); G.player.hunger = 50; G.player.thirst = 50; });
  ok(await h.eval(() => G.player.eat('kokos')), 'eat(kokos) from the backpack');
  s = await st();
  ok(Math.abs(s.hunger - 62) < 1 && Math.abs(s.thirst - 68) < 1, 'kokos values: ' + s.hunger + '/' + s.thirst);
  ok(!(await h.eval(() => G.player.eat('kokos'))), 'eat() fails without the item');
  note('cup & consume ok');

  // --- stat drain -------------------------------------------------------------------------------
  await h.eval(() => { G.player.hunger = 80; G.player.thirst = 80; });
  const t0 = await h.eval(() => G.time);
  await gw(2);
  const drain = await h.eval((t0) => ({ dt: G.time - t0, hu: G.player.hunger, th: G.player.thirst }), t0);
  const expH = 80 - drain.dt * 100 / 540, expT = 80 - drain.dt * 100 / 390;
  ok(Math.abs(drain.hu - expH) < 0.05 && Math.abs(drain.th - expT) < 0.05,
    'drain rates: ' + JSON.stringify(drain) + ' expected ' + expH.toFixed(3) + '/' + expT.toFixed(3));
  note('stat drain ok');

  // --- spear vs a dummy combat target -------------------------------------------------------------
  await h.eval(() => {
    G.player.position.set(0, G.raft.deckY(), 0);
    G.player.velocity.set(0, 0, 0);
    G.player.yaw = 0; G.player.pitch = 0;
    const pos = new THREE.Vector3(0, G.raft.deckY() + 1.4, -2.2);
    window.__dummy = { hits: [], hp: 100 };
    window.__dummyT = G.combat.add({
      kind: 'dummy', radius: 0.5,
      getPosition: (out) => out.copy(pos),
      alive: () => window.__dummy.hp > 0,
      onHit: (dmg, dir, src) => { window.__dummy.hits.push({ dmg, src, dz: dir.z }); window.__dummy.hp -= dmg; },
    });
  });
  await hold('ostep', 1);
  await gw(0.35);
  await shot('spear');
  await h.mouse('left', 40);
  await gw(0.12);
  await h.mouse('left', 40);            // inside the 0.6 s cooldown → ignored
  await gw(0.25);
  let d = await h.eval(() => ({ hits: window.__dummy.hits, dur: G.inventory.getSelected().dur }));
  ok(d.hits.length === 1 && d.hits[0].dmg === 25 && d.hits[0].src === 'spear' && d.hits[0].dz < -0.9,
    'one spear hit: ' + JSON.stringify(d.hits));
  ok(d.dur === 59, 'durability -1: ' + d.dur);
  await gw(0.4);
  await h.mouse('left', 40);
  await gw(0.25);
  d = await h.eval(() => ({ hits: window.__dummy.hits.length }));
  ok(d.hits === 2, 'second hit after cooldown');
  // miss when looking away
  await lookAt(Math.PI, 0);
  await gw(0.7);
  await h.mouse('left', 40);
  await gw(0.3);
  ok((await h.eval(() => window.__dummy.hits.length)) === 2, 'no hit when facing away');
  await h.eval(() => G.combat.remove(window.__dummyT));
  note('spear ok');

  // --- UI blocking releases buttons & stops movement -----------------------------------------------
  await h.eval(() => { G.player.position.set(0, G.raft.deckY(), 0); G.setUIBlock('test', true); });
  await h.hold('KeyW');
  await gw(0.3);
  await h.release('KeyW');
  s = await st();
  ok(Math.hypot(s.x, s.z) < 0.05, 'no movement while UI blocks');
  await h.eval(() => G.setUIBlock('test', false));

  // --- control override -------------------------------------------------------------------------
  await h.eval(() => {
    window.__ovN = 0;
    G.player.setControlOverride({ update() { window.__ovN++; G.camera.position.set(0, 9, 0); } });
  });
  await gw(0.3);
  const ov = await h.eval(() => ({ n: window.__ovN, camY: G.camera.position.y, vis: G.player.hand.visible,
    kids: G.player.hand.children.length }));
  await h.eval(() => G.player.setControlOverride(null));
  await gw(0.2);
  ov.after = await h.eval(() => G.camera.position.y);
  ok(ov.n > 3 && Math.abs(ov.camY - 9) < 0.01 && !ov.vis && ov.kids === 0, 'override owns the camera: ' + JSON.stringify(ov));
  ok(ov.after < 4, 'camera returned after override');

  // --- save / load --------------------------------------------------------------------------------
  const sl = await h.eval(() => {
    G.player.position.set(1.2, G.raft.deckY(), -0.7);
    G.player.yaw = 1.1; G.player.hunger = 44; G.player.thirst = 55; G.player.health = 66;
    const data = G.mod('player').save();
    G.mod('player').reset();
    const fresh = { hu: G.player.hunger, x: G.player.position.x };
    G.mod('player').load(JSON.parse(JSON.stringify(data)));
    return { data, fresh, x: G.player.position.x, z: G.player.position.z, yaw: G.player.yaw,
      hu: G.player.hunger, th: G.player.thirst, hp: G.player.health, onGround: G.player.onGround };
  });
  ok(sl.fresh.hu === 100 && sl.fresh.x === 0, 'reset restores fresh state');
  ok(Math.abs(sl.x - 1.2) < 0.02 && Math.abs(sl.z + 0.7) < 0.02 && Math.abs(sl.yaw - 1.1) < 0.02 && sl.onGround, 'load position');
  ok(sl.hu === 44 && sl.th === 55 && sl.hp === 66, 'load stats');

  // --- teleport / god ---------------------------------------------------------------------------------
  s = await h.eval(() => { G.debug.teleport(20, 5); return { w: G.player.inWater, x: G.player.position.x }; });
  ok(s.w && s.x === 20, 'teleport into the sea');
  s = await h.eval(() => { G.debug.teleport(-1, -1); return { w: G.player.inWater, g: G.player.groundKind }; });
  ok(!s.w && s.g === 'raft', 'teleport onto the raft');
  s = await h.eval(() => { G.debug.god(true); const r = G.player.damage(50, 'shark'); const hp = G.player.health; G.debug.god(false); return { r, hp }; });
  ok(!s.r && s.hp === 100, 'god mode blocks damage');

  // --- island shore: walk out of the sea, ride the moving ground, steep terrain blocks --------------
  await h.eval(() => {
    // a fake island: flat sand plateau (0.6 m) with a sloping beach and a tall rock block in it
    const c = new THREE.Vector3(0, 0, 40);
    window.__isl = G.ground.add({
      kind: 'island', velocity: new THREE.Vector3(0.3, 0, 0), c,
      heightAt(x, z) {
        const d = Math.hypot(x - c.x, z - c.z);
        if (d > 16) return null;
        if (Math.abs(x - c.x) < 1.5 && Math.abs(z - c.z) < 1.5) return 4;     // rock
        return Math.min(0.6, 0.6 - (d - 8) * 0.35);                              // beach slope
      },
    });
    // the island drifts at 0.3 m/s of *game* time (headless frames are slow)
    const t0 = G.time;
    window.__islMove = setInterval(() => { window.__isl.c.x = 0.3 * (G.time - t0); }, 20);
    const h0 = window.__isl.heightAt;
    window.__isl.heightAt = (x, z) => { window.__isl.c.x = 0.3 * (G.time - t0); return h0.call(window.__isl, x, z); };
    G.debug.teleport(0, 20);             // in the sea, 20 m from the island centre
    G.player.yaw = Math.PI; G.player.pitch = 0;   // face +Z
  });
  s = await st();
  ok(s.inWater, 'start swimming near the island');
  await h.hold('KeyW');
  for (let i = 0; i < 60; i++) {
    await gw(0.2);
    if (await h.eval(() => !G.player.inWater && G.player.onGround)) break;
  }
  s = await st();
  ok(!s.inWater && s.onGround && s.groundKind === 'island', 'walked out onto the shore: ' + JSON.stringify([s.inWater, s.groundKind, s.z]));
  ok((await events('player:water')).slice(-1)[0] === false, 'player:water false on the shore');
  await gw(2.5);                            // keep walking towards the rock
  await h.release('KeyW');
  s = await st();
  ok(s.z < 40 - 1.4 && s.y < 1, 'the rock blocks walking, z=' + s.z + ' y=' + s.y);
  const x0 = s.x;
  await gw(1);
  s = await st();
  ok(s.onGround && s.groundKind === 'island' && s.x - x0 > 0.15, 'standing player rides the island: dx=' + (s.x - x0));
  await h.eval(() => { clearInterval(window.__islMove); G.ground.remove(window.__isl); });
  await gw(0.3);
  s = await st();
  ok(s.inWater, 'island gone → in the water');
  note('island ok');

  // --- far from the raft ----------------------------------------------------------------------------
  await h.eval(() => { window.__notes = []; G.debug.teleport(90, 0); });
  await gw(0.7);                            // checked twice a second
  ok((await h.eval(() => window.__notes)).includes('Plav zpátky k voru!'), 'far-away notify');
  s = await st();
  ok(s.hint.includes('plav zpátky'), 'far-away hint: ' + s.hint);

  // --- a hole in the raft: fall through, swim inside, climb out ----------------------------------------
  await h.eval(() => {
    G.debug.buildRing();
    G.debug.teleport(1, 1);
    const t = G.raft.tileAt(1, 1);
    G.raft.damageTile(t, 9999, 'cannon');
  });
  await gw(0.8);
  s = await st();
  ok(s.inWater && s.x > 0.3 && s.x < 1.7 && s.z > 0.3 && s.z < 1.7, 'fell through the hole: ' + JSON.stringify([s.inWater, s.x, s.z]));
  await h.eval(() => { G.player.yaw = 0; });
  await h.hold('KeyW');
  await gw(1);
  await h.release('KeyW');
  s = await st();
  ok(s.inWater && s.z > 0.3 && s.z < 1.7, 'kept inside the hole: z=' + s.z);
  await h.key('Space', 60);
  await gw(1);
  s = await st();
  ok(!s.inWater && s.onGround && s.groundKind === 'raft', 'climbed out of the hole');
  note('hole ok');

  // --- menu hides the hand ----------------------------------------------------------------------------
  await h.eval(() => G.newGame());
  await gw(0.3);
  await h.eval(() => G.toMenu());
  await h.wait(600);
  ok(!(await h.eval(() => G.player.hand.visible)), 'hand hidden in the menu');
  await h.eval(() => { G.input.lockFailed = true; G.newGame(); });
  await gw(0.3);

  // --- damage, invulnerability, death & new game -----------------------------------------------------
  s = await h.eval(() => {
    window.__pev.length = 0;
    const a = G.player.damage(30, 'shark', new THREE.Vector3(1, 0, 0));
    const b = G.player.damage(30, 'shark');      // within 0.3 s → ignored
    return { a, b, hp: G.player.health, ev: window.__pev.filter((e) => e.n === 'player:damaged').map((e) => e.d) };
  });
  ok(s.a && !s.b && s.hp === 70, 'damage + invulnerability: ' + JSON.stringify(s));
  ok(s.ev.length === 1 && s.ev[0].amount === 30 && s.ev[0].source === 'shark', 'player:damaged payload');
  await gw(0.4);
  await h.eval(() => { G.player.health = 5; G.player.damage(20, 'cannon'); });
  await gw(0.1);
  await h.wait(5000);                      // the death camera animates in wall time (state "dead")
  s = await st();
  const over = await events('game:over');
  ok(s.state === 'dead' && !s.alive, 'dead');
  ok(over.length === 1 && over[0].reason === 'Zasáhla tě dělová koule.', 'death reason: ' + JSON.stringify(over[0] && over[0].reason));
  ok(s.camY < s.deck + 1.45, 'death camera sank: ' + s.camY);
  await shot('dead');
  // starvation reason
  await h.eval(() => G.newGame());
  await gw(0.2);
  await h.eval(() => { G.player.hunger = 0; G.player.health = 2; });
  await gw(3);
  const over2 = await events('game:over');
  ok(over2.length === 2 && over2[1].reason === 'Umřel jsi hlady.', 'starvation reason: ' + JSON.stringify(over2.map((o) => o.reason)));
  await h.eval(() => G.newGame());
  await gw(0.3);
  s = await st();
  ok(s.alive && s.state === 'playing' && s.health === 100 && Math.abs(s.x) < 0.01 && s.onGround, 'new game after death');
  note('all checks passed');
};
