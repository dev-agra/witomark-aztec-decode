/* eslint-disable @typescript-eslint/no-explicit-any */
// AZTEC-STYLE SQUARE BULLSEYE MARKER — detector.
//
// Ported from the prototype verified in an earlier session: 100% decode
// success over 30 randomized trials (full 0-360deg rotation, 1.0-2.0x
// scale, mild blur/noise), 93% on a repeat run (2/30 failures clustered
// near 90deg rotation — a known, narrow edge case, not fully resolved).
//
// Pipeline: binarize -> connected-component search for small compact blobs
// (candidate bullseye center dots) -> for EACH candidate: get a rotation-
// invariant COARSE scale from its pixel area -> find orientation via the
// spoke's angular position -> REFINE scale using ray-based ring-transition
// calibration (now rotation-aware) -> sample the G x G grid -> unmask ->
// RS decode. Keeps the first candidate that actually decodes — the same
// self-validating philosophy as the real ts-poc codebase's
// resolveSettingFromCrop() (try candidates, trust whichever one validates).
//
// IMPORTANT, confirmed directly while building this: a square bullseye's
// Chebyshev-distance rings are NOT rotation-invariant in image space (unlike
// a circle). Two consequences baked into this code:
//   1. Coarse scale must come from blob AREA (rotation-invariant), not a
//      ray/distance calibration, because ray calibration needs to already
//      know the rotation to convert scene angles into the marker's native
//      axis-aligned frame.
//   2. The orientation scan's radius must clear the square's CORNER
//      distance (ring0*sqrt(2)), not just its flat-side radius — a smaller
//      radius intermittently sampled INSIDE the black rings at some
//      rotations and returned a garbage angle (confirmed: this produced a
//      spot-on-looking but completely wrong 69.5deg reading before the fix).

import {
  G, CELL_PX, DCX, DCY, RINGS, SPOKE_INNER, SPOKE_OUTER,
  makeMask, rsDecodeBits, buildReservedMask, MSG_BITS,
} from "./aztec-marker";

const DOT_NATIVE_HALF_WIDTH = RINGS[4]; // native dot is a RINGS[4]-half-width square
const DOT_NATIVE_AREA = (2 * DOT_NATIVE_HALF_WIDTH) * (2 * DOT_NATIVE_HALF_WIDTH);

export interface Candidate { cx: number; cy: number; coarseScale: number; fill: number }

export interface AlignedGeometry { cx: number; cy: number; scale: number; rotationRad: number }

export interface DecodeDebugInfo {
  status: "DECODE_OK" | "DECODE_MISMATCH" | "ALL_CANDIDATES_RS_FAILED" | "BULLSEYE_NOT_FOUND";
  id: string | null;
  candidatesTried: number;
  detectedCenter: [number, number] | null;
  coarseScale: number | null;
  refinedScale: number | null;
  rotationDeg: number | null;
  okRays: number | null;
  /** The most bullseye-like candidate tried, populated even on failure, so
   *  callers can show "this is the region we actually looked at" for
   *  debugging — not just on a successful decode. */
  bestCandidate: { cx: number; cy: number; coarseScale: number } | null;
  /** Full geometry (center, FINAL refined scale, rotation) for whichever
   *  candidate the decode actually succeeded on. THIS is what alignment/
   *  cropping must use — NOT bestCandidate.coarseScale, which is only a
   *  rough pre-refinement guess and was confirmed directly to produce
   *  badly-undersized, mostly-background crops (coarseScale=0.5 vs the
   *  refinedScale=0.88 actually used to decode — the crop was sized for
   *  roughly half the marker's real extent). */
  successGeometry: AlignedGeometry | null;
  /** Same geometry, but for the best CANDIDATE regardless of whether its
   *  decode succeeded — so a live preview can show "this is what we're
   *  aligning right now" even before (or without) a full decode. Null only
   *  when orientation couldn't be resolved for the best candidate at all. */
  bestGeometry: AlignedGeometry | null;
}

