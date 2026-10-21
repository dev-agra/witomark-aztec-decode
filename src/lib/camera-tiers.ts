// Camera selection + initial zoom for the live scan, ported in spirit from the
// TS scan flow (src/lib/camera.ts there): pick the back camera by its minimum
// focus distance and start at a zoom for that band.
//
// Two deliberate differences from the TS version:
//  1. No hard "Device not supported" failure — a device that reports no
//     focusDistance/zoom (Safari/iOS, some Android builds) falls back to the
//     plain default camera, which is what this page did before.
//  2. The zoom values are only a STARTING point. They come from the TS bands
//     (calibrated for a different marker) and a geometric estimate for our 7mm
//     marker at a 1280px feed (~4-6x); auto-zoom.ts corrects them from the
//     marker size actually measured. Treat the table as provisional until
//     checked on real devices (use ?debug to log what each phone reports).

export interface CameraCaps {
  deviceId: string;
  label: string;
  focusMin: number | null;
  focusMax: number | null;
  zoomMin: number | null;
  zoomMax: number | null;
  error?: string;
}

export interface CameraTier {
  /** Index of the focus-distance band that matched (0-based). */
  band: number;
  /** Requested feed size (px, both axes `ideal`). Kept at 1280: the detector
   *  works on a 700px canvas, so a much larger feed would push the marker
   *  below the detection floor (see the high-res crop notes). */
  feedPx: number;
  /** Starting zoom for this band. */
  zoom: number;
}

export const FEED_PX = 1280;

const TIER_BANDS: Array<{ min: number; max: number; zoom: number }> = [
  { min: 0.01, max: 0.11, zoom: 5 },
  { min: 0.11, max: 0.16, zoom: 4 },
  { min: 0.16, max: 0.21, zoom: 5.6 },
];

/** iOS exposes combo lenses ("Back Triple Camera") that report the closest-
 *  focusing constituent lens; the plain "Back Camera" is the lens actually
 *  used at these zooms, so probe only that one when present. */
export function filterIosBackCamera<T extends { label: string }>(devices: T[], isIOS: boolean): T[] {
  if (!isIOS) return devices;
  const only = devices.filter((d) => d.label.trim().toLowerCase() === "back camera");
  return only.length > 0 ? only : devices;
}

const EXCLUDED_LABELS = ["ultra wide", "wide", "dual wide", "telephoto"];

/** Tie-break inside one band: widest focus range if reported, else the plain
 *  "Back Camera", else the first without a wide/tele label, else the first. */
export function pickBestInBand(cands: CameraCaps[]): CameraCaps {
  if (cands.some((c) => c.focusMax !== null)) {
    const range = (c: CameraCaps) => (c.focusMax !== null ? c.focusMax - (c.focusMin ?? 0) : -1);
    return cands.reduce((best, c) => (range(c) > range(best) ? c : best));
  }
  const clean = (l: string) => !EXCLUDED_LABELS.some((e) => l.toLowerCase().includes(e));
  return (
    cands.find((c) => c.label.toLowerCase() === "back camera") ??
    cands.find((c) => clean(c.label)) ??
    cands[0]
  );
}

/** First matching band wins (bands never merge). Null when no camera reports a
 *  focusDistance in any band — the caller falls back to the default camera. */
export function pickCameraTier(cands: CameraCaps[]): { cap: CameraCaps; tier: CameraTier } | null {
  for (let band = 0; band < TIER_BANDS.length; band++) {
    const b = TIER_BANDS[band];
    const inBand = cands.filter((c) => c.focusMin !== null && c.focusMin >= b.min && c.focusMin < b.max);
    if (inBand.length === 0) continue;
    const cap = pickBestInBand(inBand);
    return { cap, tier: { band, feedPx: FEED_PX, zoom: b.zoom } };
  }
  return null;
}

/** Starting zoom clamped to what the camera actually supports (never fails). */
export function clampZoom(zoom: number, zoomMin: number | null, zoomMax: number | null): number {
  const lo = zoomMin ?? 1, hi = zoomMax ?? zoom;
  return Math.max(lo, Math.min(hi, zoom));
}

// ── Probing (browser only) ──────────────────────────────────────────────

// A low-res stream negotiates much faster than a full-size one, and
// capabilities are reported the same either way.
export async function probeCamera(deviceId: string, label: string): Promise<CameraCaps> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } },
    });
    const track = stream.getVideoTracks()[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caps = (track.getCapabilities?.() ?? {}) as any;
    stream.getTracks().forEach((t) => t.stop());
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      deviceId, label,
      focusMin: num(caps.focusDistance?.min), focusMax: num(caps.focusDistance?.max),
      zoomMin: num(caps.zoom?.min), zoomMax: num(caps.zoom?.max),
    };
  } catch (e) {
    return { deviceId, label, focusMin: null, focusMax: null, zoomMin: null, zoomMax: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function selectCamera(
  devices: MediaDeviceInfo[], onLog?: (msg: string) => void
): Promise<{ cap: CameraCaps; tier: CameraTier } | null> {
  const isIOS = typeof navigator !== "undefined" && /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const candidates = filterIosBackCamera(devices, isIOS);
  const caps: CameraCaps[] = [];
  for (const d of candidates) {
    const c = await probeCamera(d.deviceId, d.label);
    caps.push(c);
    onLog?.(`[camera] "${c.label || "(no label)"}" focus ${c.focusMin ?? "?"}-${c.focusMax ?? "?"} zoom ${c.zoomMin ?? "?"}-${c.zoomMax ?? "?"}${c.error ? ` ERR ${c.error}` : ""}`);
  }
  return pickCameraTier(caps);
}

// ── Cache ───────────────────────────────────────────────────────────────
// Probing opens every back camera in turn (~0.2-0.5s each on a low-end
// phone). deviceIds are stable per origin, so remember the choice and skip
// the probe on later scans.
const CACHE_KEY = "witomark.camera.v1";

export function loadCachedTier(): { deviceId: string; tier: CameraTier } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v?.deviceId === "string" && typeof v?.tier?.zoom === "number") return v;
  } catch { /* storage unavailable */ }
  return null;
}

export function saveCachedTier(deviceId: string, tier: CameraTier) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ deviceId, tier })); } catch { /* ignore */ }
}
