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

export function sampleBilinear(img: Uint8Array | Uint8ClampedArray, size: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= size - 1 || y >= size - 1) return 255;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  return img[y0 * size + x0] * (1 - fx) * (1 - fy) + img[y0 * size + x0 + 1] * fx * (1 - fy) +
         img[(y0 + 1) * size + x0] * (1 - fx) * fy + img[(y0 + 1) * size + x0 + 1] * fx * fy;
}

export function findCandidateCenters(grayscale: Uint8Array | Uint8ClampedArray, size: number): Candidate[] {
  const bin = new Uint8Array(size * size);
  for (let i = 0; i < bin.length; i++) bin[i] = grayscale[i] < 128 ? 1 : 0;
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

export function resolveOrientation(grayscale: Uint8Array | Uint8ClampedArray, size: number, cx: number, cy: number, scale: number): number {
  const rMid = ((SPOKE_INNER + SPOKE_OUTER) / 2) * scale;
  let bestRun: { start: number; len: number } | null = null;
  let curStart = -1, curLen = 0;
  const N = 720;
  const vals: boolean[] = [];
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * 2 * Math.PI;
    const x = cx + Math.cos(ang) * rMid, y = cy + Math.sin(ang) * rMid;
    vals.push(sampleBilinear(grayscale, size, x, y) < 128);
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
  grayscale: Uint8Array | Uint8ClampedArray, size: number, cx: number, cy: number, rotation: number
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
    for (let d = 0; d < maxR; d += 0.5) seq.push(sampleBilinear(grayscale, size, cx + dx * d, cy + dy * d) < 128 ? 1 : 0);
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
  grayscale: Uint8Array | Uint8ClampedArray, size: number, cx: number, cy: number, scale: number, spokeAngle: number
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
      bits[r][c] = sampleBilinear(grayscale, size, x, y) >= 128 ? 1 : 0;
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
  const reserved = buildReservedMask();
  let nAvail = 0;
  for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) nAvail++;
  const maskBits = makeMask(seed, nAvail);

  const candidates = findCandidateCenters(grayscale, size);
  const bestCandidate = candidates.length
    ? { cx: candidates[0].cx, cy: candidates[0].cy, coarseScale: candidates[0].coarseScale }
    : null;
  for (const det of candidates) {
    const spokeAngle = resolveOrientation(grayscale, size, det.cx, det.cy, det.coarseScale);
    if (!Number.isFinite(spokeAngle)) continue;
    const designSpokeAngle = -Math.PI / 2;
    const rotation = spokeAngle - designSpokeAngle;
    const refined = refineScale(grayscale, size, det.cx, det.cy, rotation);
    const scaleToUse = Number.isFinite(refined.scale) ? refined.scale : det.coarseScale;
    const bits = extractGrid(grayscale, size, det.cx, det.cy, scaleToUse, spokeAngle);

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
  };
}
