// Watermark verification: align a capture to the clean marker (rendered from
// the decoded ID), read the DCT watermark bits, and report the BER against the
// bits expected for that ID.
//
// Why a separate fine alignment: the watermark only reads when the 8x8 DCT
// blocks sit on the marker's cells to within ~0.5 px (measured: 1 px shift
// -> 17% BER, 2 px -> 77%, 2% scale error -> 24%), while the decoder's own
// geometry is good to ~0.1-0.3 cell and its scale was off by 6-10% on some
// real captures. SQR does the same thing: ECC-align the capture to a clean
// reference before the DCT readout.
//
// The solver is the forward-additive ECC affine solve from witomark's
// ecc-align-js.ts, rewritten to work on plain arrays (no canvas) and run
// coarse-to-fine: the reference has crisp 8px cells, whose edges make the
// correlation surface full of local optima at multiples of a cell, so the
// early levels blur both images heavily to widen the basin.
//
// The capture is sampled ONCE, through the composed (similarity o affine)
// transform. Warping first and then re-warping would interpolate twice and
// smooth exactly the fine pattern being read.

import { S, G, renderMarker } from "./aztec-marker";
import { sampleBilinear } from "./aztec-detector";
import { extractWatermarkBits, watermarkBits, berPercent, DEFAULT_WM_PAIR, type CoeffPair } from "./watermark";

export interface WmGeometry { cx: number; cy: number; scale: number; rotationRad: number }

export interface WmReading {
  /** Percent of the 400 watermark bits that differ from the ID's expected bits; null when not readable. */
  ber: number | null;
  /** Correlation between the aligned capture and the clean marker (1 = identical). */
  rho: number | null;
  usable: boolean;
  /** Why it wasn't readable, when `usable` is false. */
  reason?: string;
  /** Marker size in the capture, px per cell (the watermark needs ~8+). */
  pxPerCell: number;
  iterations: number;
  ms: number;
}

// Below this the pattern (period ~5 px at 8 px/cell) is under-sampled and the BER means nothing.
export const WM_MIN_PX_PER_CELL = 5;
// ECC's correlation after convergence; the SQR frontend accepts down to 0.5 for printed codes.
export const WM_MIN_RHO = 0.5;

// ── small array helpers ────────────────────────────────────────────────────
function gaussKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

function blur(src: Float32Array, W: number, H: number, sigma: number): Float32Array {
  const k = gaussKernel(sigma), r = (k.length - 1) / 2;
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += k[i + r] * src[y * W + Math.min(W - 1, Math.max(0, x + i))];
    tmp[y * W + x] = s;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(H - 1, Math.max(0, y + i)) * W + x];
    out[y * W + x] = s;
  }
  return out;
}

function normalize(v: Float32Array): { u: Float32Array; norm: number } {
  const n = v.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += v[i];
  mean /= n;
  const u = new Float32Array(n);
  let n2 = 0;
  for (let i = 0; i < n; i++) { u[i] = v[i] - mean; n2 += u[i] * u[i]; }
  const norm = Math.sqrt(n2);
  if (norm < 1e-12) return { u, norm: 0 };
  for (let i = 0; i < n; i++) u[i] /= norm;
  return { u, norm };
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// out[y,x] = img(p0*x + p1*y + p2, p3*x + p4*y + p5), bilinear, zero outside
function warpAffine(img: Float32Array, W: number, H: number, p: number[]): Float32Array {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = p[0] * x + p[1] * y + p[2], sy = p[3] * x + p[4] * y + p[5];
    if (sx < 0 || sy < 0 || sx >= W - 1 || sy >= H - 1) continue;
    const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
    out[y * W + x] = img[y0 * W + x0] * (1 - fx) * (1 - fy) + img[y0 * W + x0 + 1] * fx * (1 - fy) + img[(y0 + 1) * W + x0] * (1 - fx) * fy + img[(y0 + 1) * W + x0 + 1] * fx * fy;
  }
  return out;
}

function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// one forward-additive ECC step; returns the updated params, the current correlation, and the step size
function eccStep(Tn: Float32Array, test: Float32Array, W: number, H: number, p: number[]): { p: number[]; rho: number; delta: number } | null {
  const n = W * H;
  const Iw = warpAffine(test, W, H, p);
  const { u: In, norm } = normalize(Iw);
  if (norm < 1e-10) return null;
  const gx = new Float32Array(n), gy = new Float32Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    gx[i] = (Iw[y * W + Math.min(W - 1, x + 1)] - Iw[y * W + Math.max(0, x - 1)]) * 0.5 / norm;
    gy[i] = (Iw[Math.min(H - 1, y + 1) * W + x] - Iw[Math.max(0, y - 1) * W + x]) * 0.5 / norm;
  }
  const J: Float32Array[] = Array.from({ length: 6 }, () => new Float32Array(n));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    J[0][i] = gx[i] * x; J[1][i] = gx[i] * y; J[2][i] = gx[i];
    J[3][i] = gy[i] * x; J[4][i] = gy[i] * y; J[5][i] = gy[i];
  }
  const rho = dot(Tn, In);
  const JtT = J.map((c) => dot(c, Tn)), JtI = J.map((c) => dot(c, In));
  const Hm: number[][] = [];
  for (let k = 0; k < 6; k++) { const row: number[] = []; for (let l = 0; l < 6; l++) row.push(dot(J[k], J[l]) - JtI[k] * JtI[l]); Hm.push(row); }
  const dp = solve(Hm, JtT.map((v, k) => v - rho * JtI[k]));
  if (!dp) return null;
  let d2 = 0;
  for (let k = 0; k < 6; k++) d2 += dp[k] * dp[k];
  return { p: p.map((v, k) => v + dp[k]), rho, delta: Math.sqrt(d2) };
}