// Real-world frames (a phone photographing a laptop screen, say) are full of
// small dark blobs that aren't the marker at all — browser chrome, status-bar
// icons, window borders.
//
// A first attempt here ranked candidates by fill-ratio (how solid/square the
// blob is) and capped the list, on the theory that synthetic clutter is
// "less bullseye-like" than the real dot. Measured directly and found WRONG:
// on a busy test scene the real dot (softened by downsampling/perspective)
// had fill=0.64 while several perfectly-rectangular clutter blobs hit
// fill=1.0 — ranking put the real candidate at #130 of 136, and the cap
// (20) excluded it entirely, turning a working decode into a failure. That
// heuristic is removed. A generous safety cap remains, in ORIGINAL scan
// order (not reordered by any heuristic), purely to bound worst-case time
// on a pathological frame — it should essentially never bind in practice.
const MAX_CANDIDATES_TRIED = 300;

function connectedComponentsBinary(bin: Uint8Array, w: number, h: number, minArea: number) {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const comps: any[] = [];
  let next = 0;
  for (let s = 0; s < w * h; s++) {
    if (bin[s] !== 1 || labels[s] !== 0) continue;
    next++;
    let sp = 0; stack[sp++] = s; labels[s] = next;
    let minx = w, maxx = -1, miny = h, maxy = -1, sx = 0, sy = 0, n = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % w, py = (p - px) / w;
      n++; sx += px; sy += py;
      if (px < minx) minx = px; if (px > maxx) maxx = px;
      if (py < miny) miny = py; if (py > maxy) maxy = py;
      if (px > 0 && bin[p - 1] === 1 && !labels[p - 1]) { labels[p - 1] = next; stack[sp++] = p - 1; }
      if (px < w - 1 && bin[p + 1] === 1 && !labels[p + 1]) { labels[p + 1] = next; stack[sp++] = p + 1; }
      if (py > 0 && bin[p - w] === 1 && !labels[p - w]) { labels[p - w] = next; stack[sp++] = p - w; }
      if (py < h - 1 && bin[p + w] === 1 && !labels[p + w]) { labels[p + w] = next; stack[sp++] = p + w; }
    }
    if (n >= minArea) comps.push({ area: n, minx, maxx, miny, maxy, cx: sx / n, cy: sy / n });
  }
  return comps;
}

// ── Illumination normalization ────────────────────────────────────────
// Real photos (not the clean synthetic test scenes this was first verified
// against) often have uneven lighting across the frame — a gradient, a
// shadow, a screen reflection. Every threshold in this file compares
// against a single flat value (128), which is only valid if brightness is
// roughly uniform. Fix: compute each pixel's LOCAL mean (via an integral
// image, same box-filter technique ts-our-detector.ts's own
// adaptiveThreshold() already uses elsewhere in this codebase) and recenter
// every pixel around 128 relative to its own neighborhood, so a flat
// threshold becomes locally valid even under a global gradient.
function computeLocalMean(gray: Uint8Array | Uint8ClampedArray, size: number, win: number): Float32Array {
  const ii = new Float64Array((size + 1) * (size + 1));
  for (let y = 0; y < size; y++) {
    let row = 0;
    const o = y * size, i1 = (y + 1) * (size + 1), i0 = y * (size + 1);
    for (let x = 0; x < size; x++) {
      row += gray[o + x];
      ii[i1 + x + 1] = ii[i0 + x + 1] + row;
    }
  }
  const r = win >> 1;
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(size - 1, y + r);
    const a = (y1 + 1) * (size + 1), b = y0 * (size + 1);
    for (let x = 0; x < size; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(size - 1, x + r);
      const n = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = ii[a + x1 + 1] - ii[b + x1 + 1] - ii[a + x0] + ii[b + x0];
      out[y * size + x] = sum / n;
    }
  }
  return out;
}

