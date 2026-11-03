#!/usr/bin/env node
/*
 * Packs Markus Lipp's UniverseVR beta (a Windows / Oculus DK2 build) into web assets that
 * universe-vr.html renders with three.js + WebXR.
 *
 *   node tools/pack-universe-vr.mjs "vr/UniverseVR beta" [out-dir = vr/universe-vr]
 *
 * What gets packed:
 *   - galaxies.bin  849,274 Millennium Simulation galaxies as float32 {x, y, z, w}, the box in
 *                   [-0.5, 0.5]^3 and w (0.05–1) the brightness the sprites are tinted by.
 *                   Re-quantised to uint16 × 4 (8 bytes a galaxy, half the size; error ≈ 1.5e-5 box).
 *   - sprite.DDS    512² BGRA galaxy sprite (mip 0)      -> sprite.png
 *   - gradient.DDS  1024×128 BGRA colour ramp (one row)  -> gradient.png (1024×1)
 *   - music.mp3     copied as-is (Eric Matyas, soundimage.org)
 * keyboard.dds (the DK2 help card) is not needed: the page has its own HUD.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [src, out = 'vr/universe-vr'] = process.argv.slice(2);
if (!src) {
    console.error('usage: node tools/pack-universe-vr.mjs <UniverseVR dir> [out-dir]');
    process.exit(1);
}
fs.mkdirSync(out, { recursive: true });

// ─── Galaxies ───────────────────────────────────────────────────────────────
const raw = fs.readFileSync(path.join(src, 'galaxies.bin'));
const f = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
const n = f.length / 4;
const q = new Uint16Array(n * 4);
for (let i = 0; i < n * 4; i++) {
    const v = (i & 3) === 3 ? f[i] : f[i] + 0.5;           // positions shift to [0, 1]; w already is
    q[i] = Math.round(Math.min(1, Math.max(0, v)) * 65535);
}
fs.writeFileSync(path.join(out, 'galaxies.u16'), Buffer.from(q.buffer));
console.log(`galaxies.u16  ${n} galaxies`);

// ─── DDS (uncompressed 32-bit BGRA only — what UniverseVR ships) -> PNG ─────
function readDDS(file) {
    const b = fs.readFileSync(file);
    if (b.toString('ascii', 0, 4) !== 'DDS ') throw new Error(`${file}: not a DDS`);
    const height = b.readUInt32LE(12), width = b.readUInt32LE(16);
    const bits = b.readUInt32LE(88), rMask = b.readUInt32LE(92);
    if (bits !== 32 || rMask !== 0xff0000) throw new Error(`${file}: expected 32-bit BGRA`);
    const px = b.subarray(128, 128 + width * height * 4);
    const rgba = Buffer.alloc(px.length);
    for (let i = 0; i < px.length; i += 4) {
        rgba[i] = px[i + 2]; rgba[i + 1] = px[i + 1]; rgba[i + 2] = px[i]; rgba[i + 3] = px[i + 3];
    }
    return { width, height, rgba };
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc32 = buf => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};
function png(width, height, rgba) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6;                                 // 8-bit RGBA
    const rows = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
    ]);
}

const sprite = readDDS(path.join(src, 'sprite.DDS'));
fs.writeFileSync(path.join(out, 'sprite.png'), png(sprite.width, sprite.height, sprite.rgba));
console.log(`sprite.png    ${sprite.width}×${sprite.height}`);

const gradient = readDDS(path.join(src, 'gradient.dds'));
const row = gradient.rgba.subarray(0, gradient.width * 4);   // the ramp is constant down its height
fs.writeFileSync(path.join(out, 'gradient.png'), png(gradient.width, 1, Buffer.from(row)));
console.log(`gradient.png  ${gradient.width}×1`);

fs.copyFileSync(path.join(src, 'music.mp3'), path.join(out, 'music.mp3'));
console.log('music.mp3     copied');
