const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = readFileSync('public/scene.js', 'utf8');
class Vector2 {
  constructor(x = 0, y = 0) { this.set(x, y); }
  set(x, y) { this.x = x; this.y = y; return this; }
  copy(v) { return this.set(v.x, v.y); }
  multiplyScalar(n) { return this.set(this.x * n, this.y * n); }
}
const listeners = {};
const document = {
  pointerLockElement: null,
  createElement: () => ({ classList: { toggle() {} } }),
  addEventListener: (name, fn) => { listeners[name] = fn; },
  exitPointerLock() { this.pointerLockElement = null; listeners.pointerlockchange(); },
};
const canvas = {
  requestPointerLock() { document.pointerLockElement = this; listeners.pointerlockchange(); return Promise.resolve(); },
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
};
const context = vm.createContext({ document, canvas, THREE: { Vector2, MathUtils: { clamp: (n, lo, hi) => Math.max(lo, Math.min(n, hi)) } }, container: { appendChild() {} }, window: { addEventListener() {} }, state: { game: { role: { touch: false, seeBomb: true } } }, pointer: new Vector2(), leaning: false, lookSpeed: 1 });
vm.runInContext(source.slice(source.indexOf('  const locked ='), source.indexOf('  function turnKey(')), context);
vm.runInContext(`
  mouseLook.set(.6, -.3);
  canvas.requestPointerLock();
  setCursorOverlay('wheel', true);
  leave({ relatedTarget: null });
`, context);
assert.equal(vm.runInContext('mouseLook.x', context), .6, 'unlocking into a wheel must retain the head angle');
vm.runInContext(`
  move({ clientX: 900, clientY: 100 });
`, context);
assert.equal(vm.runInContext('mouseLook.x', context), .6, 'wheel cursor must not turn the head');
vm.runInContext("setCursorOverlay('manual', true); setCursorOverlay('wheel', false)", context);
assert.equal(document.pointerLockElement, null, 'manual still needs the cursor');
vm.runInContext("setCursorOverlay('manual', false)", context);
assert.equal(document.pointerLockElement, canvas, 'last overlay restores shift lock');
vm.runInContext('toggleLean()', context);
assert.equal(document.pointerLockElement, null, 'leaning frees the cursor');
assert.equal(vm.runInContext('mouseLook.x', context), .6, 'leaning retains the head angle');
vm.runInContext('move({ clientX: 250, clientY: 700 })', context);
assert.equal(context.pointer.x, -.5, 'the leaned-in cursor can move');
vm.runInContext(`
  toggleLean();
  state.game.role = { touch: true, seeBomb: false };
  mouseLook.set(.9, -.7);
  keyTurn = .4; keyTilt = -.2;
  canvas.requestPointerLock();
  toggleLean();
`, context);
assert.equal(document.pointerLockElement, null, 'Blind zoom must release shift lock');
assert.equal(vm.runInContext('mouseLook.x', context), 0, 'Blind zoom must center the bomb instead of freezing the locked yaw');
assert.equal(vm.runInContext('mouseLook.y', context), 0, 'Blind zoom must clear the locked pitch');
assert.equal(vm.runInContext('keyTurn + keyTilt', context), 0, 'Blind zoom must clear residual keyboard turning');
vm.runInContext('move({ clientX: 750, clientY: 300 })', context);
assert.equal(context.pointer.x, .5, 'Blind can move the bomb interaction cursor after zooming');
console.log('cursor transition regression passed');
