// goals.js — the guided chain of objectives shown in the top-left goal card (ui.js renders it).
// Contract: ../DESIGN.md §6 "goals.js". Registers as module 'goals' (order 80).
//
// Every goal is tracked all the time (doing things out of order still counts); `current()` is the
// first goal that is not done yet. Completion comes from events plus a cheap state check twice a
// second (e.g. owning a spear, a raised sail, the day counter).
(function () {
  'use strict';

  const G = window.G;

  // kind: 'count' → progress counter up to target; 'steps' → small checklist; 'once' → single action.
  // recipe: the crafting recipe that helps with the goal (ui.js tags it in the crafting list).
  const DEFS = [
    { id: 'prkna', kind: 'count', target: 6,
      text: 'Seber hákem 6 prken',
      hint: 'Vyber hák (1), podrž levé tlačítko myši a pusť. Pak drž tlačítko a navíjej.',
      hintTouch: 'Vyber hák (1), podrž tlačítko ● a pusť. Pak ho drž a navíjej.' },
    { id: 'kladivo', kind: 'once', recipe: 'kladivo',
      text: 'Vyrob kladivo',
      hint: 'Otevři inventář (Tab), přepni na Výrobu a vyrob kladivo ze 3 prken a 2 plastů.',
      hintTouch: 'Otevři batoh (🎒), přepni na Výrobu a vyrob kladivo ze 3 prken a 2 plastů.' },
    { id: 'zaklady', kind: 'count', target: 2,
      text: 'Rozšiř vor o 2 nové základy',
      hint: 'Vezmi kladivo, zamiř na vodu hned u okraje voru a klikni. Jeden základ stojí 2 prkna a 2 plasty.' },
    { id: 'kelimek', kind: 'steps', recipe: 'kelimek',
      steps: ['Vyrob kelímek', 'Naber mořskou vodu'],
      text: 'Vyrob kelímek a naber mořskou vodu',
      hint: 'Kelímek vyrobíš ze 4 plastů. Vezmi ho do ruky, zamiř na moře a klikni.' },
    { id: 'cisticka', kind: 'steps', recipe: 'cisticka',
      steps: ['Postav čističku', 'Vyčisti vodu'],
      text: 'Postav čističku a vyčisti vodu',
      hint: 'Vyrob čističku, vyber ji a klikni na vor. Pak u ní se slanou vodou zmáčkni E a chvíli počkej.' },
    { id: 'ryba', kind: 'steps', recipe: 'udice',
      steps: ['Vyrob udici', 'Chyť rybu'],
      text: 'Vyrob udici a chyť rybu',
      hint: 'Podrž tlačítko a nahoď. Když se splávek potopí a objeví se „Záběr!“, rychle klikni.' },
    { id: 'gril', kind: 'steps', recipe: 'gril',
      steps: ['Postav gril', 'Upeč rybu'],
      text: 'Postav gril a upeč rybu',
      hint: 'Polož gril na vor. Přijď k němu se syrovou rybou, zmáčkni E a po chvíli si ji vezmi.' },
    { id: 'ostep', kind: 'once', recipe: 'ostep',
      text: 'Vyrob oštěp (proti žralokovi)',
      hint: 'Na oštěp potřebuješ kovový šrot – najdeš ho v sudech. Kliknutím bodáš, žralok pak uteče.' },
    { id: 'plachta', kind: 'steps', recipe: 'plachta',
      steps: ['Postav plachtu', 'Vytáhni ji'],
      text: 'Postav plachtu a vytáhni ji',
      hint: 'Vyrob plachtu, postav ji na vor a zmáčkni u ní E. S plachtou popluješ mnohem rychleji.' },
    { id: 'ostrov', kind: 'once',
      text: 'Navštiv ostrov',
      hint: 'Až se na obzoru objeví ostrov, doplav k němu. Na břeh vylezeš Mezerníkem. Kotva udrží vor na místě.' },
    { id: 'kanon', kind: 'once', recipe: 'kanon',
      text: 'Postav kanón',
      hint: 'Kanón potřebuje hodně kovu (8×). Hledej ho v sudech a ve vracích na ostrovech.' },
    { id: 'lod', kind: 'once', recipe: 'koule_kov',
      text: 'Potop pirátskou loď',
      hint: 'Vyrob dělové koule, sedni ke kanónu (E) a miř na loď. Piráti připlují sami, až bude vor větší…' },
    { id: 'dny', kind: 'count', target: 7, final: true,
      text: 'Přežij 7 dní',
      hint: 'Jez, pij a opravuj vor. Každou půlnoc přibude jeden přežitý den.' },
  ];

  // Live goal objects: { id, n, text, hint, hintTouch, done, progress, target, steps?, recipe?, final? }
  const list = DEFS.map((d, k) => ({
    id: d.id,
    n: k + 1,
    kind: d.kind,
    text: d.text,
    hint: d.hint,
    hintTouch: d.hintTouch || d.hint,
    recipe: d.recipe || null,
    final: !!d.final,
    target: d.kind === 'steps' ? d.steps.length : d.target || 1,
    steps: d.kind === 'steps' ? d.steps.map((t) => ({ text: t, done: false })) : null,
    progress: 0,
    done: false,
  }));
  const byId = Object.create(null);
  for (const g of list) byId[g.id] = g;

  let checkT = 0;
  let quiet = false;           // true while loading / resetting: no announcements

  const API = (G.goals = {
    list,
    version: 0,                // bumps on any change (cheap dirty check for the UI)
    current() {
      for (let i = 0; i < list.length; i++) if (!list[i].done) return list[i];
      return null;
    },
    get(id) { return byId[id] || null; },
    index(id) { const g = byId[id]; return g ? g.n - 1 : -1; },
    doneCount() { let n = 0; for (const g of list) if (g.done) n++; return n; },
    allDone() { return list.every((g) => g.done); },
    hintOf(g) {
      if (!g) return '';
      return G.input && G.input.touchMode ? g.hintTouch : g.hint;
    },
    // '3/6', '1/2' or '' for single-action goals
    progressText(g) {
      if (!g || g.kind === 'once') return '';
      if (g.id === 'dny') return Math.min(g.progress, g.target) + ' / ' + g.target + ' dní';
      return Math.min(g.progress, g.target) + '/' + g.target;
    },
    complete(id) { return complete(byId[id]); },
  });

  // ---------------------------------------------------------------------------
  // Progress helpers
  // ---------------------------------------------------------------------------
  function bump() { API.version++; }

  function complete(g) {
    if (!g || g.done) return false;
    g.done = true;
    g.progress = g.target;
    if (g.steps) for (const s of g.steps) s.done = true;
    bump();
    if (!quiet && G.state === 'playing') {
      G.notify('Úkol splněn: ' + g.text, 'good');
      G.sfx('coins');
      G.events.emit('goal:done', { id: g.id, n: g.n, text: g.text, final: g.final });
    }
    return true;
  }

  function setCount(id, value) {
    const g = byId[id];
    if (!g || g.done) return;
    const v = Math.max(0, Math.min(g.target, Math.floor(value)));
    if (v === g.progress) return;
    g.progress = v;
    bump();
    if (v >= g.target) complete(g);
  }
  function addCount(id, n) {
    const g = byId[id];
    if (!g || g.done) return;
    setCount(id, g.progress + (n || 1));
  }
  // Mark step k of a 'steps' goal. The last step implies all earlier ones (you cannot fish without a rod).
  function step(id, k) {
    const g = byId[id];
    if (!g || g.done || !g.steps || !g.steps[k]) return;
    if (k === g.steps.length - 1) { complete(g); return; }
    if (g.steps[k].done) return;
    g.steps[k].done = true;
    let n = 0;
    for (const s of g.steps) if (s.done) n++;
    g.progress = n;
    bump();
    if (n >= g.target) complete(g);
  }

  // ---------------------------------------------------------------------------
  // State checks (twice a second while playing)
  // ---------------------------------------------------------------------------
  function has(id) {
    const inv = G.inventory;
    return !!(inv && typeof inv.count === 'function' && inv.count(id) > 0);
  }
  function hasStructure(type) {
    const R = G.raft;
    const arr = R && Array.isArray(R.structures) ? R.structures : null;
    if (!arr) return false;
    for (let i = 0; i < arr.length; i++) if (arr[i] && arr[i].type === type) return true;
    return false;
  }
  function checkState() {
    if (has('kladivo')) complete(byId.kladivo);
    if (has('ostep')) complete(byId.ostep);
    if (has('kelimek') || has('kelimek_slany') || has('kelimek_sladky')) step('kelimek', 0);
    if (has('kelimek_slany')) step('kelimek', 1);
    if (hasStructure('purifier')) step('cisticka', 0);
    if (has('udice')) step('ryba', 0);
    if (hasStructure('grill')) step('gril', 0);
    if (hasStructure('sail')) step('plachta', 0);
    if (G.raft && G.raft.sailUp) step('plachta', 1);
    if (hasStructure('cannon')) complete(byId.kanon);
    const st = G.stats || {};
    if (st.islandsVisited > 0) complete(byId.ostrov);
    if (st.piratesSunk > 0) complete(byId.lod);
    if (st.fishCaught > 0) step('ryba', 1);
    const day = G.world && Number.isFinite(G.world.day) ? G.world.day : st.days || 1;
    setCount('dny', day - 1);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  function onGained(e) {
    if (!e) return;
    if (e.id === 'prkno' && (e.source === 'debris' || e.source === 'hook')) addCount('prkna', e.count || 1);
    if (e.id === 'kelimek_slany' && e.source !== 'debug') step('kelimek', 1);
  }
  function onCraft(e) {
    if (!e) return;
    if (e.id === 'kladivo') complete(byId.kladivo);
    else if (e.id === 'ostep') complete(byId.ostep);
    else if (e.id === 'kelimek') step('kelimek', 0);
    else if (e.id === 'udice') step('ryba', 0);
  }
  function onStructure(e) {
    const t = e && e.type;
    if (t === 'purifier') step('cisticka', 0);
    else if (t === 'grill') step('gril', 0);
    else if (t === 'sail') step('plachta', 0);
    else if (t === 'cannon') complete(byId.kanon);
  }

  G.register({
    name: 'goals',
    order: 80,

    init() {
      const on = (n, f) => G.events.on(n, f);
      on('item:gained', onGained);
      on('craft', onCraft);
      on('build:tile', () => addCount('zaklady', 1));
      on('cup:filled', () => step('kelimek', 1));
      on('build:structure', onStructure);
      on('purify:done', () => step('cisticka', 1));
      on('fish:caught', () => step('ryba', 1));
      on('cook:done', () => step('gril', 1));
      on('sail:toggled', (e) => { if (e && e.up) step('plachta', 1); });
      on('island:visited', () => complete(byId.ostrov));
      on('pirates:sunk', () => complete(byId.lod));
      on('world:day', (e) => setCount('dny', ((e && e.day) || 1) - 1));
      on('input:touchmode', bump);
      on('game:start', () => { checkT = 0.6; });
    },

    reset() {
      quiet = true;
      for (const g of list) {
        g.done = false;
        g.progress = 0;
        if (g.steps) for (const s of g.steps) s.done = false;
      }
      checkT = 0.6;
      quiet = false;
      bump();
    },

    save() {
      const done = [], c = {}, s = {};
      for (const g of list) {
        if (g.done) { done.push(g.id); continue; }
        if (g.kind === 'count' && g.progress > 0 && g.id !== 'dny') c[g.id] = g.progress;
        if (g.steps && g.progress > 0) s[g.id] = g.steps.map((x) => (x.done ? 1 : 0));
      }
      return { done, c, s };
    },

    load(data) {
      if (!data || typeof data !== 'object') return;
      quiet = true;
      try {
        if (Array.isArray(data.done)) for (const id of data.done) complete(byId[id]);
        const c = data.c && typeof data.c === 'object' ? data.c : {};
        for (const id in c) if (byId[id] && byId[id].kind === 'count') setCount(id, Number(c[id]) || 0);
        const s = data.s && typeof data.s === 'object' ? data.s : {};
        for (const id in s) {
          const g = byId[id];
          if (!g || !g.steps || !Array.isArray(s[id])) continue;
          s[id].forEach((v, k) => { if (v && k < g.steps.length - 1) step(id, k); });
        }
      } finally { quiet = false; }
      bump();
    },

    update(dt) {
      checkT -= dt;
      if (checkT <= 0) {
        checkT = 0.5;
        checkState();
      }
    },
  });

  // Debug: complete a goal by id or number (1..13), or everything up to it.
  G.debug.completeGoal = (idOrN) => {
    const g = typeof idOrN === 'number' ? list[idOrN - 1] : byId[idOrN];
    return complete(g);
  };
  G.debug.completeGoalsUpTo = (n) => {
    for (let i = 0; i < Math.min(n, list.length); i++) complete(list[i]);
  };
})();
