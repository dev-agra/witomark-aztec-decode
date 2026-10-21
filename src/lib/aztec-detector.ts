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
  G, CELL_PX, DCX, DCY, RINGS, SPOKE_OUTER,
  makeMask, rsDecodeBits, buildReservedMask, MSG_BITS, bullseyeCellColor, isSpokeCell,
} from "./aztec-marker";

const DOT_NATIVE_HALF_WIDTH = RINGS[RINGS.length - 1]; // native dot is a half-width square (innermost ring boundary)
const DOT_NATIVE_AREA = (2 * DOT_NATIVE_HALF_WIDTH) * (2 * DOT_NATIVE_HALF_WIDTH);

export interface Candidate { cx: number; cy: number; coarseScale: number; fill: number }

export interface AlignedGeometry { cx: number; cy: number; scale: number; rotationRad: number }

/** Where the marker most plausibly is, judged by how well a candidate's
 *  finder-pattern cells (rings + spoke, 38 cells with known colors) match the
 *  design, NOT by distance to the aim point and NOT by boundary-point count
 *  alone — measured on m1, a candidate with all 32 boundary points still had
 *  a wrong scale (0.58 vs the true 0.75). Used for scan-guidance gates
 *  (size / motion); null when no candidate looks like the marker.
 *  Real-frame data (finderWrong of 38): m2 true marker 0, blurry m1 11-13,
 *  clutter 15-29. */
export interface MarkerEstimate { cx: number; cy: number; scale: number; okRays: number; finderWrong: number; rotationRad: number }

const ESTIMATE_MIN_OKRAYS = 16;
const ESTIMATE_MAX_FINDER_WRONG = 18; // below the clutter range, above blurry-but-real markers

function countFinderWrong(bits: number[][]): number {
  let wrong = 0;
  for (let r = 0; r < G; r++) {
    for (let c = 0; c < G; c++) {
      const bull = bullseyeCellColor(r, c);
      const expected = bull !== null ? (bull === 255 ? 1 : 0) : isSpokeCell(r, c) ? 0 : null;
      if (expected !== null && bits[r][c] !== expected) wrong++;
    }
  }
  return wrong;
}

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
  markerEstimate: MarkerEstimate | null;
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

// Reused across calls: the spoke search labels a fresh patch per candidate,
// and allocating+zeroing two large Int32Arrays each time dominated its cost.
let ccLabels = new Int32Array(0);
let ccStack = new Int32Array(0);

function connectedComponentsBinary(bin: Uint8Array, w: number, h: number, minArea: number) {
  const n = w * h;
  if (ccLabels.length < n) { ccLabels = new Int32Array(n); ccStack = new Int32Array(n); }
  else ccLabels.fill(0, 0, n);
  const labels = ccLabels;
  const stack = ccStack;
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
  // `size` is the frame WIDTH; height comes from the buffer length. (Both
  // used to be treated as `size`, which read everything below row width-1 of
  // a portrait frame as pure white.)
  const height = (img.length / size) | 0;
  if (x < 0 || y < 0 || x >= size - 1 || y >= height - 1) return 255;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  return img[y0 * size + x0] * (1 - fx) * (1 - fy) + img[y0 * size + x0 + 1] * fx * (1 - fy) +
         img[(y0 + 1) * size + x0] * (1 - fx) * fy + img[(y0 + 1) * size + x0 + 1] * fx * fy;
}

// Optional region-of-interest, in the SAME pixel space as `grayscale` — a
// centered square the caller believes the marker should be within (e.g. the
// camera UI's visual guide box). When given, candidates outside it are
// dropped before the MAX_CANDIDATES_TRIED cap, not after — the point is to
// avoid wasting that cap on background clutter the user isn't even aiming
// at, not just to save time on ones that would've been tried anyway.
export interface Roi { cx: number; cy: number; halfSize: number }

export function findCandidateCenters(
  grayscale: Uint8Array | Uint8ClampedArray, size: number, threshold = 128, roi: Roi | null = null
): Candidate[] {
  const height = (grayscale.length / size) | 0;
  const bin = new Uint8Array(size * height);
  for (let i = 0; i < bin.length; i++) bin[i] = grayscale[i] < threshold ? 1 : 0;
  const comps = connectedComponentsBinary(bin, size, height, 3);
  return comps
    .map((c) => {
      const w = c.maxx - c.minx + 1, h = c.maxy - c.miny + 1, bboxArea = w * h;
      return { c, fill: c.area / bboxArea, w, h };
    })
    .filter(({ c, fill, w, h }) => c.area >= 4 && c.area <= 2000 && Math.abs(w - h) <= Math.max(w, h) * 0.5 && fill > 0.5)
    .filter(({ c }) => !roi || Math.max(Math.abs(c.cx - roi.cx), Math.abs(c.cy - roi.cy)) <= roi.halfSize)
    .slice(0, MAX_CANDIDATES_TRIED) // original scan order, not re-ranked — see note above
    .map(({ c, fill }) => ({ cx: c.cx, cy: c.cy, coarseScale: Math.sqrt(c.area / DOT_NATIVE_AREA), fill }));
}

