// LAN hub for co-op (ROADMAP 10). One WebSocket server that routes JSON messages between the host
// (the player who opened the game) and the guests. The desktop app runs it when you host a LAN
// game; the test runner (vor/tools/coop-test.mjs) runs the same file.
//
//   const hub = require('./net-hub').start({ port: 47810 });   hub.close();
//
// Clients connect to ws://<ip>:<port>/?role=host|guest&name=<name>.
// Hub → client: {t:'hub', you, host, peers:[{id,name}]}, {t:'join', id, name}, {t:'leave', id}
// Client → hub: {to: '<id>' | '*' | 'host', m: <message>}  → delivered as {from, m}
const { WebSocketServer } = require('ws');

const PORT = 47810;
const MAX_PEERS = 8;
const MAX_MSG = 2 * 1024 * 1024;

function start(opts) {
  opts = opts || {};
  const wss = new WebSocketServer({ port: opts.port || PORT, host: opts.bind || '0.0.0.0', maxPayload: MAX_MSG });
  const peers = new Map();        // id -> { ws, name, role }
  let seq = 0, hostId = null;

  const send = (ws, obj) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) { /* gone */ } };
  const clean = (s, n) => String(s || '').replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, n) || 'Hráč';

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/', 'http://x');
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'guest';
    if (role === 'host' && hostId && peers.has(hostId)) { send(ws, { t: 'error', reason: 'host-taken' }); ws.close(); return; }
    if (role === 'guest' && (!hostId || !peers.has(hostId))) { send(ws, { t: 'error', reason: 'no-host' }); ws.close(); return; }
    if (peers.size >= MAX_PEERS) { send(ws, { t: 'error', reason: 'full' }); ws.close(); return; }
    const id = 'p' + (++seq);
    const name = clean(url.searchParams.get('name'), 20);
    peers.set(id, { ws, name, role });
    if (role === 'host') hostId = id;
    send(ws, { t: 'hub', you: id, host: hostId, peers: Array.from(peers, ([pid, p]) => ({ id: pid, name: p.name })) });
    for (const [pid, p] of peers) if (pid !== id) send(p.ws, { t: 'join', id, name });

    ws.on('message', (buf) => {
      let o;
      try { o = JSON.parse(buf.toString()); } catch (e) { return; }
      if (!o || typeof o !== 'object') return;
      const out = { from: id, m: o.m };
      if (o.to === '*') { for (const [pid, p] of peers) if (pid !== id) send(p.ws, out); }
      else if (o.to === 'host') { const h = peers.get(hostId); if (h && hostId !== id) send(h.ws, out); }
      else { const p = peers.get(String(o.to)); if (p) send(p.ws, out); }
    });
    ws.on('close', () => {
      peers.delete(id);
      if (id === hostId) {
        // the host left: the session is over for everyone
        for (const [, p] of peers) { send(p.ws, { t: 'error', reason: 'host-left' }); try { p.ws.close(); } catch (e) { /* ignore */ } }
        peers.clear();
        hostId = null;
        return;
      }
      for (const [, p] of peers) send(p.ws, { t: 'leave', id });
    });
    ws.on('error', () => {});
  });

  return {
    port: opts.port || PORT,
    peers: () => peers.size,
    close: () => new Promise((res) => { for (const [, p] of peers) { try { p.ws.close(); } catch (e) { /* ignore */ } } wss.close(() => res()); }),
    ready: new Promise((res, rej) => { wss.on('listening', res); wss.on('error', rej); }),
  };
}

module.exports = { start, PORT };
