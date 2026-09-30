// Cross-module contract checks at runtime (see DESIGN.md): every module registered and none
// errored; the public API objects exist; every tool / structure type named by an item def is
// registered; every recipe is consistent; every sfx name in DESIGN §6 and every literal sound
// name used anywhere in js/*.js is synthesized by audio.js; every event name that some module
// listens to is emitted by some module.
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/contract.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lib } from '../scenario-lib.mjs';

const jsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../js');
const src = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(jsDir, f), 'utf8')]);

const DESIGN_SFX = ('pickup craft build place break_wood hammer splash splash_big hook_throw hook_land reel shark_bite hit ' +
  'hurt eat drink cannon explosion fish_bite fish_catch cast ui_click ui_open ui_close warning sail anchor sizzle bubble swim ' +
  'step jump death thunder coins sword pirate_yell whoosh error').split(' ');

export default async (page, h) => {
  const L = lib(page, h, 'contract');
  const { ok, note } = L;

  // literal sound names passed to G.sfx or a module's own sfx/snd wrapper
  const used = new Set();
  for (const [, s] of src) for (const m of s.matchAll(/\b(?:sfx|snd)\(\s*'([a-z_]+)'/g)) used.add(m[1]);
  // event names: emitted vs listened
  const emitted = new Set(), listened = new Set();
  for (const [, s] of src) {
    for (const m of s.matchAll(/emit\(\s*'([a-z:_]+)'/g)) emitted.add(m[1]);
    for (const m of s.matchAll(/\bon\(\s*'([a-z:_]+)'/g)) listened.add(m[1]);
  }
  emitted.add('game:paused'); emitted.add('game:resumed');          // core emits these via a ternary

  const r = await h.eval(([designSfx, usedSfx]) => {
    const out = {};
    out.modules = G.modules.map((m) => m.name);
    out.errored = G.modules.filter((m) => m._errored).map((m) => m.name);
    out.apis = ['items', 'inventory', 'world', 'fx', 'raft', 'player', 'debris', 'fishing', 'shark', 'pirates', 'islands', 'audio', 'goals', 'ui', 'touch']
      .filter((n) => !G[n] || typeof G[n] !== 'object');
    const badTool = [], badPlace = [], badRecipe = [];
    for (const d of G.items.list) {
      if (d.place && !G.raft.structureDefs[d.place]) badPlace.push(d.id + '→' + d.place);
      if (d.place && G.raft.structureDefs[d.place] && G.raft.structureDefs[d.place].item !== d.id) badPlace.push(d.id + ' (structure item ' + G.raft.structureDefs[d.place].item + ')');
      const handler = d.place ? 'place' : d.food ? 'consume' : d.tool;
      if (handler && !G.tools.get(handler)) badTool.push(d.id + '→' + handler);
      if (d.tool && !G.tools.get(d.tool)) badTool.push(d.id + '→' + d.tool);
      if (d.food && d.food.returns && !G.items.def(d.food.returns)) badTool.push(d.id + ' returns ' + d.food.returns);
      const cook = G.items.cookResult(d.id);
      if (cook && !G.items.def(cook)) badRecipe.push('cook ' + d.id + '→' + cook);
    }
    for (const rc of G.items.recipes) {
      if (!G.items.def(rc.out)) badRecipe.push(rc.id + ' out');
      for (const k in rc.needs) if (!G.items.def(k)) badRecipe.push(rc.id + ' needs ' + k);
    }
    out.badTool = badTool; out.badPlace = badPlace; out.badRecipe = badRecipe;
    out.tools = Object.keys(G.tools.handlers).sort();
    out.structures = Object.keys(G.raft.structureDefs).sort();
    out.missingDesignSfx = designSfx.filter((n) => !G.audio.has(n));
    out.missingUsedSfx = usedSfx.filter((n) => !G.audio.has(n));
    out.goals = G.goals.list.length;
    return out;
  }, [DESIGN_SFX, [...used]]);
  note(JSON.stringify(r));

  ok(r.modules.join(',') === 'items,world,raft,build,islands,seabed,player,debris,fishing,telescope,creatures,pirates,goals,audio,ui,touch', 'all 16 modules registered in order: ' + r.modules.join(','));
  ok(r.errored.length === 0, 'no module errored (' + r.errored.join(',') + ')');
  ok(r.apis.length === 0, 'all public API objects exist (' + r.apis.join(',') + ')');
  ok(['consume', 'cup', 'hammer', 'hook', 'place', 'rod', 'spear'].every((t) => r.tools.includes(t)), 'tool handlers registered: ' + r.tools.join(','));
  ok(['anchor', 'cannon', 'chest', 'grill', 'net', 'purifier', 'sail'].every((t) => r.structures.includes(t)), 'structure types registered: ' + r.structures.join(','));
  ok(r.badTool.length === 0, 'every item def has its tool handler (' + r.badTool.join(', ') + ')');
  ok(r.badPlace.length === 0, 'every placeable has its structure type (' + r.badPlace.join(', ') + ')');
  ok(r.badRecipe.length === 0, 'recipes and cooking results are consistent (' + r.badRecipe.join(', ') + ')');
  ok(r.missingDesignSfx.length === 0, 'all DESIGN sfx names synthesized (' + r.missingDesignSfx.join(',') + ')');
  ok(r.missingUsedSfx.length === 0, 'all ' + used.size + ' sound names used in the code exist (' + r.missingUsedSfx.join(',') + ')');
  const deaf = [...listened].filter((n) => !emitted.has(n) && !['sfx', 'notify', 'error', 'boot'].includes(n) && n.includes(':'));
  ok(deaf.length === 0, 'every listened event is emitted somewhere (' + deaf.join(', ') + ')');
  ok(r.goals === 13, '13 goals');
  // when run with --probe, make sure the probe itself records a missing member (then clear it)
  const pr = await h.eval(() => { if (!G._probe) return null; void G.raft.__probeSelfTest; const hit = !!G._probe.missing['G.raft.__probeSelfTest']; delete G._probe.missing['G.raft.__probeSelfTest']; return hit; });
  if (pr !== null) ok(pr, 'contract probe records reads of missing members');
};