// ── Finder-pattern scanline search ────────────────────────────────────
// Root-cause fix, not a tuning tweak. The connected-component blob
// detector above derives a candidate's (cx, cy) from a flood-filled
// region's PIXEL CENTROID. Confirmed directly on 3 real printed-marker
// photos: print+capture erosion disconnects the bullseye into separate
// pieces (a ring corner, the isolated inner icon), and in EVERY one of
// the 3 photos the blob detector's candidate center landed on one of
// those fragments — never the true center — even though the full
// bullseye was clearly intact and legible to the eye. A blob centroid is
// not a deterministic signal for this shape under noise: it depends on
// exactly which pixels happen to still be connected, which varies photo
// to photo.
//
// Fix: stop asking "where are the blobs?" and look for the bullseye's
// own fixed signature directly — the same technique every real 2D-barcode
// reader (zxing et al) uses to locate QR/Aztec finder patterns: scan each
// row/column for a run of alternating dark/light bands in a fixed width
// ratio. A scanline through this bullseye's TRUE center crosses, outward
// from the middle, one band per ring (1 cell wide each), with the
// innermost ring counted twice because it spans both sides of the center
// — e.g. for 3 rings: black:white:black:white:black = 1:1:2:1:1. This
// doesn't depend on pixel connectivity at all: a single row's scan only
// sees that row's own transitions, so it's unaffected by erosion
// elsewhere on the ring. Confirmed on the real photos: this scan locks
// onto the true center in all 3, where the blob detector did not.
const BULLSEYE_RATIO: number[] = (() => {
  const side = new Array(RINGS.length - 1).fill(1);
  return [...side, 2, ...side.slice().reverse()];
})();
const BULLSEYE_RATIO_SUM = BULLSEYE_RATIO.reduce((a, b) => a + b, 0);
const BULLSEYE_RATIO_TOLERANCE = 1.0; // generous — this only SEEDS resolveOrientation/refineScale, which do the precise work; false positives are cheap here because the decode loop self-validates every candidate anyway

function matchBullseyeRatio(runLens: number[]): number | null {
  const total = runLens.reduce((a, b) => a + b, 0);
  const unit = total / BULLSEYE_RATIO_SUM;
  if (unit < 1.5) return null; // sub-pixel bands aren't a usable detection at any scale
  for (let i = 0; i < runLens.length; i++) {
    const expected = BULLSEYE_RATIO[i] * unit;
    if (Math.abs(runLens[i] - expected) > expected * BULLSEYE_RATIO_TOLERANCE + 1) return null;
  }
  return unit;
}

// Run-length scratch, reused across the ~1000 scanlines of a frame (this scan
// runs over every row and column, so per-run object allocation and a
// per-pixel closure call were its dominant cost).
let runStart = new Int32Array(0), runLen = new Int32Array(0), runColor = new Int8Array(0);

function scanLineForBullseye(bin: Uint8Array, base: number, stride: number, length: number): { center: number; unit: number }[] {
  const hits: { center: number; unit: number }[] = [];
  if (runStart.length < length + 1) {
    runStart = new Int32Array(length + 1); runLen = new Int32Array(length + 1); runColor = new Int8Array(length + 1);
  }
  let nRuns = 0;
  let curColor: number = bin[base], curStart = 0;
  for (let i = 1; i <= length; i++) {
    const c = i < length ? bin[base + i * stride] : -1;
    if (c !== curColor) {
      runStart[nRuns] = curStart; runLen[nRuns] = i - curStart; runColor[nRuns] = curColor; nRuns++;
      curColor = c; curStart = i;
    }
  }
  const n = BULLSEYE_RATIO.length;
  for (let i = 0; i + n <= nRuns; i++) {
    // runs strictly alternate color, so "dark,light,dark,..." (outermost
    // ring is black) only depends on the first run being dark
    if (runColor[i] !== 1) continue;
    const lens: number[] = new Array(n);
    for (let k = 0; k < n; k++) lens[k] = runLen[i + k];
    if (matchBullseyeRatio(lens) === null) continue;
    const centerRun = { start: runStart[i + (n - 1) / 2], len: runLen[i + (n - 1) / 2] };
    // Use the CENTER band alone (expected exactly 2 native cell units) to
    // derive the scale estimate, not the average across all 5 bands.
    // Measured directly on real photos: print/capture blur erodes the
    // thin 1-cell OUTER ring bands much more than the 2-cell center band
    // (e.g. one real row: widths 6,17,17,17,6 against the design's
    // 8,8,16,8,8 — the outer dark bands shrank ~25% while the center and
    // inner-white bands barely moved). Averaging all 5 bands dragged the
    // scale estimate up by ~25% (1.30 vs a true ~1.05), which overshot
    // the orientation scan's sampling radius clean out of the real ring
    // structure into the quiet zone/data region — confirmed visually on
    // the resulting orientation-scan image. The center band alone is a
    // far more stable estimator here.
    const unit = centerRun.len / 2;
    hits.push({ center: centerRun.start + centerRun.len / 2, unit });
  }
  return hits;
}

// Cross-check tolerance, in units of the estimated ring-cell pixel width —
// loose enough to tolerate the row-scan and column-scan passing through
// slightly different rows/columns on an off-axis capture, tight enough
// that two unrelated hits elsewhere in a busy frame essentially never
// coincide by chance (verified: zero false merges across the real test
// photos' full clutter backgrounds).
const FINDER_CROSS_CHECK_UNITS = 1.5;

/**
 * Finder-pattern candidate search (see header above): scans every row and
 * column for the bullseye's own fixed ring-width ratio signature, then
 * cross-confirms a horizontal hit against a nearby vertical hit before
 * accepting it as a candidate center. Deterministic and connectivity-
 * independent, unlike findCandidateCenters' blob centroids — use this
 * FIRST and fall back to blob-based candidates for anything it misses.
 */
