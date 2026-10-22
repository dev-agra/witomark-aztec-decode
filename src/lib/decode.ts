// Decode entry point: the standard detector pass, then (optionally) the
// registration-refinement fallback. Kept separate from aztec-detector.ts
// because registration.ts imports the detector's primitives.

import { decodeFromGrayscale, type DecodeDebugInfo, type Roi } from "./aztec-detector";
import { registrationDecode } from "./registration";

export interface DecodeOptions {
  /** Run the registration-refinement fallback if the standard pass fails. */
  registration?: boolean;
  /** Live scan: cap the number of climbs and the time spent on them. */
  registrationStarts?: number;
  registrationBudgetMs?: number;
}

export function decodeWithFallbacks(
  grayscale: Uint8Array | Uint8ClampedArray, size: number, seed: string, roi: Roi | null = null, opts: DecodeOptions = {}
): DecodeDebugInfo {
  const r = decodeFromGrayscale(grayscale, size, seed, roi);
  if (r.status === "DECODE_OK" || !opts.registration || !r.markerEstimate) return r;
  const est = r.markerEstimate;
  const reg = registrationDecode(grayscale, size, est, seed, { maxStarts: opts.registrationStarts, budgetMs: opts.registrationBudgetMs });
  if (!reg) return r;
  return {
    ...r,
    status: "DECODE_OK",
    id: reg.id,
    method: "registration",
    detectedCenter: [reg.geometry.cx, reg.geometry.cy],
    refinedScale: reg.geometry.scale,
    rotationDeg: (reg.geometry.rotationRad * 180) / Math.PI,
    okRays: est.okRays,
    successGeometry: reg.geometry,
    // the estimate is the candidate registration refined; show it as the decoded one
    candidateLog: (r.candidateLog ?? []).map((c) => (Math.hypot(c.cx - est.cx, c.cy - est.cy) < 1 ? { ...c, scale: reg.geometry.scale, decoded: true } : c))
      .sort((a, b) => Number(b.decoded) - Number(a.decoded) || a.finderWrong - b.finderWrong),
  };
}
