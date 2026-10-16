// Which way the player is playing: 'touch', 'keys' (a keyboard) or 'pad' (a
// gamepad), so the page can show the hints for that. It starts from what the
// device's main pointer is (a finger on phones and tablets, a mouse or trackpad
// otherwise), then follows whichever is actually used: a touch, a key press or
// a gamepad button. Mouse movement doesn't count. The mode is put on
// <body data-input="...">, and the last one is remembered for next time.
//
//   const mode = new InputMode({ storageKey: 'z80js.inputMode' });
//   mode.onChange = (m) => { ... };
//   mode.override = 'auto' | 'touch' | 'keys' | 'pad';   // a fixed choice, from Settings

const MODES = ['touch', 'keys', 'pad'];
const PAD_POLL_MS = 250;

export class InputMode {
  constructor({ storageKey }) {
    this.storageKey = storageKey;
    this.onChange = null;
    this._override = 'auto';
    let saved = null;
    try { saved = localStorage.getItem(storageKey); } catch { /* storage blocked */ }
    const coarse = matchMedia('(pointer: coarse)').matches || matchMedia('(hover: none)').matches;
    this.detected = MODES.includes(saved) ? saved : coarse ? 'touch' : 'keys';
    this.mode = this.detected;
    document.body.dataset.input = this.mode;

    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || e.pointerType === 'pen') this.saw('touch');
    }, { capture: true, passive: true });
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || /^(Meta|Control|Alt|OS)/.test(e.code)) return;  // shortcuts, app switching
      this.saw('keys');
    }, { capture: true, passive: true });

    // Gamepads only report through polling, so look a few times a second while one is connected.
    this.padTimer = 0;
    const poll = () => {
      const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
      if (!pads.length) { clearInterval(this.padTimer); this.padTimer = 0; return; }
      if (pads.some((p) => p.buttons.some((b) => b.pressed) || p.axes.some((a) => Math.abs(a) > 0.5))) this.saw('pad');
    };
    window.addEventListener('gamepadconnected', () => { if (!this.padTimer) this.padTimer = setInterval(poll, PAD_POLL_MS); });
  }

  get override() { return this._override; }
  set override(v) {
    this._override = MODES.includes(v) ? v : 'auto';
    this.apply();
  }

  // An input of this kind was used.
  saw(kind) {
    if (this.detected === kind) return;
    this.detected = kind;
    try { localStorage.setItem(this.storageKey, kind); } catch { /* storage blocked */ }
    this.apply();
  }

  apply() {
    const mode = this._override === 'auto' ? this.detected : this._override;
    if (mode === this.mode) return;
    this.mode = mode;
    document.body.dataset.input = mode;
    if (this.onChange) this.onChange(mode);
  }
}
