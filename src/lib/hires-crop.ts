// Plans a native-resolution crop around an already-detected marker, so the
// grid can be read from the video's own pixels instead of the downscaled
// detection canvas. Pure geometry — the caller does the drawImage + decode.
//
// Measured on the real sample photos (known "DEVANSH" codeword):
//   m2  canvas 8/32 bytes wrong (at the RS limit)  -> native crop 0/32
//   m3  canvas 0/32; native crop at marker scale 4.4 -> 14/32 WORSE,
//       at scale 2.2 -> 0/32
//   m1  ~45% bits wrong at every resolution (blur-limited, not resolution)
// i.e. native pixels add margin, but only at a moderate marker scale, so the
// crop is downscaled to HIRES_TARGET_SCALE when the video is finer than that.

import { G, CELL_PX } from "./aztec-marker";

/** Marker scale (px per native marker unit) to decode the crop at. 2.0 = 16 px/cell. */
export const HIRES_TARGET_SCALE = 2.0;
/** Skip when the video is less than this much finer than the detection canvas. */
export const HIRES_MIN_GAIN = 1.2;
/** Run the crop attempt on every Nth eligible tick. Measured ~70-180ms per attempt;
 *  on a steady but undecodable marker, near-identical consecutive frames add nothing. */
export const HIRES_EVERY_N_TICKS = 3;
/** Crop half-side as a fraction of the marker side (1.7x total: room for rotation + margin). */
export const HIRES_HALF_FRACTION = 0.85;

export interface CropPlan {
  /** Source rect in native video pixels. */
  sx: number; sy: number; sw: number; sh: number;
  /** Output canvas size (source downscaled by `factor`). */
  outW: number; outH: number;
  factor: number;
  /** Marker scale in native video px per marker unit. */
  nativeScale: number;
}

/**
 * @param est  marker center/scale in DETECTION-CANVAS pixels
 * @param k    detection canvas px per native video px (canvas = k * video)
 */
export function planHiresCrop(
  est: { cx: number; cy: number; scale: number }, k: number, videoW: number, videoH: number
): CropPlan | null {
  if (!(k > 0) || 1 / k < HIRES_MIN_GAIN) return null;
  const nativeScale = est.scale / k;
  const side = G * CELL_PX * nativeScale;
  const ccx = est.cx / k, ccy = est.cy / k, half = side * HIRES_HALF_FRACTION;
  const sx = Math.max(0, Math.round(ccx - half)), sy = Math.max(0, Math.round(ccy - half));
  const sw = Math.min(videoW, Math.round(ccx + half)) - sx;
  const sh = Math.min(videoH, Math.round(ccy + half)) - sy;
  if (sw < 16 || sh < 16) return null;
  const factor = nativeScale > HIRES_TARGET_SCALE ? HIRES_TARGET_SCALE / nativeScale : 1;
  return { sx, sy, sw, sh, outW: Math.max(1, Math.round(sw * factor)), outH: Math.max(1, Math.round(sh * factor)), factor, nativeScale };
}

/** Burst crop: like planHiresCrop but without the "finer than the canvas" gate and with extra margin for hand shake. */
export const BURST_HALF_FRACTION = 0.95;
export function planBurstCrop(
  nativeCx: number, nativeCy: number, nativeScale: number, videoW: number, videoH: number
): CropPlan | null {
  const side = G * CELL_PX * nativeScale, half = side * BURST_HALF_FRACTION;
  const sx = Math.max(0, Math.round(nativeCx - half)), sy = Math.max(0, Math.round(nativeCy - half));
  const sw = Math.min(videoW, Math.round(nativeCx + half)) - sx;
  const sh = Math.min(videoH, Math.round(nativeCy + half)) - sy;
  if (sw < 16 || sh < 16) return null;
  const factor = nativeScale > HIRES_TARGET_SCALE ? HIRES_TARGET_SCALE / nativeScale : 1;
  return { sx, sy, sw, sh, outW: Math.max(1, Math.round(sw * factor)), outH: Math.max(1, Math.round(sh * factor)), factor, nativeScale };
}