// ── clean reference, cached per (id, seed) ─────────────────────────────────
const refCache = new Map<string, Float32Array>();
function cleanReference(id: string, seed: string): Float32Array {
  const key = `${id}|${seed}`;
  let r = refCache.get(key);
  if (!r) {
    const px = renderMarker(id, seed).pixels; // un-watermarked
    r = new Float32Array(S * S);
    for (let i = 0; i < r.length; i++) r[i] = px[i] / 255;
    if (refCache.size > 16) refCache.clear();
    refCache.set(key, r);
  }
  return r;
}

const SIGMAS = [4, 2, 1];
const MAX_ITER_PER_LEVEL = 25;
const EPS = 1e-3;

/**
 * Align `gray` (side `width`, any height) to the clean marker for `id`, starting from the decoder's
 * geometry, and read the watermark. `geometry` is in the pixel space of `gray`.
 */
export function verifyWatermark(
  gray: Uint8Array | Uint8ClampedArray, width: number, geometry: WmGeometry, id: string, seed: string,
  pair: CoeffPair = DEFAULT_WM_PAIR,
): WmReading {
  const t0 = performance.now();
  const pxPerCell = geometry.scale * 8;
  const fail = (reason: string, rho: number | null = null, iterations = 0): WmReading =>
    ({ ber: null, rho, usable: false, reason, pxPerCell, iterations, ms: performance.now() - t0 });
  if (pxPerCell < WM_MIN_PX_PER_CELL) return fail(`marker too small for the watermark (${pxPerCell.toFixed(1)} px/cell, need ${WM_MIN_PX_PER_CELL}+)`);

  const cos = Math.cos(geometry.rotationRad), sin = Math.sin(geometry.rotationRad);
  // canonical pixel (x, y) -> scene point; (u, v) are pixel-centre offsets from the marker centre
  const toScene = (xi: number, yi: number): [number, number] => {
    const u = xi + 0.5 - S / 2, v = yi + 0.5 - S / 2;
    return [geometry.cx + (u * cos - v * sin) * geometry.scale, geometry.cy + (u * sin + v * cos) * geometry.scale];
  };

  // capture warped onto the canonical grid by the decoder's geometry (0..1)
  const test0 = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const [sx, sy] = toScene(x, y); test0[y * S + x] = sampleBilinear(gray, width, sx, sy) / 255; }

  const ref = cleanReference(id, seed);
  let p = [1, 0, 0, 0, 1, 0], rho = 0, iterations = 0;
  for (const sigma of SIGMAS) {
    const Tn = normalize(blur(ref, S, S, sigma)).u;
    const test = blur(test0, S, S, sigma);
    for (let it = 0; it < MAX_ITER_PER_LEVEL; it++) {
      const r = eccStep(Tn, test, S, S, p);
      if (!r) return fail("alignment solve failed", rho, iterations);
      p = r.p; rho = r.rho; iterations++;
      if (r.delta < EPS && it > 1) break;
    }
  }
  const det = p[0] * p[4] - p[1] * p[3];
  if (det <= 0.5 || det > 2 || Math.abs(p[0] - 1) > 0.3 || Math.abs(p[4] - 1) > 0.3 || Math.abs(p[2]) > 24 || Math.abs(p[5]) > 24) {
    return fail("alignment drifted (implausible transform)", rho, iterations);
  }
  if (rho < WM_MIN_RHO) return fail(`alignment correlation too low (ρ ${rho.toFixed(2)})`, rho, iterations);

  // final sampling straight from the capture through the composed transform
  const fin = new Float64Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const [sx, sy] = toScene(p[0] * x + p[1] * y + p[2], p[3] * x + p[4] * y + p[5]);
    fin[y * S + x] = sampleBilinear(gray, width, sx, sy);
  }
  const ber = berPercent(watermarkBits(id, G * G), extractWatermarkBits(fin, S, pair));
  return { ber, rho, usable: true, pxPerCell, iterations, ms: performance.now() - t0 };
}
