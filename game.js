// Game rules, bomb generation and per-player views. The server owns all state;
// each player only receives what their current role is allowed to see.

const rand = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rand(a.length)];
const shuffle = (a) => {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Who can do what, modeled on BOMBANANA!. Voice: Blind's voice reaches Mute (Deaf
// hears nobody), Deaf's voice reaches everyone, Mute can't speak.
const ROLES = {
  hands: {
    title: 'BLIND', handicap: 'BOMB IN YOUR HANDS', touch: true, seeBomb: false, manual: false, seeGestures: false,
    does: "You're the only one who can touch the bomb, but you only see outlines: no colors, no screens. Do what the Deaf monkey tells you, and tell the Mute monkey what you feel.",
    voice: "Mute hears you. Deaf can't, so use gestures (E) for Deaf.",
  },
  eyes: {
    title: 'DEAF', handicap: 'YOU SEE EVERYTHING', touch: false, seeBomb: true, manual: false, seeGestures: true,
    does: "You see the bomb, the timer and everyone's gestures, but you hear nothing. Describe the bomb out loud, read Mute's gestures, and tell Blind what to do.",
    voice: 'Everyone hears you. You hear nobody, not even the bomb.',
  },
  reader: {
    title: 'MUTE', handicap: 'YOU HAVE THE MANUAL', touch: false, seeBomb: false, manual: true, seeGestures: true,
    does: "You only see the back of the bomb, but you hear everyone. Look up the answer in the manual and gesture it to the Deaf monkey.",
    voice: 'Your mic is cut. Gestures only (E).',
  },
  guide: {
    title: 'GUIDE', handicap: '2-PLAYER', touch: false, seeBomb: true, manual: true, seeGestures: true,
    does: 'You see the bomb and the manual. Talk Blind through it.',
    voice: 'You can talk and hear.',
  },
  solo: {
    title: 'SOLO', handicap: 'PRACTICE', touch: true, seeBomb: true, manual: true, seeGestures: true,
    does: 'You can see and do everything. Use this to learn the modules.',
    voice: '',
  },
};

const ROLE_SETS = {
  1: ['solo'],
  2: ['hands', 'guide'],
  3: ['hands', 'eyes', 'reader'],
  4: ['hands', 'eyes', 'reader', 'eyes'],
};

// Everyone has the same gesture wheel. Gestures are hand animations, never words:
// pointing, thumbs, confused, repeat, quiet, wave, banana, and holding up 1-10 fingers.
const GESTURES = ['👆', '👇', '👈', '👉', '👍', '👎', '🤷', '🔁', '🤫', '✋', '🍌', '🖕', '🎁', '😎',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const PICKABLE = ['hands', 'eyes', 'reader'];

// ---------- Modules ----------

const WIRE_COLORS = ['red', 'blue', 'yellow', 'white', 'black'];
const BUTTON_COLORS = ['red', 'blue', 'yellow', 'white'];
const BUTTON_LABELS = ['ABORT', 'DETONATE', 'HOLD', 'PRESS'];
const KEYPAD_COLUMNS = [
  ['Ω', 'ψ', '★', '¶', 'Ж', 'λ'],
  ['☂', 'Ф', '§', '¿', 'Ю', '♠'],
  ['Ξ', '☯', 'æ', '⊕', 'Щ', '♣'],
  ['♪', 'Δ', 'Я', '☼', '‡', '♦'],
];
const HOLD_MS = 1000;

const lastDigitOdd = (serial) => Number(serial.at(-1)) % 2 === 1;
const hasVowel = (serial) => /[AEIOU]/.test(serial);

function makeSerial() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXZ0123456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[rand(chars.length)];
  return s + rand(10);
}

// ---------- The rulebook: new rules every round ----------
// Each round draws its own rules; the manual is written from them and the bomb is solved by
// them, so the two always agree.

const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
// Morse code for the digits. Each round deals these signals out to the digits afresh.
const MORSE_SIGNALS = ['.----', '..---', '...--', '....-', '.....', '-....', '--...', '---..', '----.', '-----'];
// Braille digits 1-6 as raised dots (1-3 left column top to bottom, 4-6 right column).
const BRAILLE = { 1: [1], 2: [1, 2], 3: [1, 4], 4: [1, 4, 5], 5: [1, 5], 6: [1, 2, 4] };
const ARROWS = ['up', 'right', 'down', 'left'];
const LIGHT_COLORS = ['red', 'blue', 'green', 'yellow'];
const SLIDER_RISE_MS = 50000;

// A wire condition: text for the manual, a test for the bomb, and whether it guarantees
// at least one wire of `color` (so "cut the last red wire" is safe to follow it).
function wireCondition(n) {
  const c = pick(WIRE_COLORS);
  const count = (colors) => colors.filter((x) => x === c).length;
  return pick([
    { text: `there are no ${c} wires`, test: (w) => !count(w) },
    { text: `there is exactly one ${c} wire`, test: (w) => count(w) === 1, color: c },
    { text: `there is more than one ${c} wire`, test: (w) => count(w) > 1, color: c },
    { text: `the last wire is ${c}`, test: (w) => w[n - 1] === c, color: c },
    { text: `the first wire is ${c}`, test: (w) => w[0] === c, color: c },
  ]);
}
function wireTarget(n, color) {
  const options = [
    ...ORDINAL.slice(0, n - 1).map((o, k) => ({ text: `the ${o} wire`, index: () => k })),
    { text: 'the last wire', index: () => n - 1 },
  ];
  if (color) options.push(
    { text: `the last ${color} wire`, index: (w) => w.lastIndexOf(color) },
    { text: `the first ${color} wire`, index: (w) => w.indexOf(color) });
  return pick(options);
}
function makeWireRules() {
  const byCount = {};
  for (let n = 3; n <= 6; n++) {
    const rules = [];
    const used = new Set();
    for (let k = 0; k < (n === 3 ? 2 : 3); k++) {
      let cond = wireCondition(n);
      // Never repeat a condition: the second copy could never apply.
      while (used.has(cond.text)) cond = wireCondition(n);
      used.add(cond.text);
      const serial = Math.random() < 0.3 ? pick([
        { text: ' and the last digit of the serial is odd', test: (sn) => lastDigitOdd(sn) },
        { text: ' and the last digit of the serial is even', test: (sn) => !lastDigitOdd(sn) },
      ]) : null;
      const target = wireTarget(n, cond.color);
      rules.push({ text: `${cond.text}${serial?.text ?? ''}, cut ${target.text}.`, test: (w, sn) => cond.test(w) && (!serial || serial.test(sn)), target });
    }
    byCount[n] = { rules, otherwise: wireTarget(n) };
  }
  return byCount;
}

function makeButtonRules() {
  const conds = shuffle([
    ...BUTTON_COLORS.flatMap((c) => BUTTON_LABELS.map((l) => ({ text: `${cap(c)} button that says ${l}`, test: (b) => b.color === c && b.label === l, rank: 0 }))),
    ...BUTTON_LABELS.map((l) => ({ text: `Says ${l} and the serial has a vowel`, test: (b, sn) => b.label === l && hasVowel(sn), rank: 1 })),
    ...BUTTON_LABELS.map((l) => ({ text: `Says ${l} and the serial ends in an odd digit`, test: (b, sn) => b.label === l && lastDigitOdd(sn), rank: 1 })),
    ...BUTTON_COLORS.map((c) => ({ text: `${cap(c)} button`, test: (b) => b.color === c, rank: 2 })),
  ]).slice(0, 4).sort((a, b) => a.rank - b.rank).map((c) => ({ ...c, action: pick(['tap', 'hold']) }));
  // Releasing a held button: two strip colours get their own digit, the rest share one.
  const digits = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]).slice(0, 3).map(String);
  const special = shuffle(BUTTON_COLORS).slice(0, 2);
  return { rules: conds, otherwise: pick(['tap', 'hold']), release: { [special[0]]: digits[0], [special[1]]: digits[1] }, releaseOther: digits[2] };
}
const cap = (w) => w[0].toUpperCase() + w.slice(1);

