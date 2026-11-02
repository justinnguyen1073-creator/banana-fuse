import { createScene } from './scene.js';
import { createVoice } from './voice.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let ws = null;
let leaving = false;
let state = null;
let peeking = false;
let manualOpen = true, sentReading = null;
let manualPage = 0;
let lastRoleId = null;
const sigs = {};

const scene = createScene($('#scene'), { onAct: (a) => send({ t: 'act', ...a }), onLook: (yaw, pitch) => send({ t: 'look', yaw, pitch }) });
const voice = createVoice({ send: (m) => send(m) });
window.bananaFuse = { targets: () => scene.screenTargets(), stats: () => scene.stats(), aim: () => scene.aim(), breakdown: () => scene.breakdown(), braillePads: () => scene.braillePads() }; // used by the automated play test

// Re-render a region only when its data changed, so the manual keeps its scroll position.
function renderIf(key, data, fn) {
  const sig = JSON.stringify(data);
  if (sigs[key] === sig) return;
  sigs[key] = sig;
  fn(data);
}

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---------- Sound ----------

// ---------- Settings (saved in this browser) ----------

const settings = { sfx: 0.8, voice: 1, look: 1, ...JSON.parse(localStorage.getItem('settings') || '{}') };
// Graphics default to Auto; an older saved 'high' came from before Auto existed.
if (!settings.qualityPicked) settings.quality = 'auto';
function applySettings() {
  localStorage.setItem('settings', JSON.stringify(settings));
  voice.setVolume(settings.voice);
  scene.setLookSpeed(settings.look);
  scene.setQuality(settings.quality);
}
for (const [id, key] of [['#set-sfx', 'sfx'], ['#set-voice', 'voice'], ['#set-look', 'look']]) {
  $(id).value = settings[key];
  $(id).addEventListener('input', () => { settings[key] = Number($(id).value); applySettings(); });
}
$('#set-quality').value = settings.quality;
$('#set-quality').addEventListener('change', () => { settings.quality = $('#set-quality').value; settings.qualityPicked = true; applySettings(); });
applySettings();

function openMenu(open) {
  $('#menu').classList.toggle('hidden', !open);
  const inGame = state?.game?.status === 'playing';
  $('#menu-lobby').classList.toggle('hidden', !(state?.game && state.you === state.hostId));
  $('#menu-lobby').textContent = inGame ? 'Back to lobby (ends the round)' : 'Back to lobby';
  $('#menu-leave').classList.toggle('hidden', !state);
}
$('#menu-btn').addEventListener('click', (ev) => { ev.currentTarget.blur(); openMenu(true); });
$('#lobby-menu-btn').addEventListener('click', (ev) => { ev.currentTarget.blur(); openMenu(true); });
$('#menu-resume').addEventListener('click', () => openMenu(false));
$('#menu').addEventListener('click', (ev) => { if (ev.target.id === 'menu') openMenu(false); });
$('#menu-lobby').addEventListener('click', () => { send({ t: 'lobby' }); openMenu(false); });
$('#menu-leave').addEventListener('click', () => {
  openMenu(false);
  leaving = true;
  stopAmbience();
  ws?.close();
});

let actx = null;
function beep(freq, dur, type = 'square', vol = 0.08, delay = 0) {
  if (!settings.sfx) return;
  vol *= settings.sfx;
  actx ??= new AudioContext();
  const t = actx.currentTime + delay;
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t);
  o.stop(t + dur);
}

