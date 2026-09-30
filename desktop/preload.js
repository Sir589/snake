// Exposes a tiny, safe API to the game page (vor/js/desktop.js reads it as window.siremoreDesktop).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('siremoreDesktop', {
  quit: () => ipcRenderer.send('game:quit'),
  toggleFullscreen: () => ipcRenderer.send('game:fullscreen'),
  steamStatus: () => ipcRenderer.invoke('steam:status'),
  achievement: (name) => ipcRenderer.send('steam:achievement', String(name)),
});