// Calculator rules: how to change the answer for each light color.
const CALC_RULES = [
  ...[2, 3, 4, 5, 7, 9].map((n) => ({ text: `add ${n}`, fn: (x) => x + n })),
  { text: 'double it', fn: (x) => x * 2 },
  { text: 'triple it', fn: (x) => x * 3 },
  { text: 'add the last digit of the serial', fn: (x, serial) => x + Number(serial.at(-1)) },
  { text: 'add the first digit in the serial', fn: (x, serial) => x + Number(serial.match(/\d/)?.[0] ?? 0) },
];
// Switch rules: what the Braille digit (1-6) must be for the switch to go UP.
const SWITCH_TESTS = [
  { text: 'odd', test: (d) => d % 2 === 1 },
  { text: 'even', test: (d) => d % 2 === 0 },
  { text: '3 or less', test: (d) => d <= 3 },
  { text: '4 or more', test: (d) => d >= 4 },
  { text: '1, 2 or 6', test: (d) => [1, 2, 6].includes(d) },
  { text: '3, 4 or 5', test: (d) => [3, 4, 5].includes(d) },
];
function makeRules() {
  const shuffledTests = shuffle([0, 1, 2, 3, 4, 5]);
  const shuffledCalc = shuffle(CALC_RULES).slice(0, 4), flashDigits = shuffle([1, 2, 3, 4]);
  const morseDigits = shuffle(MORSE_SIGNALS);
  return {
    wires: makeWireRules(),
    button: makeButtonRules(),
    // Same symbol groups (so exactly one column ever fits), new order each round.
    keypad: shuffle(KEYPAD_COLUMNS.map((c) => shuffle(c))),
    morse: Object.fromEntries(morseDigits.map((sig, d) => [d, sig])),
    arrows: Object.fromEntries(LIGHT_COLORS.map((c) => [c, Array.from({ length: 6 }, () => pick(ARROWS))])),
    calculator: Object.fromEntries(LIGHT_COLORS.map((c, i) => [c, shuffledCalc[i]])),
    // Flashes: each flash color means the button with this Braille digit (1-4).
    flashes: Object.fromEntries(LIGHT_COLORS.map((c, i) => [c, flashDigits[i]])),
    // Switches: each light color gets a test on the Braille digit; true means UP.
    switches: Object.fromEntries(LIGHT_COLORS.map((c, i) => [c, SWITCH_TESTS[shuffledTests[i]]])),
    // Piano: four keys (1-5) to play for each light color and Braille digit.
    piano: Object.fromEntries(LIGHT_COLORS.map((c) => [c, Array.from({ length: 6 }, () => Array.from({ length: 4 }, () => rand(5)))])),
    // Soundboard: three of the nine buttons for each light color and Braille digit.
    soundboard: Object.fromEntries(LIGHT_COLORS.map((c) => [c, Array.from({ length: 6 }, () => shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8]).slice(0, 3).sort())])),
  };
}

