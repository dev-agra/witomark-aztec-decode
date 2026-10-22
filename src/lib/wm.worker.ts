// Web Worker: runs the watermark alignment + BER for one frame, off the UI thread.
import { verifyWatermark, type WmGeometry } from "./wm-align";
import type { CoeffPair } from "./watermark";

export interface WmJob {
  gray: Uint8ClampedArray; w: number; geo: WmGeometry; id: string; seed: string; pair: CoeffPair; warm?: number[];
}

self.onmessage = (e: MessageEvent<{ n: number; job: WmJob }>) => {
  const { n, job } = e.data;
  const reading = verifyWatermark(job.gray, job.w, job.geo, job.id, job.seed, job.pair, job.warm);
  (self as unknown as Worker).postMessage({ n, reading });
};
