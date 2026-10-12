# 2A03js

A touch-first NES emulator for phones and desktop, in plain JavaScript with
no dependencies. It's a sibling of [6502js](../2600touch) (Atari 2600) and
[SM83js](../SM83js) (Game Boy), and shares their app shell: gesture
controls with adjustable control zones, a saved cartridge library, pause and
resume, save states and an installable web app.

Named for the Ricoh 2A03, the NES's CPU and sound chip.

## Running

```bash
npm start
```

Then open http://localhost:2603 and add a `.nes` ROM (zipped is fine). No
ROMs are included.

## What it emulates

- **CPU:** the 2A03's 6502 core (no decimal mode), timed per bus cycle with
  its dummy reads, plus the unofficial opcodes games use. NMI and IRQ follow
  the real polling rules (interrupts seen before an instruction's last cycle;
  CLI, SEI and PLP acting one instruction late).
- **Picture (2C02):** stepped a dot at a time: background shifters and
  scrolling (the "loopy" registers), eight sprites a line, sprite 0 hit,
  8x16 sprites, left-edge clipping, color emphasis and grayscale, the
  odd-frame skipped dot, and the vertical-blank flag's read races. The 64
  colors are worked out from a model of the chip's NTSC signal rather than
  copied from a palette file. The top and bottom 8 lines are cropped, as a TV
  did, and pixels are shown at their 8:7 shape.
- **Sound:** both pulse channels (envelopes, sweeps), the triangle (linear
  counter), noise, and the DMC (sample fetches steal CPU cycles; IRQ), with
  the frame counter's 4- and 5-step modes and IRQ, mixed with the console's
  nonlinear formula.
- **Cartridges:** NROM (0), MMC1 (1), UxROM (2), CNROM (3), MMC3 (4, with its
  scanline IRQ), AxROM (7), MMC2 (9, Punch-Out!!), Color Dreams (11), GxROM
  (66) and Camerica (71), from iNES or NES 2.0 headers. That covers most of
  the library. Battery-backed RAM is saved per game on the device.

## Controls

- **Touch:** the left half is a d-pad that appears where your finger lands;
  the right half is A stacked over B. Select and Start are in the top bar.
  Left-handed mode swaps the sides.
- **Control zones** (as in z80js): faint outlines show each control's area,
  with adjustable opacity; the zone overlap slider sets how far they reach
  over the picture.
- **Keyboard:** arrows or WASD; X or K for A; Z or J for B; Return for
  Start; Shift or Backspace for Select; P to pause.
- **Gamepad:** d-pad or left stick; the right face button is A and the bottom
  one B (Nintendo layout); Start and Back/Select.
- **Settings** also has Reset (the console's button) and Power cycle.

## Testing

```bash
node tools/nestest.mjs                       # CPU against nestest's reference log
node tools/run-rom.mjs <rom> [frames] [out.png]   # run headless; reports Blargg results, saves the screen
node tools/state-check.mjs <rom ...>         # save/restore round trips
```

Results with the standard test ROMs (kept in `roms/test`, not committed):

| Test | Result |
|---|---|
| nestest (CPU, with unofficial opcodes) | All 8991 instructions match the reference log, registers and cycles |
| instr_test-v5 official_only / all_instrs | All 16 passed / all 16 passed |
| cpu_timing_test | Passed |
| ppu_vbl_nmi (vertical blank and NMI timing) | All 10 passed |
| sprite_hit_tests (01-11) | All passed |
| apu_test | All 8 passed |
| Save state round trips | Identical for 300 frames after restore |

## Known gaps

- NTSC only (no PAL timing).
- The MMC3's scanline counter is clocked at the usual point in each line
  rather than from the PPU's address line, so games that use unusual pattern
  table setups for split screens may be a line off.
- Sprite overflow uses the documented behavior, not the hardware's buggy scan.
- Not yet supported: other mappers (VRC, Sunsoft, Namco 163, MMC5, FDS),
  expansion audio, and the Zapper.
- Not yet tried with real games; sound in particular hasn't been checked by ear.
