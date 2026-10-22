// One unit of watermark work, shared by the worker and the main-thread fallback.
//
// Two kinds:
//  - decode job: find and decode the marker in a raw frame crop, then read its watermark BER from the
//    geometry that decode produced (so each frame is aligned on its own, not on a neighbour's position);
//  - verify job: read the BER for a known ID from a given starting geometry (used for frames that
//    didn't decode, and when the coefficient pair changes).

import { decodeWithFallbacks } from "./decode";
import type { DecodeDebugInfo } from "./aztec-detector";
import { verifyWatermark, type WmGeometry, type WmReading } from "./wm-align";
import type { CoeffPair } from "./watermark";

export interface WmJob {
  gray: Uint8ClampedArray; w: number; seed: string; pair: CoeffPair;
  /** Decode the marker in the crop first (ignores geo/id). */
  decode?: boolean;
  geo?: WmGeometry; id?: string; warm?: number[];
}

export interface WmResult {
  reading: WmReading | null;
  decode?: DecodeDebugInfo;
  /** Geometry (crop pixels) the reading was taken from. */
  geo?: WmGeometry;
}

export function processJob(job: WmJob): WmResult {
  if (job.decode) {
    const d = decodeWithFallbacks(job.gray, job.w, job.seed, null, { registration: true, registrationStarts: 2, registrationBudgetMs: 400 });
    if (d.status === "DECODE_OK" && d.successGeometry && d.id) {
      const geo = d.successGeometry;
      return { reading: verifyWatermark(job.gray, job.w, geo, d.id, job.seed, job.pair), decode: d, geo };
    }
    return { reading: null, decode: d };
  }
  if (!job.geo || !job.id) return { reading: null };
  return { reading: verifyWatermark(job.gray, job.w, job.geo, job.id, job.seed, job.pair, job.warm), geo: job.geo };
}
