// A rigged cartoon monkey: shoulders, elbows, wrists and bendable fingers, so
// gestures are real poses instead of floating icons.
import * as THREE from 'three';

const FUR = '#8a4b29';
// Soft off-white: pure white gloves blow out under the van's lamp.
const GLOVE = '#d2cbbf';
const FUR_DARK = '#5e321b';
const SKIN = '#e9c393';
const SKIN_DARK = '#c98d62';

// ----- Gestures -----
// Arm poses are in the monkey's body space and written for its right arm; the left
// arm uses the mirror image. The monkey faces +z, toward whoever it's signalling,
// so its right is -x. An arm pose is
//   w: wrist position, f: the way straightened fingers point, p: the way the palm faces,
//   curl: index..pinky (0 straight, 1 fist), th: thumb [swing out, fold across the palm],
//   pole: the way the elbow points.
// An inverse-kinematics solver turns that into joint angles, so a pose says where
// the hand is and which side faces the audience instead of guessing Euler angles.
const UPPER = 0.47, FORE = 0.47;
const arm = (w, f, p, curl, th, pole = [-1, -0.8, -0.4]) => ({ w, f, p, curl, th, pole });
const POINT = [0, 1, 1, 1], FIST = [1, 1, 1, 1], OPEN = [0, 0, 0, 0];
const TUCK = [-0.6, 1], THUMB_OUT = [1.15, 0], THUMB_UP = [Math.PI / 2, 0];
const REST = arm([-0.34, 1.38, 0.42], [0.1, -0.2, 1], [0, -1, 0.15], [0.12, 0.15, 0.2, 0.25], [0.6, 0.2], [-1, -0.3, -1]);
// Reading: the binder held up in front of the chest by its edges, cover toward the others.
const READ_BOOK = arm([-0.37, 1.98, 0.8], [0.5, 0.2, 0.85], [1, 0, -0.3], [0.45, 0.5, 0.55, 0.6], [0.3, 0.5], [-1, -0.8, -0.4]);
// First person: the same grip, framed at the bottom of your view around the open manual.
const READ_BOOK_FP = { ...arm([-0.52, 2.3, 0.7], [0.5, 0.3, 0.8], [1, 0, -0.3], [0.45, 0.5, 0.55, 0.6], [0.3, 0.5], [-1, -0.8, -0.4]), noSpread: true };
// Where the binder sits: on the lap, or raised to read. [position, x tilt]
const BOOK_LAP = [[0, 1.5, 0.62], -0.55], BOOK_READ = [[0, 1.98, 0.86], 0.12], BOOK_READ_FP = [[0, 2.32, 0.75], -0.1];
const HOLD_BOOK = arm([-0.37, 1.62, 0.66], [0.55, 0.45, 0.6], [1, 0, -0.3], [0.55, 0.6, 0.65, 0.7], [0.3, 0.5], [-1, -0.6, -0.6]);

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
// 0 -> 1 with a small overshoot and settle, starting at t = 0 (ms).
const spring = (t) => t <= 0 ? 0 : 1 - Math.exp(-t / 90) * Math.cos(t / 62);
// A single 0 -> 1 -> 0 hump of the given length.
const bump = (t, at, len) => t > at && t < at + len ? Math.sin((t - at) / len * Math.PI) : 0;
const add3 = (a, x = 0, y = 0, z = 0) => [a[0] + x, a[1] + y, a[2] + z];
const mirror = (a) => a && { ...a, w: [-a.w[0], a.w[1], a.w[2]], f: [-a.f[0], a.f[1], a.f[2]], p: [-a.p[0], a.p[1], a.p[2]], pole: [-a.pole[0], a.pole[1], a.pole[2]] };
function mixArm(a, b, t) {
  const m = (x, y) => x.map((v, i) => v + (y[i] - v) * t);
  return { w: m(a.w, b.w), f: m(a.f, b.f), p: m(a.p, b.p), curl: m(a.curl, b.curl), th: m(a.th, b.th), pole: m(a.pole, b.pole) };
}
// Eased keyframes: [[ms, pose], ...].
function keys(t, list) {
  if (t <= list[0][0]) return list[0][1];
  for (let i = 1; i < list.length; i++) {
    const [t1, b] = list[i], [t0, a] = list[i - 1];
    if (t < t1) return mixArm(a, b, smooth((t - t0) / (t1 - t0)));
  }
  return list.at(-1)[1];
}

// Each gesture: (ms since it started, first person?) -> { R, L, head, lean, shrug }.
// R and L are right-arm poses; L gets mirrored. Missing arms rest.
const pointAt = (t) => 0.07 * (bump(t, 230, 190) + 0.7 * bump(t, 560, 190));
const pointRight = (t, fp) => arm(add3([fp ? -0.55 : -1.0, 2.1, 0.42], -pointAt(t)), [-1, 0.06, 0.22], [0.15, -0.2, 1], POINT, TUCK, [0, -1, -0.6]);
// Numbers, index first: 1 = index, 4 = four fingers, 5 adds the thumb, 6-10 add the left hand.
// The fingers form on the way up and then hold still, so nobody reads a number in passing.
function count(n) {
  const hand = (upTo, t) => arm([-0.8, 2.32 + 0.03 * bump(t, 200, 220), 0.5], [-0.08, 1, 0.05], [0.2, 0, 1],
    [0, 1, 2, 3].map((i) => i < upTo ? 0 : 1), upTo === 5 ? THUMB_OUT : TUCK, [-1, -1, -0.2]);
  return (t) => ({ R: hand(Math.min(n, 5), t), L: n > 5 ? hand(n - 5, t) : null, head: [-0.05, 0, 0] });
}

