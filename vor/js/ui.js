// ui.js — every DOM part of the game: HUD, inventory / crafting / storage panel, menus and screens.
// Contract: ../DESIGN.md §4, §6 "ui.js", §8. Registers as module 'ui' (order 90). Styles: css/ui.css.
//
// The UI never owns game state: it reads the public APIs (G.inventory, G.player, G.world, G.goals…)
// and calls their actions. The HUD only touches the DOM when a value changes (cached per element)
// and refreshes slow parts at ~15 Hz.
(function () {
  'use strict';

  const G = window.G;
  const HOTBAR = 8;
  const MINUS = '−';
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // ---------------------------------------------------------------------------
  // Tiny DOM helpers (cache the last written value on the element → no redundant DOM writes)
  // ---------------------------------------------------------------------------
  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]); }
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function setText(e, v) {
    v = v == null ? '' : String(v);
    if (e && e._t !== v) { e._t = v; e.textContent = v; }
  }
  function setHTML(e, v) {
    if (e && e._h !== v) { e._h = v; e.innerHTML = v; }
  }
  function setCls(e, c, on) {
    on = !!on;
    const k = '_c_' + c;
    if (e && e[k] !== on) { e[k] = on; e.classList.toggle(c, on); }
  }
  function setStyle(e, p, v) {
    const k = '_s_' + p;
    if (e && e[k] !== v) { e[k] = v; e.style[p] = v; }
  }
  function setVar(e, p, v) {
    const k = '_v_' + p;
    if (e && e[k] !== v) { e[k] = v; e.style.setProperty(p, v); }
  }
  function showEl(e, on) { setCls(e, 'is-hidden', !on); }
  function restartAnim(e, cls) {
    e.classList.remove(cls);
    void e.offsetWidth;          // reflow so the CSS animation starts again
    e.classList.add(cls);
    e['_c_' + cls] = true;
  }
  function sfx(name, vol) { G.sfx(name, vol != null ? { volume: vol } : {}); }
  function signed(n) { n = Math.round(n); return (n > 0 ? '+' : n < 0 ? MINUS : '') + Math.abs(n); }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = (h ? String(m).padStart(2, '0') : String(m)), ss = String(s).padStart(2, '0');
    return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }
  function itemDef(id) { return G.items && G.items.def ? G.items.def(id) : null; }
  function invSlots() { return G.inventory && G.inventory.slots ? G.inventory.slots : null; }
  function arrOf(x) { return Array.isArray(x) ? x : x && Array.isArray(x.slots) ? x.slots : null; }
  function isDrink(d) { return !!d && d.category === 'water'; }
  function touch() { return !!(G.input && G.input.touchMode); }
  let coarseMQ = null;
  function coarse() {
    if (touch()) return true;
    try { coarseMQ = coarseMQ || window.matchMedia('(pointer: coarse)'); return coarseMQ.matches; } catch (e) { return false; }
  }

  // ---------------------------------------------------------------------------
  // Icons (inline SVG, currentColor) for the HUD chrome. Items keep their emoji.
  // ---------------------------------------------------------------------------
  const SV = (body, cls) => '<svg class="ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + body + '</svg>';
  const ICON = {
    heart: SV('<path fill="currentColor" d="M12 21.2l-1.4-1.3C5.4 15.3 2 12.2 2 8.4 2 5.4 4.4 3 7.4 3c1.7 0 3.4.8 4.6 2.1C13.2 3.8 14.9 3 16.6 3 19.6 3 22 5.4 22 8.4c0 3.8-3.4 6.9-8.6 11.5L12 21.2z"/>'),
    fish: SV('<path fill="currentColor" d="M2.5 12C5.4 8.1 9 6.2 12.8 6.2c3 0 5.5 1.4 7.1 3.4L22.5 7v10l-2.6-2.6c-1.6 2-4.1 3.4-7.1 3.4C9 17.8 5.4 15.9 2.5 12z"/><circle cx="8" cy="11" r="1.3" fill="#06222b"/>'),
    drop: SV('<path fill="currentColor" d="M12 2.6c-3.3 4.4-7 8.5-7 12.4a7 7 0 0 0 14 0c0-3.9-3.7-8-7-12.4z"/><path fill="none" stroke="#06222b" stroke-opacity=".45" stroke-width="1.6" stroke-linecap="round" d="M8.9 15.2a3.2 3.2 0 0 0 2.4 3"/>'),
    arrow: SV('<path fill="currentColor" d="M12 2.5l6.5 9h-4.2V21h-4.6v-9.5H5.5z"/>'),
    chevron: SV('<path fill="currentColor" d="M12 3l7.5 16.5L12 15.3l-7.5 4.2z"/>'),
    sail: SV('<path fill="currentColor" d="M11 2.5V17H4.2L11 2.5zM13 5c3.3 3 5.6 7.4 6.3 12H13V5z"/><path fill="currentColor" d="M2.5 18.5h19l-2.2 3H4.7z"/>'),
    anchor: SV('<g fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><circle cx="12" cy="4.8" r="2.1"/><path d="M12 6.9V21M8 10.2h8M4.3 13.6A7.7 7.7 0 0 0 12 21a7.7 7.7 0 0 0 7.7-7.4"/></g>'),
    storm: SV('<path fill="currentColor" d="M7.2 16.5a4.6 4.6 0 0 1-.7-9.1 6.2 6.2 0 0 1 11.8 1.4 4 4 0 0 1-.5 7.7h-2.6l1.3-2.1h-4.8z"/><path fill="currentColor" d="M11.2 12.6h3.6l-2 3.2h2.6L10.6 23l1.3-5.4H9.4z"/>'),
    palm: SV('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 22c.2-4.8 1.3-8.8 3.6-12"/></g><path fill="currentColor" d="M14.6 10c-2.6-3.4-7-4.2-10.4-2 3.4-.3 6.8.4 10.4 2zm0 0c.8-3.6 4-5.8 7.6-5-3.2.9-5.6 2.6-7.6 5zm0 0c-3.4.2-6.3 2.4-7.4 5.8 2.2-2.6 4.6-4.4 7.4-5.8zm0 0c3.4-.1 6 2.1 6.9 5.6-2-2.6-4.3-4.4-6.9-5.6z"/><path fill="currentColor" d="M3 22h18v1.5H3z" opacity=".6"/>'),
    skull: SV('<path fill="currentColor" d="M12 2.8c-4.5 0-8.1 3.2-8.1 7.4 0 2.5 1.3 4.6 3.3 6V19a1 1 0 0 0 1 1h1.3v-2.1h1.1V20h2.8v-2.1h1.1V20h1.3a1 1 0 0 0 1-1v-2.8c2-1.4 3.3-3.5 3.3-6 0-4.2-3.6-7.4-8.1-7.4zm-3.3 9.8a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm6.6 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>'),
    close: SV('<path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/>'),
    check: SV('<path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.5l4.8 4.8L19.5 7"/>'),
    mouse: SV('<rect x="6.5" y="3" width="11" height="18" rx="5.5" fill="none" stroke="currentColor" stroke-width="1.9"/><path stroke="currentColor" stroke-width="1.9" stroke-linecap="round" d="M12 6.5v3.5"/>'),
    bang: SV('<path fill="currentColor" d="M10.6 3.5h2.8l-.5 11h-1.8zM12 16.8a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8z"/>'),
    star: SV('<path fill="currentColor" d="M12 2.8l2.6 6.1 6.6.5-5 4.3 1.6 6.4L12 16.7l-5.8 3.4 1.6-6.4-5-4.3 6.6-.5z"/>'),
  };
  const STAT_ICON = { health: ICON.heart, hunger: ICON.fish, thirst: ICON.drop };
  const STAT_KEYS = ['health', 'hunger', 'thirst'];

  // ---------------------------------------------------------------------------
  // Static texts
  // ---------------------------------------------------------------------------
  // [action, keyboard & mouse (HTML: keys in <kbd>), touch]
  const K = (k) => '<kbd>' + k + '</kbd>';
  const HELP_ROWS = [
    ['Chůze', K('W') + K('A') + K('S') + K('D') + ' nebo šipky', 'levý joystick'],
    ['Rozhlížení', 'pohyb myší', 'táhni po pravé půlce'],
    ['Běh', K('Shift'), 'joystick až na kraj'],
    ['Skok, plavání nahoru, vylézt na vor', K('Mezerník'), '⤒'],
    ['Použít věc v ruce', 'levé tlačítko myši (podrž a pusť)', '● (podrž)'],
    ['Druhá akce, zrušit', 'pravé tlačítko myši', '◐'],
    ['Sebrat, otevřít, použít', K('E'), 'E'],
    ['Rychlá lišta', K('1') + '–' + K('8') + ' nebo kolečko myši', 'klepni na políčko'],
    ['Inventář a výroba', K('Tab') + ' nebo ' + K('I') + ', výroba ' + K('C'), '🎒'],
    ['Otočit stavbu (vybavení po 15°)', K('R') + ' nebo pravé tlačítko myši, zpět ' + K('Shift') + '+' + K('R'), '◐ nebo ↻'],
    ['Stavění z bloků (s kladivem)', K('Z') + ' / ' + K('X') + ' vybrat blok, levé tl. postavit, pravé tl. rozbít', 'klepni na blok v nabídce, ● postavit, ◐ rozbít'],
    ['Jemné díly (prkénko, trám, sloup, půlblok)', K('G') + ' mřížka 25 / 50 cm, ' + K('R') + ' otočit', 'vyber díl v nabídce kladiva'],
    ['Dalekohled', 'podrž levé tlačítko, pravé = zvětšení 4× / 8×', '● podrž, ◐ zvětšení'],
    ['Podpalubí', 'kladivo → Podpalubí pod díl voru, dolů poklopem (' + K('E') + ')', 'kladivo → Podpalubí, E u poklopu'],
    ['Pauza, zavřít okno', K('Esc') + ' nebo ' + K('P'), '❚❚'],
    ['Nápověda', K('H'), '—'],
    ['Ztlumit zvuk', K('M'), '—'],
  ];
  const TIPS = [
    'Hák hoď do moře a přitáhni si prkna, plasty a sudy.',
    'Slanou vodu nepij! Vyčisti ji v čističce.',
    'Syrové ryby upeč na grilu – zasytí mnohem víc.',
    'Žralok nesnese oštěp. Radši moc neplavej.',
    'Kladivem rozšíříš vor a opravíš poškozená prkna.',
    'S kladivem v ruce stavíš z bloků: domy, patra, schody, okna i dveře.',
  ];
  const STAT_NAMES = [
    ['days', 'Den'],
    ['fishCaught', 'Chycené ryby'],
    ['piratesSunk', 'Potopené pirátské lodě'],
    ['piratesDefeated', 'Poražení piráti'],
    ['islandsVisited', 'Navštívené ostrovy'],
    ['debrisCollected', 'Sebrané trosky'],
    ['itemsCrafted', 'Vyrobené předměty'],
    ['gold', 'Poklad (zlaťáky)'],
  ];
  // item:gained sources that only move things the player already had (no new treasure)
  const NOT_NEW = { storage: 1, refund: 1, start: 1, debug: 1, return: 1, replace: 1 };

  function slotHTML(i, key) {
    return (key ? '<span class="slot-key">' + key + '</span>' : '') +
      '<span class="slot-icon"></span><span class="slot-count"></span><span class="slot-dur"><i></i></span>';
  }

  function template() {
    let hot = '';
    for (let i = 0; i < HOTBAR; i++) hot += '<div class="slot hud-slot" id="hot-slot-' + i + '" data-i="' + i + '">' + slotHTML(i, i + 1) + '</div>';
    const stat = (k, label) => '<div class="stat stat-' + k + '" id="stat-' + k + '" title="' + label + '">' +
      '<span class="stat-ico">' + STAT_ICON[k] + '</span><span class="stat-bar"><i></i></span><b class="stat-val">100</b></div>';
    let help = '';
    for (const r of HELP_ROWS) help += '<tr' + (r[2] === '—' ? ' class="no-touch"' : '') + '><th scope="row">' + esc(r[0]) + '</th><td>' + r[1] + '</td><td>' + esc(r[2]) + '</td></tr>';
    let tips = '';
    for (const t of TIPS) tips += '<li>' + esc(t) + '</li>';

    return '' +
    '<div class="fx fx-under" id="fx-under"></div>' +
    '<div class="fx fx-vignette" id="fx-vignette"></div>' +
    '<div class="fx fx-lowhp" id="fx-lowhp"></div>' +

    '<div class="hud" id="hud">' +
      '<section class="goal-card is-hidden" id="goal-card" aria-live="polite">' +
        '<div class="goal-kicker"><span id="goal-num">Úkol</span><span class="goal-toggle" aria-hidden="true">?</span></div>' +
        '<div class="goal-text" id="goal-text"></div>' +
        '<ul class="goal-steps" id="goal-steps"></ul>' +
        '<div class="goal-prog" id="goal-prog"><span class="goal-bar"><i id="goal-bar"></i></span><span class="goal-count" id="goal-count"></span></div>' +
        '<p class="goal-hint" id="goal-hint"></p>' +
        '<div class="goal-stamp" id="goal-stamp">' + ICON.check + '<span>Úkol splněn!</span></div>' +
      '</section>' +

      '<div class="status" id="status">' +
        '<div class="st-day"><span>Den</span><b id="st-day">1</b></div>' +
        '<svg class="dial" id="st-dial" viewBox="-16 -16 32 32" aria-hidden="true">' +
          '<defs><clipPath id="dial-clip"><circle r="13.2"/></clipPath></defs>' +
          '<g clip-path="url(#dial-clip)">' +
            '<rect class="dial-sky" id="dial-sky" x="-16" y="-16" width="32" height="16"/>' +
            '<g id="dial-rot"><circle class="dial-sun" cx="0" cy="-8.2" r="3.5"/>' +
              '<circle class="dial-moon" cx="0" cy="8.2" r="3"/><circle class="dial-moon-cut" id="dial-moon-cut" cx="1.5" cy="7.2" r="2.5"/></g>' +
            '<rect class="dial-sea" x="-16" y="0" width="32" height="16"/>' +
            '<path class="dial-wave" d="M-14 2.4q3.5-1.6 7 0t7 0 7 0 7 0"/>' +
          '</g>' +
          '<circle class="dial-rim" r="14.2"/>' +
        '</svg>' +
        '<div class="st-icons">' +
          '<span class="st-ico st-wind" id="st-wind" title="Vítr – kam fouká"><span class="st-rot" id="st-wind-rot">' + ICON.arrow + '</span></span>' +
          '<span class="st-ico is-hidden" id="st-sail" title="Plachta">' + ICON.sail + '</span>' +
          '<span class="st-ico is-hidden" id="st-anchor" title="Kotva">' + ICON.anchor + '</span>' +
          '<span class="st-ico st-storm is-hidden" id="st-storm" title="Bouře">' + ICON.storm + '</span>' +
        '</div>' +
        '<div class="st-ind st-island is-hidden" id="st-island" title="Nejbližší ostrov">' + ICON.palm +
          '<span class="st-rot st-dir" id="st-island-dir">' + ICON.chevron + '</span><span class="st-dist" id="st-island-dist"></span></div>' +
        '<div class="st-ind st-pirate is-hidden" id="st-pirate" title="Pirátská loď">' + ICON.skull +
          '<span class="st-rot st-dir" id="st-pirate-dir">' + ICON.chevron + '</span><span class="st-hp"><i id="st-pirate-hp"></i></span></div>' +
      '</div>' +

      '<div class="notes" id="notes" aria-live="polite"></div>' +

      '<div class="center" id="center">' +
        '<div class="crosshair" id="crosshair"></div>' +
        '<svg class="ring is-hidden" id="ring" viewBox="0 0 48 48" aria-hidden="true"><circle class="ring-bg" cx="24" cy="24" r="19"/>' +
          '<circle class="ring-fg" id="ring-fg" cx="24" cy="24" r="19"/></svg>' +
        '<div class="below">' +
          '<div class="ring-label is-hidden" id="ring-label"></div>' +
          '<div class="prompt is-hidden" id="prompt"><kbd>E</kbd><span id="prompt-text"></span></div>' +
          '<div class="toolhint is-hidden" id="toolhint"></div>' +
        '</div>' +
      '</div>' +

      '<div class="stats" id="stats">' + stat('health', 'Zdraví') + stat('hunger', 'Hlad') + stat('thirst', 'Žízeň') + '</div>' +

      '<div class="hotbar-wrap">' +
        '<div class="held-name" id="held-name"></div>' +
        '<div class="hotbar" id="hotbar">' + hot + '</div>' +
      '</div>' +

      '<div class="lock-hint is-hidden" id="lock-hint">' + ICON.mouse + '<span>Klikni do hry pro ovládání myší</span></div>' +
    '</div>' +

    '<div class="banner" id="banner" role="status"><span class="banner-text" id="banner-text"></span></div>' +

    // ---- inventory / crafting / storage ----
    '<div class="panel-layer is-hidden" id="panel-layer">' +
      '<section class="panel inv-panel" id="inv-panel" role="dialog" aria-modal="true" aria-label="Inventář a výroba">' +
        '<header class="panel-head">' +
          '<div class="tabs" role="tablist">' +
            '<button type="button" class="tab" id="tab-inv" role="tab">Inventář</button>' +
            '<button type="button" class="tab" id="tab-craft" role="tab">Výroba<span class="tab-badge is-hidden" id="craft-badge"></span></button>' +
          '</div>' +
          '<span class="panel-keys" id="panel-keys">Tab nebo Esc zavře</span>' +
          '<button type="button" class="icon-btn" id="btn-inv-close" aria-label="Zavřít">' + ICON.close + '</button>' +
        '</header>' +
        '<div class="panel-body">' +
          '<div class="inv-view" id="inv-view">' +
            '<div class="inv-main">' +
              '<h3 class="label">Batoh</h3>' +
              '<div class="grid grid-back" id="grid-back"></div>' +
              '<h3 class="label label-hot">Rychlá lišta <small>(1 – 8)</small></h3>' +
              '<div class="grid grid-hot" id="grid-hot"></div>' +
            '</div>' +
            '<aside class="inv-side">' +
              '<div class="detail" id="detail"></div>' +
              '<div class="storage is-hidden" id="storage">' +
                '<div class="storage-head"><h3 class="label" id="storage-title">Truhla</h3>' +
                  '<span class="storage-btns"><button type="button" class="btn btn-small" id="btn-store-all">Uložit vše</button>' +
                  '<button type="button" class="btn btn-small" id="btn-take-all">Vzít vše</button></span></div>' +
                '<div class="grid grid-sto" id="grid-sto"></div>' +
                '<p class="storage-tip" id="storage-tip">Shift + klik přesune věc mezi truhlou a batohem. E zavře.</p>' +
              '</div>' +
            '</aside>' +
          '</div>' +
          '<div class="craft-view is-hidden" id="craft-view">' +
            '<nav class="cats" id="cats" aria-label="Kategorie"></nav>' +
            '<div class="recipes" id="recipes"></div>' +
          '</div>' +
        '</div>' +
      '</section>' +
    '</div>' +

    // ---- screens ----
    '<div class="screen scr-menu is-hidden" id="scr-menu">' +
      '<div class="menu-inner">' +
        '<h1 class="title">Širé moře</h1>' +
        '<svg class="title-wave" viewBox="0 0 240 14" aria-hidden="true"><path d="M2 8q15-10 30 0t30 0 30 0 30 0 30 0 30 0 30 0 30 0"/></svg>' +
        '<p class="tagline">Malý vor, nekonečný oceán. Chytej trosky, stav, rybař a nedej se pirátům.</p>' +
        '<nav class="menu-buttons">' +
          '<button type="button" class="btn btn-primary" id="btn-continue">Pokračovat<small id="continue-info"></small></button>' +
          '<button type="button" class="btn" id="btn-new">Nová hra</button>' +
          '<button type="button" class="btn" id="btn-menu-help">Ovládání</button>' +
          '<button type="button" class="btn" id="btn-menu-settings">Nastavení</button>' +
          '<button type="button" class="btn desktop-only" id="btn-menu-quit">Ukončit hru</button>' +
        '</nav>' +
        '<p class="menu-foot" id="menu-foot">Hra se sama ukládá. Pauza: Esc.</p>' +
      '</div>' +
    '</div>' +

    '<div class="screen scr-card is-hidden" id="scr-pause">' +
      '<div class="card">' +
        '<h2 class="card-title">Pauza</h2>' +
        '<p class="card-sub" id="pause-info"></p>' +
        '<nav class="card-buttons">' +
          '<button type="button" class="btn btn-primary" id="btn-resume">Pokračovat</button>' +
          '<button type="button" class="btn" id="btn-pause-help">Ovládání</button>' +
          '<button type="button" class="btn" id="btn-pause-settings">Nastavení</button>' +
          '<button type="button" class="btn" id="btn-save-quit">Uložit a do menu</button>' +
          '<button type="button" class="btn desktop-only" id="btn-pause-quit">Uložit a ukončit hru</button>' +
        '</nav>' +
      '</div>' +
    '</div>' +

    '<div class="screen scr-card scr-over is-hidden" id="scr-over">' +
      '<div class="card">' +
        '<h2 class="card-title">Konec plavby</h2>' +
        '<p class="over-reason" id="over-reason"></p>' +
        '<dl class="over-stats" id="over-stats"></dl>' +
        '<nav class="card-buttons card-buttons-row">' +
          '<button type="button" class="btn btn-primary" id="btn-again">Hrát znovu</button>' +
          '<button type="button" class="btn" id="btn-over-menu">Do menu</button>' +
        '</nav>' +
      '</div>' +
    '</div>' +

    '<div class="screen scr-card scr-victory is-hidden" id="scr-victory">' +
      '<div class="card">' +
        '<div class="victory-star">' + ICON.star + '</div>' +
        '<h2 class="card-title">Širé moře je tvoje!</h2>' +
        '<p class="card-sub">7 dní na otevřeném moři – zvládnuto! Vor je tvůj domov. Hraj dál, jak dlouho chceš.</p>' +
        '<dl class="over-stats" id="victory-stats"></dl>' +
        '<nav class="card-buttons"><button type="button" class="btn btn-primary" id="btn-victory-continue">Hrát dál</button></nav>' +
      '</div>' +
    '</div>' +

    '<div class="screen scr-card scr-help is-hidden" id="scr-help">' +
      '<div class="card card-wide">' +
        '<h2 class="card-title">Ovládání</h2>' +
        '<div class="help-scroll">' +
          '<table class="help-table"><thead><tr><th>Co</th><th>Klávesnice a myš</th><th>Dotyk</th></tr></thead><tbody>' + help + '</tbody></table>' +
          '<h3 class="label">Tipy</h3><ul class="tips">' + tips + '</ul>' +
        '</div>' +
        '<nav class="card-buttons"><button type="button" class="btn btn-primary" id="btn-help-close">Zpět</button></nav>' +
      '</div>' +
    '</div>' +

    '<div class="screen scr-card scr-settings is-hidden" id="scr-settings">' +
      '<div class="card">' +
        '<h2 class="card-title">Nastavení</h2>' +
        '<div class="settings">' +
          '<div class="set-row"><label for="set-sens" id="lbl-sens">Citlivost myši</label><input type="range" id="set-sens" min="0.2" max="3" step="0.05"><output id="set-sens-v"></output></div>' +
          '<div class="set-row"><label for="set-volume">Hlasitost</label><input type="range" id="set-volume" min="0" max="1" step="0.05"><output id="set-volume-v"></output></div>' +
          '<div class="set-row"><label for="set-music">Hudba</label><input type="range" id="set-music" min="0" max="1" step="0.05"><output id="set-music-v"></output></div>' +
          '<div class="set-row"><span class="set-label" id="lbl-invert">Obrátit osu Y<small id="lbl-invert-sub">myš nahoru = pohled dolů</small></span>' +
            '<button type="button" class="switch" id="set-invert" role="switch" aria-checked="false" aria-labelledby="lbl-invert"><i></i></button></div>' +
          '<div class="set-row"><span class="set-label" id="lbl-quality">Kvalita grafiky</span>' +
            '<div class="seg" role="radiogroup" aria-labelledby="lbl-quality">' +
              '<button type="button" id="set-quality-low" role="radio">Nízká</button>' +
              '<button type="button" id="set-quality-high" role="radio">Vysoká</button></div></div>' +
        '</div>' +
        '<nav class="card-buttons"><button type="button" class="btn btn-primary" id="btn-settings-close">Hotovo</button></nav>' +
      '</div>' +
    '</div>' +

    '<div class="cursor-stack is-hidden" id="cursor-stack"><span class="slot-icon"></span><span class="slot-count"></span></div>' +
    '<div class="tooltip is-hidden" id="tooltip" role="tooltip"></div>';
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let built = false;
  let root = null;
  const E = {};                       // element refs by short name
  const hudSlots = [];                // HUD hotbar slot elements
  const invEls = [];                  // 28 inventory panel slot elements
  let stoEls = [];                    // storage slot elements (rebuilt when the size changes)

  // HUD caches
  let hudT = 0, statusT = 0;
  let hotVersion = -1, hotSel = -1, hotDirty = true;
  let ringShown = -1;
  let lastCur = null, labelT = 0;
  let vignette = 0, vigShown = -1;
  let heldNameT = 0;
  let lastEquipIdx = -1;
  const statEls = {};

  // Panels
  let invOpen = false;
  let invTab = 'inv';
  let storage = null;                 // { slots } currently open next to the inventory
  let storageTitle = '';
  let held = null;                    // { grid: 'inv'|'sto', i, id }
  let drag = null;                    // { x, y, moved }
  let hoverSlot = null;               // { grid, i } under the mouse
  let pointerX = 0, pointerY = 0;
  let invDirty = true;
  let craftCat = 0;
  let craftSel = null;                // selected recipe id (keyboard)
  let recipeRows = [];                // { r, row, btn, chips: [{ id, need, el }] }
  let catEls = [];
  let suppressGains = false;
  let panelGoalVersion = -1;
  let lastPanelPointerT = -1e9;       // last pointerdown in the panel (a click right after it is not a keyboard Enter)

  // Screens
  const overlays = [];                // stack of 'help' | 'settings' | 'victory'
  let overShown = false, overTimer = 0, overData = null;
  let pausedAt = -1e9;
  let newConfirmUntil = 0;
  let victoryPending = 0;
  let pausedByOverlay = false;        // help / victory paused a running game; closing it resumes

  // Notifications / banners
  const notes = [];                   // { el, until, gainId?, count?, text }
  let bannerUntil = 0, bannerText = '', lastBannerAt = -1e9;
  const pendingBanners = [];
  const throttle = Object.create(null);

  // Goal card
  let shownGoal = null, goalVersion = -1, goalHoldUntil = 0, goalHolding = false, allDoneAt = 0;

  // Pointer lock helper
  let lockWorked = false;

  // ---------------------------------------------------------------------------
  // Public API (exists at load time)
  // ---------------------------------------------------------------------------
  const UI = (G.ui = {
    openInventory(tab) { openInventory(tab === 'craft' || tab === 'crafting' ? 'craft' : 'inv', null, ''); },
    openStorage(st, title) {
      const a = arrOf(st);
      if (!a) return false;
      openInventory('inv', st, title || 'Úložiště');
      return true;
    },
    closeAll() { closeAll(); },
    isOpen() { return invOpen || overlays.length > 0; },
    banner(text, kind, seconds) { banner(text, kind, seconds); },
    // --- extras ---
    toggleHelp() { toggleHelp(); },
    openSettings() { pushOverlay('settings'); },
    get tab() { return invOpen ? invTab : null; },
    get storageOpen() { return invOpen && !!storage; },
    heldSlot() { return held ? { grid: held.grid, index: held.i, id: held.id } : null; },
  });

  // ---------------------------------------------------------------------------
  // Build
  // ---------------------------------------------------------------------------
  function build() {
    const host = $('ui');
    if (!host) return;
    const boot = $('boot-msg');
    if (boot && boot.parentNode) boot.parentNode.removeChild(boot);
    root = el('div', 'ui-root');
    root.id = 'ui-root';
    root.dataset.state = 'boot';
    root.innerHTML = template();
    host.appendChild(root);

    const ids = ['hud', 'goal-card', 'goal-num', 'goal-text', 'goal-steps', 'goal-prog', 'goal-bar', 'goal-count', 'goal-hint',
      'goal-stamp', 'status', 'st-day', 'dial-sky', 'dial-rot', 'dial-moon-cut', 'st-wind-rot', 'st-sail', 'st-anchor', 'st-storm',
      'st-island', 'st-island-dir', 'st-island-dist', 'st-pirate', 'st-pirate-dir', 'st-pirate-hp', 'notes', 'crosshair', 'ring',
      'ring-fg', 'ring-label', 'prompt', 'prompt-text', 'toolhint', 'held-name', 'hotbar', 'lock-hint', 'banner', 'banner-text',
      'fx-under', 'fx-vignette', 'fx-lowhp', 'panel-layer', 'inv-panel', 'tab-inv', 'tab-craft', 'craft-badge', 'panel-keys',
      'btn-inv-close', 'inv-view', 'craft-view', 'grid-back', 'grid-hot', 'detail', 'storage', 'storage-title', 'grid-sto',
      'btn-take-all', 'btn-store-all', 'storage-tip', 'lbl-sens', 'lbl-invert-sub', 'cats', 'recipes', 'scr-menu', 'scr-pause', 'scr-over', 'scr-victory', 'scr-help', 'scr-settings',
      'continue-info', 'btn-continue', 'btn-new', 'pause-info', 'over-reason', 'over-stats', 'victory-stats', 'cursor-stack',
      'tooltip', 'set-sens', 'set-sens-v', 'set-volume', 'set-volume-v', 'set-music', 'set-music-v', 'set-invert',
      'set-quality-low', 'set-quality-high'];
    for (const id of ids) E[id] = $(id);
    E.cursorIcon = E['cursor-stack'].querySelector('.slot-icon');
    E.cursorCount = E['cursor-stack'].querySelector('.slot-count');

    for (const k of ['health', 'hunger', 'thirst']) {
      const s = $('stat-' + k);
      statEls[k] = { el: s, bar: s.querySelector('.stat-bar i'), val: s.querySelector('.stat-val'), last: -1 };
    }
    for (let i = 0; i < HOTBAR; i++) hudSlots.push(prepSlot($('hot-slot-' + i)));

    // inventory panel grids: backpack 8..27, hotbar 0..7
    for (let i = 0; i < 28; i++) {
      const b = el('button', 'slot inv-slot', slotHTML(i, i < HOTBAR ? i + 1 : 0));
      b.type = 'button';
      b.id = 'inv-slot-' + i;
      b.dataset.grid = 'inv';
      b.dataset.i = String(i);
      invEls[i] = prepSlot(b);
      (i < HOTBAR ? E['grid-hot'] : E['grid-back']).appendChild(b);
    }
    buildCrafting();
    bindEvents();
    built = true;
    syncSettings();
  }

  function prepSlot(e) {
    e._icon = e.querySelector('.slot-icon');
    e._count = e.querySelector('.slot-count');
    e._dur = e.querySelector('.slot-dur');
    e._durBar = e._dur ? e._dur.querySelector('i') : null;
    e._key = null;
    return e;
  }

  // ---------------------------------------------------------------------------
  // Slot rendering
  // ---------------------------------------------------------------------------
  function renderSlot(e, s) {
    const id = s ? s.id : null;
    const count = s ? s.count : 0;
    const dur = s && s.dur != null ? s.dur : -1;
    const key = id ? id + '|' + count + '|' + dur : '';
    if (e._key === key) return;
    e._key = key;
    const d = id ? itemDef(id) : null;
    e._icon.textContent = d ? d.icon : id ? '❔' : '';
    e._count.textContent = count > 1 ? String(count) : '';
    if (e._dur) {
      const md = d && d.maxDur ? d.maxDur : 0;
      const show = md > 0 && dur >= 0;
      e._dur.style.display = show ? '' : 'none';
      if (show) {
        const r = Math.max(0, Math.min(1, dur / md));
        e._durBar.style.transform = 'scaleX(' + r.toFixed(3) + ')';
        e._dur.classList.toggle('low', r < 0.25);
      }
    }
    e.classList.toggle('empty', !id);
    e.style.setProperty('--tint', d && d.color ? d.color : 'transparent');
  }

  // ---------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------
  function updateHotbar() {
    const inv = G.inventory;
    if (!inv || !inv.slots) return;
    if (hotDirty || inv.version !== hotVersion || inv.selected !== hotSel) {
      hotDirty = false;
      hotVersion = inv.version;
      hotSel = inv.selected;
      for (let i = 0; i < HOTBAR; i++) {
        renderSlot(hudSlots[i], inv.slots[i]);
        setCls(hudSlots[i], 'sel', i === inv.selected);
      }
    }
  }

  function showHeldName() {
    const inv = G.inventory;
    if (!inv || !G.isPlaying()) return;
    const s = inv.getSelected ? inv.getSelected() : null;
    const d = s ? itemDef(s.id) : null;
    setText(E['held-name'], d ? d.name : 'Prázdná ruka');
    restartAnim(E['held-name'], 'show');
    heldNameT = now() + 1400;
  }

  function updateStats() {
    const P = G.player;
    if (!P) return;
    for (let n = 0; n < STAT_KEYS.length; n++) {
      const k = STAT_KEYS[n];
      const st = statEls[k];
      let v = Number(k === 'health' ? P.health : k === 'hunger' ? P.hunger : P.thirst);
      if (!Number.isFinite(v)) v = 0;
      const max = k === 'health' && P.maxHealth ? P.maxHealth : 100;
      const pct = Math.max(0, Math.min(1, v / max));
      const r = Math.round(pct * 200) / 200;
      if (r !== st.last) {
        if (st.last >= 0 && r > st.last + 0.02) restartAnim(st.el, 'up');
        st.last = r;
        st.bar.style.transform = 'scaleX(' + r + ')';
      }
      setText(st.val, Math.ceil(v));
      setCls(st.el, 'low', pct < 0.25);
      setCls(st.el, 'crit', pct < 0.1);
    }
    const hp = Number(P.health) / (P.maxHealth || 100);
    setCls(E['fx-lowhp'], 'on', G.isPlaying() && P.alive !== false && hp < 0.3);
  }

  // Clockwise screen angle (deg) of a world direction (dx, dz) relative to the player's view.
  function relAngle(dx, dz) {
    const P = G.player;
    let yaw = P && Number.isFinite(P.yaw) ? P.yaw : 0;
    if (!P && G.camera) yaw = G.camera.rotation.y;
    const s = Math.sin(yaw), c = Math.cos(yaw);
    const f = -dx * s - dz * c;
    const r = dx * c - dz * s;
    return Math.round(Math.atan2(r, f) * 180 / Math.PI);
  }

  // Rotate an arrow element; keeps the angle continuous so the CSS transition never spins the long way.
  function rotateTo(e, deg) {
    let a = e._ang;
    if (a === undefined) a = deg;
    else a += ((((deg - a) % 360) + 540) % 360) - 180;
    if (a !== e._ang) { e._ang = a; e.style.transform = 'rotate(' + a + 'deg)'; }
  }

  const SKY_DAY = [127, 196, 216], SKY_DUSK = [226, 140, 90], SKY_NIGHT = [18, 42, 70];
  function updateStatus() {
    const W = G.world;
    if (W) {
      setText(E['st-day'], W.day || (G.stats && G.stats.days) || 1);
      const f = Number.isFinite(W.dayFraction) ? W.dayFraction : 0.3;
      const deg = Math.round((f - 0.5) * 360);
      if (E['dial-rot']._deg !== deg) { E['dial-rot']._deg = deg; E['dial-rot'].setAttribute('transform', 'rotate(' + deg + ')'); }
      // sky colour: sun height from the dial angle (+ a warm tint around sunrise / sunset)
      const h = Math.cos((f - 0.5) * Math.PI * 2);            // 1 noon, -1 midnight
      const day = Math.max(0, Math.min(1, (h + 0.25) / 0.6));
      const dusk = Math.max(0, 1 - Math.abs(h) / 0.35) * 0.8;
      const col = [0, 1, 2].map((k) => Math.round((SKY_NIGHT[k] + (SKY_DAY[k] - SKY_NIGHT[k]) * day) * (1 - dusk) + SKY_DUSK[k] * dusk));
      const css = 'rgb(' + col.join(',') + ')';
      if (E['dial-sky']._fill !== css) {
        E['dial-sky']._fill = css;
        E['dial-sky'].setAttribute('fill', css);
        E['dial-moon-cut'].setAttribute('fill', css);
      }
      const wd = W.windDir;
      if (wd) rotateTo(E['st-wind-rot'], relAngle(wd.x, wd.z));
      const storm = (typeof W.stormActive === 'function' ? W.stormActive() : false) || W.storm > 0.35;
      showEl(E['st-storm'], storm);
    }
    const R = G.raft;
    if (R) {
      let hasSail = false, hasAnchor = false;
      const arr = Array.isArray(R.structures) ? R.structures : null;
      if (arr) for (let i = 0; i < arr.length; i++) {
        const t = arr[i] && arr[i].type;
        if (t === 'sail' || t === 'bigsail') hasSail = true; else if (t === 'anchor') hasAnchor = true;
      }
      showEl(E['st-sail'], hasSail || !!R.sailUp);
      setCls(E['st-sail'], 'on', !!R.sailUp);
      E['st-sail'].title = R.sailUp ? 'Plachta je nahoře' : 'Plachta je dole';
      showEl(E['st-anchor'], hasAnchor || !!R.anchored);
      setCls(E['st-anchor'], 'on', !!R.anchored);
      E['st-anchor'].title = R.anchored ? 'Kotva je spuštěná' : 'Kotva je nahoře';
    }
    // nearest island
    const I = G.islands, P = G.player;
    let isl = null;
    try { isl = I && typeof I.nearest === 'function' ? I.nearest(P && P.position) : null; } catch (e) { isl = null; }
    if (isl && isl.position && isl.alive !== false) {
      const px = P && P.position ? P.position.x : 0, pz = P && P.position ? P.position.z : 0;
      const dx = isl.position.x - px, dz = isl.position.z - pz;
      let dist = Math.hypot(dx, dz) - (isl.radius || 0);
      if (typeof I.shoreDistance === 'function') {
        const sd = I.shoreDistance(isl, px, pz);
        if (Number.isFinite(sd)) dist = sd;
      }
      const onIt = P && P.groundKind === 'island';
      showEl(E['st-island'], dist < 420 || onIt);
      setText(E['st-island-dist'], onIt || dist <= 1 ? 'Na ostrově' : Math.round(dist) + ' m');
      setCls(E['st-island'], 'here', onIt || dist <= 1);
      rotateTo(E['st-island-dir'], relAngle(dx, dz));
    } else showEl(E['st-island'], false);
    // pirate ship
    const PR = G.pirates;
    const ship = PR && PR.active ? PR.ship : null;
    if (ship && ship.position) {
      showEl(E['st-pirate'], true);
      const px = P && P.position ? P.position.x : 0, pz = P && P.position ? P.position.z : 0;
      rotateTo(E['st-pirate-dir'], relAngle(ship.position.x - px, ship.position.z - pz));
      const hp = ship.maxHp ? Math.max(0, Math.min(1, ship.hp / ship.maxHp)) : 1;
      setStyle(E['st-pirate-hp'], 'transform', 'scaleX(' + hp.toFixed(3) + ')');
    } else showEl(E['st-pirate'], false);
  }

  function updateCenter() {
    const H = G.hud || {};
    const playing = G.isPlaying() && !G.uiBlocking();
    // interaction prompt
    const IT = G.interaction;
    const cur = playing && IT ? IT.current : null;
    const t = now();
    if (cur !== lastCur || (cur && t > labelT)) {
      lastCur = cur;
      labelT = t + 100;
      let label = '', passive = false;
      if (cur) {
        try { label = IT.labelOf(cur) || ''; } catch (e) { label = ''; }
        // information-only labels (e.g. 'Čistí se… 12 s') get no [E] key cap
        try { passive = typeof cur.passive === 'function' ? !!cur.passive() : !!cur.passive; } catch (e) { passive = false; }
      }
      showEl(E.prompt, !!label);
      setCls(E.prompt, 'passive', passive);
      if (label) setText(E['prompt-text'], label);
    }
    setCls(E.crosshair, 'target', !!cur);
    showEl(E.crosshair, playing && H.crosshair !== 'hidden');
    // tool hint
    const hint = playing ? H.toolHint || '' : '';
    showEl(E.toolhint, !!hint);
    if (hint && E.toolhint._raw !== hint) { E.toolhint._raw = hint; setHTML(E.toolhint, hintHTML(hint)); }
    // progress ring
    const p = playing && H.progress != null && Number.isFinite(H.progress) ? Math.max(0, Math.min(1, H.progress)) : null;
    showEl(E.ring, p !== null);
    const lbl = p !== null ? H.progressLabel || '' : '';
    showEl(E['ring-label'], !!lbl);
    if (p !== null) {
      const q = Math.round(p * 200);
      if (q !== ringShown) { ringShown = q; E['ring-fg'].style.strokeDashoffset = String(Math.round(119.38 * (1 - q / 200) * 10) / 10); }
      const urgent = /!\s*$/.test(lbl);
      setCls(E.ring, 'urgent', urgent);
      setCls(E['ring-label'], 'urgent', urgent);
      setCls(E.ring, 'full', p >= 0.999);
      if (lbl) setText(E['ring-label'], lbl);
    }
  }

  // 'Levé tlačítko: Hodit · E: Vstát' → key names become small brass key caps.
  const HINT_KEY = /^((?:Levé tlačítko|Pravé tlačítko|Mezerník|Shift|Esc|[A-Z]|[●◐⤒↻](?: nebo [●◐⤒↻])?)(?: \([^)]{1,8}\))?)\s*:\s*/;
  function hintHTML(hint) {
    return String(hint).split(' · ').map((part) => {
      const m = HINT_KEY.exec(part);
      return m ? '<kbd class="hk">' + esc(m[1]) + '</kbd>' + esc(part.slice(m[0].length)) : esc(part);
    }).join('<span class="hk-sep"> · </span>');
  }

  function updateFx(dt) {
    // damage vignette
    if (vignette > 0) vignette = Math.max(0, vignette - dt * 1.5);
    const v = Math.round(vignette * 50) / 50;
    if (v !== vigShown) { vigShown = v; E['fx-vignette'].style.opacity = String(v); }
    // underwater tint
    let under = false;
    if (G.state === 'playing' || G.state === 'dead') {
      const W = G.world, P = G.player;
      if (W && typeof W.underwater === 'boolean') under = W.underwater;
      if (!under && P && P.inWater && G.camera && W && typeof W.waveHeight === 'function') {
        const cp = G.camera.position;
        under = cp.y < W.waveHeight(cp.x, cp.z) - 0.02;
      }
    }
    setCls(E['fx-under'], 'on', under);
  }

  function updateLockHint() {
    const I = G.input;
    const on = !!I && G.isPlaying() && !G.uiBlocking() && !I.touchMode && !I.pointerLocked && !I.lockFailed;
    showEl(E['lock-hint'], on);
  }

  // ---------------------------------------------------------------------------
  // Goal card
  // ---------------------------------------------------------------------------
  function updateGoal() {
    const GS = G.goals;
    const card = E['goal-card'];
    if (!GS || !GS.list) { showEl(card, false); return; }
    const t = now();
    if (GS.version === goalVersion && !goalHolding && !allDoneAt) return;
    if (goalHolding) {
      if (t < goalHoldUntil) return;
      goalHolding = false;
      card.classList.remove('is-done');
    }
    goalVersion = GS.version;
    const shown = shownGoal ? GS.get(shownGoal) : null;
    if (shown && shown.done) {
      // the goal on the card was just completed: flourish, then move on
      goalHolding = true;
      goalHoldUntil = t + 2300;
      fillGoal(shown);
      card.classList.add('is-done');
      restartAnim(E['goal-stamp'], 'pop');
      shownGoal = '__done__' + shown.id;
      return;
    }
    const cur = GS.current();
    if (!cur) {
      if (!allDoneAt) {
        allDoneAt = t + 9000;
        shownGoal = null;
        setText(E['goal-num'], 'Všechny úkoly');
        setText(E['goal-text'], 'Hotovo! Širé moře je tvoje.');
        setHTML(E['goal-steps'], '');
        showEl(E['goal-prog'], false);
        setText(E['goal-hint'], 'Hraj dál, rozšiřuj vor a objevuj ostrovy.');
        showEl(card, true);
        restartAnim(card, 'enter');
      } else if (t > allDoneAt) {
        showEl(card, false);
      }
      return;
    }
    allDoneAt = 0;
    if (cur.id !== shownGoal) {
      shownGoal = cur.id;
      restartAnim(card, 'enter');
    }
    fillGoal(cur);
    showEl(card, G.state === 'playing');
  }

  function fillGoal(g) {
    const GS = G.goals;
    setText(E['goal-num'], 'Úkol ' + g.n + ' z ' + GS.list.length);
    setText(E['goal-text'], g.text);
    if (g.steps) {
      let html = '';
      for (const s of g.steps) html += '<li class="' + (s.done ? 'ok' : '') + '"><span class="tick">' + (s.done ? ICON.check : '') + '</span>' + esc(s.text) + '</li>';
      setHTML(E['goal-steps'], html);
      showEl(E['goal-steps'], true);
      showEl(E['goal-prog'], false);
    } else {
      setHTML(E['goal-steps'], '');
      showEl(E['goal-steps'], false);
      const txt = GS.progressText ? GS.progressText(g) : '';
      showEl(E['goal-prog'], !!txt);
      if (txt) {
        setText(E['goal-count'], txt);
        E['goal-bar'].style.transform = 'scaleX(' + Math.max(0, Math.min(1, g.progress / (g.target || 1))).toFixed(3) + ')';
      }
    }
    setText(E['goal-hint'], GS.hintOf ? GS.hintOf(g) : g.hint);
  }

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------
  const NOTE_ICON = { good: ICON.check, warn: ICON.bang, danger: ICON.bang, info: '' };
  function pushNote(node, life) {
    E.notes.prepend(node);
    const n = { el: node, until: now() + life };
    notes.unshift(n);
    const cap = window.innerWidth <= 640 ? 3 : 6;   // phones: keep the stack clear of the banner
    while (notes.length > cap) dropNote(notes[notes.length - 1], true);
    return n;
  }
  function dropNote(n, fast) {
    const i = notes.indexOf(n);
    if (i >= 0) notes.splice(i, 1);
    if (fast) { n.el.remove(); return; }
    n.el.classList.add('out');
    setTimeout(() => n.el.remove(), 320);
  }
  function onNotify(e) {
    if (!built || !e || !e.text) return;
    if (G.state !== 'playing' && G.state !== 'dead') return;
    const kind = ['info', 'good', 'warn', 'danger'].indexOf(e.kind) >= 0 ? e.kind : 'info';
    const t = now();
    for (const n of notes) {
      if (!n.gainId && n.text === e.text && n.until - t > 0) {
        n.until = t + (kind === 'danger' ? 6000 : 4800);
        restartAnim(n.el, 'bump');
        return;
      }
    }
    const node = el('div', 'note note-' + kind, (NOTE_ICON[kind] ? '<span class="note-ico">' + NOTE_ICON[kind] + '</span>' : '') +
      '<span class="note-text">' + esc(e.text) + '</span>');
    const n = pushNote(node, kind === 'danger' ? 6000 : 4800);
    n.text = e.text;
  }
  function onGained(e) {
    if (e && e.id === 'zlato' && G.state === 'playing' && !NOT_NEW[e.source]) {
      G.stats.gold = (Number(G.stats.gold) || 0) + Math.max(0, e.count | 0);
    }
    if (!built || !e || suppressGains || e.source === 'start') return;
    if (G.state !== 'playing') return;
    const d = itemDef(e.id);
    if (!d) return;
    const t = now();
    const count = Math.max(1, e.count | 0);
    // pulse the hotbar slot that holds it
    const inv = G.inventory;
    if (inv && inv.slots) for (let i = 0; i < HOTBAR; i++) if (inv.slots[i] && inv.slots[i].id === e.id) restartAnim(hudSlots[i], 'gain');
    for (const n of notes) {
      if (n.gainId === e.id && t - n.last < 1500) {
        n.count += count;
        n.last = t;
        n.until = t + 3200;
        setText(n.countEl, '+' + n.count);
        restartAnim(n.el, 'bump');
        return;
      }
    }
    const node = el('div', 'note note-gain', '<span class="note-item">' + d.icon + '</span><b class="note-count">+' + count +
      '</b><span class="note-text">' + esc(d.name) + '</span>');
    const n = pushNote(node, 3200);
    n.gainId = e.id;
    n.count = count;
    n.last = t;
    n.countEl = node.querySelector('.note-count');
  }
  function updateNotes() {
    const t = now();
    for (let i = notes.length - 1; i >= 0; i--) if (t > notes[i].until) dropNote(notes[i], false);
  }
  function clearNotes() {
    for (const n of notes.slice()) dropNote(n, true);
  }

  // ---------------------------------------------------------------------------
  // Banner
  // ---------------------------------------------------------------------------
  function banner(text, kind, seconds) {
    if (!text) return;
    if (!built) { G.notify(text, kind); return; }
    const k = ['info', 'good', 'warn', 'danger'].indexOf(kind) >= 0 ? kind : 'info';
    const t = now();
    lastBannerAt = t;
    const life = Math.max(1, Number(seconds) || 3) * 1000;
    if (bannerUntil > t && bannerText === text) { bannerUntil = Math.max(bannerUntil, t + life); return; }
    bannerText = text;
    bannerUntil = t + life;
    setText(E['banner-text'], text);
    E.banner.className = 'banner banner-' + k;
    void E.banner.offsetWidth;
    E.banner.classList.add('show');
    setCls(root, 'banner-on', true);
  }
  // Event-driven banner: skipped when the emitting module shows its own banner around the same time.
  function eventBanner(text, kind, secs, key, gapMs) {
    const t = now();
    if (key) {
      if (t - (throttle[key] || -1e9) < gapMs) return;
      throttle[key] = t;
    }
    pendingBanners.push({ text, kind, secs, at: t + 180, since: t });
  }
  function updateBanner() {
    const t = now();
    for (let i = pendingBanners.length - 1; i >= 0; i--) {
      const b = pendingBanners[i];
      if (t < b.at) continue;
      pendingBanners.splice(i, 1);
      if (lastBannerAt >= b.since - 400) continue;
      if (G.state === 'playing') banner(b.text, b.kind, b.secs);
    }
    if (bannerUntil && t > bannerUntil) {
      bannerUntil = 0;
      bannerText = '';
      E.banner.classList.remove('show');
      setCls(root, 'banner-on', false);
    }
  }

  // ---------------------------------------------------------------------------
  // Inventory panel
  // ---------------------------------------------------------------------------
  function canOpenPanels() {
    return G.state === 'playing' && !G.paused && !(G.player && G.player.alive === false) && overlays.length === 0;
  }

  function openInventory(tab, st, title) {
    if (!built) return;
    if (G.state !== 'playing' || G.paused) return;
    const wasOpen = invOpen;
    invOpen = true;
    storage = st ? st : null;
    storageTitle = title || '';
    held = null;
    drag = null;
    if (!wasOpen) {
      G.setUIBlock('inventory', true);
      sfx('ui_open', 0.6);
    }
    showEl(E['panel-layer'], true);
    root.classList.add('panel-open');
    setTab(storage ? 'inv' : tab || 'inv');
    if (storage) buildStorageGrid();
    showEl(E.storage, !!storage);
    showEl(E.detail, !storage);
    setText(E['storage-title'], storageTitle);
    setText(E['storage-tip'], touch() ? 'Klepni na věc a pak na políčko v truhle. Nebo ji přetáhni.' : 'Shift + klik přesune věc mezi truhlou a batohem. E zavře.');
    E['inv-panel'].classList.toggle('with-storage', !!storage);
    invDirty = true;
    renderPanel();
    restartAnim(E['inv-panel'], 'enter');
  }

  function closeInventory(silent) {
    if (!invOpen) return;
    invOpen = false;
    held = null;
    drag = null;
    hoverSlot = null;
    storage = null;
    hideTooltip();
    showEl(E['cursor-stack'], false);
    showEl(E['panel-layer'], false);
    root.classList.remove('panel-open');
    blurInside(E['panel-layer']);
    G.setUIBlock('inventory', false);
    if (!silent) sfx('ui_close', 0.6);
  }

  function closeAll() {
    closeInventory(true);
    while (overlays.length) popOverlay(true);
  }

  function setTab(tab) {
    invTab = tab === 'craft' ? 'craft' : 'inv';
    setCls(E['tab-inv'], 'active', invTab === 'inv');
    setCls(E['tab-craft'], 'active', invTab === 'craft');
    E['tab-inv'].setAttribute('aria-selected', String(invTab === 'inv'));
    E['tab-craft'].setAttribute('aria-selected', String(invTab === 'craft'));
    showEl(E['inv-view'], invTab === 'inv');
    showEl(E['craft-view'], invTab === 'craft');
    if (invTab === 'craft') {
      held = null;
      showEl(E['cursor-stack'], false);
      hideTooltip();
      pickDefaultCategory();
    }
    invDirty = true;
  }

  function buildStorageGrid() {
    const a = arrOf(storage);
    const n = a ? a.length : 0;
    if (stoEls.length !== n) {
      E['grid-sto'].innerHTML = '';
      stoEls = [];
      for (let i = 0; i < n; i++) {
        const b = el('button', 'slot inv-slot', slotHTML(i, 0));
        b.type = 'button';
        b.id = 'sto-slot-' + i;
        b.dataset.grid = 'sto';
        b.dataset.i = String(i);
        stoEls.push(prepSlot(b));
        E['grid-sto'].appendChild(b);
      }
    }
    for (const e of stoEls) e._key = null;
  }

  function gridArr(grid) { return grid === 'sto' ? arrOf(storage) : invSlots(); }
  function slotAt(grid, i) { const a = gridArr(grid); return a ? a[i] || null : null; }

  function renderPanel() {
    if (!invOpen) return;
    invDirty = false;
    const inv = G.inventory;
    const a = invSlots();
    // a held stack that vanished or changed id is dropped
    if (held) {
      const s = slotAt(held.grid, held.i);
      if (!s || s.id !== held.id) held = null;
    }
    if (a) {
      for (let i = 0; i < invEls.length; i++) {
        renderSlot(invEls[i], a[i]);
        setCls(invEls[i], 'sel', i < HOTBAR && inv && i === inv.selected);
        setCls(invEls[i], 'lifted', !!held && held.grid === 'inv' && held.i === i);
      }
    }
    const sa = arrOf(storage);
    if (sa) {
      if (stoEls.length !== sa.length) buildStorageGrid();
      for (let i = 0; i < stoEls.length; i++) {
        renderSlot(stoEls[i], sa[i]);
        setCls(stoEls[i], 'lifted', !!held && held.grid === 'sto' && held.i === i);
      }
    }
    renderCursor();
    renderDetail();
    updateRecipes();
  }

  function renderCursor() {
    const cs = E['cursor-stack'];
    const s = held ? slotAt(held.grid, held.i) : null;
    showEl(cs, !!s);
    if (!s) return;
    const d = itemDef(s.id);
    setText(E.cursorIcon, d ? d.icon : '❔');
    setText(E.cursorCount, s.count > 1 ? s.count : '');
    positionCursor();
  }
  function positionCursor() {
    E['cursor-stack'].style.transform = 'translate3d(' + (pointerX - 22) + 'px,' + (pointerY - 22) + 'px,0)';
  }

  function foodChips(d) {
    if (!d || !d.food) return '';
    const f = d.food;
    let h = '';
    const chip = (icon, v, label) => '<span class="fchip ' + (v >= 0 ? 'pos' : 'neg') + '" title="' + label + '">' + icon + '<b>' + signed(v) + '</b></span>';
    if (f.hunger) h += chip(ICON.fish, f.hunger, 'Zasytí');
    if (f.thirst) h += chip(ICON.drop, f.thirst, 'Napojí');
    if (f.health) h += chip(ICON.heart, f.health, 'Zdraví');
    return h ? '<div class="fchips">' + h + '</div>' : '';
  }
  function durHTML(d, s) {
    if (!d || !d.maxDur || s.dur == null) return '';
    const r = Math.max(0, Math.min(1, s.dur / d.maxDur));
    return '<div class="dur-row"><span>Výdrž</span><span class="dur-bar' + (r < 0.25 ? ' low' : '') + '"><i style="transform:scaleX(' + r.toFixed(3) + ')"></i></span><b>' +
      Math.ceil(s.dur) + '/' + d.maxDur + '</b></div>';
  }
  function useHint(d) {
    if (!d) return '';
    if (d.food) return isDrink(d) ? 'Dvojklik: vypít.' : 'Dvojklik: sníst.';
    if (d.category === 'placeable') return 'Dej do lišty, vyber a klikni na vor.';
    if (d.tool) return 'Dej do lišty a vyber číslem.';
    return '';
  }

  function renderDetail() {
    const box = E.detail;
    if (storage) return;
    const s = held ? slotAt(held.grid, held.i) : null;
    const d = s ? itemDef(s.id) : null;
    let html;
    if (!s || !d) {
      html = touch()
        ? '<h3 class="label">Jak na batoh</h3><ul class="howto">' +
          '<li><b>Klepnutí</b> zvedne věc, další klepnutí ji položí.</li>' +
          '<li>Věc můžeš i <b>přetáhnout</b> prstem.</li>' +
          '<li><b>Jídlo a pití</b> zvedni a zvol Sníst / Vypít.</li></ul>'
        : '<h3 class="label">Jak na batoh</h3><ul class="howto">' +
          '<li><b>Klik</b> zvedne věc, další klik ji položí.</li>' +
          '<li><b>Shift + klik</b> ji rychle přesune.</li>' +
          '<li><b>Pravé tlačítko</b> rozdělí hromádku.</li>' +
          '<li><b>Jídlo</b>: dvojklik ho sní.</li></ul>';
    } else {
      const kind = G.items.kindNames ? G.items.kindNames[d.category] || '' : '';
      const inInv = held.grid === 'inv';
      let actions = '';
      if (d.food && inInv) actions += '<button type="button" class="btn btn-primary btn-small" id="btn-eat">' + (isDrink(d) ? 'Vypít' : 'Sníst') + '</button>';
      if (inInv) actions += '<button type="button" class="btn btn-small" id="btn-to-hand">Do ruky</button>';
      if (s.count > 1) actions += '<button type="button" class="btn btn-small" id="btn-split">Rozdělit</button>';
      html = '<div class="detail-head"><span class="detail-icon" style="--tint:' + esc(d.color || 'transparent') + '">' + d.icon + '</span>' +
        '<div><div class="detail-name">' + esc(d.name) + '</div><div class="detail-kind">' + esc(kind) + (s.count > 1 ? ' · ' + s.count + ' ks' : '') + '</div></div></div>' +
        '<p class="detail-desc">' + esc(d.desc || '') + '</p>' + foodChips(d) + durHTML(d, s) +
        (actions ? '<div class="detail-actions">' + actions + '</div>' : '') +
        '<p class="detail-tip">' + (touch() ? 'Klepni' : 'Klikni') + ' na jiné políčko a věc se tam přesune.</p>';
    }
    const key = s ? s.id + '|' + s.count + '|' + s.dur + '|' + held.grid + held.i : touch() ? 'none-t' : 'none';
    if (box._key !== key) { box._key = key; box.innerHTML = html; }
  }

  function showTooltip(grid, i) {
    const s = slotAt(grid, i);
    const d = s ? itemDef(s.id) : null;
    const tt = E.tooltip;
    if (!d || held || touch()) { hideTooltip(); return; }
    const kind = G.items.kindNames ? G.items.kindNames[d.category] || '' : '';
    const hint = useHint(d);
    const key = s.id + '|' + s.count + '|' + s.dur;
    if (tt._key !== key) {
      tt._key = key;
      tt.innerHTML = '<div class="tt-name">' + esc(d.name) + '</div><div class="tt-kind">' + esc(kind) + (s.count > 1 ? ' · ' + s.count + ' ks' : '') + '</div>' +
        '<p class="tt-desc">' + esc(d.desc || '') + '</p>' + foodChips(d) + durHTML(d, s) + (hint ? '<p class="tt-hint">' + esc(hint) + '</p>' : '');
    }
    showEl(tt, true);
    positionTooltip();
  }
  function positionTooltip() {
    const tt = E.tooltip;
    if (tt.classList.contains('is-hidden')) return;
    const w = tt.offsetWidth || 240, h = tt.offsetHeight || 120;
    let x = pointerX + 18, y = pointerY + 18;
    if (x + w > window.innerWidth - 8) x = pointerX - w - 14;
    if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8;
    tt.style.transform = 'translate3d(' + Math.max(8, x) + 'px,' + Math.max(8, y) + 'px,0)';
  }
  function hideTooltip() { if (E.tooltip) showEl(E.tooltip, false); }

  // --- slot actions ---
  function pickUp(grid, i) {
    const s = slotAt(grid, i);
    if (!s) return false;
    held = { grid, i, id: s.id };
    hideTooltip();
    sfx('ui_click', 0.35);
    invDirty = true;
    return true;
  }
  function dropHeldOn(grid, i, count) {
    if (!held) return;
    const inv = G.inventory;
    const from = gridArr(held.grid), to = gridArr(grid);
    if (!inv || !from || !to) { held = null; return; }
    if (held.grid === grid && held.i === i) { held = null; invDirty = true; return; }
    const ok = inv.transfer(from, held.i, to, i, count);
    if (count != null) {
      // placing one by one keeps the rest on the cursor
      const s = from[held.i];
      if (!s || s.id !== held.id) held = null;
    } else held = null;
    sfx(ok ? 'ui_click' : 'error', ok ? 0.45 : 0.4);
    invDirty = true;
  }
  function quickMove(grid, i) {
    const inv = G.inventory;
    const a = gridArr(grid);
    if (!inv || !a || !a[i] || typeof inv.moveToRange !== 'function') return;
    let moved = 0;
    if (storage) {
      const sa = arrOf(storage);
      if (grid === 'inv') moved = inv.moveToRange(a, i, sa, 0, sa.length);
      else moved = inv.moveToRange(sa, i, invSlots(), 0, invSlots().length);
    } else if (grid === 'inv') {
      moved = i < HOTBAR ? inv.moveToRange(a, i, a, HOTBAR, a.length) : inv.moveToRange(a, i, a, 0, HOTBAR);
    }
    held = null;
    sfx(moved ? 'ui_click' : 'error', moved ? 0.45 : 0.35);
    invDirty = true;
  }
  // Everything from the backpack (not the hotbar) goes into the open storage.
  function storeAll() {
    const inv = G.inventory;
    const a = invSlots(), sa = arrOf(storage);
    if (!inv || !a || !sa || typeof inv.moveToRange !== 'function') return;
    let moved = 0, left = false;
    for (let i = HOTBAR; i < a.length; i++) {
      if (!a[i]) continue;
      moved += inv.moveToRange(a, i, sa, 0, sa.length) || 0;
      if (a[i]) left = true;
    }
    held = null;
    sfx(moved ? 'ui_click' : 'error', moved ? 0.5 : 0.35);
    if (moved) G.notify('Uloženo: ' + moved + ' ks', 'good');
    else if (left) G.notify('Truhla je plná', 'warn');
    else G.notify('V batohu nic není (lišta zůstává).', 'info');
    if (moved && left) G.notify('Všechno se nevešlo.', 'warn');
    invDirty = true;
    renderPanel();
  }
  function splitAt(grid, i) {
    const inv = G.inventory;
    const a = gridArr(grid);
    if (!inv || typeof inv.split !== 'function' || !a || !a[i] || a[i].count < 2) { sfx('error', 0.3); return; }
    const ok = inv.split(a, i);
    sfx(ok ? 'ui_click' : 'error', 0.4);
    invDirty = true;
  }
  function eatHeld() {
    if (!held || held.grid !== 'inv') return;
    const inv = G.inventory, P = G.player;
    const s = slotAt('inv', held.i);
    const d = s ? itemDef(s.id) : null;
    if (!inv || !P || typeof P.eat !== 'function' || !d || !d.food) return;
    const id = s.id;
    const before = inv.count(id);
    const ok = P.eat(id);
    if (ok && inv.count(id) >= before) {
      // an eat() that only applies the food: take the item (and give back the cup) ourselves
      inv.remove(id, 1);
      if (d.food.returns) inv.add(d.food.returns, 1, 'refund');
    }
    if (!ok) sfx('error', 0.4);
    invDirty = true;
    renderPanel();
  }
  function heldToHand() {
    if (!held || held.grid !== 'inv') return;
    const inv = G.inventory;
    if (!inv) return;
    const i = held.i;
    if (i < HOTBAR) inv.select(i);
    else {
      const target = inv.selected;
      inv.transfer(inv.slots, i, inv.slots, target);
      inv.select(target, true);
    }
    held = null;
    sfx('ui_click', 0.45);
    invDirty = true;
    renderPanel();
  }

  function slotFromEvent(e) {
    const t = e.target && e.target.closest ? e.target.closest('.inv-slot') : null;
    if (!t) return null;
    return { el: t, grid: t.dataset.grid, i: Number(t.dataset.i) };
  }
  function slotFromPoint(x, y) {
    const t = document.elementFromPoint(x, y);
    const s = t && t.closest ? t.closest('.inv-slot') : null;
    return s ? { el: s, grid: s.dataset.grid, i: Number(s.dataset.i) } : null;
  }

  function onPanelPointerDown(e) {
    pointerX = e.clientX; pointerY = e.clientY;
    lastPanelPointerT = now();
    const hit = slotFromEvent(e);
    if (!hit) {
      // backdrop click (outside the panel) puts a lifted stack back
      if (held && !e.target.closest('.panel')) { held = null; invDirty = true; renderPanel(); }
      return;
    }
    e.preventDefault();
    if (e.button === 2) {
      if (held) dropHeldOn(hit.grid, hit.i, 1);
      else splitAt(hit.grid, hit.i);
      renderPanel();
      return;
    }
    if (e.button !== 0) return;
    if (e.shiftKey) quickMove(hit.grid, hit.i);
    else if (held) dropHeldOn(hit.grid, hit.i);
    else if (pickUp(hit.grid, hit.i)) drag = { x: e.clientX, y: e.clientY, moved: false };
    renderPanel();                 // immediate feedback, do not wait for the next HUD tick
  }
  function onPointerMove(e) {
    pointerX = e.clientX; pointerY = e.clientY;
    if (!invOpen) return;
    if (held) positionCursor();
    if (drag && !drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 7) drag.moved = true;
    positionTooltip();
  }
  function onPointerUp(e) {
    if (!invOpen || !drag) return;
    const d = drag;
    drag = null;
    if (!d.moved || !held) return;
    const hit = slotFromPoint(e.clientX, e.clientY);
    if (hit && !(hit.grid === held.grid && hit.i === held.i)) dropHeldOn(hit.grid, hit.i);
    else if (!hit) { held = null; invDirty = true; }
    renderPanel();
  }

  // ---------------------------------------------------------------------------
  // Crafting
  // ---------------------------------------------------------------------------
  function buildCrafting() {
    const IT = G.items;
    if (!IT || !IT.recipes) return;
    const cats = IT.categories || [];
    E.cats.innerHTML = '';
    catEls = cats.map((c, k) => {
      const b = el('button', 'cat', '<span>' + esc(c) + '</span><b class="cat-badge"></b>');
      b.type = 'button';
      b.id = 'cat-' + k;
      b.dataset.k = String(k);
      E.cats.appendChild(b);
      return b;
    });
    E.recipes.innerHTML = '';
    recipeRows = [];
    for (const r of IT.recipes) {
      const d = itemDef(r.out);
      const row = el('div', 'recipe');
      row.id = 'craft-' + r.id;
      row.dataset.r = r.id;
      const chips = [];
      let needs = '';
      for (const k in r.needs) {
        const nd = itemDef(k);
        needs += '<span class="need" data-need="' + esc(k) + '" title="' + esc(nd ? nd.name : k) + '"><span class="need-ico">' + (nd ? nd.icon : '❔') +
          '</span><b class="need-n"></b><span class="need-name">' + esc(nd ? nd.name : k) + '</span></span>';
      }
      row.innerHTML = '<span class="r-icon" style="--tint:' + esc(d && d.color ? d.color : 'transparent') + '">' + (d ? d.icon : '❔') + '</span>' +
        '<div class="r-main"><div class="r-name">' + esc(r.name || (d ? d.name : r.out)) + (r.count > 1 ? ' <span class="r-count">×' + r.count + '</span>' : '') +
        '<span class="r-goal is-hidden">Úkol</span></div>' +
        '<div class="r-desc">' + esc(d ? d.desc : '') + '</div><div class="r-needs">' + needs + '</div></div>' +
        '<button type="button" class="btn btn-craft" id="craft-btn-' + esc(r.id) + '">Vyrobit</button>';
      row.querySelectorAll('.need').forEach((c) => {
        const id = c.dataset.need;
        chips.push({ id, need: r.needs[id], el: c, n: c.querySelector('.need-n') });
      });
      recipeRows.push({ r, row, btn: row.querySelector('.btn-craft'), goal: row.querySelector('.r-goal'), chips, cat: cats.indexOf(r.category) >= 0 ? cats.indexOf(r.category) : cats.length - 1 });
      E.recipes.appendChild(row);
    }
    selectCategory(0, true);
  }

  function selectCategory(k, silent) {
    if (!catEls.length) return;
    craftCat = (k + catEls.length) % catEls.length;
    for (let i = 0; i < catEls.length; i++) {
      setCls(catEls[i], 'active', i === craftCat);
      catEls[i].setAttribute('aria-pressed', String(i === craftCat));
    }
    for (const rr of recipeRows) showEl(rr.row, rr.cat === craftCat);
    const sel = recipeRows.find((rr) => rr.r.id === craftSel);
    if (!sel || sel.cat !== craftCat) {
      const first = recipeRows.find((rr) => rr.cat === craftCat);
      setCraftSel(first ? first.r.id : null);
    }
    if (!silent) sfx('ui_click', 0.3);
    E.recipes.scrollTop = 0;
  }
  function setCraftSel(id) {
    craftSel = id;
    for (const rr of recipeRows) setCls(rr.row, 'selected', rr.r.id === id);
  }
  function goalRecipe() {
    const GS = G.goals;
    const g = GS && GS.current ? GS.current() : null;
    return g && g.recipe ? g.recipe : null;
  }
  function pickDefaultCategory() {
    const gr = goalRecipe();
    const rr = gr ? recipeRows.find((x) => x.r.id === gr) : null;
    if (rr && rr.cat >= 0) { selectCategory(rr.cat, true); setCraftSel(rr.r.id); return; }
    const inv = G.inventory;
    if (inv && recipeRows.length) {
      const cur = recipeRows.some((x) => x.cat === craftCat && inv.canCraft(x.r.id));
      if (!cur) {
        const any = recipeRows.find((x) => inv.canCraft(x.r.id));
        if (any) { selectCategory(any.cat, true); return; }
      }
    }
    selectCategory(craftCat, true);
  }
  function updateRecipes() {
    const inv = G.inventory;
    if (!inv || !recipeRows.length) return;
    const gr = goalRecipe();
    const perCat = new Array(catEls.length).fill(0);
    let total = 0;
    for (const rr of recipeRows) {
      const can = inv.canCraft(rr.r.id);
      if (can) { total++; if (rr.cat >= 0) perCat[rr.cat]++; }
      rr.btn.disabled = !can;
      setCls(rr.row, 'can', can);
      showEl(rr.goal, rr.r.id === gr);
      if (invOpen && invTab === 'craft') {
        for (const c of rr.chips) {
          const have = inv.count(c.id);
          setText(c.n, have + '/' + c.need);
          setCls(c.el, 'miss', have < c.need);
        }
      }
    }
    for (let i = 0; i < catEls.length; i++) {
      const b = catEls[i].querySelector('.cat-badge');
      setText(b, perCat[i] ? perCat[i] : '');
    }
    setText(E['craft-badge'], total || '');
    showEl(E['craft-badge'], total > 0);
  }
  function craft(id) {
    const inv = G.inventory;
    if (!inv || !id) return false;
    const rr = recipeRows.find((x) => x.r.id === id);
    const ok = inv.craft(id);
    if (rr) {
      restartAnim(rr.row, ok ? 'crafted' : 'nope');
      if (ok) {
        const d = itemDef(rr.r.out);
        const pop = el('span', 'craft-pop', '+' + rr.r.count + ' ' + (d ? d.icon : ''));
        rr.row.appendChild(pop);
        setTimeout(() => pop.remove(), 900);
      }
    }
    setCraftSel(id);
    invDirty = true;
    renderPanel();
    return ok;
  }
  function moveCraftSel(dir) {
    const vis = recipeRows.filter((x) => x.cat === craftCat);
    if (!vis.length) return;
    let i = vis.findIndex((x) => x.r.id === craftSel);
    i = i < 0 ? 0 : (i + dir + vis.length) % vis.length;
    setCraftSel(vis[i].r.id);
    vis[i].row.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------------------
  // Screens (menu / pause / game over / victory / help / settings)
  // ---------------------------------------------------------------------------
  const SCREENS = ['menu', 'pause', 'over', 'victory', 'help', 'settings'];
  function baseScreen() {
    if (G.state === 'menu') return 'menu';
    if (G.state === 'dead') return overShown ? 'over' : null;
    if (G.state === 'playing' && G.paused) return 'pause';
    return null;
  }
  function topOverlay() { return overlays.length ? overlays[overlays.length - 1] : null; }
  function visibleScreen() {
    const name = topOverlay() || baseScreen();
    return name ? E['scr-' + name] : null;
  }
  let lastVisible = null;
  function refreshScreens() {
    if (!built) return;
    const top = topOverlay() || baseScreen();
    for (const n of SCREENS) {
      const e = E['scr-' + n];
      const on = n === top;
      if (!on && !e.classList.contains('is-hidden')) blurInside(e);
      showEl(e, on);
    }
    root.dataset.state = G.state === 'playing' ? (G.paused ? 'paused' : 'playing') : G.state;
    setCls(root, 'has-screen', !!top);
    setCls(root, 'has-overlay', overlays.length > 0);
    if (top !== lastVisible) {
      lastVisible = top;
      if (top) {
        const e = E['scr-' + top];
        restartAnim(e, 'enter');
        if (top === 'menu') refreshMenu();
        if (top === 'pause') refreshPause();
        if (top === 'settings') syncSettings();
        if (!coarse()) {
          const f = e.querySelector('.btn-primary:not(.is-hidden)') || e.querySelector('button:not(.is-hidden)');
          if (f) try { f.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
        }
      }
    }
  }
  function blurInside(e) {
    const a = document.activeElement;
    if (a && e && e.contains(a) && a.blur) a.blur();
  }
  const OVERLAY_BLOCK = { help: 'ui-help', settings: 'ui-settings', victory: 'ui-victory' };
  const overlayFocus = [];           // the element that had focus when each overlay opened
  function pushOverlay(name) {
    if (!built || topOverlay() === name) return;
    const i = overlays.indexOf(name);
    if (i >= 0) { overlays.splice(i, 1); overlayFocus.splice(i, 1); }
    overlayFocus.push(document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
    if (invOpen) closeInventory(true);
    overlays.push(name);
    if (G.state === 'playing' && !G.paused) {
      G.setUIBlock(OVERLAY_BLOCK[name], true);
      // full-screen help / victory card: the world must not keep running behind it (shark!)
      if (name === 'help' || name === 'victory') {
        pausedByOverlay = true;
        G.setPaused(true);
        if (!G.paused) pausedByOverlay = false;
      }
    }
    sfx('ui_open', 0.5);
    refreshScreens();
  }
  function popOverlay(silent) {
    const name = overlays.pop();
    if (!name) return;
    const back = overlayFocus.pop();
    G.setUIBlock(OVERLAY_BLOCK[name], false);
    if (!silent) sfx('ui_close', 0.5);
    if (!overlays.length && pausedByOverlay) {
      pausedByOverlay = false;
      if (G.state === 'playing' && G.paused) G.setPaused(false);
    }
    refreshScreens();
    // keyboard users land back on the button that opened the overlay
    if (back && back.isConnected && back.focus && !coarse() && !back.closest('.is-hidden')) {
      try { back.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    }
  }
  function toggleHelp() {
    if (topOverlay() === 'help') popOverlay();
    else if (G.state !== 'boot') pushOverlay('help');
  }

  function daysAgo(n) { return n <= 1 ? 'před 1 dnem' : 'před ' + n + ' dny'; }
  function saveInfo() {
    const d = G.save && G.save.read ? G.save.read() : null;
    if (!d) return null;
    let when = '';
    if (d.savedAt) {
      const min = Math.floor((Date.now() - d.savedAt) / 60000);
      when = min < 1 ? 'právě teď' : min < 60 ? 'před ' + min + ' min' : min < 60 * 24 ? 'před ' + Math.floor(min / 60) + ' h' : daysAgo(Math.floor(min / 1440));
    }
    const day = d.stats && d.stats.days ? d.stats.days : 1;
    return 'Den ' + day + (when ? ' · uloženo ' + when : '');
  }
  function refreshMenu() {
    const info = saveInfo();
    showEl(E['btn-continue'], !!info);
    setText(E['continue-info'], info || '');
    setCls(E['btn-new'], 'btn-primary', !info);
    const persistent = !G.save || G.save.persistent !== false;
    setText($('menu-foot'), !persistent ? 'Ukládání tu nefunguje – po zavření stránky se postup ztratí.'
      : coarse() ? 'Hra se sama ukládá.' : G.desktop && G.desktop.available ? 'Hra se sama ukládá. Pauza: Esc. Celá obrazovka: F11.' : 'Hra se sama ukládá. Pauza: Esc.');
    newConfirmUntil = 0;
    setText(E['btn-new'], 'Nová hra');
  }
  function refreshPause() {
    const day = G.world && G.world.day ? G.world.day : G.stats.days || 1;
    setText(E['pause-info'], 'Den ' + day + ' · na moři ' + fmtTime(G.time));
  }
  function statsHTML(stats, time) {
    let h = '';
    for (const [k, label] of STAT_NAMES) h += '<div><dt>' + label + '</dt><dd>' + (Number(stats && stats[k]) || 0) + '</dd></div>';
    h += '<div><dt>Čas na moři</dt><dd>' + fmtTime(time) + '</dd></div>';
    return h;
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  function applyTouchTexts() {
    if (!built) return;
    const t = touch() || root.classList.contains('is-touch');
    setText(E['lbl-sens'], t ? 'Citlivost rozhlížení' : 'Citlivost myši');
    setText(E['lbl-invert-sub'], t ? 'prst nahoru = pohled dolů' : 'myš nahoru = pohled dolů');
  }
  function syncSettings() {
    if (!built) return;
    const S = G.settings;
    E['set-sens'].value = String(S.sensitivity);
    E['set-volume'].value = String(S.volume);
    E['set-music'].value = String(S.music);
    setText(E['set-sens-v'], Number(S.sensitivity).toFixed(2).replace('.', ',') + '×');
    setText(E['set-volume-v'], Math.round(S.volume * 100) + ' %');
    setText(E['set-music-v'], Math.round(S.music * 100) + ' %');
    E['set-invert'].setAttribute('aria-checked', String(!!S.invertY));
    setCls(E['set-invert'], 'on', !!S.invertY);
    const low = S.quality === 'low';
    setCls(E['set-quality-low'], 'active', low);
    setCls(E['set-quality-high'], 'active', !low);
    E['set-quality-low'].setAttribute('aria-checked', String(low));
    E['set-quality-high'].setAttribute('aria-checked', String(!low));
  }
  function setSetting(k, v) {
    G.settings[k] = v;
    G.saveSettings();
    syncSettings();
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  function click(id, fn) {
    const e = $(id);
    if (e) e.addEventListener('click', (ev) => { ev.preventDefault(); fn(ev); });
  }

  function bindEvents() {
    // HUD hotbar: click / tap selects, wheel scrolls
    E.hotbar.addEventListener('pointerdown', (e) => {
      const s = e.target.closest('.hud-slot');
      if (!s || !G.isPlaying() || G.uiBlocking()) return;
      e.preventDefault();
      e.stopPropagation();
      if (G.inventory) G.inventory.select(Number(s.dataset.i));
    });
    E.hotbar.addEventListener('wheel', (e) => {
      if (!G.isPlaying() || G.uiBlocking()) return;
      e.preventDefault();
      G.input.mouse.wheel += Math.sign(e.deltaY);
    }, { passive: false });
    E['goal-card'].addEventListener('click', () => E['goal-card'].classList.toggle('expanded'));

    // inventory panel
    const layer = E['panel-layer'];
    layer.addEventListener('pointerdown', onPanelPointerDown);
    layer.addEventListener('contextmenu', (e) => e.preventDefault());
    layer.addEventListener('click', (e) => {
      // keyboard activation of a slot (Enter / Space) arrives as a click with detail 0 and no
      // pointerdown before it. Touch taps can also have detail 0, so skip clicks that follow a
      // pointerdown (that already picked up / dropped the stack).
      if (e.detail !== 0 || now() - lastPanelPointerT < 700) return;
      if (e.pointerType === 'mouse' || e.pointerType === 'touch' || e.pointerType === 'pen') return;
      const hit = slotFromEvent(e);
      if (!hit) return;
      if (held) dropHeldOn(hit.grid, hit.i); else pickUp(hit.grid, hit.i);
      renderPanel();
    });
    layer.addEventListener('dblclick', (e) => {
      const hit = slotFromEvent(e);
      if (!hit || hit.grid !== 'inv') return;
      const s = slotAt('inv', hit.i);
      const d = s ? itemDef(s.id) : null;
      if (!d || !d.food) return;
      held = { grid: 'inv', i: hit.i, id: s.id };
      eatHeld();
      held = null;
      invDirty = true;
      renderPanel();
    });
    layer.addEventListener('pointerover', (e) => {
      const hit = slotFromEvent(e);
      hoverSlot = hit ? { grid: hit.grid, i: hit.i } : null;
      if (hit && e.pointerType === 'mouse') { pointerX = e.clientX; pointerY = e.clientY; showTooltip(hit.grid, hit.i); } else if (!hit) hideTooltip();
    });
    layer.addEventListener('pointerout', (e) => {
      const hit = slotFromEvent(e);
      if (hit && (!e.relatedTarget || !hit.el.contains(e.relatedTarget))) { hoverSlot = null; hideTooltip(); }
    });
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp);
    click('tab-inv', () => { if (invTab !== 'inv') { setTab('inv'); sfx('ui_click', 0.3); renderPanel(); } });
    click('tab-craft', () => { if (invTab !== 'craft') { setTab('craft'); sfx('ui_click', 0.3); renderPanel(); } });
    click('btn-inv-close', () => closeInventory());
    click('btn-take-all', () => {
      if (!storage || !G.inventory) return;
      suppressGains = true;
      let n = 0;
      try { n = G.inventory.takeAll(storage, 'storage'); } finally { suppressGains = false; }
      sfx(n ? 'pickup' : 'error', 0.5);
      if (n) G.notify('Přesunuto do batohu: ' + n + ' ks', 'good');
      invDirty = true;
      renderPanel();
    });
    click('btn-store-all', () => storeAll());
    E.detail.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.id === 'btn-eat') eatHeld();
      else if (b.id === 'btn-to-hand') heldToHand();
      else if (b.id === 'btn-split' && held) { const h = held; held = null; splitAt(h.grid, h.i); renderPanel(); }
    });
    E.cats.addEventListener('click', (e) => {
      const b = e.target.closest('.cat');
      if (b) selectCategory(Number(b.dataset.k));
    });
    E.recipes.addEventListener('click', (e) => {
      const row = e.target.closest('.recipe');
      if (!row) return;
      if (e.target.closest('.btn-craft')) craft(row.dataset.r);
      else setCraftSel(row.dataset.r);
    });

    // menu
    click('btn-continue', () => { sfx('ui_click'); G.continueGame(); });
    click('btn-new', () => {
      const t = now();
      if (G.save && G.save.exists() && t > newConfirmUntil) {
        newConfirmUntil = t + 3500;
        setText(E['btn-new'], 'Opravdu? Uložená hra zmizí');
        E['btn-new'].classList.add('confirm');
        sfx('warning', 0.3);
        setTimeout(() => { if (now() > newConfirmUntil) { setText(E['btn-new'], 'Nová hra'); E['btn-new'].classList.remove('confirm'); } }, 3600);
        return;
      }
      newConfirmUntil = 0;
      E['btn-new'].classList.remove('confirm');
      sfx('ui_click');
      G.newGame();
    });
    click('btn-menu-help', () => pushOverlay('help'));
    click('btn-menu-settings', () => pushOverlay('settings'));
    // pause
    click('btn-resume', () => { sfx('ui_click'); G.setPaused(false); });
    click('btn-pause-help', () => pushOverlay('help'));
    click('btn-pause-settings', () => pushOverlay('settings'));
    click('btn-save-quit', () => { sfx('ui_click'); G.save.write(); G.toMenu(); });
    click('btn-menu-quit', () => { sfx('ui_click'); if (G.desktop) G.desktop.quit(); });
    click('btn-pause-quit', () => { sfx('ui_click'); if (G.desktop) G.desktop.quit(); });
    // game over
    click('btn-again', () => { sfx('ui_click'); G.newGame(); });
    click('btn-over-menu', () => { sfx('ui_click'); G.toMenu(); });
    // overlays
    click('btn-help-close', () => popOverlay());
    click('btn-settings-close', () => popOverlay());
    click('btn-victory-continue', () => popOverlay());
    // settings controls
    E['set-sens'].addEventListener('input', (e) => setSetting('sensitivity', Number(e.target.value)));
    E['set-volume'].addEventListener('input', (e) => setSetting('volume', Number(e.target.value)));
    E['set-music'].addEventListener('input', (e) => setSetting('music', Number(e.target.value)));
    click('set-invert', () => setSetting('invertY', !G.settings.invertY));
    click('set-quality-low', () => setSetting('quality', 'low'));
    click('set-quality-high', () => setSetting('quality', 'high'));
    // stop clicks inside screens from reaching the canvas
    for (const n of SCREENS) E['scr-' + n].addEventListener('pointerdown', (e) => e.stopPropagation());

    // game events
    const on = (n, f) => G.events.on(n, f);
    on('notify', onNotify);
    on('item:gained', onGained);
    on('inventory:changed', () => { invDirty = true; hotDirty = true; });
    on('storage:changed', () => { invDirty = true; });
    on('equip:changed', (e) => {
      const idx = e ? e.index : -1;
      if (idx !== lastEquipIdx || (e && e.slot)) { lastEquipIdx = idx; showHeldName(); }
    });
    on('player:damaged', (e) => {
      const a = Math.max(0, Number(e && e.amount) || 0);
      vignette = Math.min(1, vignette + 0.35 + a / 45);
      if (statEls.health) restartAnim(statEls.health.el, 'hit');
    });
    on('pirates:sighted', () => eventBanner('Piráti na obzoru!', 'danger', 4, 'pirates', 20000));
    on('shark:attack', (e) => {
      if (e && e.target === 'player') eventBanner('Žralok! Rychle z vody!', 'danger', 2.5, 'shark-p', 12000);
      else eventBanner('Žralok útočí na vor!', 'danger', 3, 'shark', 25000);
    });
    on('world:storm', (e) => { if (e && e.active) eventBanner(e.text || 'Blíží se bouře!', e.power > 1.2 ? 'danger' : 'warn', 3.5, 'storm', 30000); });
    on('tile:destroyed', () => eventBanner('Vor přišel o kus!', 'danger', 2.5, 'tile', 5000));
    on('goal:done', (e) => {
      if (e && e.final) victoryPending = now() + 1600;
    });
    on('game:start', onGameStart);
    on('game:menu', () => {
      closeAll();
      overShown = false;
      clearTimeout(overTimer);
      refreshScreens();
    });
    on('game:paused', () => {
      pausedAt = now();
      closeInventory(true);
      refreshScreens();
    });
    on('game:resumed', () => {
      while (overlays.length) popOverlay(true);
      refreshScreens();
    });
    on('game:over', (e) => {
      closeAll();
      overData = e || {};
      overShown = false;
      setText(E['over-reason'], overData.reason || 'Tvoje plavba skončila.');
      E['over-stats'].innerHTML = statsHTML(overData.stats || G.stats, overData.time || G.time);
      refreshScreens();
      clearTimeout(overTimer);
      overTimer = setTimeout(() => { if (G.state === 'dead') { overShown = true; refreshScreens(); } }, 1700);
    });
    on('settings:changed', syncSettings);
    on('input:touchmode', () => { setCls(root, 'is-touch', true); goalVersion = -1; applyTouchTexts(); invDirty = true; });

    // pointer lock: a refusal right after a working lock is usually the browser's short cooldown
    // after Esc — let the next click on the game try again instead of falling back to free look.
    document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement) lockWorked = true; });
    document.addEventListener('pointerlockerror', () => {
      if (!lockWorked) return;
      setTimeout(() => { if (G.input && !G.input.pointerLocked) G.input.lockFailed = false; }, 60);
    });
  }

  function onGameStart() {
    closeAll();
    overShown = false;
    clearTimeout(overTimer);
    clearNotes();
    pendingBanners.length = 0;
    bannerUntil = 0;
    E.banner.classList.remove('show');
    setCls(root, 'banner-on', false);
    vignette = 0;
    shownGoal = null;
    goalVersion = -1;
    goalHolding = false;
    allDoneAt = 0;
    victoryPending = 0;
    hotVersion = -1;
    lastCur = null;
    E['goal-card'].classList.remove('is-done', 'expanded');
    refreshScreens();
    setTimeout(showHeldName, 400);
  }

  // ---------------------------------------------------------------------------
  // Keys (polled from G.input so touch.js virtual keys work the same)
  // ---------------------------------------------------------------------------
  function handleKeys() {
    const I = G.input;
    if (!I) return;
    const esc = I.pressed('Escape'), pk = I.pressed('KeyP');
    const top = topOverlay();

    if (esc || pk) {
      if (top) { if (esc || top === 'help') popOverlay(); }
      else if (invOpen) closeInventory();
      else if (G.state === 'playing') {
        if (G.paused) { if (now() - pausedAt > 280) G.setPaused(false); }
        // Esc at the cannon means "get up" (pirates.js); P always pauses
        else if (pk || !(G.pirates && G.pirates.seated)) G.setPaused(true);
      }
      return;
    }
    if (I.pressed('KeyH') && G.state !== 'boot' && !(G.state === 'dead' && !overShown)) { toggleHelp(); return; }

    const scr = visibleScreen();
    if (scr) {
      const shift = I.down('ShiftLeft') || I.down('ShiftRight');
      if (I.pressed('ArrowDown') || (I.pressed('Tab') && !shift)) moveFocus(scr, 1);
      else if (I.pressed('ArrowUp') || (I.pressed('Tab') && shift)) moveFocus(scr, -1);
      return;
    }

    const invKey = I.pressed('Tab') || I.pressed('KeyI');
    const craftKey = I.pressed('KeyC');
    if (invOpen) {
      if (invKey || (storage && I.pressed('KeyE'))) { closeInventory(); return; }
      if (craftKey) {
        if (invTab === 'craft' && !storage) closeInventory();
        else { setTab('craft'); renderPanel(); sfx('ui_click', 0.3); }
        return;
      }
      if (invTab === 'craft') {
        if (I.pressed('ArrowDown')) moveCraftSel(1);
        else if (I.pressed('ArrowUp')) moveCraftSel(-1);
        else if (I.pressed('ArrowRight')) selectCategory(craftCat + 1);
        else if (I.pressed('ArrowLeft')) selectCategory(craftCat - 1);
        else if (I.pressed('Enter') || I.pressed('NumpadEnter')) {
          const a = document.activeElement;
          if (!a || a.tagName !== 'BUTTON') craft(craftSel);
        }
      }
      return;
    }
    if ((invKey || craftKey) && canOpenPanels() && !G.uiBlocking()) {
      openInventory(craftKey ? 'craft' : 'inv', null, '');
    }
  }
  function moveFocus(scr, dir) {
    const list = Array.prototype.filter.call(scr.querySelectorAll('button, input'), (b) => !b.disabled && b.offsetParent !== null);
    if (!list.length) return;
    let i = list.indexOf(document.activeElement);
    i = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
    try { list[i].focus({ preventScroll: false }); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Module
  // ---------------------------------------------------------------------------
  G.register({
    name: 'ui',
    order: 90,

    init() {
      build();
      if (built && coarse()) setCls(root, 'is-touch', true);
      applyTouchTexts();
    },

    reset() {
      if (!built) return;
      closeAll();
      held = null;
      drag = null;
      storage = null;
      invDirty = true;
      hotVersion = -1;
      vignette = 0;
      shownGoal = null;
      goalVersion = -1;
      goalHolding = false;
      allDoneAt = 0;
      victoryPending = 0;
      pausedByOverlay = false;
      clearNotes();
      pendingBanners.length = 0;
      for (const k in throttle) delete throttle[k];
      bannerUntil = 0;
      bannerText = '';
      E.banner.classList.remove('show');
      setCls(root, 'banner-on', false);
      E['fx-under'].classList.remove('on');
      E['fx-lowhp'].classList.remove('on');
    },

    frame(dt) {
      if (!built) return;
      handleKeys();
      const playing = G.state === 'playing';
      if (playing) {
        updateHotbar();
        updateCenter();
      }
      updateFx(dt);
      updateBanner();
      hudT += dt;
      if (hudT >= 1 / 15) {
        hudT = 0;
        if (playing) {
          updateStats();
          updateGoal();
          updateLockHint();
          if (heldNameT && now() > heldNameT) { heldNameT = 0; E['held-name'].classList.remove('show'); E['held-name']._c_show = false; }
        }
        updateNotes();
        if (G.goals && G.goals.version !== panelGoalVersion) { panelGoalVersion = G.goals.version; invDirty = true; }
        if (invOpen && invDirty) renderPanel();
        if (victoryPending && now() > victoryPending && G.isPlaying() && !invOpen && overlays.length === 0) {
          victoryPending = 0;
          E['victory-stats'].innerHTML = statsHTML(G.stats, G.time);
          pushOverlay('victory');
        }
      }
      statusT += dt;
      if (statusT >= 0.2) {
        statusT = 0;
        if (playing) updateStatus();
      }
      // keep the screen set in sync with the core state (menu / pause / death)
      const want = topOverlay() || baseScreen();
      if (want !== lastVisible) refreshScreens();
    },
  });
})();
