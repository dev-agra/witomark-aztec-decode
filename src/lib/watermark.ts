// SQR-style DCT watermark, ported from sentinel-main's
// fingerprints/fingerprint_generators/sqr_generator.py (and the witomark
// frontend's lib/dct-fingerprint.ts + lib/watermark-scan/core.ts for the
// reader side). Independent of the marker code on purpose — it only knows
// about 8x8 blocks, so aztec-marker.ts can call it without a circular import.
//
// Scheme, per 8x8 block (one block per marker cell, row-major):
//   F = DCT(block); pair = (c1, c2) = coefficients (3,1) and (1,3)
//   avg = (F[c1] + F[c2]) / 2
//   bit 1: F[c1] = avg + strength/2, F[c2] = avg - strength/2
//   bit 0: F[c1] = avg - strength/2, F[c2] = avg + strength/2
//   block = IDCT(F), clipped to 0..255
// Reading: F[c1] > F[c2] -> 1. A relative-order test, so no gray-level cutoff.
//
// Bits: mulberry32(crc32(id)), `rand() < 0.5 ? 1 : 0` — the same as SQR, so a
// given ID produces the same bit string here as in the SQR backend.
//
// One deliberate difference: the final conversion uses rounding, where the
// SQR Python code truncates (astype(uint8)). On white modules the pattern is
// exactly 0 along the block diagonal, so truncation turns floating-point
// noise there into an arbitrary 255/254. The gray-level difference is at most
// 1 and never flips a bit.

export const WM_BLOCK = 8;
export const DEFAULT_WM_STRENGTH = 120;

export type CoeffPair = [[number, number], [number, number]];
export const DEFAULT_WM_PAIR: CoeffPair = [[3, 1], [1, 3]];

/** Named pairs seen in the SQR / QR Fingerprint code, for the generator's picker. [u, v]: u = vertical frequency, v = horizontal. */
export const WM_PAIR_PRESETS: { name: string; pair: CoeffPair }[] = [
  { name: "SQR default (3,1)/(1,3)", pair: [[3, 1], [1, 3]] },
  { name: "Level 1 (1,0)/(0,1)", pair: [[1, 0], [0, 1]] },
  { name: "Level 2 (2,1)/(1,2)", pair: [[2, 1], [1, 2]] },
  { name: "Level 3 (3,2)/(2,3)", pair: [[3, 2], [2, 3]] },
];

export function samePair(a: CoeffPair, b: CoeffPair): boolean {
  return a[0][0] === b[0][0] && a[0][1] === b[0][1] && a[1][0] === b[1][0] && a[1][1] === b[1][1];
}

/** null when usable; otherwise why not. The DC term carries the block's brightness, so it can't hold a bit. */
export function validatePair(pair: CoeffPair): string | null {
  for (const [u, v] of pair) {
    if (!Number.isInteger(u) || !Number.isInteger(v) || u < 0 || u >= WM_BLOCK || v < 0 || v >= WM_BLOCK) return "coefficients must be 0-7";
    if (u === 0 && v === 0) return "(0,0) is the DC term and cannot carry a bit";
  }
  if (pair[0][0] === pair[1][0] && pair[0][1] === pair[1][1]) return "the two coefficients must differ";
  return null;
}