const GESTURES = {
  '👆': (t) => ({ R: arm(add3([-0.74, 2.68, 0.36], 0, pointAt(t)), [0.05, 1, 0.12], [0.3, 0, 1], POINT, TUCK, [-1, -0.7, -0.2]), head: [-0.3, -0.1, 0] }),
  '👇': (t, fp) => ({ R: arm(add3([-0.85, 2.55, 0.5], 0, -pointAt(t)), [fp ? 0.2 : 0.05, -1, 0.25], [0.1, 0.25, -1], POINT, TUCK, [-1, -0.5, -0.6]), head: [0.22, 0, 0] }),
  // Pointing uses the gesturer's own left and right: 👉 sweeps the right arm out to its right.
  '👉': (t, fp) => ({ R: pointRight(t, fp), head: [0, -0.45, 0] }),
  '👈': (t, fp) => ({ L: pointRight(t, fp), head: [0, 0.45, 0] }),
  '👍': (t, fp) => {
    const punch = spring(t - 180);
    return { R: arm([-0.42, 2.2 + 0.08 * punch + 0.04 * bump(t, 950, 240), 0.6 + 0.14 * punch], fp ? [1, 0.1, 0.5] : [0.3, 0.1, 1], fp ? [0.45, 0, -1] : [1, 0, 0.45], FIST, THUMB_UP, [-1, -1, -0.4]),
      head: [0.13 * (bump(t, 330, 320) + bump(t, 680, 320)), 0, 0] };
  },
  '👎': (t, fp) => {
    const push = spring(t - 180);
    return { R: arm([-0.42, 2.42 - 0.14 * push - 0.04 * bump(t, 950, 240), 0.62 + 0.1 * push], fp ? [1, -0.1, 0.5] : [0.3, -0.1, 1], fp ? [-0.45, 0, 1] : [-1, 0, 0.45], FIST, THUMB_UP, [-1, -1, -0.4]),
      head: [0.05, 0.2 * Math.sin(t / 85) * bump(t, 280, 900), 0] };
  },
  '🤷': (t) => {
    const up = smooth((t - 220) / 260) - 0.25 * smooth((t - 1500) / 400);
    const palm = arm([-0.7, 1.98 + 0.1 * up, 0.5], [-0.6, 0.15, 0.8], [0.1, 1, 0], [0.12, 0.16, 0.2, 0.26], [1.1, 0], [-0.3, -1, -0.8]);
    return { R: palm, L: palm, head: [0.05, 0, 0.3 * up], shrug: up };
  },
  // Repeat: both index fingers point at each other and roll round each other, half a
  // turn apart, coming toward the audience over the top.
  '🔁': (t, fp) => {
    const r = 0.12 * smooth((t - 120) / 220), a = (t - 120) * 0.0105;
    const hand = (phase) => arm([-0.52, (fp ? 2.3 : 2.22) + Math.sin(a + phase) * r, 0.72 - Math.cos(a + phase) * r], [1, 0.05, 0.15], [0, -0.55, -1], POINT, TUCK, [-1, -0.8, -0.5]);
    return { R: hand(0), L: hand(Math.PI), head: [0.06 + 0.04 * Math.sin(a * 2), 0, 0] };
  },
  '🤫': (t) => ({ R: arm([0.15, 1.92, 0.7 + 0.02 * bump(t, 520, 260)], [0, 1, 0.05], [0.45, 0, -1], POINT, TUCK, [-1, -1, 0]), head: [0.1, 0, 0], lean: 0.08 }),
  '✋': (t) => {
    const a = t * 0.0135, amp = smooth((t - 200) / 300);
    return { R: arm([-0.8 + 0.07 * Math.sin(a - 0.7) * amp, 2.6, 0.32], [-0.12 + 0.5 * Math.sin(a) * amp, 1, 0.1], [0, 0, 1], [0, 0.02, 0.04, 0.06], THUMB_OUT, [-1, -0.8, -0.2]),
      head: [0, 0, 0.12 * Math.sin(a * 0.5) * amp] };
  },
  // Overarm throw: cock the banana behind the head, whip it forward, let go, follow through.
  '🍌': (t) => {
    const grip = [0.72, 0.76, 0.8, 0.84], loose = [0.08, 0.1, 0.14, 0.2];
    const cocked = arm([-0.56, 2.58, -0.22], [0, 0.8, -0.6], [0, 0.6, 0.8], grip, [0.4, 0.8], [-1, -0.2, -0.8]);
    const cocked2 = { ...cocked, w: [-0.58, 2.62, -0.32] };
    const release = arm([-0.4, 2.55, 0.72], [0, 0.45, 1], [0, -0.9, 0.42], loose, [0.8, 0.2], [-1, -0.5, -0.3]);
    const follow = arm([-0.14, 1.82, 0.72], [0.4, -0.8, 0.5], [0.3, -0.45, -0.85], [0.3, 0.35, 0.4, 0.45], [0.6, 0.3], [-1, -0.6, -0.3]);
    const R = keys(t, [[0, cocked], [380, cocked2], [520, release], [760, follow]]);
    if (t > 470) R.curl = R.curl.map((c, i) => c + (loose[i] - c) * smooth((t - 470) / 60));
    const lean = -0.12 * smooth(t / 380) + 0.3 * smooth((t - 380) / 220) - 0.12 * smooth((t - 700) / 400);
    return { R, head: [lean * -0.6, 0, 0], lean };
  },
};
for (let n = 1; n <= 10; n++) GESTURES[String(n)] = count(n);