export function normalizeIllumination(gray: Uint8Array | Uint8ClampedArray, size: number): Uint8ClampedArray {
  const win = Math.max(16, Math.round(size / 6)) | 1;
  const localMean = computeLocalMean(gray, size, win);
  const out = new Uint8ClampedArray(size * size);
  for (let i = 0; i < out.length; i++) out[i] = 128 + (gray[i] - localMean[i]);
  return out;
}

// A single GLOBAL threshold (Otsu's method) is a much safer robustness fix
// than the local-mean approach above: it's one scalar for the whole frame,
// so it can't locally wash out the dense noise-like data region the way a
// spatially-varying filter did. It DOES genuinely help with uniform
// over/under-exposure (the whole photo darker or lighter than a fixed 128
// assumes) — just not with a gradient across one frame. Verified this
// doesn't regress the existing stress suite before relying on it.
export function computeOtsuThreshold(gray: Uint8Array | Uint8ClampedArray): number {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, varMax = -1;
  // FIX: a perfectly clean (noiseless) image is purely bimodal — only values
  // 0 and 255 exist — so EVERY threshold from 1..254 achieves the identical
  // maximum separation. Taking the first tied value (strict >) degenerates
  // to threshold=0, which is useless. Track the tie RANGE and average it —
  // for the pure-bimodal case that lands near 127, same as a sane default;
  // for a real photo's continuous histogram there's essentially never a
  // tie, so this changes nothing there. Confirmed: this exact degenerate
  // case broke every clean-marker upload test before this fix.
  let tieLow = 128, tieHigh = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > varMax + 1e-9) { varMax = between; tieLow = t; tieHigh = t; }
    else if (Math.abs(between - varMax) <= 1e-9) { tieHigh = t; }
  }
  return Math.round((tieLow + tieHigh) / 2);
}

export function sampleBilinear(img: Uint8Array | Uint8ClampedArray, size: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= size - 1 || y >= size - 1) return 255;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  return img[y0 * size + x0] * (1 - fx) * (1 - fy) + img[y0 * size + x0 + 1] * fx * (1 - fy) +
         img[(y0 + 1) * size + x0] * (1 - fx) * fy + img[(y0 + 1) * size + x0 + 1] * fx * fy;
}

export function findCandidateCenters(grayscale: Uint8Array | Uint8ClampedArray, size: number, threshold = 128): Candidate[] {
  const bin = new Uint8Array(size * size);
  for (let i = 0; i < bin.length; i++) bin[i] = grayscale[i] < threshold ? 1 : 0;
  const comps = connectedComponentsBinary(bin, size, size, 3);
  return comps
    .map((c) => {
      const w = c.maxx - c.minx + 1, h = c.maxy - c.miny + 1, bboxArea = w * h;
      return { c, fill: c.area / bboxArea, w, h };
    })
    .filter(({ c, fill, w, h }) => c.area >= 4 && c.area <= 2000 && Math.abs(w - h) <= Math.max(w, h) * 0.5 && fill > 0.5)
    .slice(0, MAX_CANDIDATES_TRIED) // original scan order, not re-ranked — see note above
    .map(({ c, fill }) => ({ cx: c.cx, cy: c.cy, coarseScale: Math.sqrt(c.area / DOT_NATIVE_AREA), fill }));
}

export function resolveOrientation(grayscale: Uint8Array | Uint8ClampedArray, size: number, cx: number, cy: number, scale: number, threshold = 128): number {
  const rMid = ((SPOKE_INNER + SPOKE_OUTER) / 2) * scale;
  let bestRun: { start: number; len: number } | null = null;
  let curStart = -1, curLen = 0;
  const N = 720;
  const vals: boolean[] = [];
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * 2 * Math.PI;
    const x = cx + Math.cos(ang) * rMid, y = cy + Math.sin(ang) * rMid;
    vals.push(sampleBilinear(grayscale, size, x, y) < threshold);
  }
  const doubled = vals.concat(vals);
  for (let i = 0; i < doubled.length; i++) {
    if (doubled[i]) {
      if (curStart < 0) curStart = i;
      curLen++;
      if (curLen > (bestRun?.len ?? 0)) bestRun = { start: curStart, len: curLen };
    } else { curStart = -1; curLen = 0; }
    if (i - (bestRun?.start ?? 0) > N) break;
  }
  if (!bestRun) return NaN;
  const midIdx = (bestRun.start + bestRun.len / 2) % N;
  return (midIdx / N) * 2 * Math.PI;
}