export function findBullseyeCenters(
  grayscale: Uint8Array | Uint8ClampedArray, size: number, threshold = 128
): Candidate[] {
  const height = (grayscale.length / size) | 0;
  const bin = new Uint8Array(size * height);
  for (let i = 0; i < bin.length; i++) bin[i] = grayscale[i] < threshold ? 1 : 0;

  const hHits: { x: number; y: number; unit: number }[] = [];
  for (let y = 0; y < height; y++) {
    for (const h of scanLineForBullseye(bin, y * size, 1, size)) hHits.push({ x: h.center, y, unit: h.unit });
  }
  const vHits: { x: number; y: number; unit: number }[] = [];
  for (let x = 0; x < size; x++) {
    for (const h of scanLineForBullseye(bin, x, size, height)) vHits.push({ x, y: h.center, unit: h.unit });
  }

  const used = new Array(vHits.length).fill(false);
  const candidates: Candidate[] = [];
  for (const h of hHits) {
    let bestJ = -1, bestD = Infinity;
    for (let j = 0; j < vHits.length; j++) {
      if (used[j]) continue;
      const v = vHits[j];
      const tol = Math.max(h.unit, v.unit) * FINDER_CROSS_CHECK_UNITS;
      const d = Math.hypot(v.x - h.x, v.y - h.y);
      if (d <= tol && d < bestD) { bestD = d; bestJ = j; }
    }
    if (bestJ < 0) continue;
    used[bestJ] = true;
    const v = vHits[bestJ];
    candidates.push({
      cx: (h.x + v.x) / 2,
      cy: (h.y + v.y) / 2,
      coarseScale: (h.unit + v.unit) / 2 / CELL_PX,
      fill: 1,
    });
  }
  return candidates;
}

// Finds the orientation spoke by looking at the 2D region, not by
// guessing a radius and sampling points on it: the spoke is a real,
// physically isolated dark shape sitting in the quiet zone. Binarize a
// generous annulus around the candidate center, run connected-component
// labeling on it (same technique findCandidateCenters uses on the whole
// frame), and look for a component that's (a) its own separate blob —
// real white quiet-zone pixels around it, which the flood-fill already
// respects, no explicit connectivity check needed — (b) at a plausible
// distance from center, clear of where the ring itself could reach, and
// (c) roughly the spoke's known shape (a compact ~2-cell-by-1-cell
// rectangle). Its centroid position relative to center IS the
// orientation, read directly via atan2 — no angular scanning at all.
function findSpokeByBlob(
  grayscale: Uint8Array | Uint8ClampedArray, size: number, cx: number, cy: number, coarseScale: number, threshold: number
): number | null {
  const innerR = RINGS[0] * Math.SQRT2 * coarseScale * 0.85;
  const outerR = SPOKE_OUTER * coarseScale * 1.4;
  const half = Math.ceil(outerR);
  const height = (grayscale.length / size) | 0;
  const minX = Math.max(0, Math.floor(cx - half)), maxX = Math.min(size - 1, Math.ceil(cx + half));
  const minY = Math.max(0, Math.floor(cy - half)), maxY = Math.min(height - 1, Math.ceil(cy + half));
  const pw = maxX - minX + 1, ph = maxY - minY + 1;
  if (pw <= 0 || ph <= 0) return null;
  const bin = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    const rowBase = (minY + y) * size + minX;
    for (let x = 0; x < pw; x++) bin[y * pw + x] = grayscale[rowBase + x] < threshold ? 1 : 0;
  }
  const comps = connectedComponentsBinary(bin, pw, ph, 3);
  const expectedArea = 2 * CELL_PX * CELL_PX * coarseScale * coarseScale; // ~128*scale^2 native
  let best: { cx: number; cy: number } | null = null;
  let bestScore = -Infinity;
  for (const comp of comps) {
    const compCx = minX + comp.cx, compCy = minY + comp.cy;
    const dist = Math.hypot(compCx - cx, compCy - cy);
    if (dist < innerR || dist > outerR) continue;
    const bw = comp.maxx - comp.minx + 1, bh = comp.maxy - comp.miny + 1;
    const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
    if (aspect < 1.3 || aspect > 3.5) continue; // the spoke is a ~2:1 rectangle, not a blob or a thin sliver
    if (comp.area < expectedArea * 0.4 || comp.area > expectedArea * 2.5) continue;
    if (Math.max(bw, bh) > CELL_PX * coarseScale * 3) continue; // reject anything much bigger than the spoke itself (a stray ring fragment)
    const score = -(Math.abs(aspect - 2) + Math.abs(comp.area - expectedArea) / expectedArea);
    if (score > bestScore) { bestScore = score; best = { cx: compCx, cy: compCy }; }
  }
  if (!best) return null;
  return Math.atan2(best.cy - cy, best.cx - cx);
}

export function resolveOrientation(
  grayscale: Uint8Array | Uint8ClampedArray, size: number, cx: number, cy: number, scale: number, threshold = 128
): number {
  return findSpokeByBlob(grayscale, size, cx, cy, scale, threshold) ?? NaN;
}