// Rude ones. A raised middle finger shows the back of the hand to whoever it's aimed at.
const BIRD = [1, 0, 1, 1];
const bird = (w, curl = BIRD) => arm(w, [0.04, 1, 0.08], [0.15, 0, -1], curl, TUCK, [-1, -1, -0.2]);
// Both middle fingers up beside the head, pumping.
GESTURES['🖕'] = (t) => {
  const pump = 0.05 * (bump(t, 300, 260) + bump(t, 650, 260) + bump(t, 1000, 260));
  return { R: bird([-0.72, 2.35 + pump, 0.5]), L: bird([-0.72, 2.35 + pump, 0.5]), head: [-0.08, 0, 0.12 * Math.sin(t / 140) * smooth((t - 200) / 300)], lean: 0.05 };
};
// Jack-in-the-box: one hand cranks a handle beside the other fist, which rises with every
// turn until the middle finger springs up.
const POP_MS = 2100;
GESTURES['🎁'] = (t) => {
  const a = t * 0.0115, cranking = t < POP_MS, rise = smooth(t / POP_MS);
  const pop = t > POP_MS ? Math.min(1.15, spring(t - POP_MS)) : 0;
  // Each turn of the crank ratchets the finger up a notch; the pop finishes it with a bounce.
  const turns = a / (Math.PI * 2), notch = Math.floor(turns) + smooth((turns % 1) * 4);
  const creep = Math.min(1, notch / (POP_MS * 0.0115 / (Math.PI * 2)));
  const middle = cranking ? 1 - 0.75 * creep : 0.25 - 0.25 * pop;
  const fist = bird([-0.55, 1.95 + 0.38 * rise + 0.06 * pop, 0.62], [1, middle, 1, 1]);
  const crank = cranking
    ? arm([0.2, 1.9 + 0.3 * rise + Math.sin(a) * 0.1, 0.5 - Math.cos(a) * 0.1], [0, -0.2, 1], [1, 0, 0], [0.75, 0.8, 0.85, 0.9], [0.3, 0.8], [-1, -0.8, -0.5])
    : null;
  return { R: fist, L: crank, head: cranking ? [0.15, 0, 0.05 * Math.sin(a)] : [-0.15, 0, 0.1], lean: cranking ? 0.04 : -0.06 - 0.06 * bump(t, POP_MS, 300) };
};
// Aaron flick (the frat flick): one arm up and out, index pointing forward with the palm
// down, the wrist flicking down to the beat (120 BPM) while the head bobs along.
GESTURES['😎'] = (t, fp) => {
  let flick = 0;
  for (const at of [600, 1100, 1600, 2100, 2600]) flick += bump(t, at - 100, 100) * -0.5 + bump(t, at, 110) - 0.25 * bump(t, at + 110, 220);
  flick *= smooth((t - 350) / 150);
  const hand = arm([-0.68, (fp ? 3.15 : 2.7) - 0.03 * flick, 0.62], [fp ? -0.12 : -0.3, fp ? 0.8 - 0.6 * flick : 0.35 - 0.9 * flick, 1], [0, -1, 0.2], [0, 0.8, 0.85, 0.9], TUCK, [-1, -0.7, -0.6]);
  return { R: hand, head: [0.06 + 0.12 * flick, -0.15, 0.05], lean: 0.02 + 0.03 * flick };
};
// How long each gesture is held before the hands drop back to rest (ms).
const GESTURE_MS = (e) => /^(?:[1-9]|10)$/.test(e) ? 3800 : e === '🍌' ? 2400 : e === '🎁' ? 4200 : 3000;
const BODY_TURN = 0.35;
const RELEASE_MS = 470; // when the banana leaves the hand