// A steady tone with soft edges, like a radio beacon. Unlike beep() it holds its
// volume, so a dash sounds like one long note instead of a fading blip.
function tone(freq, dur, vol, delay = 0) {
  if (!settings.sfx) return;
  actx ??= new AudioContext();
  const t = actx.currentTime + delay, peak = vol * settings.sfx;
  const o = actx.createOscillator(), g = actx.createGain(), f = actx.createBiquadFilter();
  o.type = 'triangle';
  o.frequency.setValueAtTime(freq, t);
  f.type = 'lowpass'; f.frequency.value = 1800;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.012);
  g.gain.setValueAtTime(peak, t + dur - 0.02);
  g.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(f).connect(g).connect(actx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

// ---------- Ambience: the van on the road and the bomb ticking ----------
let ambience = null;
function noiseBuffer(seconds, brown) {
  const buf = actx.createBuffer(1, actx.sampleRate * seconds, actx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    data[i] = brown ? (last = (last + 0.02 * white) / 1.02) * 3.5 : white;
  }
  return buf;
}
function startAmbience() {
  actx ??= new AudioContext();
  const master = actx.createGain();
  master.gain.value = 0;
  master.connect(actx.destination);
  // Road rumble: brown noise, low-passed, with a slow swell.
  const road = actx.createBufferSource();
  road.buffer = noiseBuffer(4, true); road.loop = true;
  const roadLow = actx.createBiquadFilter(); roadLow.type = 'lowpass'; roadLow.frequency.value = 220;
  const roadGain = actx.createGain(); roadGain.gain.value = 0.1;
  road.connect(roadLow).connect(roadGain).connect(master);
  // Tyre hiss: a little white noise around 900 Hz.
  const hiss = actx.createBufferSource();
  hiss.buffer = noiseBuffer(3, false); hiss.loop = true;
  const hissBand = actx.createBiquadFilter(); hissBand.type = 'bandpass'; hissBand.frequency.value = 900; hissBand.Q.value = 0.6;
  const hissGain = actx.createGain(); hissGain.gain.value = 0.005;
  hiss.connect(hissBand).connect(hissGain).connect(master);
  // Engine hum, wobbling slowly.
  const engine = actx.createOscillator(); engine.type = 'sawtooth'; engine.frequency.value = 52;
  const engineLow = actx.createBiquadFilter(); engineLow.type = 'lowpass'; engineLow.frequency.value = 160;
  const engineGain = actx.createGain(); engineGain.gain.value = 0.01;
  const wobble = actx.createOscillator(); wobble.frequency.value = 0.3;
  const wobbleGain = actx.createGain(); wobbleGain.gain.value = 3;
  wobble.connect(wobbleGain).connect(engine.frequency);
  engine.connect(engineLow).connect(engineGain).connect(master);
  for (const s of [road, hiss, engine, wobble]) s.start();
  master.gain.linearRampToValueAtTime(0.5 * settings.sfx, actx.currentTime + 1.5);
  ambience = { master, sources: [road, hiss, engine, wobble], nextTick: actx.currentTime + 0.5, tock: false, nextBump: actx.currentTime + 3 };
}
function stopAmbience() {
  if (!ambience) return;
  const { master, sources } = ambience;
  ambience = null;
  master.gain.cancelScheduledValues(actx.currentTime);
  master.gain.setValueAtTime(master.gain.value, actx.currentTime);
  master.gain.linearRampToValueAtTime(0, actx.currentTime + 0.6);
  for (const s of sources) s.stop(actx.currentTime + 0.7);
}
// A clock tick: a click of filtered noise with a small wooden knock under it.
function tick(at, tock, vol) {
  const click = actx.createBufferSource();
  click.buffer = noiseBuffer(0.03, false);
  const high = actx.createBiquadFilter(); high.type = 'bandpass'; high.frequency.value = tock ? 2600 : 3400; high.Q.value = 3;
  const g = actx.createGain();
  g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);
  click.connect(high).connect(g).connect(ambience.master);
  click.start(at);
  const knock = actx.createOscillator(); knock.frequency.value = tock ? 900 : 1150;
  const kg = actx.createGain();
  kg.gain.setValueAtTime(vol * 0.5, at); kg.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
  knock.connect(kg).connect(ambience.master);
  knock.start(at); knock.stop(at + 0.06);
}
// Keeps the ticks and the odd road bump scheduled a little ahead of time.
function updateAmbience(on, hurry) {
  if (!on || !settings.sfx) return stopAmbience();
  if (!ambience) startAmbience();
  ambience.master.gain.setTargetAtTime(0.5 * settings.sfx, actx.currentTime, 0.3);
  ambience.hurry = hurry;
}
setInterval(() => {
  if (!ambience) return;
  const now = actx.currentTime;
  while (ambience.nextTick < now + 0.3) {
    tick(ambience.nextTick, ambience.tock, ambience.hurry ? 0.9 : 0.6);
    ambience.tock = !ambience.tock;
    ambience.nextTick += ambience.hurry ? 0.5 : 1;
  }
  if (ambience.nextBump < now + 0.3) {
    // A soft thump as the van rolls over a seam in the road.
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.setValueAtTime(70, ambience.nextBump); o.frequency.exponentialRampToValueAtTime(40, ambience.nextBump + 0.25);
    g.gain.setValueAtTime(0.07, ambience.nextBump); g.gain.exponentialRampToValueAtTime(0.0001, ambience.nextBump + 0.3);
    o.connect(g).connect(ambience.master);
    o.start(ambience.nextBump); o.stop(ambience.nextBump + 0.32);
    ambience.nextBump += 3 + Math.random() * 5;
  }
}, 100);