// Returns the index of the wire to cut.
function solveWires(colors, serial, rules) {
  const book = rules.wires[colors.length];
  const hit = book.rules.find((r) => r.test(colors, serial));
  return (hit ? hit.target : book.otherwise).index(colors);
}
function buttonAction(color, label, serial, rules) {
  const hit = rules.button.rules.find((r) => r.test({ color, label }, serial));
  return hit ? hit.action : rules.button.otherwise;
}
const releaseDigit = (strip, rules) => rules.button.release[strip] ?? rules.button.releaseOther;

// The manual covers the bomb's modules plus as many decoys (two decoys for a single
// module), shuffled, so Mute has to work out which pages matter. The slider page comes
// along whenever the slider is on the bomb.
function manualFor(pages, bomb) {
  const onBomb = new Set(bomb.modules.map((m) => m.type));
  const real = pages.filter((p) => onBomb.has(p.type) && p.type !== 'slider');
  const want = real.length === 1 ? 3 : real.length * 2;
  const decoys = shuffle(pages.filter((p) => !onBomb.has(p.type) && p.type !== 'slider')).slice(0, Math.max(0, want - real.length));
  return shuffle([...real, ...decoys, ...pages.filter((p) => p.type === 'slider' && onBomb.has('slider'))]);
}

function makeManual(rules) {
  const { button } = rules;
  const others = BUTTON_COLORS.filter((c) => !button.release[c]);
  return [
    {
      type: 'wires',
      title: 'Wires',
      text: 'Count the wires. Cut the wire named by the first rule that matches.',
      groups: [3, 4, 5, 6].map((n) => ({ heading: `${n} wires`, items: [
        ...rules.wires[n].rules.map((r, k) => `${k ? 'Otherwise, if' : 'If'} ${r.text}`),
        `Otherwise, cut ${rules.wires[n].otherwise.text}.`,
      ] })),
    },
    {
      type: 'button',
      title: 'The Button',
      text: 'The first matching rule says tap or hold. When holding, release by the strip color.',
      groups: [
        { heading: 'Tap or hold?', items: [
          ...button.rules.map((r) => `${r.text}: ${r.action}.`),
          `Anything else: ${button.otherwise}.`,
        ] },
        { heading: 'Release on', items: [
          ...Object.entries(button.release).map(([c, d]) => `${cap(c)} strip: release on a ${d}.`),
          `${others.map((c, i) => (i ? c : cap(c))).join(' or ')} strip: release on a ${button.releaseOther}.`,
        ] },
      ],
    },
    {
      type: 'keypad',
      title: 'Keypad',
      text: 'Find the column with all four symbols. Press them in that column\'s order, top to bottom.',
      columns: rules.keypad,
    },
    {
      type: 'morse',
      title: 'Morse',
      text: 'Decode each beeped digit with the table, set the dials to them, then press ENTER.',
      table: { head: ['Digit', 'Signal'], rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((d) => [String(d), rules.morse[d].replace(/\./g, '•').replace(/-/g, '▬')]) },
    },
    {
      type: 'arrows',
      title: 'Arrows',
      text: 'Press the arrow for the light color and the Braille digit. Three in a row.',
      table: { head: ['Light', '1', '2', '3', '4', '5', '6'], rows: LIGHT_COLORS.map((c) => [c, ...rules.arrows[c].map((d) => ({ up: '↑', right: '→', down: '↓', left: '←' })[d])]) },
    },
    {
      type: 'switches',
      title: 'Switches',
      text: 'Set each switch by its light color and Braille digit: UP when the rule fits, DOWN when it doesn\'t. Then press ENTER.',
      table: { head: ['Light', 'UP when the digit is'], rows: LIGHT_COLORS.map((c) => [c, rules.switches[c].text]) },
    },
    {
      type: 'piano',
      title: 'Piano',
      text: 'Play the four keys for the light color and the Braille digit, in order.',
      table: { head: ['Light', '1', '2', '3', '4', '5', '6'], rows: LIGHT_COLORS.map((c) => [c, ...rules.piano[c].map((keys) => keys.map((k) => k + 1).join(' '))]) },
    },
    {
      type: 'soundboard',
      title: 'Soundboard',
      text: 'Find the button that makes a sound. Its Braille digit and the light color show which three buttons to press, then press ENTER.',
      table: { head: ['Light', '1', '2', '3', '4', '5', '6'], rows: LIGHT_COLORS.map((c) => [c, ...rules.soundboard[c].map((cells) => ({ grid: cells }))]) },
    },
    {
      type: 'calculator',
      title: 'Calculator',
      text: 'Work out the sum on the screen, change it by the rule for the light color, type the result and press ENTER.',
      table: { head: ['Light', 'Then'], rows: LIGHT_COLORS.map((c) => [c, rules.calculator[c].text]) },
    },
    {
      type: 'flashes',
      title: 'Flashes',
      text: 'The buttons flash a sequence. For each flash color, press the button with this Braille digit, in the same order.',
      table: { head: ['Flash', 'Press'], rows: LIGHT_COLORS.map((c) => [c, String(rules.flashes[c])]) },
    },
    {
      type: 'slider',
      title: 'Slider',
      text: 'Push it down before it reaches the top.',
    },
  ];
}