// Real-photo failure, measured directly: transitions used to snap to the
// nearest 0.5px sampling step (just "where the binary threshold flips").
// Tried sub-pixel linear interpolation of the crossing point instead —
// measured directly on real captures and found WRONG: a real JPEG photo's
// per-pixel brightness is noisy near a threshold crossing (compression
// ringing, not clean blur), so interpolating on the exact magnitude of the
// two bracketing samples amplifies that noise instead of averaging over
// it. A real example: a capture whose old binary-snap read decoded cleanly
// (5/32 bytes wrong) went to 14/32 (over the correction budget) with
// sub-pixel interpolation enabled, on the EXACT SAME pixels — worse, not
// better. The coarse binary threshold is actually more robust here because
// it only needs the sign of (value - threshold), not its magnitude. Kept
// as a plain step-grid snap.
function findSubpixelTransitions(
  grayscale: Uint8Array | Uint8ClampedArray, size: number, cx: number, cy: number, dx: number, dy: number, threshold: number, maxCount: number
): number[] {
  const maxR = 120, step = 0.5;
  const transitions: number[] = [];
  let prev = sampleBilinear(grayscale, size, cx, cy) < threshold;
  for (let d = step; d < maxR && transitions.length < maxCount; d += step) {
    const cur = sampleBilinear(grayscale, size, cx + dx * d, cy + dy * d) < threshold;
    if (cur !== prev) transitions.push(d);
    prev = cur;
  }
  return transitions;
}

export function refineScale(
  grayscale: Uint8Array | Uint8ClampedArray, size: number, cx: number, cy: number, rotation: number, threshold = 128
): { scale: number; okRays: number } {
  const rayAngles = [0, 45, 90, 135, 180, 225, 270, 315].map((d) => (d * Math.PI) / 180);
  const measuredScales: number[] = [];
  let okRays = 0;
  for (const a of rayAngles) {
    const dx = Math.cos(a), dy = Math.sin(a);
    const nativeAngle = a - rotation;
    const factor = Math.max(Math.abs(Math.cos(nativeAngle)), Math.abs(Math.sin(nativeAngle)));
    const transitions = findSubpixelTransitions(grayscale, size, cx, cy, dx, dy, threshold, RINGS.length).map((t) => t * factor);
    if (transitions.length < RINGS.length) continue;
    const ratios = transitions.map((t, i) => t / RINGS[RINGS.length - 1 - i]);
    const mean = ratios.reduce((a2, b2) => a2 + b2, 0) / ratios.length;
    const variance = ratios.reduce((a2, b2) => a2 + (b2 - mean) ** 2, 0) / ratios.length;
    if (Math.sqrt(variance) / mean < 0.15) { measuredScales.push(mean); okRays++; }
  }
  if (!measuredScales.length) return { scale: NaN, okRays: 0 };
  measuredScales.sort((a, b) => a - b);
  return { scale: measuredScales[Math.floor(measuredScales.length / 2)], okRays };
}

// Real-photo failure, measured directly: sampling a SINGLE point at each
// cell's exact center read the marker's own FINDER PATTERN wrong — a ring
// edge that should be a solid, unambiguous dark line across several cells
// (not data, not masked, nothing ambiguous about its intended color) came
// out as isolated dark pixels at its two ends with white in between.
// Confirmed this wasn't a calibration problem (scale/rotation were both
// independently verified correct to within ~1deg and all 32 boundary
// points agreeing) — it's that a single bilinear sample is fragile to
// local noise (JPEG compression blocking, uneven print ink, a dust fleck)
// landing on that one exact pixel, even dead center in an otherwise-solid
// cell. Average over several points spread across the cell's own area
// instead of trusting one: a localized defect gets outvoted by the rest
// of the cell, which single-point sampling has no way to do.
const CELL_SAMPLE_OFFSETS = [-0.25, 0, 0.25]; // fraction of CELL_PX, both axes -> 3x3 = 9 samples per cell

export function extractGrid(
  grayscale: Uint8Array | Uint8ClampedArray, size: number, cx: number, cy: number, scale: number, spokeAngle: number, threshold = 128
): number[][] {
  const designSpokeAngle = -Math.PI / 2;
  const rotation = spokeAngle - designSpokeAngle;
  const cosr = Math.cos(rotation), sinr = Math.sin(rotation);
  const bits: number[][] = Array.from({ length: G }, () => new Array(G).fill(0));
  for (let r = 0; r < G; r++) {
    for (let c = 0; c < G; c++) {
      const baseDdx = (c * CELL_PX + CELL_PX / 2) - DCX, baseDdy = (r * CELL_PX + CELL_PX / 2) - DCY;
      let sum = 0, n = 0;
      for (const ox of CELL_SAMPLE_OFFSETS) {
        for (const oy of CELL_SAMPLE_OFFSETS) {
          const ddx = baseDdx + ox * CELL_PX, ddy = baseDdy + oy * CELL_PX;
          const rx = ddx * cosr - ddy * sinr, ry = ddx * sinr + ddy * cosr;
          sum += sampleBilinear(grayscale, size, cx + rx * scale, cy + ry * scale);
          n++;
        }
      }
      bits[r][c] = sum / n >= threshold ? 1 : 0;
    }
  }
  return bits;
}

