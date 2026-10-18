// Иконки PWA (галочка на бирюзовом) → public/icon-{180,192,512}.png. Запуск: node apps/pwa/scripts/icons.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const BG = [0x0f, 0x76, 0x6e];
const FG = [0xff, 0xff, 0xff];
/** Галочка в долях стороны: в центральных 60% — переживает маску Android (maskable). */
const CHECK: [number, number][] = [
  [0.3, 0.52],
  [0.44, 0.66],
  [0.71, 0.37],
];
const STROKE = 0.09;

function distToSegment(px: number, py: number, a: [number, number], b: [number, number]): number {
  const [ax, ay] = a;
  const [bx, by] = b;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2),
    ),
  );
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size: number): Buffer {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / size;
      const py = (y + 0.5) / size;
      let d = Number.POSITIVE_INFINITY;
      for (let i = 1; i < CHECK.length; i++) {
        const a = CHECK[i - 1];
        const b = CHECK[i];
        if (a && b) d = Math.min(d, distToSegment(px, py, a, b));
      }
      // Сглаживание края — полпикселя.
      const alpha = Math.max(0, Math.min(1, (STROKE / 2 - d) * size + 0.5));
      for (let c = 0; c < 3; c++) {
        raw[row + 1 + x * 3 + c] = Math.round((BG[c] ?? 0) * (1 - alpha) + (FG[c] ?? 0) * alpha);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = join(import.meta.dirname, '../public');
for (const size of [180, 192, 512]) writeFileSync(join(out, `icon-${size}.png`), png(size));
console.log(`иконки → ${out}`);
