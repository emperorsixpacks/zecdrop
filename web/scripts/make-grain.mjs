// Writes public/grain.png: the faint speckle behind the page (src/index.css, body::before).
//
//   node scripts/make-grain.mjs
//
// A 128x128 tile of black pixels whose opacity is one of four levels, drawn from a seeded generator, so the file is the same
// every time it is made and tiles without a seam. It is an indexed PNG with two bits a pixel (a few kilobytes). It is a static
// file of the site's own because the hosted Content-Security-Policy allows no data: image. The stylesheet draws it at 4 percent
// or so over the page, and turns it white after hours.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SIZE = 128;
const ALPHAS = [0, 85, 170, 255];
// How often each level is drawn, as a share of 100.
const SHARES = [40, 25, 20, 15];

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

const random = mulberry32(0x7a3c0d);
const level = () => {
  const roll = random() * 100;
  let sum = 0;
  for (let i = 0; i < SHARES.length; i += 1) {
    sum += SHARES[i];
    if (roll < sum) return i;
  }
  return SHARES.length - 1;
};

// One filter byte (0, none) and then SIZE pixels of two bits each, four to a byte, per row.
const rowBytes = SIZE / 4;
const raw = Buffer.alloc((rowBytes + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  const row = y * (rowBytes + 1);
  for (let x = 0; x < SIZE; x += 4) {
    raw[row + 1 + x / 4] = (level() << 6) | (level() << 4) | (level() << 2) | level();
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 2; // two bits a pixel
header[9] = 3; // indexed colour
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("PLTE", Buffer.alloc(ALPHAS.length * 3)), // every entry black
  chunk("tRNS", Buffer.from(ALPHAS)),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const target = fileURLToPath(new URL("../public/grain.png", import.meta.url));
writeFileSync(target, png);
console.log(`wrote ${target} (${String(png.length)} bytes)`);