// ── Projective (homography) extraction — a fallback tried only when the
// plain rotate+uniform-scale model above fails to decode a candidate. ──
//
// Root cause this targets: the similarity model (rotation + one scalar
// scale) can only represent a marker photographed head-on. A flat marker
// photographed at ANY angle is genuinely a projective transform (a camera
// is a pinhole projection), which has local shear that VARIES with
// position — something a single global rotate+scale can never capture,
// however good the rotation/scale estimate is. Measured directly with a
// synthetic perspective-warped marker: the existing pipeline fails
// outright (NaN scale) under a tilt too mild to be unrealistic for a
// handheld photo, while a fitted homography recovers a clean decode (down
// to 0-3 bits wrong out of 256) on the same pixels.
//
// Approach (the same one real 2D barcode readers use): measure the OUTER
// ring's boundary (the biggest, highest-contrast feature — reliable even
// under blur) at many angles, fit a full 8-parameter homography from those
// native<->scene correspondences via DLT, then re-measure using the fitted
// homography as a better predictor and refit, narrowing the search window
// each pass. Two things were necessary to make this actually work in
// practice, both confirmed by direct measurement, not assumption:
//   1. Hartley normalization (recenter + rescale both point sets before the
//      DLT solve) — plain unnormalized DLT has a well-known algebraic bias
//      that left a persistent ~6% spurious shear term even with accurate
//      individual point measurements.
//   2. Iterative re-measurement with a gradually narrowing window — a
//      single pass leaves a few-pixel residual that's too much for the RS
//      budget; refitting from the previous pass's own prediction converges
//      to sub-pixel accuracy within a handful of passes.
const BOUNDARY_NATIVE_ANGLES = 32;
const HOMOGRAPHY_WINDOW_SCHEDULE = [10, 6, 4, 3, 3, 3, 3, 3]; // native-px search half-width per refinement pass

export function applyHomography(H: number[][], nx: number, ny: number): [number, number] {
  const w = H[2][0] * nx + H[2][1] * ny + H[2][2];
  return [(H[0][0] * nx + H[0][1] * ny + H[0][2]) / w, (H[1][0] * nx + H[1][1] * ny + H[1][2]) / w];
}

function measureOuterBoundary(
  grayscale: Uint8Array | Uint8ClampedArray, size: number, threshold: number, cx: number, cy: number,
  predictScene: (nx: number, ny: number) => [number, number], searchHalfWidthScenePx: number
): { nx: number; ny: number; sx: number; sy: number }[] {
  const pts: { nx: number; ny: number; sx: number; sy: number }[] = [];
  for (let i = 0; i < BOUNDARY_NATIVE_ANGLES; i++) {
    const phi = (i / BOUNDARY_NATIVE_ANGLES) * 2 * Math.PI;
    const cosP = Math.cos(phi), sinP = Math.sin(phi);
    const t = RINGS[0] / Math.max(Math.abs(cosP), Math.abs(sinP));
    const nx = t * cosP, ny = t * sinP;
    const [psx, psy] = predictScene(nx, ny);
    const dirX = psx - cx, dirY = psy - cy;
    const dirLen = Math.hypot(dirX, dirY);
    if (dirLen < 1e-6) continue;
    const ux = dirX / dirLen, uy = dirY / dirLen;
    const rLo = Math.max(1, dirLen - searchHalfWidthScenePx), rHi = dirLen + searchHalfWidthScenePx;
    let found: number | null = null, bestDist = Infinity;
    let prevR = rLo, prevV = sampleBilinear(grayscale, size, cx + ux * rLo, cy + uy * rLo) - threshold;
    for (let r = rLo + 0.5; r <= rHi; r += 0.5) {
      const v = sampleBilinear(grayscale, size, cx + ux * r, cy + uy * r) - threshold;
      if (prevV < 0 && v >= 0) { // dark -> light: the outer ring's own edge
        const t2 = prevV / (prevV - v);
        const rc = prevR + t2 * (r - prevR);
        const d = Math.abs(rc - dirLen);
        if (d < bestDist) { bestDist = d; found = rc; }
      }
      prevR = r; prevV = v;
    }
    if (found !== null) pts.push({ nx, ny, sx: cx + ux * found, sy: cy + uy * found });
  }
  return pts;
}

function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[piv][i])) piv = k;
    if (Math.abs(M[piv][i]) < 1e-10) return null;
    [M[i], M[piv]] = [M[piv], M[i]];
    for (let k = i + 1; k < n; k++) {
      const f = M[k][i] / M[i][i];
      for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

function matMul3(A: number[][], B: number[][]): number[][] {
  const out = Array.from({ length: 3 }, () => new Array(3).fill(0));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0; for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j];
    out[i][j] = s;
  }
  return out;
}

function invert3(M: number[][]): number[][] {
  const det = M[0][0]*(M[1][1]*M[2][2]-M[1][2]*M[2][1]) - M[0][1]*(M[1][0]*M[2][2]-M[1][2]*M[2][0]) + M[0][2]*(M[1][0]*M[2][1]-M[1][1]*M[2][0]);
  const cof = (a: number, b: number, c: number, d: number) => a * d - b * c;
  return [
    [cof(M[1][1],M[1][2],M[2][1],M[2][2])/det, -cof(M[0][1],M[0][2],M[2][1],M[2][2])/det, cof(M[0][1],M[0][2],M[1][1],M[1][2])/det],
    [-cof(M[1][0],M[1][2],M[2][0],M[2][2])/det, cof(M[0][0],M[0][2],M[2][0],M[2][2])/det, -cof(M[0][0],M[0][2],M[1][0],M[1][2])/det],
    [cof(M[1][0],M[1][1],M[2][0],M[2][1])/det, -cof(M[0][0],M[0][1],M[2][0],M[2][1])/det, cof(M[0][0],M[0][1],M[1][0],M[1][1])/det],
  ];
}

function normalizeTransform(pts: { x: number; y: number }[]): number[][] {
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= pts.length; my /= pts.length;
  let avgDist = 0;
  for (const p of pts) avgDist += Math.hypot(p.x - mx, p.y - my);
  avgDist /= pts.length;
  const s = avgDist > 1e-9 ? Math.SQRT2 / avgDist : 1;
  return [[s, 0, -s * mx], [0, s, -s * my], [0, 0, 1]];
}

