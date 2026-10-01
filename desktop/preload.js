// Exposes a tiny, safe API to the game page (vor/js/desktop.js reads it as window.siremoreDesktop).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('siremoreDesktop', {
  quit: () => ipcRenderer.send('game:quit'),
  toggleFullscreen: () => ipcRenderer.send('game:fullscreen'),
  steamStatus: () => ipcRenderer.invoke('steam:status'),
  achievement: (name) => ipcRenderer.send('steam:achievement', String(name)),
  // co-op (vor/js/net.js)
  net: {
    lanHost: () => ipcRenderer.invoke('net:lanHost'),
    lanStop: () => ipcRenderer.invoke('net:lanStop'),
    steamHost: () => ipcRenderer.invoke('net:steamHost'),
    steamJoin: (id) => ipcRenderer.invoke('net:steamJoin', String(id)),
    steamInvite: () => ipcRenderer.send('net:steamInviteDialog'),
    steamLeave: () => ipcRenderer.send('net:steamLeave'),
    steamSend: (to, data) => ipcRenderer.send('net:steamSend', String(to), String(data)),
    launchLobby: () => ipcRenderer.invoke('net:launchLobby'),
    onSteamMsg: (cb) => ipcRenderer.on('net:steamMsg', (_e, p) => cb(p)),
    onSteamPeers: (cb) => ipcRenderer.on('net:steamPeers', (_e, p) => cb(p)),
    onSteamInvite: (cb) => ipcRenderer.on('net:steamInvite', (_e, p) => cb(p)),
  },
});
