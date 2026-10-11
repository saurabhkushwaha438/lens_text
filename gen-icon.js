// Generates build/icon.png (256x256) - no dependencies, hand-rolled PNG
// encoder + signed-distance-function rasterizer. Icon: iOS/macOS-style blue
// rounded square with three white "text lines" (the app selects text).
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function crc32(buf) {
  if (!crc32.table) {
    crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crc32.table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function writePng(file, w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}

const W = 256, H = 256;
const img = Buffer.alloc(W * H * 4);

// Signed distance to a rounded rectangle centered at (cx,cy).
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

// SDF fill: alpha = clamp(0.5 - d, 0, 1) gives 1px antialiasing.
function fill(sdf, r, g, b) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = Math.min(1, Math.max(0, 0.5 - sdf(x + 0.5, y + 0.5)));
      if (a <= 0) continue;
      const i = (y * W + x) * 4;
      img[i]     = Math.round(img[i]     * (1 - a) + r * a);
      img[i + 1] = Math.round(img[i + 1] * (1 - a) + g * a);
      img[i + 2] = Math.round(img[i + 2] * (1 - a) + b * a);
      img[i + 3] = Math.round(img[i + 3] * (1 - a) + 255 * a);
    }
  }
}

// Background: vertical gradient blue rounded square (macOS squircle-ish).
fill((x, y) => {
  const base = sdRoundRect(x, y, 128, 128, 118, 118, 52);
  // top edge of gradient slightly lighter handled per-pixel below
  return base;
}, 10, 132, 255); // #0a84ff

// Lighten the top half for depth (cheap gradient pass clipped to alpha).
for (let y = 0; y < H; y++) {
  const t = Math.max(0, 1 - y / 150); // brighter near the top
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (img[i + 3] === 0) continue;
    img[i]     = Math.round(img[i] + (46 - img[i]) * 0.45 * t);
    img[i + 1] = Math.round(img[i + 1] + (168 - img[i + 1]) * 0.35 * t);
  }
}

// Three white "text lines" with a shorter last line - reads as selectable text.
const lines = [
  { cy: 92,  hw: 74, hh: 11, r: 11 },
  { cy: 128, hw: 74, hh: 11, r: 11 },
  { cy: 164, hw: 44, hh: 11, r: 11 },
];
for (const L of lines) {
  fill((x, y) => sdRoundRect(x, y, 128, L.cy, L.hw, L.hh, L.r), 255, 255, 255);
}

// Caret block at the end of the short line (text cursor).
fill((x, y) => sdRoundRect(x, y, 192, 164, 8, 14, 4), 255, 255, 255);

fs.mkdirSync(path.join(__dirname, 'build'), { recursive: true });
writePng(path.join(__dirname, 'build', 'icon.png'), W, H, img);
console.log('build/icon.png written');

// Also emit a real Windows .ico with PNG-compressed entries (valid since
// Vista). electron-builder's PNG->ICO converter is a WebAssembly tool that
// crashes with "could not allocate memory" on some machines - pointing it at
// a ready-made icon.ico skips that converter entirely.

// Render the whole icon scene at an arbitrary square size.
function renderAt(size) {
  const s = size / 256; // scale factor from design space
  const buf = Buffer.alloc(size * size * 4);
  const sdRR = (x, y, cx, cy, hw, hh, r) => {
    const qx = Math.abs(x - cx) - (hw - r);
    const qy = Math.abs(y - cy) - (hh - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
  const fill = (sdf, r, g, b) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const a = Math.min(1, Math.max(0, 0.5 - sdf(x + 0.5, y + 0.5)));
        if (a <= 0) continue;
        const i = (y * size + x) * 4;
        buf[i]     = Math.round(buf[i]     * (1 - a) + r * a);
        buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + g * a);
        buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + b * a);
        buf[i + 3] = Math.round(buf[i + 3] * (1 - a) + 255 * a);
      }
    }
  };
  fill((x, y) => sdRR(x, y, size / 2, size / 2, 118 * s, 118 * s, 52 * s), 10, 132, 255);
  const lines = [
    { cy: 92,  hw: 74, hh: 11, r: 11 },
    { cy: 128, hw: 74, hh: 11, r: 11 },
    { cy: 164, hw: 44, hh: 11, r: 11 },
  ];
  for (const L of lines) {
    fill((x, y) => sdRR(x, y, size / 2, L.cy * s, L.hw * s, L.hh * s, L.r * s), 255, 255, 255);
  }
  fill((x, y) => sdRR(x, y, 192 * s, 164 * s, 8 * s, 14 * s, 4 * s), 255, 255, 255);

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    // ICO entries are stored bottom-up
    buf.copy(raw, y * (size * 4 + 1) + 1, (size - 1 - y) * size * 4, (size - y) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Multi-resolution icon: Windows Explorer/taskbar/alt-tab pick the best fit.
(function writeMultiIco() {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const entries = sizes.map(sz => ({ sz, png: renderAt(sz) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dirs = [];
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d[0] = e.sz >= 256 ? 0 : e.sz;
    d[1] = e.sz >= 256 ? 0 : e.sz;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(e.png.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.png.length;
    dirs.push(d);
  }
  fs.writeFileSync(path.join(__dirname, 'build', 'icon.ico'),
    Buffer.concat([header, ...dirs, ...entries.map(e => e.png)]));
  console.log('build/icon.ico written (' + sizes.join(',') + ')');
})();