function fitHomography(pts: { nx: number; ny: number; sx: number; sy: number }[]): number[][] | null {
  if (pts.length < 6) return null; // a bare 4-point minimum is too fragile against outliers
  const Tn = normalizeTransform(pts.map((p) => ({ x: p.nx, y: p.ny })));
  const Ts = normalizeTransform(pts.map((p) => ({ x: p.sx, y: p.sy })));
  const normPts = pts.map((p) => {
    const nw = Tn[2][0]*p.nx + Tn[2][1]*p.ny + Tn[2][2];
    const nx = (Tn[0][0]*p.nx + Tn[0][1]*p.ny + Tn[0][2]) / nw;
    const ny = (Tn[1][0]*p.nx + Tn[1][1]*p.ny + Tn[1][2]) / nw;
    const sw = Ts[2][0]*p.sx + Ts[2][1]*p.sy + Ts[2][2];
    const sx = (Ts[0][0]*p.sx + Ts[0][1]*p.sy + Ts[0][2]) / sw;
    const sy = (Ts[1][0]*p.sx + Ts[1][1]*p.sy + Ts[1][2]) / sw;
    return { nx, ny, sx, sy };
  });
  const ATA: number[][] = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const ATb: number[] = new Array(8).fill(0);
  for (const p of normPts) {
    const { nx, ny, sx, sy } = p;
    const row1 = [nx, ny, 1, 0, 0, 0, -nx * sx, -ny * sx];
    const row2 = [0, 0, 0, nx, ny, 1, -nx * sy, -ny * sy];
    for (const [row, rhs] of [[row1, sx], [row2, sy]] as [number[], number][]) {
      for (let i = 0; i < 8; i++) {
        ATb[i] += row[i] * rhs;
        for (let j = 0; j < 8; j++) ATA[i][j] += row[i] * row[j];
      }
    }
  }
  const h = solveLinearSystem(ATA, ATb);
  if (!h) return null;
  const Hnorm = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
  const H = matMul3(invert3(Ts), matMul3(Hnorm, Tn));
  const h33 = H[2][2];
  if (Math.abs(h33) < 1e-9) return null;
  return H.map((row) => row.map((v) => v / h33));
}

function medianScaleFromBoundaryPoints(
  pts: { nx: number; ny: number; sx: number; sy: number }[], cx: number, cy: number
): number {
  const scales = pts.map((p) => Math.hypot(p.sx - cx, p.sy - cy) / Math.hypot(p.nx, p.ny));
  scales.sort((a, b) => a - b);
  return scales[Math.floor(scales.length / 2)];
}

// Real-photo failure, measured directly: the original scale estimator
// (refineScale, below) casts only 8 rays and requires EACH one to
// independently find a clean, uninterrupted count of ring-transition
// crossings before trusting it — real print/capture noise routinely
// breaks that on most rays (confirmed directly: n1/n2/n3 all capped at
// 3-4 of 8 "okRays" even once orientation itself was exactly correct),
// leaving too few measurements for a reliable scale.
//
// This reuses the SAME boundary-measurement machinery already built for
// the homography fallback (measureOuterBoundary, 32 points around the
// ring instead of 8, each with its own local sub-pixel search window) and
// the same iterative narrowing-window refinement — but fits a single
// robust scalar (median of per-point scale ratios) instead of a full
// 8-parameter homography. More points, more tolerance for a few bad ones
// (the median shrugs off outliers a 50%-of-rays requirement can't), and
// the same convergence behavior the homography path already relies on.
export function refineScaleFromBoundary(
  grayscale: Uint8Array | Uint8ClampedArray, size: number, cx: number, cy: number,
  rotation: number, seedScale: number, threshold: number
): { scale: number; okRays: number } {
  const cosr = Math.cos(rotation), sinr = Math.sin(rotation);
  let scale = seedScale;
  let pts = measureOuterBoundary(
    grayscale, size, threshold, cx, cy,
    (nx, ny) => [cx + (nx * cosr - ny * sinr) * scale, cy + (nx * sinr + ny * cosr) * scale],
    16 * scale
  );
  if (pts.length >= 6) scale = medianScaleFromBoundaryPoints(pts, cx, cy);
  for (const halfWidth of HOMOGRAPHY_WINDOW_SCHEDULE) {
    const s = scale;
    pts = measureOuterBoundary(
      grayscale, size, threshold, cx, cy,
      (nx, ny) => [cx + (nx * cosr - ny * sinr) * s, cy + (nx * sinr + ny * cosr) * s],
      halfWidth
    );
    if (pts.length >= 6) scale = medianScaleFromBoundaryPoints(pts, cx, cy);
  }
  return { scale: pts.length >= 6 ? scale : NaN, okRays: pts.length };
}

/**
 * Fits a full projective transform (native marker space -> scene space)
 * from the outer ring's boundary, seeded with a similarity (rotation+scale)
 * estimate and iteratively refined. Returns null if too few boundary points
 * were measurable (e.g. the ring is too obscured) to fit reliably.
 */
