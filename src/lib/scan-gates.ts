// Live-scan guidance gates: marker SIZE and MOTION. Pure functions, no DOM,
// so they can be checked against real sample photos without a camera.
//
// These drive on-screen guidance and diagnostics only. They deliberately do
// NOT block decoding: a decode is RS-validated and costs ~20-60ms, so wrongly
// skipping a decodable frame is worse than decoding a hopeless one. They
// become hard gates later, for choosing which frames are worth collecting for
// multi-frame escalation.
//
// Every threshold below is PROVISIONAL — set from the real sample photos
// (see the size note) or marked as needing on-device calibration.

import { G, CELL_PX } from "./aztec-marker";
import { sampleBilinear } from "./aztec-detector";

export type SizeState = "unknown" | "too_small" | "ok" | "too_big";

/** Marker side in the same pixel space as `scale` (scale = px per native unit). */
export function markerSidePx(scale: number): number {
  return G * CELL_PX * scale;
}

/** Pixels per marker cell in the decode canvas. */
export function pxPerCell(scale: number): number {
  return CELL_PX * scale;
}

// Smallest marker (px per cell, in the 700px decode canvas) worth asking the
// user to keep. Real samples: p1 decoded at ~6.2 px/cell; m1 (6.0) failed from
// blur, not size, so size alone can't separate them — this only flags markers
// too small to have any chance. Revisit when detection moves to high-res crops
// (the basis changes from canvas px to native video px).
export const MIN_PX_PER_CELL = 5.5;

// "Move back" only when the marker overflows the on-screen guide box. Larger
// markers still decode fine (m2 decoded at 1.84 scale), so this is about the
// marker fitting in view, not about decode quality.
export const MAX_FRACTION_OF_GUIDE = 1.15;

export function evaluateSize(scale: number | null, guideSidePx: number): SizeState {
  if (scale === null || !Number.isFinite(scale) || scale <= 0) return "unknown";
  if (pxPerCell(scale) < MIN_PX_PER_CELL) return "too_small";
  if (markerSidePx(scale) > guideSidePx * MAX_FRACTION_OF_GUIDE) return "too_big";
  return "ok";
}

// ── Motion ──────────────────────────────────────────────────────────────
// Center/scale jitter between consecutive ticks, in marker-native units so
// the limit means the same thing at any distance. PROVISIONAL: no live video
// was available to calibrate these; read them off the ?debug overlay on a
// real device and tune.
export const MAX_JITTER_CELLS = 0.75;     // center movement per tick, in cells
export const MAX_SCALE_CHANGE = 0.06;     // |scale ratio - 1| per tick
export const STEADY_TICKS = 2;            // consecutive stable comparisons

export interface MotionSample { cx: number; cy: number; scale: number; thumb: Uint8Array | null }

export interface MotionReading {
  jitterCells: number | null;
  scaleChange: number | null;
  /** Mean absolute difference of mean-normalized thumbnails (0-255). Logged
   *  only — not used for decisions until calibrated on real video. */
  thumbDiff: number | null;
  stableTicks: number;
  /** The latest tick-to-tick comparison was within limits. */
  stableNow: boolean;
  /** Stable for STEADY_TICKS comparisons in a row (for later hard gating). */
  steady: boolean;
}

export class MotionTracker {
  private prev: MotionSample | null = null;
  private stableTicks = 0;

  reset() { this.prev = null; this.stableTicks = 0; }

  push(s: MotionSample): MotionReading {
    const p = this.prev;
    this.prev = s;
    if (!p) { this.stableTicks = 0; return { jitterCells: null, scaleChange: null, thumbDiff: null, stableTicks: 0, stableNow: true, steady: false }; }
    const jitterCells = Math.hypot(s.cx - p.cx, s.cy - p.cy) / pxPerCell(Math.min(s.scale, p.scale));
    const scaleChange = Math.abs(s.scale / p.scale - 1);
    const thumbDiff = s.thumb && p.thumb ? thumbnailDiff(s.thumb, p.thumb) : null;
    const stable = jitterCells <= MAX_JITTER_CELLS && scaleChange <= MAX_SCALE_CHANGE;
    this.stableTicks = stable ? this.stableTicks + 1 : 0;
    return { jitterCells, scaleChange, thumbDiff, stableTicks: this.stableTicks, stableNow: stable, steady: this.stableTicks >= STEADY_TICKS };
  }
}

const THUMB_N = 24;

/** N x N brightness thumbnail of a square region (the guide box). */
export function makeThumb(gray: Uint8Array | Uint8ClampedArray, width: number, cx: number, cy: number, halfSide: number): Uint8Array {
  const out = new Uint8Array(THUMB_N * THUMB_N);
  const step = (halfSide * 2) / THUMB_N;
  const x0 = cx - halfSide + step / 2, y0 = cy - halfSide + step / 2;
  for (let j = 0; j < THUMB_N; j++) {
    for (let i = 0; i < THUMB_N; i++) out[j * THUMB_N + i] = sampleBilinear(gray, width, x0 + i * step, y0 + j * step);
  }
  return out;
}

function thumbnailDiff(a: Uint8Array, b: Uint8Array): number {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= a.length;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs((a[i] - ma) - (b[i] - mb));
  return d / a.length;
}

// ── Guidance ────────────────────────────────────────────────────────────
export type Guidance = "move_closer" | "move_back" | "hold_steady" | null;

/** Priority: size first (nothing else matters if the marker is out of range),
 *  then motion. `null` = nothing to tell the user. */
export function chooseGuidance(size: SizeState, motion: MotionReading | null): Guidance {
  if (size === "too_small") return "move_closer";
  if (size === "too_big") return "move_back";
  // Keyed on the LATEST comparison, not on `steady`: requiring two stable
  // ticks first made "Hold steady" flash at the start of every scan.
  if (size === "ok" && motion && !motion.stableNow) return "hold_steady";
  return null;
}

export const GUIDANCE_TEXT: Record<Exclude<Guidance, null>, string> = {
  move_closer: "Move closer",
  move_back: "Move back",
  hold_steady: "Hold steady",
};
