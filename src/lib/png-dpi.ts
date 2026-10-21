// Writes a pHYs chunk (pixel density) into a PNG so a downloaded marker prints
// at its design physical size — canvas.toDataURL() produces no DPI metadata.
// The SQR backend does the same (PIL save(..., dpi=...)).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Bytes(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Returns the PNG bytes with a pHYs chunk for `dpi` inserted right after IHDR (replacing any existing one). */
export function pngWithDpi(png: Uint8Array, dpi: number): Uint8Array {
  const sig = 8;
  if (png.length < 33 || png[0] !== 0x89 || png[1] !== 0x50) throw new Error("not a PNG");
  const ihdrEnd = sig + 8 + 13 + 4; // length+type, 13 data bytes, crc
  const ppm = Math.round(dpi / 0.0254); // pixels per metre

  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1; // unit: metre
  dv.setUint32(17, crc32Bytes(chunk.subarray(4, 17)));

  // drop an existing pHYs, keep everything else
  const parts: Uint8Array[] = [png.subarray(0, ihdrEnd), chunk];
  let pos = ihdrEnd;
  const pdv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  while (pos + 12 <= png.length) {
    const len = pdv.getUint32(pos);
    const type = String.fromCharCode(png[pos + 4], png[pos + 5], png[pos + 6], png[pos + 7]);
    const end = pos + 12 + len;
    if (type !== "pHYs") parts.push(png.subarray(pos, end));
    pos = end;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const bin = atob(dataUrl.split(",")[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
