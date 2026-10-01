// Širé moře – desktop app (Electron). Opens the game (vor/index.html) in a fullscreen window
// without a menu bar. Saves use localStorage, which Electron keeps in %APPDATA%\SireMore.
const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const path = require('path');
const steam = require('./steam');
const os = require('os');
const netHub = require('./net-hub');

const GAME_TITLE = 'Širé moře';
// Packaged: the game is copied to resources/game (see "extraResources" in package.json).
const gameDir = app.isPackaged ? path.join(process.resourcesPath, 'game') : path.join(__dirname, '..', 'vor');
const iconPath = path.join(__dirname, 'build', 'icon.png');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Steam has to be initialised before the app is ready (the overlay needs extra GPU switches).
  steam.init([path.dirname(process.execPath), __dirname, process.cwd()]);
  Menu.setApplicationMenu(null);

  let win = null;

  function createWindow() {
    win = new BrowserWindow({
      title: GAME_TITLE,
      icon: iconPath,
      width: 1280,
      height: 720,
      minWidth: 800,
      minHeight: 500,
      fullscreen: true,
      autoHideMenuBar: true,
      backgroundColor: '#06222b',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.once('ready-to-show', () => win.show());
    win.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle(GAME_TITLE); });

    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      // F11 (fullscreen) is handled by the game page itself (vor/js/desktop.js → game:fullscreen).
      if (input.key === 'F12' && !app.isPackaged) {
        win.webContents.toggleDevTools();
      } else if ((input.control || input.meta) && ['r', 'R'].includes(input.key)) {
        event.preventDefault(); // no accidental reloads in the middle of a game
      }
    });

    // The game never navigates away; open real web links (if any) in the system browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('file://')) e.preventDefault();
    });

    win.loadFile(path.join(gameDir, 'index.html'));
    win.on('closed', () => { win = null; });
  }

  ipcMain.on('game:quit', () => app.quit());
  ipcMain.on('game:fullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()); });
  ipcMain.handle('steam:status', () => steam.status());
  ipcMain.on('steam:achievement', (_e, name) => steam.achievement(name));

  // --- co-op (ROADMAP 10) ---------------------------------------------------------------------
  // LAN: this app runs the hub; everybody (the host page too) connects to it with a WebSocket.
  let hub = null;
  const lanIps = () => {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a && a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
    return out;
  };
  ipcMain.handle('net:lanHost', async () => {
    if (!hub) {
      hub = netHub.start({ port: netHub.PORT, bind: process.env.SIREMORE_HUB_BIND || '0.0.0.0' });
      try { await hub.ready; } catch (e) { hub = null; return { ok: false, error: String(e && e.message || e) }; }
    }
    return { ok: true, port: netHub.PORT, ips: lanIps() };
  });
  ipcMain.handle('net:lanStop', async () => { if (hub) { await hub.close(); hub = null; } return true; });
  // Steam: lobby + P2P
  steam.net.setSink((ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); });
  ipcMain.handle('net:steamHost', async () => { try { return Object.assign({ ok: true }, await steam.net.host()); } catch (e) { return { ok: false, error: String(e.message || e) }; } });
  ipcMain.handle('net:steamJoin', async (_e, id) => { try { return Object.assign({ ok: true }, await steam.net.join(String(id))); } catch (e) { return { ok: false, error: String(e.message || e) }; } });
  ipcMain.on('net:steamInviteDialog', () => steam.net.invite());
  ipcMain.on('net:steamLeave', () => steam.net.leave());
  ipcMain.on('net:steamSend', (_e, to, data) => steam.net.send(to, data));
  ipcMain.handle('net:launchLobby', () => steam.net.launchLobby(process.argv));
  app.on('before-quit', () => { steam.net.leave(); if (hub) hub.close(); });

  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