const SOUNDS = {
  start: () => beep(440, 0.2),
  press: () => beep(700, 0.06),
  flip: () => beep(1200, 0.03, 'square', 0.05),
  solve: () => { beep(880, 0.12); beep(1320, 0.2, 'square', 0.08, 0.12); },
  strike: () => beep(110, 0.5, 'sawtooth', 0.15),
  shuffle: () => [0, 0.15, 0.3].forEach((d) => beep(600, 0.1, 'triangle', 0.1, d)),
  win: () => [523, 659, 784, 1047].forEach((f, i) => beep(f, 0.2, 'triangle', 0.1, i * 0.12)),
  boom: () => { beep(60, 1.5, 'sawtooth', 0.3); beep(45, 1.8, 'square', 0.2, 0.05); },
};

// signals: one dot/dash string per digit; the server picks this round's code.
function playMorse(signals) {
  let t = 0.2;
  for (const signal of signals) {
    for (const sign of signal) {
      // A dot is a short blip, a dash a long tone; each digit ends with a clear pause.
      const len = sign === '.' ? 0.1 : 0.5;
      tone(660, len, 0.16, t);
      t += len + 0.18;
    }
    t += 1.1;
  }
}

function onEvent(e) {
  // The Deaf monkey hears nothing, not even the bomb.
  const deaf = state?.game?.status === 'playing' && state.game.role.id === 'eyes';
  if (!deaf || e.kind === 'start') SOUNDS[e.kind]?.();
  if (e.kind === 'morse' && !deaf) playMorse(e.signals);
  // Piano keys 1-5 play a C major pentatonic run; the soundboard's one live button chimes.
  if (e.kind === 'note' && !deaf) tone([523, 587, 659, 784, 880][e.index] ?? 440, 0.35, 0.16);
  if (e.kind === 'chime' && !deaf) [1568, 2093].forEach((f, i) => tone(f, 0.5, 0.09, i * 0.08));
  if (e.kind === 'reach') scene.reach(e.id, e.at, e.hold);
  if (e.kind === 'strike' || e.kind === 'boom') {
    document.body.classList.remove('shake');
    void document.body.offsetWidth;
    document.body.classList.add('shake');
  }
  if (e.kind === 'start' || e.kind === 'cancel') peeking = false;
}

// ---------- Join / lobby ----------

$('#room-code').value = new URLSearchParams(location.search).get('room') || '';
$('#name').value = localStorage.getItem('name') || '';

$('#join-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = $('#name').value.trim();
  localStorage.setItem('name', name);
  $('#join-error').textContent = '';
  await voice.start();
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => send({ t: 'join', room: $('#room-code').value, name });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'state') render(m);
    else if (m.t === 'event') onEvent(m);
    else if (m.t === 'rtc') voice.handleSignal(m);
    else if (m.t === 'look') scene.setHeadLook(m.id, m.yaw, m.pitch);
    else if (m.t === 'error') {
      $('#join-error').textContent = m.msg;
      ws.close();
    }
  };
  ws.onclose = () => {
    stopAmbience();
    if (state && !leaving) $('#join-error').textContent = 'Disconnected from the server.';
    leaving = false;
    state = null;
    voice.stop();
    for (const k in sigs) delete sigs[k];
    show('join');
  };
});

