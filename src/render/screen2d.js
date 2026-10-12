// Draws the NES frame (256x240 RGBA pixels) to a canvas at native size, minus
// the top and bottom 8 lines that an NTSC TV hid in its overscan; CSS scales
// it up with crisp pixels.

import { WIDTH } from '../emu/ppu.js';

export const CROP = 8, VISIBLE = 240 - CROP * 2;

export class Screen2D {
  constructor(canvas) {
    this.canvas = canvas;
    canvas.width = WIDTH;
    canvas.height = VISIBLE;
    this.ctx = canvas.getContext('2d');
    this.image = this.ctx.createImageData(WIDTH, VISIBLE);
    this.pixels = new Uint32Array(this.image.data.buffer);
  }

  draw(frame) {
    this.pixels.set(frame.subarray(CROP * WIDTH, (CROP + VISIBLE) * WIDTH));
    this.ctx.putImageData(this.image, 0, 0);
  }
}
