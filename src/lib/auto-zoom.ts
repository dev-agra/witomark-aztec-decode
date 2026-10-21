// Closed-loop zoom: nudges the camera zoom so the marker lands in a good size
// band on the sensor, using the marker size the detector actually measured.
// The starting zoom from camera-tiers.ts is only a guess; this corrects it, so
// a wrong table entry (or a different hold distance) still ends up fine.
//
// Pure logic, no DOM. The caller applies the returned zoom to the track.

export interface AutoZoomConfig {
  /** Native video px per marker cell to aim for. The decoder reads cleanly
   *  from ~8 px/cell up; m2/m3 were best around 12-18 (see hires-crop.ts). */
  targetPxPerCell: number;
  /** No adjustment while px/cell is within [target*lowFrac, target*highFrac]. */
  lowFrac: number;
  highFrac: number;
  /** Largest single zoom multiplier per adjustment (avoids overshoot). */
  maxStepFactor: number;
  /** Minimum time between adjustments: the camera needs time to apply the
   *  zoom and refocus before the next measurement means anything. */
  minIntervalMs: number;
  /** After an adjustment, wait until the measured size has moved at least this
   *  fraction (in log space) of the way to what the new zoom should produce. */
  confirmFraction: number;
  /** ...but give up waiting after this long. */
  confirmTimeoutMs: number;
  /** Stop adjusting after this many adjustments whose effect never showed up
   *  (camera ignoring the zoom request). */
  maxUnconfirmed: number;
}

export const DEFAULT_AUTO_ZOOM: AutoZoomConfig = {
  targetPxPerCell: 12,
  lowFrac: 0.78,   // ~9.4 px/cell
  highFrac: 1.35,  // ~16.2 px/cell
  maxStepFactor: 1.6,
  minIntervalMs: 800,
  confirmFraction: 0.7,
  confirmTimeoutMs: 2500,
  maxUnconfirmed: 2,
};

export interface AutoZoomInput {
  nowMs: number;
  zoom: number;
  zoomMin: number;
  zoomMax: number;
  step: number;
  /** Measured marker size, native video px per cell; null = no marker seen. */
  pxPerCell: number | null;
  /** The measurement has stopped changing (stable over several consecutive
   *  ticks). Required because frames lag the zoom request by a few hundred ms:
   *  right after a zoom change the measured size belongs to the OLD zoom, and
   *  scaling the NEW zoom by that correction sends the zoom the wrong way. */
  steady: boolean;
}

export class AutoZoom {
  private lastAdjustAt = -Infinity;
  private disabled = false;
  // The last adjustment's expected effect, until it has been observed. Frames
  // lag the zoom request, and a stale frame is CONSTANT across ticks, so
  // "steady" alone can't tell stale from settled.
  private pending: { fromPx: number; expectedPx: number; since: number } | null = null;
  private unconfirmed = 0;
  constructor(private cfg: AutoZoomConfig = DEFAULT_AUTO_ZOOM) {}

  /** A zoom was applied outside the controller (initial tier zoom): start the settle window. */
  noteApplied(nowMs: number) { this.lastAdjustAt = nowMs; }

  /** The user took manual control (touched the slider): stop adjusting. */
  disable() { this.disabled = true; }
  get active() { return !this.disabled; }
  reset() { this.lastAdjustAt = -Infinity; this.disabled = false; this.pending = null; this.unconfirmed = 0; }

  /** New zoom to apply, or null to leave it alone. */
  next(i: AutoZoomInput): number | null {
    if (this.disabled || i.pxPerCell === null || !(i.pxPerCell > 0) || !i.steady) return null;
    if (i.nowMs - this.lastAdjustAt < this.cfg.minIntervalMs) return null;
    if (this.pending) {
      const { fromPx, expectedPx, since } = this.pending;
      const progress = Math.log(i.pxPerCell / fromPx) / Math.log(expectedPx / fromPx);
      if (progress >= this.cfg.confirmFraction) {
        this.pending = null; this.unconfirmed = 0;
      } else if (i.nowMs - since > this.cfg.confirmTimeoutMs) {
        this.pending = null;
        if (++this.unconfirmed >= this.cfg.maxUnconfirmed) { this.disabled = true; return null; }
      } else {
        return null; // still waiting to see the last adjustment take effect
      }
    }
    const { targetPxPerCell: t, lowFrac, highFrac, maxStepFactor } = this.cfg;
    if (i.pxPerCell >= t * lowFrac && i.pxPerCell <= t * highFrac) return null;

    const factor = Math.max(1 / maxStepFactor, Math.min(maxStepFactor, t / i.pxPerCell));
    let z = Math.max(i.zoomMin, Math.min(i.zoomMax, i.zoom * factor));
    // snap to the camera's zoom step so the request is honoured exactly
    const step = i.step > 0 ? i.step : 0.1;
    z = i.zoomMin + Math.round((z - i.zoomMin) / step) * step;
    z = Math.max(i.zoomMin, Math.min(i.zoomMax, Math.round(z * 1000) / 1000));
    if (Math.abs(z - i.zoom) < step * 0.99) return null; // already at the limit / too small to matter
    this.lastAdjustAt = i.nowMs;
    const ratio = z / i.zoom;
    this.pending = Math.abs(Math.log(ratio)) > 0.1 ? { fromPx: i.pxPerCell, expectedPx: i.pxPerCell * ratio, since: i.nowMs } : null;
    return z;
  }
}
