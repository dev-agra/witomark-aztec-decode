// Web Worker: runs one watermark job (decode + alignment + BER) off the UI thread.
import { processJob, type WmJob } from "./wm-job";

self.onmessage = (e: MessageEvent<{ n: number; job: WmJob }>) => {
  const { n, job } = e.data;
  (self as unknown as Worker).postMessage({ n, result: processJob(job) });
};
