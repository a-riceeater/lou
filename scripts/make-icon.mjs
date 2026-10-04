// Generates apps/windows/src/Lou.App/Assets/lou.ico: the "presence" dot used across
// the UI, as a multi-size 32-bit ICO. Pure Node, no dependencies.
//   node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "apps/windows/src/Lou.App/Assets/lou.ico");
const sizes = [16, 20, 24, 32, 40, 48, 64];

// Iris #4F5BD5 with a lighter highlight toward the top-left.
const base = [0x4f, 0x5b, 0xd5];
const light = [0xa9, 0xb0, 0xf2];

function render(size) {
  const ss = 4; // supersampling for anti-aliasing
  const px = new Uint8Array(size * size * 4);
  const r = size * 0.42;
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const dx = x + (sx + 0.5) / ss - c;
        const dy = y + (sy + 0.5) / ss - c;
        if (dx * dx + dy * dy <= r * r) cover++;
      }
      const a = cover / (ss * ss);
      // Highlight blend based on distance from the top-left focus.
      const fx = x + 0.5 - (c - r * 0.35);
      const fy = y + 0.5 - (c - r * 0.4);
      const t = Math.min(1, Math.sqrt(fx * fx + fy * fy) / (r * 1.4));
      const col = base.map((b, i) => Math.round(light[i] * (1 - t) + b * t));
      // ICO DIBs are bottom-up BGRA.
      const o = ((size - 1 - y) * size + x) * 4;
      px[o] = col[2];
      px[o + 1] = col[1];
      px[o + 2] = col[0];
      px[o + 3] = Math.round(a * 255);
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // color + mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(px.length + maskRow * size, 20);
  return Buffer.concat([header, Buffer.from(px), Buffer.alloc(maskRow * size)]);
}

const images = sizes.map(render);
const dir = Buffer.alloc(6 + 16 * sizes.length);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(sizes.length, 4);
let offset = dir.length;
sizes.forEach((s, i) => {
  const e = 6 + i * 16;
  dir.writeUInt8(s >= 256 ? 0 : s, e);
  dir.writeUInt8(s >= 256 ? 0 : s, e + 1);
  dir.writeUInt8(0, e + 2);
  dir.writeUInt8(0, e + 3);
  dir.writeUInt16LE(1, e + 4);
  dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(images[i].length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([dir, ...images]));
console.log(`wrote ${out}`);
