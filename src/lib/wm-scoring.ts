// Per-frame watermark scores and the SQR verdict rule, kept free of React/canvas
// so the decode page and the debug panel share one definition.
//
// SQR backend rule (sentinel-main): best BER <= threshold -> genuine. Otherwise
// take x = best BER and y = x + margin (6 / 5 / 4 / 3 as x is <20 / <30 / <40 /
// beyond); if at least 40% of the frames score inside [x, y] the readings agree
// with each other but not with the ID -> "counterfeit" (a consistent copy),
// else the frames just disagree -> "blurred" (bad capture, rescan).

import type { WmReading } from "./wm-align";

export const WM_BER_THRESHOLD = 32;
export const WM_TARGET_FRAMES = 20;
export const WM_SCORING_TIMEOUT_MS = 25000;
const CONSISTENT_FRACTION = 0.4;

export interface CandidateScore {
  cx: number; cy: number;
  pxPerCell: number;
  finderWrong: number;
  okRays: number;
  decoded: boolean;
  /** Only the decoded candidate has an ID to compare against, so only it is scored. */
  reading: WmReading | null;
}

export interface FrameScore {
  index: number;
  decoded: boolean;
  id: string | null;
  method: string;
  candidatesTried: number;
  reading: WmReading | null;
  candidates: CandidateScore[];
  note?: string;
}

export type WmVerdict = "genuine" | "counterfeit" | "blurred" | "no-reading";

export interface WmSummary {
  scored: number;
  best: number | null;
  bestIndex: number | null;
  withinMargin: number;
  verdict: WmVerdict;
  margin: number;
}

export function consistencyMargin(best: number): number {
  return best < 20 ? 6 : best < 30 ? 5 : best < 40 ? 4 : 3;
}

export function summarize(frames: FrameScore[], threshold = WM_BER_THRESHOLD): WmSummary {
  let best: number | null = null, bestIndex: number | null = null, scored = 0;
  for (const f of frames) {
    const b = f.reading?.usable ? f.reading.ber : null;
    if (b === null || b === undefined) continue;
    scored++;
    if (best === null || b < best) { best = b; bestIndex = f.index; }
  }
  if (best === null) return { scored: 0, best: null, bestIndex: null, withinMargin: 0, verdict: "no-reading", margin: 0 };
  const margin = consistencyMargin(best);
  let withinMargin = 0;
  for (const f of frames) {
    const b = f.reading?.usable ? f.reading.ber : null;
    if (b !== null && b !== undefined && b >= best && b <= best + margin) withinMargin++;
  }
  const verdict: WmVerdict = best <= threshold ? "genuine" : withinMargin / scored >= CONSISTENT_FRACTION ? "counterfeit" : "blurred";
  return { scored, best, bestIndex, withinMargin, verdict, margin };
}