function arrowPrompt(rules) {
  const light = pick(LIGHT_COLORS), digit = 1 + rand(6);
  return { light, digit, answer: ARROWS.indexOf(rules.arrows[light][digit - 1]) };
}

const MODULE_TYPES = ['wires', 'button', 'keypad', 'morse', 'arrows', 'switches', 'piano', 'soundboard', 'calculator', 'flashes'];

// A bomb holds a random pick of `count` normal modules, plus the chaos slider if enabled.
function generateBomb({ modules: count = 3, chaos = false } = {}, rules) {
  const serial = makeSerial();
  const make = {
    wires() {
      const colors = Array.from({ length: 3 + rand(4) }, () => pick(WIRE_COLORS));
      return { type: 'wires', colors, cut: colors.map(() => false), answer: solveWires(colors, serial, rules), solved: false };
    },
    button() {
      const color = pick(BUTTON_COLORS), label = pick(BUTTON_LABELS);
      return { type: 'button', color, label, strip: pick(BUTTON_COLORS), action: buttonAction(color, label, serial, rules), holdStart: null, solved: false };
    },
    keypad() {
      const column = pick(rules.keypad);
      const symbols = shuffle(column).slice(0, 4);
      return { type: 'keypad', symbols, order: [...symbols].sort((a, b) => column.indexOf(a) - column.indexOf(b)), pressed: [], solved: false };
    },
    morse: () => ({ type: 'morse', code: [rand(10), rand(10), rand(10)], dials: [0, 0, 0], solved: false }),
    arrows: () => ({ type: 'arrows', stage: 0, ...arrowPrompt(rules), solved: false }),
    switches: () => {
      const lights = Array.from({ length: 4 }, () => pick(LIGHT_COLORS)), digits = Array.from({ length: 4 }, () => 1 + rand(6));
      const answer = lights.map((c, i) => rules.switches[c].test(digits[i]));
      // Never start already solved.
      const up = answer.map(() => Math.random() < 0.5);
      if (up.every((u, i) => u === answer[i])) { const k = rand(4); up[k] = !up[k]; }
      return { type: 'switches', lights, digits, up, answer, solved: false };
    },
    piano: () => {
      const light = pick(LIGHT_COLORS), digit = 1 + rand(6);
      return { type: 'piano', light, digit, keys: rules.piano[light][digit - 1], progress: 0, solved: false };
    },
    calculator: () => {
      const op = pick(['+', '−', '×']);
      let a = 2 + rand(8), b = 2 + rand(8);
      if (op === '−' && b > a) [a, b] = [b, a];
      const sum = op === '+' ? a + b : op === '−' ? a - b : a * b, light = pick(LIGHT_COLORS);
      return { type: 'calculator', expr: `${a} ${op} ${b}`, light, answer: String(rules.calculator[light].fn(sum, serial)), typed: '', solved: false };
    },
    flashes: () => {
      // Buttons sit up, right, down, left; colors and Braille digits are dealt to them at random.
      const colors = shuffle(LIGHT_COLORS), digits = shuffle([1, 2, 3, 4]);
      const sequence = Array.from({ length: 3 }, () => rand(4));
      const answer = sequence.map((i) => digits.indexOf(rules.flashes[colors[i]]));
      return { type: 'flashes', colors, digits, sequence, answer, progress: 0, solved: false };
    },
    soundboard: () => {
      const light = pick(LIGHT_COLORS), digits = Array.from({ length: 9 }, () => 1 + rand(6)), sound = rand(9);
      return { type: 'soundboard', light, digits, sound, answer: rules.soundboard[light][digits[sound] - 1], latched: Array(9).fill(false), solved: false };
    },
  };
  const types = shuffle(MODULE_TYPES).slice(0, Math.min(5, Math.max(1, count)));
  const modules = MODULE_TYPES.filter((t) => types.includes(t)).map((t) => make[t]());
  if (chaos) modules.push({ type: 'slider', value: 0, chaos: true });
  return { serial, modules };
}

