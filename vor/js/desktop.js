// desktop.js — bridge to the desktop (Electron) build. In a normal browser it does nothing.
// The Electron preload script exposes `window.siremoreDesktop`; this module wraps it as G.desktop:
//   G.desktop.available            true inside the desktop app
//   G.desktop.quit()               saves (when a game is running) and closes the app
//   G.desktop.toggleFullscreen()   same as F11
//   G.desktop.steam                { running, name } once Steam answered (null without Steam)
// Finished goals unlock Steam achievements named GOAL_<GOAL ID> (e.g. GOAL_KLADIVO, GOAL_LOD).
(function () {
  'use strict';
  const bridge = window.siremoreDesktop || null;

  const D = (G.desktop = {
    available: !!bridge,
    steam: null,
    quit() {
      if (G.state === 'playing' && G.save) G.save.write();
      if (bridge) bridge.quit();
    },
    toggleFullscreen() { if (bridge) bridge.toggleFullscreen(); },
    achievement(name) { if (bridge && D.steam && D.steam.running) bridge.achievement(name); },
  });

  if (!bridge) return;
  document.body.classList.add('is-desktop');
  // F11 = fullscreen on/off (handled here so it works wherever the game has focus).
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F11' && !e.repeat) { e.preventDefault(); e.stopPropagation(); D.toggleFullscreen(); }
  }, true);

  G.register({
    name: 'desktop',
    order: 99,
    init() {
      G.events.on('goal:done', (e) => { if (e && e.id) D.achievement('GOAL_' + String(e.id).toUpperCase()); });
      Promise.resolve(bridge.steamStatus()).then((s) => {
        D.steam = s || null;
        // Goals finished before Steam was connected (e.g. an older save) still unlock.
        if (D.steam && D.steam.running && G.goals && G.goals.list) {
          for (const g of G.goals.list) if (g.done) D.achievement('GOAL_' + g.id.toUpperCase());
        }
      }).catch(() => {});
    },
  });
})();