const sendSettings = () => send({ t: 'settings', minutes: $('#set-minutes').value, modules: $('#set-modules').value, chaos: $('#set-chaos').checked, colorBlind: $('#set-colorblind').checked });
for (const id of ['#set-minutes', '#set-modules', '#set-chaos', '#set-colorblind']) $(id).addEventListener('change', sendSettings);
$('#start-btn').addEventListener('click', () => send({ t: 'start' }));
$('#again-btn').addEventListener('click', () => send({ t: 'start' }));
$('#lobby-btn').addEventListener('click', () => send({ t: 'lobby' }));
$('#peek-btn').addEventListener('click', () => { peeking = true; render(state); });

// Only the controls this role can actually use.
function keyHints(role) {
  return [
    'E: gestures',
    role.touch && 'click: touch the bomb',
    role.id !== 'reader' && 'Space or right-click: lean in',
    // The bomb hands keep the mouse for the bomb, so they look around with the keys only.
    role.touch ? 'WASD or arrows: look around' : 'mouse, WASD or arrows: look around',
    role.manual && 'M: manual',
    'Shift: lock cursor',
  ].filter(Boolean).join(' · ');
}
function toggleManual() {
  manualOpen = !manualOpen;
  if (state) render(state);
}
window.addEventListener('keydown', (ev) => {
  if (ev.key.toLowerCase() !== 'm' || ev.target.matches('input')) return;
  toggleManual();
});
$('#manual-btn').addEventListener('click', (ev) => { ev.currentTarget.blur(); toggleManual(); });

const MIC_TEXT = {
  on: '🎤 Mic on',
  'muted-by-role': '🤐 Your mic is cut',
  denied: '🎤 Mic blocked. Allow it in the browser to talk.',
  unavailable: '🎤 No mic found',
};

function playerList(s, withRoles) {
  const speaking = voice.speaking();
  return s.players.map((p) => {
    const tags = [p.id === s.you ? 'you' : '', p.id === s.hostId ? 'host' : '', withRoles && p.role ? p.role : ''].filter(Boolean);
    return `<li>${speaking.has(p.id) ? '🔊 ' : ''}${esc(p.name)}${tags.length ? ` <span class="tag">${tags.join(' · ')}</span>` : ''}</li>`;
  }).join('');
}

function renderLobby(s) {
  show('lobby');
  const isHost = s.you === s.hostId;
  const link = `${location.origin}/?room=${s.room}`;
  $('#lobby-code').textContent = s.room;
  $('#share-link').textContent = link;
  $('#share-link').href = link;
  $('#lobby-players').innerHTML = playerList(s, false);
  renderPicker(s);
  $('#random-btn').classList.toggle('hidden', !isHost || s.players.length !== 3);
  $('#mic-status').textContent = MIC_TEXT[voice.status().mic] ?? '';
  $('#set-minutes').value = String(s.settings.minutes);
  $('#set-modules').value = String(s.settings.modules);
  $('#set-chaos').checked = s.settings.chaos;
  $('#set-colorblind').checked = !!s.settings.colorBlind;
  $('#set-minutes').disabled = $('#set-modules').disabled = $('#set-chaos').disabled = $('#set-colorblind').disabled = !isHost;
  $('#start-btn').classList.toggle('hidden', !isHost);
  $('#lobby-wait').classList.toggle('hidden', isHost);
}

// ---------- Game ----------

