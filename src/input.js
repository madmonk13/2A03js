// Keyboard + gamepad + touch -> the NES controller's eight buttons.
//
// Keys: arrows / WASD for the d-pad, X or K for A, Z or J for B, Return for
// Start, Shift or Backspace for Select. Gamepads: the d-pad or left stick; the
// right face button (or top) is A and the bottom (or left) is B, as on a
// Nintendo pad; Start and Back/Select as labeled.

// NES controller bits, in the order the controller shifts them out (as NES.buttons reads them).
export const BTN = { a: 0x01, b: 0x02, select: 0x04, start: 0x08, up: 0x10, down: 0x20, left: 0x40, right: 0x80 };

const KEYS = {
  ArrowRight: BTN.right, KeyD: BTN.right, ArrowLeft: BTN.left, KeyA: BTN.left,
  ArrowUp: BTN.up, KeyW: BTN.up, ArrowDown: BTN.down, KeyS: BTN.down,
  KeyX: BTN.a, KeyK: BTN.a, KeyZ: BTN.b, KeyJ: BTN.b,
  Enter: BTN.start, NumpadEnter: BTN.start, ShiftLeft: BTN.select, ShiftRight: BTN.select, Backspace: BTN.select,
};
// Touch d-pad direction bits (see touch.js) -> NES bits.
const TOUCH_DIR = [[0x10, BTN.up], [0x20, BTN.down], [0x40, BTN.left], [0x80, BTN.right]];

export class Input {
  constructor() {
    this.keys = new Set();
    this.uiSelect = false;    // the top-bar buttons
    this.uiStart = false;
    this.onActivity = null;   // called on keyboard or gamepad input
    // Extra sources (touch controls): objects with dir() -> direction bits
    // (0x10 up, 0x20 down, 0x40 left, 0x80 right), a() and b() -> bool.
    this.sources = [];
    window.addEventListener('keydown', (e) => {
      if (!(e.code in KEYS) || e.metaKey || e.ctrlKey || e.altKey) return;
      // While a full-screen sheet is open, keys (Return especially) belong to its controls.
      if (document.querySelector('.sheet-backdrop:not([hidden])')) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'BUTTON')) t.blur();
      e.preventDefault();
      this.keys.add(e.code);
      if (this.onActivity) this.onActivity();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // Everything pressed right now, as NES controller bits.
  read() {
    let bits = (this.uiSelect ? BTN.select : 0) | (this.uiStart ? BTN.start : 0);
    for (const code of this.keys) bits |= KEYS[code] || 0;

    for (const src of this.sources) {
      const d = src.dir();
      for (const [t, g] of TOUCH_DIR) if (d & t) bits |= g;
      if (src.a()) bits |= BTN.a;
      if (src.b()) bits |= BTN.b;
    }

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad) continue;
      const b = (i) => pad.buttons[i] && pad.buttons[i].pressed;
      const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
      let p = 0;
      if (ay < -0.5 || b(12)) p |= BTN.up;
      if (ay > 0.5 || b(13)) p |= BTN.down;
      if (ax < -0.5 || b(14)) p |= BTN.left;
      if (ax > 0.5 || b(15)) p |= BTN.right;
      if (b(1) || b(3)) p |= BTN.a;
      if (b(0) || b(2)) p |= BTN.b;
      if (b(8)) p |= BTN.select;
      if (b(9)) p |= BTN.start;
      if (p && this.onActivity) this.onActivity();
      bits |= p;
      break;                    // one player
    }

    // A real d-pad can't press opposite directions together.
    if ((bits & (BTN.left | BTN.right)) === (BTN.left | BTN.right)) bits &= ~(BTN.left | BTN.right);
    if ((bits & (BTN.up | BTN.down)) === (BTN.up | BTN.down)) bits &= ~(BTN.up | BTN.down);
    return bits;
  }
}