export function createMonkey({ name, role, firstPerson = false }) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const std = (color, extra = {}) => firstPerson && role === 'hands'
    ? new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false })
    : new THREE.MeshStandardMaterial({ color, roughness: 0.72, ...extra });
  const fur = std(FUR, { roughness: 0.82 }), furDark = std(FUR_DARK, { roughness: 0.85 });
  const furLight = std('#a96135', { roughness: 0.82 });
  const skin = std(SKIN, { roughness: 0.8 }), skinDark = std(SKIN_DARK);
  const pink = std('#dd9384', { roughness: 0.6 });
  const glove = std(GLOVE, { roughness: 0.9 });
  const sphereGeometry = new THREE.SphereGeometry(1, 24, 16);
  const sphere = () => sphereGeometry;
  const capsule = (r, len) => new THREE.CapsuleGeometry(r, len, 6, 12);
  function add(parent, geometry, material, pos = [0, 0, 0], scale = [1, 1, 1], rot = [0, 0, 0]) {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(...pos);
    m.scale.set(...scale);
    m.rotation.set(...rot);
    m.castShadow = !firstPerson;
    m.receiveShadow = !firstPerson;
    parent.add(m);
    return m;
  }

  // ----- Body, sitting -----
  add(body, sphere(), fur, [0, 1.66, -0.025], [0.52, 0.61, 0.44]);
  add(body, sphere(), furLight, [0, 1.48, 0.08], [0.48, 0.43, 0.4]);
  add(body, sphere(), skin, [0, 1.62, 0.255], [0.365, 0.43, 0.235]);
  const footGeometry = capsule(0.17, 0.22);
  for (const s of [-1, 1]) {
    add(body, sphere(), fur, [s * 0.33, 1.18, 0.1], [0.235, 0.24, 0.29]);
    add(body, footGeometry, fur, [s * 0.29, 1.13, 0.36], [1, 1, 1], [Math.PI / 2, 0, s * 0.12]);
    add(body, sphere(), skin, [s * 0.3, 1.09, 0.63], [0.2, 0.13, 0.26]);
    for (let t = 0; t < 3; t++) add(body, sphere(), skin, [s * 0.3 + (t - 1) * 0.105, 1.09, 0.81], [0.064, 0.075, 0.09]);
  }
  const tail = new THREE.Group();
  tail.position.set(0, 1.3, -0.35);
  body.add(tail);
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.3, -0.25, -0.35), new THREE.Vector3(0.75, -0.12, -0.4),
    new THREE.Vector3(0.88, 0.25, -0.22), new THREE.Vector3(0.7, 0.44, -0.15), new THREE.Vector3(0.57, 0.29, -0.13)]);
  add(tail, new THREE.TubeGeometry(tailCurve, 32, 0.075, 8), fur);
  add(tail, sphere(), furLight, [0.57, 0.29, -0.13], [0.078, 0.078, 0.078]);

  // ----- Head -----
  const head = new THREE.Group();
  head.position.set(0, 2.55, 0);
  body.add(head);
  add(head, sphere(), fur, [0, 0.08, -0.025], [0.67, 0.62, 0.57]);
  add(head, sphere(), furLight, [0, 0.25, 0.08], [0.6, 0.43, 0.48]);
  for (const [x, rz, h] of [[-0.09, 0.6, 0.1], [0.02, 0.3, 0.16], [0.12, -0.3, 0.08]]) add(head, capsule(0.065, h), fur, [x, 0.67, -0.04], [1, 1, 1], [-0.25, 0, rz]);
  for (const s of [-1, 1]) add(head, sphere(), skin, [s * 0.205, 0.13, 0.34], [0.3, 0.345, 0.235]);
  add(head, sphere(), skin, [0, 0.055, 0.465], [0.16, 0.2, 0.105]);
  add(head, sphere(), skin, [0, -0.15, 0.365], [0.405, 0.265, 0.28]);
  for (const s of [-1, 1]) {
    add(head, sphere(), skin, [s * 0.28, -0.115, 0.43], [0.19, 0.16, 0.17]);
  }
  add(head, sphere(), skinDark, [0, -0.025, 0.61], [0.105, 0.064, 0.055]);
  for (const s of [-1, 1]) add(head, sphere(), furDark, [s * 0.045, -0.04, 0.655], [0.018, 0.012, 0.009]);
  const mouthMat = std('#643429', { roughness: 0.65 });
  const mouth = add(head, new THREE.TorusGeometry(0.125, 0.017, 8, 24, Math.PI), mouthMat, [0, -0.175, 0.632], [1, 0.65, 1], [0.15, 0, Math.PI]);
  for (const s of [-1, 1]) add(head, sphere(), mouthMat, [s * 0.123, -0.175, 0.633], [0.021, 0.022, 0.012]);
  const ears = [];
  for (const s of [-1, 1]) {
    const ear = new THREE.Group();
    ear.position.set(s * 0.64, 0.08, -0.015);
    ear.rotation.y = s * 0.25;
    head.add(ear);
    add(ear, sphere(), fur, [s * 0.04, 0, 0], [0.245, 0.27, 0.145]);
    add(ear, sphere(), skin, [s * 0.055, 0, 0.075], [0.18, 0.205, 0.085]);
    add(ear, sphere(), pink, [s * 0.065, -0.005, 0.135], [0.125, 0.145, 0.035]);
    ears.push(ear);
  }
  const eyes = [];
  const pupilMat = std('#18131a', { roughness: 0.16, metalness: 0.05 });
  const shine = std('#ffffff', { emissive: '#ffffff', emissiveIntensity: 0.35 });
  const browCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.09, -0.01, 0), new THREE.Vector3(0, 0.018, 0.008), new THREE.Vector3(0.09, -0.01, 0)]);
  const browGeometry = new THREE.TubeGeometry(browCurve, 10, 0.029, 8);
  for (const s of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(s * 0.185, 0.15, 0.568);
    head.add(eye);
    const pupil = add(eye, sphere(), pupilMat, [0, 0, 0], [0.067, 0.093, 0.04]);
    add(eye, sphere(), shine, [-0.019, 0.032, 0.034], [0.02, 0.024, 0.01]);
    add(eye, sphere(), shine, [0.021, -0.024, 0.035], [0.008, 0.009, 0.006]);
    const brow = add(head, browGeometry, furDark, [s * 0.195, 0.345, 0.532], [1, 1, 1], [0, 0, -s * 0.12]);
    eyes.push({ eye, pupil, brow, side: s });
  }
  // Open mouth shown while this player is talking in voice chat.
  const mouthOpen = add(head, sphere(), std('#3b1512'), [0, -0.2, 0.642], [0.1, 0.05, 0.025]);
  mouthOpen.visible = false;

  // ----- Arms -----
  // First-person arms are longer so they reach up from below the frame.
  const upper = firstPerson ? 0.8 : UPPER, fore = firstPerson ? 0.8 : FORE;
  const digitGeometry = new THREE.CapsuleGeometry(1, 2, 3, 8);
  function segment(parent, radius, length) {
    return add(parent, digitGeometry, glove, [0, -length / 2, 0], [radius, (length + 0.07) / 4, radius]);
  }
  // side: which way is out from the body (-1 for the right arm, since the monkey faces +z).
  // The wrist's local frame: fingers along -y, palm toward +z, so a right hand's thumb is on -x.
  function makeArm(side, right) {
    const thumbSide = right ? -1 : 1;
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.46, 2.08, 0.02);
    body.add(shoulder);
    add(shoulder, capsule(0.1, upper - 0.14), fur, [0, -upper / 2, 0]);
    const elbow = new THREE.Group();
    elbow.position.set(0, -upper, 0);
    shoulder.add(elbow);
    add(elbow, capsule(0.09, fore - 0.16), fur, [0, -fore / 2, 0]);
    const wrist = new THREE.Group();
    wrist.position.set(0, -fore, 0);
    elbow.add(wrist);
    add(wrist, new THREE.TorusGeometry(0.11, 0.045, 10, 24), glove, [0, 0.0, 0], [1, 1, 1], [Math.PI / 2, 0, 0]);
    add(wrist, sphere(), glove, [0, -0.1, 0], [0.17, 0.17, 0.095]);
    // Rounded segments overlap at their joints; the tips fold in front of the palm.
    const fingers = [];
    for (let i = 0; i < 4; i++) {
      const proximal = new THREE.Group(), distal = new THREE.Group();
      const length = [0.115, 0.13, 0.12, 0.095][i];
      proximal.position.set(thumbSide * (0.129 - i * 0.086), -0.22, 0.025);
      wrist.add(proximal);
      segment(proximal, 0.043, length);
      distal.position.y = -length;
      proximal.add(distal);
      segment(distal, 0.041, length * 0.85);
      fingers.push({ proximal, distal });
    }
    const thumb = new THREE.Group(), thumbTip = new THREE.Group();
    thumb.position.set(thumbSide * 0.15, -0.085, 0.045);
    wrist.add(thumb);
    segment(thumb, 0.052, 0.12);
    thumbTip.position.y = -0.12;
    thumb.add(thumbTip);
    segment(thumbTip, 0.047, 0.105);
    return { side, thumbSide, base: shoulder.position.clone(), shoulder, elbow, wrist, fingers, thumb, thumbTip };
  }

  const R = makeArm(-1, true), L = makeArm(1, false);
  const arms = [R, L];

  // ----- Role props -----
  if (role === 'hands') {
    const cloth = std('#d93936', { roughness: 0.82, side: THREE.DoubleSide });
    const trim = std('#ae2729', { roughness: 0.85 });
    add(head, new THREE.CylinderGeometry(1, 1, 0.27, 40, 3, true), cloth, [0, 0.16, 0], [0.71, 1, 0.675]);
    for (const y of [0.028, 0.292]) add(head, new THREE.TorusGeometry(1, 0.009, 6, 40), trim, [0, y, 0], [0.711, 0.677, 1], [Math.PI / 2, 0, 0]);
    // Soft gathered folds lead into a side knot, visible across the table.
    for (const y of [0.09, 0.21]) add(head, capsule(0.012, 0.16), trim, [0.56, y, 0.37], [1, 1, 1], [0, -0.6, 1.35]);
    add(head, sphere(), cloth, [0.66, 0.13, 0.1], [0.105, 0.11, 0.09]);
    for (const s of [-1, 1]) add(head, capsule(0.055, 0.22), cloth, [0.72 + s * 0.045, -0.055, 0.07], [1, 1, 0.35], [0.2, 0, s * 0.35]);
    for (const e of eyes) e.eye.visible = false;
    for (const e of eyes) e.brow.position.y = 0.4;
  }
  if (role === 'eyes') {
    const shell = std('#df3835', { roughness: 0.45, metalness: 0.05 });
    const dark = std('#392e32', { roughness: 0.48 });
    const pad = std('#493d40', { roughness: 0.95 });
    const accent = std('#fa7961', { roughness: 0.35 });
    add(head, new THREE.TorusGeometry(0.72, 0.073, 10, 32, Math.PI), shell, [0, 0.1, -0.025], [1, 1, 1.25]);
    add(head, new THREE.TorusGeometry(0.66, 0.039, 8, 24, Math.PI * 0.7), pad, [0, 0.1, -0.025], [1, 1, 1.6], [0, 0, Math.PI * 0.15]);
    for (const s of [-1, 1]) {
      add(head, sphere(), pad, [s * 0.635, 0.06, 0], [0.14, 0.265, 0.235]);
      add(head, sphere(), dark, [s * 0.72, 0.06, 0], [0.15, 0.28, 0.245]);
      add(head, sphere(), shell, [s * 0.77, 0.065, 0.015], [0.15, 0.255, 0.23]);
      add(head, sphere(), accent, [s * 0.865, 0.065, 0.025], [0.065, 0.145, 0.145]);
      add(head, capsule(0.04, 0.15), shell, [s * 0.73, 0.29, 0.05], [1, 1, 1], [0, 0, -s * 0.2]);
    }
    for (const e of ears) e.visible = false;
  }
  let book = null;
  if (role === 'reader') {
    const strip = std('#dc403a', { roughness: 0.85, side: THREE.DoubleSide });
    add(head, new THREE.CylinderGeometry(1, 1, 0.135, 24, 1, true, -1.05, 2.1), strip, [0, -0.175, 0.38], [0.405, 1, 0.29], [0.08, 0, -0.07]);
    mouth.visible = false;
    book = new THREE.Group();
    book.position.set(0, 1.5, 0.62);
    book.rotation.x = -0.55;
    body.add(book);
    const cover = std('#9cc7e6', { roughness: 0.5 });
    add(book, new THREE.BoxGeometry(0.62, 0.78, 0.07), cover, [0, 0, 0.012]);
    add(book, new THREE.BoxGeometry(0.58, 0.74, 0.05), std('#fbf6e8'), [0.015, 0, -0.025]);
    add(book, new THREE.BoxGeometry(0.065, 0.78, 0.085), std('#699dc5'), [-0.28, 0, 0.015]);
    add(book, new THREE.BoxGeometry(0.3, 0.16, 0.008), std('#eaf5f5'), [0.035, 0.19, 0.052]);
    const ring = std('#df5746', { metalness: 0.35, roughness: 0.35 });
    for (const y of [-0.22, 0, 0.22]) add(book, new THREE.TorusGeometry(0.05, 0.012, 8, 16), ring, [-0.31, y, 0], [1, 1, 1], [0, Math.PI / 2, 0]);
  }

  // ----- Name tag -----
  function canvasSprite(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, toneMapped: false, depthTest: false }));
    s.renderOrder = 10;
    return s;
  }
  const tag = canvasSprite(512, 128, (ctx, w, h) => {
    ctx.fillStyle = 'rgba(25,24,20,.72)';
    ctx.beginPath(); ctx.roundRect(4, 4, w - 8, h - 8, 50); ctx.fill();
    ctx.fillStyle = '#fff6dc';
    ctx.font = 'bold 72px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(name, w / 2, h / 2 + 4, w - 40);
  });
  tag.scale.set(1.0, 0.25, 1);
  tag.position.y = 3.55;
  root.add(tag);

  // ----- Banana for 🍌 -----
  const banana = new THREE.Group();
  const bananaCurve = new THREE.CatmullRomCurve3([new THREE.Vector3(-0.22, 0.08, 0), new THREE.Vector3(0, -0.06, 0), new THREE.Vector3(0.22, 0.08, 0)]);
  add(banana, new THREE.TubeGeometry(bananaCurve, 20, 0.06, 10), std('#ffd23f', { roughness: 0.75 }));
  for (const s of [-1, 1]) add(banana, sphere(), std('#5b3a1a'), [s * 0.22, 0.08, 0], [0.03, 0.03, 0.03]);
  banana.visible = false;
  root.add(banana);


  // First person: the same rig, turned to face away from the camera with the eyes at
  // the camera, so your own gestures are exactly what your teammates see from behind.
  // Only the arms show; the shoulders move forward so the hands sit in view.
  if (firstPerson) {
    for (const child of body.children) child.visible = false;
    for (const a of arms) {
      a.shoulder.visible = true;
      a.base.set(a.side * 0.5, 1.2, 1.4);
      a.shoulder.position.copy(a.base);
      // Your own hands are close to your eyes, so they should look big.
      a.wrist.scale.setScalar(1.6);
      banana.scale.setScalar(1.6);
      // Thicken the fur on the arms to match the bigger gloves.
      a.shoulder.children[0].scale.set(1.7, 1, 1.7);
      a.elbow.children[0].scale.set(1.7, 1, 1.7);
    }
    tag.visible = false;
    // Tiny and close to the lens, so the table and bomb never cut through your own hands.
    const s = 0.15;
    root.scale.setScalar(s);
    root.rotation.y = Math.PI;
    root.position.set(0, -2.45 * s, 0.2 * s);
  }

  // ----- Animation -----
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), elbowAt = new THREE.Vector3();
  const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), basis = new THREE.Matrix4();
  const DOWN = new THREE.Vector3(0, -1, 0);
  const worldPosition = new THREE.Vector3();
  // A resolved arm pose: wrist position and orientation, fingers, thumb, elbow direction.
  const resolved = () => ({ w: new THREE.Vector3(), q: new THREE.Quaternion(), curl: [0, 0, 0, 0], th: [0, 0], pole: new THREE.Vector3() });
  const shown = { R: resolved(), L: resolved() }, from = { R: resolved(), L: resolved() }, goal = { R: resolved(), L: resolved() };
  function resolve(out, p) {
    out.w.set(...p.w);
    // First person squeezes the gesture space into the middle of the view.
    if (firstPerson && !p.raw) out.w.set(out.w.x * (p.noSpread ? 1 : spread), 1.85 + (out.w.y - 2.4) * 0.8, 2.6 + (out.w.z - 0.5) * 0.5);
    // Fingers run along the wrist's -y and the palm faces its +z.
    v2.set(...p.f).normalize().negate();
    v3.set(...p.p);
    v3.addScaledVector(v2, -v3.dot(v2)).normalize();
    v1.crossVectors(v2, v3);
    out.q.setFromRotationMatrix(basis.makeBasis(v1, v2, v3));
    for (let i = 0; i < 4; i++) out.curl[i] = p.curl[i];
    out.th[0] = p.th[0]; out.th[1] = p.th[1];
    out.pole.set(...p.pole).normalize();
  }
  function copyResolved(to, src) {
    to.w.copy(src.w); to.q.copy(src.q); to.pole.copy(src.pole);
    for (let i = 0; i < 4; i++) to.curl[i] = src.curl[i];
    to.th[0] = src.th[0]; to.th[1] = src.th[1];
  }
  // Two-bone IK: place the elbow so the wrist lands on w, bending toward the pole.
  function solve(a, p) {
    const S = a.shoulder.position;
    v1.subVectors(p.w, S);
    // Cartoon rubber arms: stretch to reach anything past arm's length (up to 2.2x).
    const stretch = THREE.MathUtils.clamp(v1.length() / (upper + fore - 0.002), 1, 2.2);
    const U = upper * stretch, F = fore * stretch;
    a.elbow.position.y = -U; a.wrist.position.y = -F;
    a.shoulder.children[0].scale.y = stretch; a.shoulder.children[0].position.y = -U / 2;
    a.elbow.children[0].scale.y = stretch; a.elbow.children[0].position.y = -F / 2;
    const d = Math.min(Math.max(v1.length(), 0.08), U + F - 0.002);
    v1.normalize();
    const along = (U * U - F * F + d * d) / (2 * d);
    const out = Math.sqrt(Math.max(0, U * U - along * along));
    v2.copy(p.pole).addScaledVector(v1, -p.pole.dot(v1));
    if (v2.lengthSq() < 1e-6) v2.set(0, -1, 0).addScaledVector(v1, -v1.y);
    v2.normalize();
    elbowAt.copy(S).addScaledVector(v1, along).addScaledVector(v2, out);
    v3.subVectors(elbowAt, S).normalize();
    a.shoulder.quaternion.setFromUnitVectors(DOWN, v3);
    v3.copy(v1).multiplyScalar(d).add(S).sub(elbowAt).normalize();
    q1.copy(a.shoulder.quaternion).invert();
    a.elbow.quaternion.setFromUnitVectors(DOWN, v3.applyQuaternion(q1));
    q2.copy(a.shoulder.quaternion).multiply(a.elbow.quaternion).invert();
    a.wrist.quaternion.copy(q2).multiply(p.q);
    const c = a.thumbSide;
    for (let i = 0; i < 4; i++) {
      const f = a.fingers[i], k = p.curl[i];
      f.proximal.rotation.set(-k * 1.25, 0, c * (1.5 - i) * 0.1 * (1 - Math.max(0, k)));
      f.distal.rotation.x = -1.6 * smooth(k);
    }
    a.thumb.rotation.set(-p.th[1] * 0.85, -c * p.th[1] * 0.35, c * p.th[0]);
    a.thumbTip.rotation.x = -p.th[1] * 1.2;
  }

  // First-person framing, in fractions of the screen width: where the pair of hands is
  // centred and how far each hand sits from that centre.
  let frameCenter = 0.5, frameHalf = 0.27, spread = 1;
  function setFrame(center, half) { frameCenter = center; frameHalf = half; }
  let emote = null, emoteStart = 0, emoteAt = null, gesture = null, blendStart = -1e9;
  let lean = 0, shrug = 0;
  const headPose = [0, 0, 0];
  let bodyYaw = 0;
  // Reaching for the bomb: a world-space point, until when, and a fresh key to start the blend.
  let reachAt = null, reachUntil = 0, reachKey = {};
  const reachLocal = new THREE.Vector3();
  function reach(at, hold) {
    const now = performance.now();
    if (!at) { reachUntil = Math.min(reachUntil, now + 120); return; }
    reachAt = at.clone();
    reachUntil = hold ? Infinity : now + 750;
    reachKey = {};
  }
  let look = null; // [yaw, pitch] of the player's view, relative to the seat
  const phase = Math.random() * 10;
  let nextBlink = performance.now() + Math.random() * 4000, blinkUntil = 0, talking = false;
  let bananaFrom = null, thrown = null;

  function setEmote(e, age, now = performance.now()) {
    const at = e ? now - age : null;
    // A new emote, or the same one sent again.
    if (e !== emote || (at != null && Math.abs(at - emoteAt) > 400)) {
      emote = e;
      emoteAt = at;
      emoteStart = at ?? 0;
      // A throw that was already over when we saw it doesn't launch a banana.
      bananaFrom = e === '🍌' && age >= RELEASE_MS ? true : null;
    }
  }

  // Mute's manual: open (raised to read) or closed (on the lap).
  let reading = false, readBlend = 0;
    // In first person the binder sits right behind the on-screen manual page, so its size
  // and height come from where the page is drawn: fractions of the screen height.
  let bookH = 0.74, bookCy = 0.5;
  const readFp = { ...READ_BOOK_FP, w: [...READ_BOOK_FP.w], raw: true };
  const restPose = () => !book ? REST : reading ? (firstPerson ? readFp : READ_BOOK) : firstPerson ? REST : HOLD_BOOK;
  let rest = restPose();
  function idle(now) {
    const b = Math.sin(now * 0.0018 + phase) * 0.012;
    return { R: { ...rest, w: add3(rest.w, 0, b) }, L: { ...rest, w: add3(rest.w, 0, b) } };
  }
  // A little anticipation and overshoot on the way into each pose.
  function backEase(u) {
    const c = 0.9 * 1.525;
    return u < 0.5 ? (2 * u) ** 2 * ((c + 1) * 2 * u - c) / 2 : ((2 * u - 2) ** 2 * ((c + 1) * (2 * u - 2) + c) + 2) / 2;
  }

  function update(now, dt, camera) {
    const age = now - emoteStart;
    const fn = GESTURES[emote];
    const active = !!(emote && age < GESTURE_MS(emote));
    const current = active && fn ? fn : null;
    rest = restPose();
    const reaching = !!reachAt && now < reachUntil;
    if (reachAt && !reaching) reachAt = null;
    const key = current ?? (reaching ? reachKey : rest);
    if (key !== gesture) {
      // Start a new blend from wherever the hands are now.
      copyResolved(from.R, shown.R); copyResolved(from.L, shown.L);
      blendStart = now;
      gesture = key;
    }
    if (firstPerson && camera) {
      // Two-hand poses keep their wrists at body x = ±0.8, 2.4 units in front of the eyes.
      const tanH = camera.aspect * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      spread = 6 * frameHalf * tanH;
      root.position.x = (frameCenter - 0.5) * 2 * tanH * 2.4 * root.scale.x;
    }
    let out = current ? current(age, firstPerson) : idle(now);
    if (reaching) {
      // Point the nearer hand's index finger at the touched spot, leaning in toward it.
      body.updateMatrixWorld(true);
      const target = body.worldToLocal(reachLocal.copy(reachAt));
      const right = target.x < 0, side = right ? R : L;
      if (!right) target.x = -target.x; // poses are written for the right arm
      const sx = right ? side.shoulder.position.x : -side.shoulder.position.x;
      const f = [target.x - sx, target.y - side.shoulder.position.y, target.z - side.shoulder.position.z];
      const len = Math.hypot(...f), tip = 0.44;
      const w = [target.x - f[0] / len * tip, target.y - f[1] / len * tip, target.z - f[2] / len * tip];
      const poke = arm(w, f, [0, -1, 0.1], POINT, TUCK, [-1, -0.6, -0.4]);
      out = { ...out, [right ? 'R' : 'L']: poke, lean: 0.22, head: [0.35, 0, 0] };
    }
    resolve(goal.R, out.R ?? rest);
    resolve(goal.L, mirror(out.L ?? rest));
    const u = clamp01((now - blendStart) / 260);
    for (const side of ['R', 'L']) {
      const s = shown[side], a = from[side], g = goal[side];
      s.w.lerpVectors(a.w, g.w, backEase(u));
      s.q.slerpQuaternions(a.q, g.q, smooth(u));
      s.pole.lerpVectors(a.pole, g.pole, smooth(u));
      for (let i = 0; i < 4; i++) s.curl[i] = a.curl[i] + (g.curl[i] - a.curl[i]) * smooth((now - blendStart - 30 - i * 20) / 200);
      for (let i = 0; i < 2; i++) s.th[i] = a.th[i] + (g.th[i] - a.th[i]) * smooth((now - blendStart - 50) / 220);
    }

    const k = now * 0.001, ease = 1 - Math.exp(-dt * 9);
    lean += ((out.lean ?? 0) - lean) * ease;
    // The body turns a third of the way toward where the player looks; the head does the rest.
    bodyYaw += ((look ? look[0] * BODY_TURN : 0) - bodyYaw) * (1 - Math.exp(-dt * 4));
    shrug += ((out.shrug ?? 0) - shrug) * ease;
    for (let i = 0; i < 3; i++) {
      // A player's own view direction steers the head; idle drift only fills in without one.
      const idleHead = look ? 0 : i === 0 ? Math.sin(now * 0.0004 + phase) * 0.08 : i === 1 ? Math.sin(now * 0.00025 + phase) * 0.2 : 0;
      const viewHead = !look ? 0 : i === 0 ? -THREE.MathUtils.clamp(look[1], -0.9, 0.9) : i === 1 ? THREE.MathUtils.clamp(look[0] * (1 - BODY_TURN), -1.1, 1.1) : 0;
      const h = (out.head ? out.head[i] * (look ? 0.5 : 1) : idleHead) + viewHead;
      headPose[i] += (h - headPose[i]) * (1 - Math.exp(-dt * 7));
    }
    head.rotation.set(...headPose);
    tail.rotation.y = Math.sin(k * 1.2 + phase) * 0.09;
    for (let i = 0; i < ears.length; i++) {
      ears[i].rotation.z = (i === 0 ? -1 : 1) * Math.sin(k * 2.1 + phase) * 0.025;
    }

    // Breathing, with the shoulders lifting for a shrug.
    const breath = Math.sin(k * 1.8 + phase);
    if (!firstPerson) {
      body.position.y = breath * 0.02 + shrug * 0.04;
      body.rotation.set(lean, bodyYaw, 0, 'YXZ');
      body.scale.set(1 + breath * 0.008, 1 - breath * 0.008, 1);
    }
    for (const a of arms) a.shoulder.position.set(a.base.x, a.base.y + shrug * 0.09, a.base.z);
    solve(R, shown.R);
    solve(L, shown.L);
    if (book) {
      readBlend += ((reading && !current ? 1 : 0) - readBlend) * (1 - Math.exp(-dt * 9));
      const [up, tiltUp] = BOOK_READ, [down, tiltDown] = BOOK_LAP, u = smooth(readBlend);
      book.position.set(...down.map((v, i) => v + (up[i] - v) * u));
      book.rotation.x = tiltDown + (tiltUp - tiltDown) * u;
      if (firstPerson && camera) {
        // Your own binder rises from below into the exact spot the manual page covers.
        const D = 1.52, span = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * D;
        const scale = bookH * span / 0.78, cy = 2.45 + (0.5 - bookCy) * span;
        book.visible = readBlend > 0.05;
        book.scale.setScalar(scale);
        book.position.set(0, cy - (1 - u) * span * 0.9, 0.2 + D);
        book.rotation.x = 0;
        readFp.w[0] = -(0.31 * scale + 0.05); readFp.w[1] = cy - 0.15 * scale; readFp.w[2] = 0.2 + D - 0.06;
      }
    }

    // In first person, hide the arms once they've dropped out of view.
    if (firstPerson) {
      if (current) { R.up = !!out.R; L.up = !!out.L; }
      if (!current && reading && book) R.up = L.up = true;
      for (const a of arms) a.shoulder.visible = a.up && (!!current || (reading && !!book) || now - blendStart < 300);
    }

    // Banana: in the hand until release.
    const throwing = emote === '🍌' && age < GESTURE_MS(emote);
    banana.visible = throwing && !bananaFrom;
    if (banana.visible) {
      root.updateMatrixWorld(true);
      R.wrist.localToWorld(worldPosition.set(R.thumbSide * 0.02, -0.3, 0.14));
      root.worldToLocal(worldPosition);
      banana.position.copy(worldPosition);
      banana.quaternion.copy(R.shoulder.quaternion).multiply(R.elbow.quaternion).multiply(R.wrist.quaternion);
      if (age >= RELEASE_MS) {
        // Let go: the scene takes over and flies it round the van.
        banana.visible = false;
        banana.updateMatrixWorld(true);
        const at = banana.getWorldPosition(new THREE.Vector3());
        // Lobbed high enough to clear the bomb lid and land across the table.
        const dir = new THREE.Vector3(0.05, 0.9, 1).applyQuaternion(body.getWorldQuaternion(new THREE.Quaternion())).normalize();
        thrown = { late: age - RELEASE_MS, at, velocity: dir.multiplyScalar(5.5), size: banana.getWorldScale(new THREE.Vector3()).x };
        bananaFrom = true;
      }
    }

    // Blink.
    if (now > nextBlink) { blinkUntil = now + 130; nextBlink = now + 2500 + Math.random() * 3500; }
    for (const e of eyes) e.eye.scale.y = now < blinkUntil ? 0.12 : 1;
    // Talking: the mouth flaps open and shut.
    mouthOpen.visible = talking && mouth.visible;
    if (mouthOpen.visible) mouthOpen.scale.y = 0.03 + Math.abs(Math.sin(k * 14)) * 0.07;

    const near = camera ? root.getWorldPosition(worldPosition).distanceTo(camera.position) < 2.4 : false;
    tag.visible = !firstPerson && !active && !near;
  }

  // takeThrow hands over a just-released banana once: { at, velocity, size } in world units.
  // Only the big shapes (body, head, limbs) cast shadows; fingers, eyes and trim don't.
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || !o.castShadow) return;
    o.geometry.computeBoundingSphere();
    o.castShadow = o.geometry.boundingSphere.radius * o.getWorldScale(new THREE.Vector3()).x > 0.22;
  });
  return { root, banana, reach, setBookFrame: (h, cy) => { bookH = h; bookCy = cy; }, setReading: (on) => { reading = !!on; }, takeThrow: () => { const t = thrown; thrown = null; return t; }, setEmote, update, setFrame, setLook: (l) => { look = l; }, setTalking: (on) => { talking = on; } };
}