function render(s) {
  state = s;
  voice.update(s);
  scene.update({ ...s, speaking: [...voice.speaking()] });
  if (!s.game) {
    stopAmbience();
    lastRoleId = null;
    return renderLobby(s);
  }
  show('game');
  const g = s.game;
  // The Deaf monkey hears nothing, not even the van or the ticking.
  updateAmbience(g.status === 'playing' && g.role.id !== 'eyes', g.hurry);
  const over = g.status !== 'playing';
  const vs = voice.status();

  if (g.role.id !== lastRoleId) {
    const card = $('#role-card');
    card.className = `card role-${g.role.id}`;
    card.innerHTML = `<div class="role-title">${g.role.title} <span>${g.role.handicap}</span></div>
      <p>${esc(g.role.does)}</p>${g.role.voice ? `<p class="voice">${esc(g.role.voice)}</p>` : ''}<p class="voice-status"></p>`;
    if (lastRoleId) {
      card.classList.add('flash');
      SOUNDS.shuffle();
    }
    lastRoleId = g.role.id;
  }
  $('#role-card .voice-status').textContent = `${MIC_TEXT[vs.mic] ?? ''}${vs.deafened ? ' · 🔇 You hear nobody' : ''}`;

  renderIf('manual', [g.manual, manualOpen, manualPage, s.settings?.colorBlind], () => renderManual(g.manual));
  renderIf('hints', [g.role.id], () => { $('#key-hints').textContent = keyHints(g.role); });
  renderIf('wheel', s.emoteList, renderWheel);
  $('#game-players').innerHTML = playerList(s, true);

  $('#result').classList.toggle('hidden', !over || peeking);
  if (over) {
    const isHost = s.you === s.hostId;
    $('#result-title').textContent = g.status === 'won' ? '🍌 DEFUSED! 🍌' : '💥 BOOM 💥';
    $('#result-reason').textContent = `${g.reason}. Time left: ${g.timer}.`;
    $('#result-host').classList.toggle('hidden', !isHost);
    $('#result-wait').classList.toggle('hidden', isHost);
  }
}

const GESTURE_NAMES = {
  '👆': 'Point up', '👇': 'Point down', '👈': 'Point to your left', '👉': 'Point to your right', '👍': 'Yes', '👎': 'No',
  '🤷': 'Confused', '🔁': 'Repeat', '🤫': 'Quiet', '✋': 'Wave / stop', '🍌': 'Throw a banana',
  '🖕': 'Middle fingers', '🎁': 'Jack-in-the-box', '😎': 'Aaron flick',
};

// Radial gesture wheel: gestures on the outer ring, finger counts 1-10 on the inner ring.
function renderWheel(list) {
  const outer = list.filter((e) => GESTURE_NAMES[e]);
  const inner = list.filter((e) => !GESTURE_NAMES[e]);
  const ring = (items, r, cls) => items.map((e, i) => {
    const a = (i / items.length) * Math.PI * 2 - Math.PI / 2;
    return `<button class="${cls}" data-emote="${esc(e)}" data-name="${esc(GESTURE_NAMES[e] ?? `${e} finger${e === '1' ? '' : 's'}`)}"
      style="left:calc(50% + ${Math.cos(a) * r}px);top:calc(50% + ${Math.sin(a) * r}px)">${esc(e)}</button>`;
  }).join('');
  $('#emote-wheel .wheel').innerHTML = ring(outer, 250, 'g') + ring(inner, 135, 'n') + '<div class="wheel-label">Gestures</div>';
}

function openWheel(open) {
  $('#emote-wheel').classList.toggle('hidden', !open);
  scene.setCursorOverlay('wheel', open);
}

const ROLE_CARDS = [
  { id: 'hands', title: 'BLIND', icon: '🙈', text: 'Holds the bomb. Sees only outlines.' },
  { id: 'eyes', title: 'DEAF', icon: '🙉', text: 'Sees everything. Hears nothing.' },
  { id: 'reader', title: 'MUTE', icon: '🙊', text: 'Has the manual. Gestures only.' },
];

function renderPicker(s) {
  const el = $('#role-picker');
  el.classList.toggle('hidden', s.players.length !== 3);
  const me = s.players.find((p) => p.id === s.you);
  el.innerHTML = ROLE_CARDS.map((r) => {
    const who = s.players.find((p) => p.pick === r.id);
    return `<button class="role-pick ${who?.id === s.you ? 'mine' : ''} ${who && who.id !== s.you ? 'taken' : ''}" data-pick="${r.id}">
      <span class="icon">${r.icon}</span><b>${r.title}</b><small>${r.text}</small><em>${who ? esc(who.name) : 'open'}</em></button>`;
  }).join('');
  el.dataset.mine = me?.pick ?? '';
}