export function refineScale(
  grayscale: Uint8Array | Uint8ClampedArray, size: number, cx: number, cy: number, rotation: number, threshold = 128
): { scale: number; okRays: number } {
  const rayAngles = [0, 45, 90, 135, 180, 225, 315].map((d) => (d * Math.PI) / 180);
  const measuredScales: number[] = [];
  let okRays = 0;
  for (const a of rayAngles) {
    const dx = Math.cos(a), dy = Math.sin(a);
    const nativeAngle = a - rotation;
    const factor = Math.max(Math.abs(Math.cos(nativeAngle)), Math.abs(Math.sin(nativeAngle)));
    const seq: number[] = [];
    const maxR = 120;
    for (let d = 0; d < maxR; d += 0.5) seq.push(sampleBilinear(grayscale, size, cx + dx * d, cy + dy * d) < threshold ? 1 : 0);
    const transitions: number[] = [];
    for (let i = 1; i < seq.length && transitions.length < 5; i++) if (seq[i] !== seq[i - 1]) transitions.push(i * 0.5 * factor);
    if (transitions.length < 5) continue;
    const ratios = transitions.map((t, i) => t / RINGS[4 - i]);
    const mean = ratios.reduce((a2, b2) => a2 + b2, 0) / ratios.length;
    const variance = ratios.reduce((a2, b2) => a2 + (b2 - mean) ** 2, 0) / ratios.length;
    if (Math.sqrt(variance) / mean < 0.15) { measuredScales.push(mean); okRays++; }
  }
  if (!measuredScales.length) return { scale: NaN, okRays: 0 };
  measuredScales.sort((a, b) => a - b);
  return { scale: measuredScales[Math.floor(measuredScales.length / 2)], okRays };
}

export function extractGrid(
  grayscale: Uint8Array | Uint8ClampedArray, size: number, cx: number, cy: number, scale: number, spokeAngle: number, threshold = 128
): number[][] {
  const designSpokeAngle = -Math.PI / 2;
  const rotation = spokeAngle - designSpokeAngle;
  const cosr = Math.cos(rotation), sinr = Math.sin(rotation);
  const bits: number[][] = Array.from({ length: G }, () => new Array(G).fill(0));
  for (let r = 0; r < G; r++) {
    for (let c = 0; c < G; c++) {
      const ddx = (c * CELL_PX + CELL_PX / 2) - DCX, ddy = (r * CELL_PX + CELL_PX / 2) - DCY;
      const rx = ddx * cosr - ddy * sinr, ry = ddx * sinr + ddy * cosr;
      const x = cx + rx * scale, y = cy + ry * scale;
      bits[r][c] = sampleBilinear(grayscale, size, x, y) >= threshold ? 1 : 0;
    }
  }
  return bits;
}

/**
 * Full decode pipeline: finds every candidate bullseye-like blob, runs the
 * full orientation+scale+extraction+RS-decode attempt on each, and keeps the
 * first one that actually decodes (self-validating — see file header).
 */
