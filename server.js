const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const game = require('./game');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const THREE_DIR = path.join(__dirname, 'node_modules', 'three');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  // Three.js and its addons are served straight from node_modules.
  let root = PUBLIC;
  let rel = url === '/' ? '/index.html' : url;
  if (url.startsWith('/vendor/addons/')) [root, rel] = [path.join(THREE_DIR, 'examples', 'jsm'), url.slice('/vendor/addons'.length)];
  else if (url.startsWith('/vendor/')) [root, rel] = [path.join(THREE_DIR, 'build'), url.slice('/vendor'.length)];
  const file = path.join(root, rel);
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const rooms = new Map();
let nextId = 1;

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  for (const p of room.players) send(p.ws, msg);
}

function pushState(room) {
  const now = Date.now();
  for (const p of room.players) send(p.ws, { t: 'state', ...game.viewFor(room, p, now) });
}

function broadcastEvents(room, events) {
  for (const e of events) broadcast(room, { t: 'event', ...e });
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let room = null;
  let player = null;

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const now = Date.now();

    if (m.t === 'join') {
      if (room) return;
      let code = String(m.room || '').trim().toUpperCase();
      if (!code) {
        code = makeCode();
        rooms.set(code, { code, players: [], hostId: null, settings: { minutes: 5, modules: 3, chaos: false, colorBlind: false }, game: null });
      }
      const target = rooms.get(code);
      if (!target) return send(ws, { t: 'error', msg: `No room with code ${code}` });
      if (target.game?.status === 'playing') return send(ws, { t: 'error', msg: 'That room is mid-round. Try again when the round ends.' });
      room = target;
      player = { id: nextId++, name: String(m.name || '').trim().slice(0, 16) || 'Monkey', ws, role: null };
      room.players.push(player);
      room.hostId ??= player.id;
      return pushState(room);
    }
    if (!room) return;
    const isHost = player.id === room.hostId;
    const playing = room.game?.status === 'playing';

    if (m.t === 'settings' && isHost && !playing) {
      room.settings = {
        minutes: Math.min(10, Math.max(2, Number(m.minutes) || 5)),
        modules: Math.min(5, Math.max(1, Number(m.modules) || 3)),
        chaos: Boolean(m.chaos),
        colorBlind: Boolean(m.colorBlind),
      };
    } else if (m.t === 'start' && isHost && !playing) {
      game.startGame(room, now);
      broadcast(room, { t: 'event', kind: 'start' });
    } else if (m.t === 'pick' && !playing) {
      game.pickRole(room, player, m.role ?? null);
    } else if (m.t === 'randomize' && isHost && !playing) {
      game.randomizePicks(room);
    } else if (m.t === 'lobby' && isHost) {
      // The host can also cancel a round in progress from the in-game menu.
      if (playing) broadcast(room, { t: 'event', kind: 'cancel' });
      room.game = null;
      for (const p of room.players) p.role = null;
    } else if (m.t === 'act') {
      // Show everyone Blind's hand going to the spot that was touched (or letting go).
      if (room.game?.status === 'playing') {
        const at = Array.isArray(m.at) && m.at.length === 3 && m.at.every((v) => Number.isFinite(v) && Math.abs(v) < 10) ? m.at : null;
        if (at || m.kind === 'release') broadcast(room, { t: 'event', kind: 'reach', id: player.id, at: m.kind === 'release' ? null : at, hold: m.kind === 'hold' });
      }
      broadcastEvents(room, game.act(room, player, m, now));
    } else if (m.t === 'emote') {
      game.addEmote(room, player, m.e, now, m.aim);
    } else if (m.t === 'manual') {
      // Whether Mute has the manual open, so the others see the binder raised.
      player.reading = !!m.open;
    } else if (m.t === 'look') {
      // Head direction relative to the seat: relayed straight to the others, not stored.
      const yaw = Math.max(-1.6, Math.min(1.6, Number(m.yaw) || 0)), pitch = Math.max(-1.5, Math.min(1.5, Number(m.pitch) || 0));
      for (const p of room.players) if (p !== player) send(p.ws, { t: 'look', id: player.id, yaw, pitch });
      return;
    } else if (m.t === 'rtc') {
      // Voice chat signaling: pass WebRTC offers/answers/candidates to one player in the room.
      const to = room.players.find((p) => p.id === m.to);
      if (to) send(to.ws, { t: 'rtc', from: player.id, data: m.data });
      return;
    }
    pushState(room);
  });

  ws.on('close', () => {
    if (!room) return;
    room.players = room.players.filter((p) => p !== player);
    if (!room.players.length) return rooms.delete(room.code);
    if (room.hostId === player.id) room.hostId = room.players[0].id;
    broadcastEvents(room, game.abort(room, `${player.name} left the van`, Date.now()));
    pushState(room);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.game?.status !== 'playing') continue;
    broadcastEvents(room, game.tick(room, now));
    pushState(room);
  }
}, 200);

server.listen(PORT, () => console.log(`Banana Fuse running on http://localhost:${PORT}`));
