'use strict';

// ينشئ أيقونة التطبيق (PNG مضمّن داخل ICO) دون أي تبعيات خارجية.
// التشغيل: node tools/make-icon.js

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, checksum]);
}

function png(width, height, pixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function hex(value) {
  const text = value.replace('#', '');
  return [parseInt(text.slice(0, 2), 16), parseInt(text.slice(2, 4), 16), parseInt(text.slice(4, 6), 16)];
}

function mix(a, b, amount) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * amount),
    Math.round(a[1] + (b[1] - a[1]) * amount),
    Math.round(a[2] + (b[2] - a[2]) * amount)
  ];
}

function roundedRectangle(x, y, left, top, right, bottom, radius) {
  const dx = Math.max(left + radius - x, 0, x - (right - radius));
  const dy = Math.max(top + radius - y, 0, y - (bottom - radius));
  return Math.sqrt(dx * dx + dy * dy) <= radius;
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, lengthSquared ? ((px - ax) * dx + (py - ay) * dy) / lengthSquared : 0));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function draw() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const navy = hex('#173f5f');
  const teal = hex('#2aa198');
  const light = hex('#eaf7f5');
  const check = [[78, 136], [116, 174], [186, 92]];
  const thickness = 13;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const offset = (y * SIZE + x) * 4;
      const insideOuter = roundedRectangle(x, y, 8, 8, 248, 248, 52);
      if (!insideOuter) {
        pixels[offset + 3] = 0;
        continue;
      }
      // خلفية متدرجة من الكحلي إلى الفيروزي.
      const gradient = Math.min(1, Math.max(0, (x + y) / (SIZE * 2)));
      let color = mix(navy, teal, gradient * 0.65);
      // قرص داخلي فاتح خلف علامة الصح.
      const distance = Math.hypot(x - 128, y - 134);
      if (distance <= 78) color = mix(color, light, 0.14);
      if (distance > 74 && distance <= 78) color = mix(color, light, 0.28);
      // علامة صح بيضاء.
      const onCheck = Math.min(
        segmentDistance(x, y, check[0][0], check[0][1], check[1][0], check[1][1]),
        segmentDistance(x, y, check[1][0], check[1][1], check[2][0], check[2][1])
      );
      if (onCheck <= thickness) color = [255, 255, 255];
      else if (onCheck <= thickness + 2) color = mix(color, [255, 255, 255], 0.4);
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = 255;
    }
  }
  return png(SIZE, SIZE, pixels);
}

function ico(image) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0; // 256 بكسل
  entry[1] = 0; // 256 بكسل
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(image.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, image]);
}

function main() {
  const out = path.resolve(__dirname, '..', 'build');
  fs.mkdirSync(out, { recursive: true });
  const image = draw();
  fs.writeFileSync(path.join(out, 'icon.png'), image);
  fs.writeFileSync(path.join(out, 'icon.ico'), ico(image));
  process.stdout.write('icon.png و icon.ico تم إنشاؤهما في ' + out + '\n');
}

main();