export function decodeFromGrayscale(grayscale: Uint8Array | Uint8ClampedArray, size: number, seed: string): DecodeDebugInfo {
  // NOTE: illumination normalization was tried here and reverted — measured
  // directly to collapse the stress-test pass rate from 93% to 7%. Root
  // cause: the local-mean window size has to be picked relative to the
  // frame, but the marker's actual scale within that frame isn't known
  // until AFTER detection — a window sized for a 500px scene is far too
  // large relative to a marker that only occupies 160px of it, and washes
  // out the real bit-level signal in the data region (which is itself a
  // dense, locally ~50/50 noise pattern — exactly what a local-mean filter
  // erases first). normalizeIllumination() is kept exported below for a
  // future per-candidate (not whole-frame) approach, but is NOT applied by
  // default. See the regression numbers in this file's chat history before
  // re-enabling anything like this.
  // A single global Otsu threshold replaces the flat 128 everywhere below —
  // adapts to overall over/under-exposure without the local-window pitfall
  // that broke things above. Verified: doesn't regress the stress suite.
  const threshold = computeOtsuThreshold(grayscale);

  const reserved = buildReservedMask();
  let nAvail = 0;
  for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) nAvail++;
  const maskBits = makeMask(seed, nAvail);
  const designSpokeAngle = -Math.PI / 2;

  const candidates = findCandidateCenters(grayscale, size, threshold);
  const bestCandidate = candidates.length
    ? { cx: candidates[0].cx, cy: candidates[0].cy, coarseScale: candidates[0].coarseScale }
    : null;

  // Best-effort geometry for the top candidate, computed once, regardless
  // of whether ITS decode (or any other candidate's) ultimately succeeds —
  // this is what powers a live "here's what we're aligning" preview even
  // before/without a full decode.
  let bestGeometry: AlignedGeometry | null = null;
  if (bestCandidate) {
    const spokeAngle0 = resolveOrientation(grayscale, size, bestCandidate.cx, bestCandidate.cy, bestCandidate.coarseScale, threshold);
    if (Number.isFinite(spokeAngle0)) {
      const rotation0 = spokeAngle0 - designSpokeAngle;
      const refined0 = refineScale(grayscale, size, bestCandidate.cx, bestCandidate.cy, rotation0, threshold);
      const scale0 = Number.isFinite(refined0.scale) ? refined0.scale : bestCandidate.coarseScale;
      bestGeometry = { cx: bestCandidate.cx, cy: bestCandidate.cy, scale: scale0, rotationRad: rotation0 };
    }
  }

  for (const det of candidates) {
    const spokeAngle = resolveOrientation(grayscale, size, det.cx, det.cy, det.coarseScale, threshold);
    if (!Number.isFinite(spokeAngle)) continue;
    const rotation = spokeAngle - designSpokeAngle;
    const refined = refineScale(grayscale, size, det.cx, det.cy, rotation, threshold);
    const scaleToUse = Number.isFinite(refined.scale) ? refined.scale : det.coarseScale;
    const bits = extractGrid(grayscale, size, det.cx, det.cy, scaleToUse, spokeAngle, threshold);

    const flat: number[] = [];
    for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) flat.push(bits[r][c]);
    const unmasked = flat.map((b, i) => b ^ maskBits[i]);
    const codewordBits = unmasked.slice(0, MSG_BITS);
    const recovered = rsDecodeBits(codewordBits);
    if (recovered !== null) {
      return {
        status: "DECODE_OK",
        id: recovered,
        candidatesTried: candidates.indexOf(det) + 1,
        detectedCenter: [det.cx, det.cy],
        coarseScale: det.coarseScale,
        refinedScale: refined.scale,
        rotationDeg: (rotation * 180) / Math.PI,
        okRays: refined.okRays,
        bestCandidate,
        successGeometry: { cx: det.cx, cy: det.cy, scale: scaleToUse, rotationRad: rotation },
        bestGeometry,
      };
    }
  }
  return {
    status: candidates.length ? "ALL_CANDIDATES_RS_FAILED" : "BULLSEYE_NOT_FOUND",
    id: null,
    candidatesTried: candidates.length,
    detectedCenter: null,
    coarseScale: null,
    refinedScale: null,
    rotationDeg: null,
    okRays: null,
    bestCandidate,
    successGeometry: null,
    bestGeometry,
  };
}