// ---------- Game flow ----------

function formatTime(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function rolesFor(n) {
  const roles = [...ROLE_SETS[Math.min(n, 4)]];
  while (roles.length < n) roles.push('eyes');
  return shuffle(roles);
}

// Players keep the role they picked in the lobby when it's free; everyone else gets a random one.
function assignRoles(room) {
  const pool = rolesFor(room.players.length);
  const unassigned = [];
  for (const p of shuffle(room.players)) {
    const i = pool.indexOf(p.pick);
    if (i >= 0) p.role = pool.splice(i, 1)[0];
    else unassigned.push(p);
  }
  unassigned.forEach((p, i) => { p.role = pool[i]; });
}

function pickRole(room, player, role) {
  if (role !== null && !PICKABLE.includes(role)) return;
  if (role && room.players.some((p) => p !== player && p.pick === role)) return;
  player.pick = role;
}

function randomizePicks(room) {
  const roles = shuffle(PICKABLE);
  shuffle(room.players).forEach((p, i) => { p.pick = roles[i] ?? null; });
}

function startGame(room, now) {
  const rules = makeRules();
  const bomb = generateBomb(room.settings, rules);
  room.game = {
    rules,
    bomb,
    manual: manualFor(makeManual(rules), bomb),
    endsAt: now + room.settings.minutes * 60000,
    strikes: 0,
    maxStrikes: 3,
    status: 'playing',
    reason: '',
    emotes: [],
  };
  assignRoles(room);
}

function finish(g, status, reason, now) {
  g.status = status;
  g.timeLeft = Math.max(0, g.endsAt - now);
  g.reason = reason;
  return [{ kind: status === 'won' ? 'win' : 'boom', reason }];
}

function tick(room, now) {
  const g = room.game;
  if (!g || g.status !== 'playing') return [];
  if (now >= g.endsAt) return finish(g, 'lost', 'Time ran out', now);
  // Chaos: the slider keeps rising; at the top it's a strike and it drops back.
  const slider = g.bomb.modules.find((m) => m.type === 'slider');
  if (!slider) return [];
  slider.value += (now - (g.lastTick ?? now)) / SLIDER_RISE_MS;
  g.lastTick = now;
  if (slider.value >= 1) {
    slider.value = 0;
    return strike(g, now);
  }
  return [];
}

function strike(g, now) {
  g.strikes++;
  if (g.strikes >= g.maxStrikes) return [{ kind: 'strike' }, ...finish(g, 'lost', 'Too many strikes', now)];
  return [{ kind: 'strike' }];
}

function solve(g, m, now) {
  m.solved = true;
  if (g.bomb.modules.every((x) => x.solved || x.chaos)) return finish(g, 'won', 'Bomb defused', now);
  return [{ kind: 'solve' }];
}

function act(room, player, a, now) {
  const g = room.game;
  if (!g || g.status !== 'playing' || !ROLES[player.role]?.touch) return [];
  const m = g.bomb.modules[a.module];
  if (!m || m.solved) return [];

  if (m.type === 'wires' && a.kind === 'cut') {
    if (m.cut[a.index] !== false) return [];
    m.cut[a.index] = true;
    return a.index === m.answer ? solve(g, m, now) : strike(g, now);
  }

  if (m.type === 'button' && a.kind === 'hold') {
    if (m.holdStart == null) m.holdStart = now;
    return [];
  }
  if (m.type === 'button' && a.kind === 'release') {
    if (m.holdStart == null) return [];
    const held = now - m.holdStart;
    m.holdStart = null;
    if (m.action === 'tap') return held < HOLD_MS ? solve(g, m, now) : strike(g, now);
    if (held >= HOLD_MS && formatTime(g.endsAt - now).includes(releaseDigit(m.strip, g.rules))) return solve(g, m, now);
    return strike(g, now);
  }

  if (m.type === 'keypad' && a.kind === 'press') {
    const sym = m.symbols[a.index];
    if (!sym || m.pressed.includes(sym)) return [];
    if (sym !== m.order[m.pressed.length]) return strike(g, now);
    m.pressed.push(sym);
    return m.pressed.length === m.order.length ? solve(g, m, now) : [{ kind: 'press' }];
  }

  if (m.type === 'morse') {
    if (a.kind === 'play') return [{ kind: 'morse', signals: m.code.map((d) => g.rules.morse[d]) }];
    if (a.kind === 'dial' && m.dials[a.index] != null) {
      m.dials[a.index] = (m.dials[a.index] + 1) % 10;
      return [{ kind: 'press' }];
    }
    if (a.kind === 'enter') return m.dials.join('') === m.code.join('') ? solve(g, m, now) : strike(g, now);
  }

  if (m.type === 'arrows' && a.kind === 'dir') {
    if (a.index !== m.answer) {
      Object.assign(m, { stage: 0 }, arrowPrompt(g.rules));
      return strike(g, now);
    }
    m.stage++;
    if (m.stage >= 3) return solve(g, m, now);
    Object.assign(m, arrowPrompt(g.rules));
    return [{ kind: 'press' }];
  }

  if (m.type === 'switches') {
    if (a.kind === 'flip' && m.up[a.index] != null) { m.up[a.index] = !m.up[a.index]; return [{ kind: 'flip' }]; }
    if (a.kind === 'enter') return m.up.every((u, i) => u === m.answer[i]) ? solve(g, m, now) : strike(g, now);
  }

  if (m.type === 'piano' && a.kind === 'key' && a.index >= 0 && a.index < 5) {
    const note = { kind: 'note', index: a.index };
    if (a.index !== m.keys[m.progress]) { m.progress = 0; return [note, ...strike(g, now)]; }
    m.progress++;
    return m.progress >= m.keys.length ? [note, ...solve(g, m, now)] : [note];
  }

  if (m.type === 'calculator') {
    if (a.kind === 'digit' && a.index >= 0 && a.index <= 9 && m.typed.length < 3) { m.typed += a.index; return [{ kind: 'press' }]; }
    if (a.kind === 'clear') { m.typed = ''; return [{ kind: 'press' }]; }
    if (a.kind === 'enter') {
      if (m.typed === m.answer) return solve(g, m, now);
      m.typed = '';
      return strike(g, now);
    }
  }

  if (m.type === 'flashes' && a.kind === 'press' && a.index >= 0 && a.index < 4) {
    if (a.index !== m.answer[m.progress]) { m.progress = 0; return strike(g, now); }
    m.progress++;
    return m.progress >= m.answer.length ? solve(g, m, now) : [{ kind: 'press' }];
  }

  if (m.type === 'soundboard') {
    if (a.kind === 'tap' && m.latched[a.index] != null) {
      m.latched[a.index] = !m.latched[a.index];
      return [{ kind: a.index === m.sound ? 'chime' : 'press' }];
    }
    if (a.kind === 'enter') {
      const ok = m.latched.every((on, i) => on === m.answer.includes(i));
      if (ok) return solve(g, m, now);
      m.latched.fill(false);
      return strike(g, now);
    }
  }

  if (m.type === 'slider' && a.kind === 'push') {
    m.value = Math.max(0, m.value - 0.34);
    return [{ kind: 'press' }];
  }
  return [];
}

// A player left mid-round: roles never change during a round, so the round ends.
function abort(room, reason, now) {
  const g = room.game;
  return g?.status === 'playing' ? finish(g, 'lost', reason, now) : [];
}

function addEmote(room, player, e, now, aim) {
  const g = room.game;
  if (!g || g.status !== 'playing' || !GESTURES.includes(e)) return;
  const entry = { id: player.id, from: player.name, e, at: now };
  // A banana flies where its thrower was looking: [yaw from the seat, pitch], in radians.
  if (e === '🍌' && Array.isArray(aim) && aim.length === 2 && aim.every(Number.isFinite)) {
    entry.aim = [Math.max(-1.6, Math.min(1.6, aim[0])), Math.max(-1.5, Math.min(1.5, aim[1]))];
  }
  g.emotes.push(entry);
  if (g.emotes.length > 8) g.emotes.shift();
}

function moduleView(m, see, touch) {
  switch (m.type) {
    case 'wires': return { type: 'wires', solved: m.solved, cut: m.cut, colors: see ? m.colors : null };
    case 'button': {
      const holding = m.holdStart != null;
      return { type: 'button', solved: m.solved, holding, color: see ? m.color : null, label: see ? m.label : null, strip: see && holding ? m.strip : null };
    }
    case 'keypad': return { type: 'keypad', solved: m.solved, symbols: see ? m.symbols : null, pressed: m.symbols.map((s) => m.pressed.includes(s)) };
    case 'morse': return { type: 'morse', solved: m.solved, dials: m.dials };
    // The light color is visual. Everyone who can see or touch gets the Braille dots; only Blind
    // gets them read out (the client shows the number when Blind's finger is on them).
    case 'arrows': return { type: 'arrows', solved: m.solved, stage: m.stage, light: see && !m.solved ? m.light : null, braille: (see || touch) && !m.solved ? BRAILLE[m.digit] : null };
    case 'switches': return { type: 'switches', solved: m.solved, up: m.up, lights: see ? m.lights : null, braille: see || touch ? m.digits.map((d) => BRAILLE[d]) : null };
    case 'piano': return { type: 'piano', solved: m.solved, progress: m.progress, light: see && !m.solved ? m.light : null, braille: (see || touch) && !m.solved ? BRAILLE[m.digit] : null };
    case 'calculator': return { type: 'calculator', solved: m.solved, typed: m.typed, expr: see ? m.expr : null, light: see && !m.solved ? m.light : null };
    // Deaf sees the colors and the flashing sequence; Blind feels the Braille digits.
    case 'flashes': return { type: 'flashes', solved: m.solved, progress: m.progress, colors: see ? m.colors : null, sequence: see && !m.solved ? m.sequence : null, braille: see || touch ? m.digits.map((d) => BRAILLE[d]) : null };
    case 'soundboard': return { type: 'soundboard', solved: m.solved, latched: m.latched, light: see ? m.light : null, braille: see || touch ? m.digits.map((d) => BRAILLE[d]) : null };
    default: return { type: 'slider', chaos: true, value: m.value };
  }
}

function bombView(bomb, see, touch) {
  return { serial: see ? bomb.serial : null, modules: bomb.modules.map((m) => moduleView(m, see, touch)) };
}

function viewFor(room, player, now) {
  const g = room.game;
  const view = {
    room: room.code,
    you: player.id,
    hostId: room.hostId,
    settings: room.settings,
    players: room.players.map((p) => ({ id: p.id, name: p.name, role: p.role, pick: p.pick ?? null, reading: !!p.reading })),
    emoteList: GESTURES,
    game: null,
  };
  if (!g) return view;
  const role = ROLES[player.role];
  const over = g.status !== 'playing';
  view.game = {
    status: g.status,
    reason: g.reason,
    strikes: g.strikes,
    maxStrikes: g.maxStrikes,
    role: { id: player.role, ...role },
    timer: over ? formatTime(g.timeLeft) : role.seeBomb ? formatTime(g.endsAt - now) : null,
    // Everyone can hear the ticking speed up in the last 30 seconds.
    hurry: !over && g.endsAt - now < 30000,
    bomb: role.touch || role.seeBomb || over ? bombView(g.bomb, role.seeBomb || over, role.touch || over) : null,
    manual: role.manual ? g.manual : null,
    // Blind can't see anyone's gestures, but still feels their own hands moving.
    emotes: g.emotes.filter((x) => role.seeGestures || x.id === player.id).map((x) => ({ ...x, age: now - x.at })),
  };
  return view;
}

module.exports = { startGame, pickRole, randomizePicks, abort, tick, act, addEmote, viewFor, solveWires, buttonAction };