const SWATCHES = ['red', 'blue', 'yellow', 'white', 'black', 'green'];
// Turn color words into little swatches and bold the action words.
function decorate(text) {
  return esc(text)
    .replace(new RegExp(`\\b(${SWATCHES.join('|')})\\b`, 'gi'), (w) => `<span class="swatch sw-${w.toLowerCase()}"></span>${state?.settings?.colorBlind ? `<b>${w}</b>` : ''}`)
    .replace(/\b(cut|tap|hold|release)\b/gi, '<em>$1</em>');
}

// A small labelled sketch of each module, in pencil, like the drawings in BOMBANANA's manual.
// Layout and part names only: no colors, so the sketch never gives an answer away.
const svgText = (x, y, t, anchor = 'middle') => `<text x="${x}" y="${y}" text-anchor="${anchor}">${t}</text>`;
const rr = (x, y, w, h, r = 3, fill = 'none') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`;
const circ = (x, y, r, fill = 'none') => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`;
const brailleCell = (x, y) => rr(x, y, 16, 22, 2) + [[5, 6], [11, 6], [5, 11], [11, 11], [5, 16], [11, 16]].map(([dx, dy]) => circ(x + dx, y + dy, 1.4, '#3b3a37')).join('');
const DIAGRAMS = {
  wires: rr(10, 6, 140, 88, 5) + [0, 1, 2, 3].map((k) => `<text x="22" y="${26 + k * 18}">${k + 1}</text><path d="M34 ${22 + k * 18} q50 -8 100 0"/>`).join('') + svgText(80, 105, 'wires, numbered'),
  button: rr(10, 6, 140, 88, 5) + circ(65, 48, 28) + svgText(65, 52, 'LABEL') + rr(112, 20, 10, 58, 2) + svgText(117, 105, 'strip') + svgText(65, 105, 'button'),
  keypad: rr(10, 6, 140, 88, 5) + [0, 1, 2, 3].map((k) => rr(42 + (k % 2) * 40, 14 + Math.floor(k / 2) * 38, 34, 32, 4) + svgText(59 + (k % 2) * 40, 35 + Math.floor(k / 2) * 38, '✱')).join('') + svgText(80, 105, '4 symbol keys'),
  morse: rr(10, 6, 140, 88, 5) + circ(40, 28, 13) + svgText(40, 50, 'speaker') + circ(108, 28, 10) + svgText(108, 32, '▶') + svgText(108, 50, 'PLAY') + [0, 1, 2].map((k) => circ(52 + k * 28, 66, 9) + svgText(52 + k * 28, 70, '0')).join('') + rr(48, 80, 64, 10, 2) + svgText(80, 88, 'ENTER'),
  arrows: rr(10, 6, 140, 88, 5) + circ(36, 26, 9) + svgText(36, 46, 'light') + brailleCell(98, 14) + svgText(106, 46, 'Braille') + [[80, 58, '↑'], [100, 72, '→'], [80, 86, '↓'], [60, 72, '←']].map(([x, y, g]) => rr(x - 8, y - 8, 16, 14, 2) + svgText(x, y + 3, g)).join('') + [0, 1, 2].map((k) => circ(26, 60 + k * 11, 3)).join('') + svgText(26, 105, 'stage'),
  switches: rr(6, 6, 148, 88, 5) + [0, 1, 2, 3].map((k) => { const x = 30 + k * 32; return circ(x, 18, 6) + rr(x - 6, 30, 12, 20, 2) + `<path d="M${x} 40 l-5 -12"/>` + brailleCell(x - 8, 56); }).join('')  + svgText(80, 105, 'light · switch · Braille') + rr(40, 82, 80, 9, 2) + svgText(80, 89.5, 'ENTER'),
  piano: rr(10, 6, 140, 88, 5) + circ(40, 20, 8) + svgText(40, 36, 'light') + brailleCell(98, 9) + [0, 1, 2, 3, 4].map((k) => rr(36 + k * 18, 44, 16, 44, 2) + svgText(44 + k * 18, 84, k + 1)).join('') + [0, 1, 2, 3].map((k) => rr(47 + k * 18, 44, 8, 24, 1, '#3b3a37')).join(''),
  soundboard: rr(10, 6, 140, 88, 5) + [...Array(9)].map((_, k) => rr(22 + (k % 3) * 28, 14 + Math.floor(k / 3) * 26, 22, 20, 3) + [0, 1].map((d) => circ(29 + (k % 3) * 28 + d * 7, 22 + Math.floor(k / 3) * 26, 1.3, '#3b3a37')).join('')).join('') + circ(124, 22, 8) + svgText(124, 38, 'light') + rr(114, 50, 20, 34, 3) + svgText(124, 70, '⏎') + svgText(57, 105, 'each has Braille'),
  calculator: rr(10, 6, 140, 88, 5) + rr(24, 12, 80, 18, 2) + svgText(64, 25, '7 + 5') + circ(133, 20, 7) + svgText(133, 36, 'light') + ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⏎'].map((t, k) => rr(40 + (k % 3) * 28, 36 + Math.floor(k / 3) * 14, 24, 11, 2) + svgText(52 + (k % 3) * 28, 45 + Math.floor(k / 3) * 14, t)).join(''),
  flashes: rr(10, 6, 140, 88, 5) + [[80, 24], [108, 50], [80, 76], [52, 50]].map(([x, y]) => circ(x, y, 13) + circ(x - 3, y, 1.4, '#3b3a37') + circ(x + 3, y, 1.4, '#3b3a37')).join('') + `<path d="M118 20 l6 -6 m-6 0 l6 6"/>` + svgText(124, 30, 'flash') + [0, 1, 2].map((k) => circ(24, 22 + k * 11, 3)).join('') + svgText(24, 105, 'stage'),
};
const diagram = (type) => DIAGRAMS[type] ? `<svg class="diagram" viewBox="0 0 160 110" aria-hidden="true">${DIAGRAMS[type]}</svg>` : '';

