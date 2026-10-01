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

// ---------------------------------------------------------------------------
// Co-op over Steam (ROADMAP 10): a friends-only lobby + P2P packets (JSON strings).
// The renderer sees the same hub-style messages as on LAN (vor/js/net.js).
// ---------------------------------------------------------------------------
let steamworksMod = null, lobby = null, pollTimer = null, handles = [];
let sink = null;                 // (channel, payload) => webContents.send
const meId = () => { try { return client.localplayer.getSteamId().steamId64.toString(); } catch { return ''; } };
function mod() { if (!steamworksMod) steamworksMod = require('steamworks.js'); return steamworksMod; }
function members() {
  if (!lobby) return [];
  try { return lobby.getMembers().map((m) => m.steamId64.toString()); } catch { return []; }
}
function ownerId() { try { return lobby ? lobby.getOwner().steamId64.toString() : ''; } catch { return ''; } }
function nameOf(id) {
  try { return client.friends && client.friends.getFriendName ? client.friends.getFriendName(BigInt(id)) : ''; } catch { return ''; }
}
function emitPeers() { if (sink) sink('net:steamPeers', { me: meId(), host: ownerId(), members: members().map((id) => ({ id, name: nameOf(id) })) }); }
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (!client) return;
    try {
      for (let k = 0; k < 64; k++) {
        const size = client.networking.isP2PPacketAvailable();
        if (!size) break;
        const p = client.networking.readP2PPacket(size);
        if (sink) sink('net:steamMsg', { from: p.steamId.steamId64.toString(), data: p.data.toString('utf8') });
      }
    } catch { /* ignore */ }
  }, 25);
  try {
    const S = mod().SteamCallback;
    handles.push(client.callback.register(S.P2PSessionRequest, (e) => { try { client.networking.acceptP2PSession(e.remote); } catch { /* ignore */ } }));
    handles.push(client.callback.register(S.LobbyChatUpdate, () => emitPeers()));
    handles.push(client.callback.register(S.GameLobbyJoinRequested, (e) => { if (sink) sink('net:steamInvite', { lobby: e.lobby_steam_id.toString() }); }));
  } catch { /* ignore */ }
}
function setSink(fn) { sink = fn; if (client) startPolling(); }
async function host() {
  if (!client) throw new Error('Steam neběží');
  const T = 1;                    // LobbyType.FriendsOnly
  lobby = await client.matchmaking.createLobby(T, 8);
  try { lobby.setData('game', 'siremore'); } catch { /* ignore */ }
  startPolling();
  emitPeers();
  return { lobby: lobby.id.toString(), me: meId() };
}
async function join(id) {
  if (!client) throw new Error('Steam neběží');
  lobby = await client.matchmaking.joinLobby(BigInt(id));
  startPolling();
  emitPeers();
  return { lobby: lobby.id.toString(), me: meId(), host: ownerId() };
}
function invite() { try { if (lobby) lobby.openInviteDialog(); return !!lobby; } catch { return false; } }
function leave() { try { if (lobby) lobby.leave(); } catch { /* ignore */ } lobby = null; }
function send(to, data) {
  if (!client || !lobby) return false;
  const buf = Buffer.from(String(data), 'utf8');
  const me = meId();
  const targets = to === '*' ? members().filter((id) => id !== me) : to === 'host' ? [ownerId()] : [String(to)];
  let ok = true;
  for (const id of targets) {
    if (!id || id === me) continue;
    try { ok = client.networking.sendP2PPacket(BigInt(id), 2, buf) && ok; } catch { ok = false; }   // 2 = Reliable
  }
  return ok;
}
// Launched from a Steam invite while the game was closed: +connect_lobby <id>
function launchLobby(argv) {
  const i = argv.indexOf('+connect_lobby');
  return i >= 0 && argv[i + 1] ? String(argv[i + 1]) : '';
}

module.exports = { init, status, achievement, net: { setSink, host, join, invite, leave, send, launchLobby, members } };