export function fitHomographyFromBoundary(
  grayscale: Uint8Array | Uint8ClampedArray, size: number, cx: number, cy: number,
  rotation: number, seedScale: number, threshold: number
): number[][] | null {
  const cosr = Math.cos(rotation), sinr = Math.sin(rotation);
  const predictSimilarity = (nx: number, ny: number): [number, number] =>
    [cx + (nx * cosr - ny * sinr) * seedScale, cy + (nx * sinr + ny * cosr) * seedScale];

  let pts = measureOuterBoundary(grayscale, size, threshold, cx, cy, predictSimilarity, 16 * seedScale);
  let homography = fitHomography(pts);
  for (let pass = 0; pass < HOMOGRAPHY_WINDOW_SCHEDULE.length && homography; pass++) {
    const H = homography;
    const predictH = (nx: number, ny: number): [number, number] => applyHomography(H, nx, ny);
    pts = measureOuterBoundary(grayscale, size, threshold, cx, cy, predictH, HOMOGRAPHY_WINDOW_SCHEDULE[pass]);
    const refit = fitHomography(pts);
    if (refit) homography = refit;
  }
  return homography;
}

export function extractGridHomography(
  grayscale: Uint8Array | Uint8ClampedArray, size: number, homography: number[][], threshold = 128
): number[][] {
  const bits: number[][] = Array.from({ length: G }, () => new Array(G).fill(0));
  for (let r = 0; r < G; r++) {
    for (let c = 0; c < G; c++) {
      const ddx = (c * CELL_PX + CELL_PX / 2) - DCX, ddy = (r * CELL_PX + CELL_PX / 2) - DCY;
      const [x, y] = applyHomography(homography, ddx, ddy);
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
export function decodeFromGrayscale(
  grayscale: Uint8Array | Uint8ClampedArray, size: number, seed: string, roi: Roi | null = null
): DecodeDebugInfo {
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

  // Finder-pattern hits are deterministic and connectivity-independent
  // (see findBullseyeCenters' header) — try them first, then ALSO try
  // every blob-based candidate, unfiltered. A first attempt here dropped
  // any blob candidate within one cell-width of a finder hit, on the
  // theory that it'd be a redundant near-duplicate. Measured directly and
  // found WRONG: it collapsed the clean-synthetic stress-test pass rate
  // from ~98% to 78.8%. Root cause — the finder scan's tolerance has to
  // stay generous (see BULLSEYE_RATIO_TOLERANCE) to catch real eroded
  // print+capture rings, which means it also throws a fair number of
  // imprecise hits (slightly-off center or scale) near busy/clutter
  // regions of a synthetic scene; the dedup let one of those suppress the
  // CORRECT, precise blob candidate at the same location, replacing a
  // candidate that decoded with one that didn't. Trying both lists in
  // full is self-validating either way — a bad candidate from either
  // source just fails its RS decode and the loop moves on — so the only
  // cost of not deduping is a bit of wasted work on near-duplicates, never
  // a lost correct candidate.
  const finderCandidates = findBullseyeCenters(grayscale, size, threshold)
    .filter((c) => !roi || Math.max(Math.abs(c.cx - roi.cx), Math.abs(c.cy - roi.cy)) <= roi.halfSize);
  const blobCandidates = findCandidateCenters(grayscale, size, threshold, roi);
  // Do NOT de-duplicate near-identical hits: measured on real photos, even
  // collapsing hits within a third of a cell and 8% scale stopped p1, m3@700
  // and m2@1100+ from decoding. Neighboring finder hits are not
  // interchangeable seeds.
  const candidates = [...finderCandidates, ...blobCandidates];
  // Try candidates nearest the aim point first (the user centers the marker).
  // Every candidate is still tried and the first RS-valid decode wins, so this
  // changes only how quickly a decodable frame returns, never what is tried.
  const frameHeight = (grayscale.length / size) | 0;
  const aimX = roi?.cx ?? size / 2, aimY = roi?.cy ?? frameHeight / 2;
  candidates.sort((a, b) => Math.hypot(a.cx - aimX, a.cy - aimY) - Math.hypot(b.cx - aimX, b.cy - aimY));
  // "bestCandidate" is ONLY for the failure-case diagnostic crop/preview —
  // it does NOT affect correctness (the RS-decode loop below still tries
  // every candidate in original scan order, same as always). Picking
  // candidates[0] here (literally "first blob the flood-fill happened to
  // reach") was a real bug: in a real scene with a dark laptop bezel or
  // keyboard, a big unrelated dark region can easily be first in raster
  // scan order, pass the blob filters, and get a huge coarseScale from its
  // large area — producing a diagnostic crop that zooms OUT to nearly the
  // whole photo instead of the actual marker. Pick the candidate closest to
  // the ROI (or frame) center instead — the user aims the marker at the
  // center, so this is the one actually worth showing as "what we looked
  // at", even though it has zero influence on which one the decode loop
  // below accepts.
  const refCx = aimX, refCy = aimY;
  let bestIdx = -1, bestDist = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const d = Math.hypot(candidates[i].cx - refCx, candidates[i].cy - refCy);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  const bestCandidate = bestIdx >= 0
    ? { cx: candidates[bestIdx].cx, cy: candidates[bestIdx].cy, coarseScale: candidates[bestIdx].coarseScale }
    : null;

  // Best-effort geometry for the top candidate, computed once, regardless
  // of whether ITS decode (or any other candidate's) ultimately succeeds —
  // this is what powers a live "here's what we're aligning" preview even
  // before/without a full decode.
  // Orientation + scale refinement are the expensive per-candidate steps and
  // the best-candidate preview below reuses the SAME candidate the loop will
  // visit — memoize so each candidate is analyzed at most once per frame.
  const analysisCache = new Map<Candidate, { spokeAngle: number; rotation: number; refined: { scale: number; okRays: number } | null }>();
  const analyze = (det: Candidate) => {
    let a = analysisCache.get(det);
    if (!a) {
      const spokeAngle = resolveOrientation(grayscale, size, det.cx, det.cy, det.coarseScale, threshold);
      if (Number.isFinite(spokeAngle)) {
        const rotation = spokeAngle - designSpokeAngle;
        a = { spokeAngle, rotation, refined: refineScaleFromBoundary(grayscale, size, det.cx, det.cy, rotation, det.coarseScale, threshold) };
      } else {
        a = { spokeAngle, rotation: NaN, refined: null };
      }
      analysisCache.set(det, a);
    }
    return a;
  };

  let bestGeometry: AlignedGeometry | null = null;
  if (bestIdx >= 0) {
    const a0 = analyze(candidates[bestIdx]);
    if (a0.refined) {
      const scale0 = Number.isFinite(a0.refined.scale) ? a0.refined.scale : candidates[bestIdx].coarseScale;
      bestGeometry = { cx: candidates[bestIdx].cx, cy: candidates[bestIdx].cy, scale: scale0, rotationRad: a0.rotation };
    }
  }

  // The homography fit costs ~8 boundary-measurement passes; measured on real
  // frames it was firing for ~13 near-duplicate candidates per frame once
  // okRays moved to a 0-32 scale. Only strong boundary evidence earns it, and
  // at most a few per frame.
  const HOMOGRAPHY_MIN_OKRAYS = 24;
  const HOMOGRAPHY_MAX_PER_FRAME = 4;
  let homographyRuns = 0;
  let markerEstimate: MarkerEstimate | null = null;

  for (const det of candidates) {
    const { spokeAngle, rotation, refined } = analyze(det);
    if (!refined) continue;
    const scaleToUse = Number.isFinite(refined.scale) ? refined.scale : det.coarseScale;
    const bits = extractGrid(grayscale, size, det.cx, det.cy, scaleToUse, spokeAngle, threshold);
    const finderWrong = countFinderWrong(bits);
    if (
      refined.okRays >= ESTIMATE_MIN_OKRAYS && finderWrong <= ESTIMATE_MAX_FINDER_WRONG &&
      (!markerEstimate || finderWrong < markerEstimate.finderWrong ||
        (finderWrong === markerEstimate.finderWrong && refined.okRays > markerEstimate.okRays))
    ) {
      markerEstimate = { cx: det.cx, cy: det.cy, scale: scaleToUse, okRays: refined.okRays, finderWrong, rotationRad: rotation };
    }

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
        markerEstimate: { cx: det.cx, cy: det.cy, scale: scaleToUse, okRays: refined.okRays, finderWrong, rotationRad: rotation },
      };
    }

    // Second attempt for this SAME candidate, only tried when the plain
    // rotate+uniform-scale model above failed: fit a full projective
    // transform from the outer ring's actual boundary and re-extract. This
    // targets perspective/keystone distortion (photographing a flat marker
    // at an angle) that no single rotation+scale value can represent,
    // regardless of how accurately it's measured — confirmed directly on a
    // synthetic perspective-warped marker that broke the similarity model
    // outright. Self-validating like everything else here: only accepted
    // if it ACTUALLY decodes, so a bad homography fit just falls through to
    // the next candidate exactly as a bad similarity fit already does.
    //
    // Gated on okRays >= 16 (half of the 32 boundary points, matching the
    // same ~50% proportion the old 8-ray gate used): this fit costs ~8
    // refinement passes x 32 points each, meaningful on a phone and NOT
    // worth paying for every random clutter blob in a busy real frame —
    // only worth it for a candidate whose boundary measurement already
    // shows partial, plausible structure.
    const homography = refined.okRays >= HOMOGRAPHY_MIN_OKRAYS && homographyRuns < HOMOGRAPHY_MAX_PER_FRAME
      ? (homographyRuns++, fitHomographyFromBoundary(grayscale, size, det.cx, det.cy, rotation, scaleToUse, threshold))
      : null;
    if (homography) {
      const hBits = extractGridHomography(grayscale, size, homography, threshold);
      const hFlat: number[] = [];
      for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) hFlat.push(hBits[r][c]);
      const hUnmasked = hFlat.map((b, i) => b ^ maskBits[i]);
      const hCodewordBits = hUnmasked.slice(0, MSG_BITS);
      const hRecovered = rsDecodeBits(hCodewordBits);
      if (hRecovered !== null) {
        return {
          status: "DECODE_OK",
          id: hRecovered,
          candidatesTried: candidates.indexOf(det) + 1,
          detectedCenter: [det.cx, det.cy],
          coarseScale: det.coarseScale,
          refinedScale: refined.scale,
          rotationDeg: (rotation * 180) / Math.PI,
          okRays: refined.okRays,
          bestCandidate,
          // No AlignedGeometry representation for a full projective
          // transform (it's similarity-only: cx,cy,scale,rotation) — the
          // debug crop for a homography-recovered decode falls back to the
          // similarity approximation, which may show visible skew. That's
          // a cosmetic limitation of the Analyse view only.
          successGeometry: { cx: det.cx, cy: det.cy, scale: scaleToUse, rotationRad: rotation },
          bestGeometry,
          markerEstimate: { cx: det.cx, cy: det.cy, scale: scaleToUse, okRays: refined.okRays, finderWrong, rotationRad: rotation },
        };
      }
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
    markerEstimate,
  };
}