// A drawing for the slider page: the knob creeping up toward the strike line.
const SLIDER_FIGURE = `<svg class="figure" viewBox="0 0 200 260" aria-hidden="true">
  <rect x="80" y="20" width="40" height="220" rx="20" fill="#2a2620"/>
  <rect x="62" y="22" width="76" height="10" rx="5" fill="#c9473a"/><text x="146" y="32" font-size="15" font-weight="800" fill="#c9473a">STRIKE</text>
  <rect x="70" y="150" width="60" height="34" rx="10" fill="#ffd84d" stroke="#2a2620" stroke-width="4"/>
  <path d="M100 140 v-50 m-14 14 l14 -14 l14 14" stroke="#c9473a" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M38 120 v60 m-12 -12 l12 12 l12 -12" stroke="#2a8f5a" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="6" y="210" font-size="15" font-weight="800" fill="#2a8f5a">PUSH DOWN</text>
</svg>`;
// Rules are drawn fresh each round and screens differ, so pick the largest type that
// still fits the page without scrolling.
function fitManual() {
  const article = $('#manual article');
  if (!article || $('#manual').classList.contains('hidden')) return;
  const fits = (px) => { article.style.fontSize = `${px}px`; return article.scrollHeight <= article.clientHeight + 1; };
  let lo = 9, hi = Math.max(12, article.clientWidth / 30);
  if (!fits(lo)) return;
  while (hi - lo > 0.5) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
  fits(lo);
}
window.addEventListener('resize', fitManual);
document.fonts?.ready.then(fitManual);
// Re-fit once the page has its real size (after the opening animation, on resize).
new ResizeObserver(() => fitManual()).observe($('#manual'));
$('#manual').addEventListener('animationend', fitManual);
// A 3x3 soundboard pattern: the buttons to press are filled in.
const miniGrid = (cells) => `<span class="mini-grid">${Array.from({ length: 9 }, (_, i) => `<i class="${cells.includes(i) ? 'on' : ''}"></i>`).join('')}</span>`;
function renderManual(manual) {
  const el = $('#manual');
  const open = !!manual && manualOpen;
  if (open !== sentReading) { sentReading = open; send({ t: 'manual', open }); scene.setReading(open); }
  scene.setCursorOverlay('manual', open);
  el.classList.toggle('hidden', !open);
  // One button beside Gestures that opens or closes the manual.
  $('#manual-btn').classList.toggle('hidden', !manual);
  $('#manual-btn').textContent = manualOpen ? '📕 Close manual (M)' : '📖 Manual (M)';
  if (!manual) return;
  const sec = manual[Math.min(manualPage, manual.length - 1)];
  el.innerHTML = `
    <div class="manual-head"><span>🍌 DEFUSAL MANUAL</span><span><span class="stamp">TOP SECRET</span><button class="manual-close" data-close title="Close (M)">✕</button></span></div>
    <nav class="manual-tabs">${manual.map((m, i) => `<button data-page="${i}" class="${m === sec ? 'on' : ''}">${esc(m.title)}</button>`).join('')}</nav>
    <article class="page-${esc(sec.title.toLowerCase().replace(/\W+/g, '-'))}">
      <div class="intro"><p class="lead">${decorate(sec.text)}</p>${diagram(sec.type)}</div>
      ${sec.groups ? `<div class="groups n${sec.groups.length}">${sec.groups.map((g) => `<section><h4>${esc(g.heading)}</h4><ol>${g.items.map((i) => `<li>${decorate(i)}</li>`).join('')}</ol></section>`).join('')}</div>` : ''}
      ${sec.table ? `<div class="table-fill"><table class="manual-table"><tr>${sec.table.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>${sec.table.rows.map((r) => `<tr>${r.map((c, i) => `<td>${i === 0 ? decorate(c) : c?.grid ? miniGrid(c.grid) : esc(c)}</td>`).join('')}</tr>`).join('')}</table></div>` : ''}
      ${sec.columns ? `<div class="columns">${sec.columns.map((c, i) => `<div><b>${i + 1}</b>${c.map((x) => `<span>${x}</span>`).join('')}</div>`).join('')}</div>` : ''}
      ${sec.title === 'Slider' ? SLIDER_FIGURE : ''}
    </article>
    <div class="manual-foot">Page ${manual.indexOf(sec) + 1} of ${manual.length} · M to close</div>`;
  requestAnimationFrame(fitManual);
}

$('#manual').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-close]')) return toggleManual();
  const t = ev.target.closest('[data-page]');
  if (!t) return;
  manualPage = Number(t.dataset.page);
  t.blur();
  render(state);
});