// ── seed -> bits ──────────────────────────────────────────────────────────
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Standard CRC-32 (IEEE) over the UTF-8 bytes — same as Python's zlib.crc32. */
export function crc32(str: string): number {
  let c = 0xffffffff;
  for (const b of new TextEncoder().encode(str)) c = CRC32_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The expected watermark bits for an ID: mulberry32(crc32(id)). */
export function watermarkBits(id: string, count: number): number[] {
  const rnd = mulberry32(crc32(id));
  const bits: number[] = new Array(count);
  for (let i = 0; i < count; i++) bits[i] = rnd() < 0.5 ? 1 : 0;
  return bits;
}

// ── 8x8 orthonormal DCT-II (matches scipy.fftpack.dct norm="ortho") ────────
// M[k][n] = sqrt(2/N) * c(k) * cos(pi*(2n+1)*k / 2N), c(0) = 1/sqrt(2)
const N = WM_BLOCK;
const M: Float64Array[] = Array.from({ length: N }, (_, k) =>
  Float64Array.from({ length: N }, (_, n) => Math.sqrt(2 / N) * (k === 0 ? Math.SQRT1_2 : 1) * Math.cos((Math.PI * (2 * n + 1) * k) / (2 * N))),
);

// F[u][v] = sum_{r,c} B[r][c] M[u][r] M[v][c]   (u vertical, v horizontal)
function dct2(B: Float64Array): Float64Array {
  const T = new Float64Array(N * N); // T = M * B
  for (let u = 0; u < N; u++) for (let c = 0; c < N; c++) {
    let s = 0;
    for (let r = 0; r < N; r++) s += M[u][r] * B[r * N + c];
    T[u * N + c] = s;
  }
  const F = new Float64Array(N * N); // F = T * M^T
  for (let u = 0; u < N; u++) for (let v = 0; v < N; v++) {
    let s = 0;
    for (let c = 0; c < N; c++) s += T[u * N + c] * M[v][c];
    F[u * N + v] = s;
  }
  return F;
}

// B = M^T F M
function idct2(F: Float64Array): Float64Array {
  const T = new Float64Array(N * N); // T = M^T * F
  for (let r = 0; r < N; r++) for (let v = 0; v < N; v++) {
    let s = 0;
    for (let u = 0; u < N; u++) s += M[u][r] * F[u * N + v];
    T[r * N + v] = s;
  }
  const B = new Float64Array(N * N); // B = T * M
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    let s = 0;
    for (let v = 0; v < N; v++) s += T[r * N + v] * M[v][c];
    B[r * N + c] = s;
  }
  return B;
}

/**
 * Embed one bit per 8x8 block (row-major) into a grayscale image.
 * `size` is the side in px (a multiple of 8); returns a new Uint8Array.
 */
export function embedWatermark(
  pixels: ArrayLike<number>, size: number, bits: ArrayLike<number>,
  strength: number = DEFAULT_WM_STRENGTH, pairs: CoeffPair[] = [DEFAULT_WM_PAIR],
): Uint8Array {
  if (size % WM_BLOCK !== 0) throw new Error(`watermark: size ${size} is not a multiple of ${WM_BLOCK}`);
  const per = size / WM_BLOCK;
  if (bits.length < per * per) throw new Error(`watermark: need ${per * per} bits, got ${bits.length}`);
  const out = new Uint8Array(size * size);
  const block = new Float64Array(N * N);
  for (let idx = 0; idx < per * per; idx++) {
    const y0 = Math.floor(idx / per) * WM_BLOCK, x0 = (idx % per) * WM_BLOCK;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) block[y * N + x] = pixels[(y0 + y) * size + (x0 + x)];
    const F = dct2(block);
    for (const [[u1, v1], [u2, v2]] of pairs) {
      const avg = (F[u1 * N + v1] + F[u2 * N + v2]) / 2;
      if (bits[idx] === 1) { F[u1 * N + v1] = avg + strength / 2; F[u2 * N + v2] = avg - strength / 2; }
      else { F[u1 * N + v1] = avg - strength / 2; F[u2 * N + v2] = avg + strength / 2; }
    }
    const B = idct2(F);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      out[(y0 + y) * size + (x0 + x)] = Math.max(0, Math.min(255, Math.round(B[y * N + x])));
    }
  }
  return out;
}

/** Read one bit per 8x8 block (row-major) from a grayscale image of side `size`. */
export function extractWatermarkBits(gray: ArrayLike<number>, size: number, pair: CoeffPair = DEFAULT_WM_PAIR): number[] {
  const per = Math.floor(size / WM_BLOCK);
  const bits: number[] = new Array(per * per);
  const block = new Float64Array(N * N);
  const [[u1, v1], [u2, v2]] = pair;
  for (let idx = 0; idx < per * per; idx++) {
    const y0 = Math.floor(idx / per) * WM_BLOCK, x0 = (idx % per) * WM_BLOCK;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) block[y * N + x] = gray[(y0 + y) * size + (x0 + x)];
    const F = dct2(block);
    bits[idx] = F[u1 * N + v1] > F[u2 * N + v2] ? 1 : 0;
  }
  return bits;
}

/** Bit error rate in percent, as the SQR backend reports it (0 = identical, ~50 = unrelated). */
export function berPercent(expected: ArrayLike<number>, got: ArrayLike<number>): number {
  const len = Math.min(expected.length, got.length);
  if (len === 0) return 100;
  let diff = 0;
  for (let i = 0; i < len; i++) if (expected[i] !== got[i]) diff++;
  return (diff / len) * 100;
}
