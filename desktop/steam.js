// Optional Steam integration (steamworks.js). The game must run without Steam too, so every call
// here is wrapped: when Steam is not installed/running (or the app is not owned) we simply report
// `running: false` and the achievements become no-ops.
const fs = require('fs');
const path = require('path');

let client = null;
let lastError = null;

// App ID: Steam sets SteamAppId when it launches the game; otherwise steam_appid.txt next to the
// exe (or in this folder while developing). 480 = Valve's public test app "Spacewar".
function readAppId(baseDirs) {
  const env = Number(process.env.SteamAppId || process.env.SteamGameId);
  if (Number.isInteger(env) && env > 0) return env;
  for (const dir of baseDirs) {
    try {
      const n = Number(fs.readFileSync(path.join(dir, 'steam_appid.txt'), 'utf8').trim());
      if (Number.isInteger(n) && n > 0) return n;
    } catch { /* not there */ }
  }
  return null;
}

function init(baseDirs) {
  const appId = readAppId(baseDirs);
  if (!appId) { lastError = 'chybí App ID (steam_appid.txt)'; return false; }
  let steamworks;
  try { steamworks = require('steamworks.js'); } catch (e) { lastError = 'steamworks.js nejde načíst: ' + e.message; return false; }
  try {
    client = steamworks.init(appId);
    // Shift+Tab overlay inside Electron needs a couple of Chromium switches (set before app ready).
    steamworks.electronEnableSteamOverlay();
    return true;
  } catch (e) {
    client = null;
    lastError = 'Steam neběží: ' + (e && e.message ? e.message : e);
    return false;
  }
}

function status() {
  if (!client) return { running: false, error: lastError };
  let name = '';
  try { name = client.localplayer.getName(); } catch { /* ignore */ }
  return { running: true, name };
}

function achievement(name) {
  if (!client || typeof name !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(name)) return false;
  try {
    if (client.achievement.isActivated(name)) return true;
    return client.achievement.activate(name);
  } catch { return false; }
}

module.exports = { init, status, achievement };