$('#emote-wheel').addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-emote]');
  if (t) send({ t: 'emote', e: t.dataset.emote, aim: scene.aim() });
  openWheel(false);
});
$('#emote-wheel').addEventListener('mouseover', (ev) => {
  const t = ev.target.closest('[data-emote]');
  $('#emote-wheel .wheel-label').textContent = t ? t.dataset.name : 'Gestures';
});
$('#wheel-btn').addEventListener('click', (ev) => { ev.currentTarget.blur(); openWheel(true); });
window.addEventListener('keydown', (ev) => {
  if (!state) return;
  // Esc closes the gesture wheel first, otherwise toggles the menu (lobby, round, or results).
  if (ev.key === 'Escape') {
    if (!$('#emote-wheel').classList.contains('hidden')) openWheel(false);
    else openMenu($('#menu').classList.contains('hidden'));
    return;
  }
  if (ev.target.matches('input') || state.game?.status !== 'playing') return;
  if (ev.key.toLowerCase() === 'e') openWheel($('#emote-wheel').classList.contains('hidden'));
});

$('#role-picker').addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-pick]');
  if (!t) return;
  const mine = $('#role-picker').dataset.mine === t.dataset.pick;
  send({ t: 'pick', role: mine ? null : t.dataset.pick });
});
$('#random-btn').addEventListener('click', () => send({ t: 'randomize' }));
