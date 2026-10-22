// A small pool of watermark workers. Falls back to running on the calling thread when Workers
// can't be created, so the page still works (just slower).

import { processJob, type WmJob, type WmResult } from "./wm-job";

export type { WmJob, WmResult };

export class WmPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private waiting: { job: WmJob; resolve: (r: WmResult) => void }[] = [];
  private inflight = new Map<Worker, { n: number; job: WmJob; resolve: (r: WmResult) => void }>();
  private seq = 0;
  private dead = false;

  constructor(size: number) {
    try {
      for (let i = 0; i < size; i++) {
        const w = new Worker(new URL("./wm.worker.ts", import.meta.url));
        w.onmessage = (e: MessageEvent<{ n: number; result: WmResult }>) => {
          const cur = this.inflight.get(w);
          if (!cur || cur.n !== e.data.n) return;
          this.inflight.delete(w);
          cur.resolve(e.data.result);
          this.release(w);
        };
        w.onerror = () => {
          // a failing worker: redo its job inline and retire it
          const cur = this.inflight.get(w);
          this.inflight.delete(w);
          this.workers = this.workers.filter((x) => x !== w);
          w.terminate();
          if (cur) setTimeout(() => cur.resolve(processJob(cur.job)), 0);
        };
        this.workers.push(w);
        this.idle.push(w);
      }
    } catch {
      this.workers.forEach((w) => w.terminate());
      this.workers = []; this.idle = [];
    }
  }

  /** Number of jobs worth keeping in flight. */
  get size(): number { return Math.max(1, this.workers.length); }

  run(job: WmJob): Promise<WmResult> {
    return new Promise((resolve) => {
      if (this.dead) return;
      if (this.workers.length === 0) {
        setTimeout(() => resolve(processJob(job)), 0);
        return;
      }
      this.waiting.push({ job, resolve });
      this.pump();
    });
  }

  private release(w: Worker) { this.idle.push(w); this.pump(); }

  private pump() {
    while (this.idle.length && this.waiting.length) {
      const w = this.idle.pop()!;
      const next = this.waiting.shift()!;
      const n = ++this.seq;
      this.inflight.set(w, { n, job: next.job, resolve: next.resolve });
      w.postMessage({ n, job: next.job });
    }
  }

  terminate() {
    this.dead = true;
    this.workers.forEach((w) => w.terminate());
    this.workers = []; this.idle = []; this.waiting = []; this.inflight.clear();
  }
}
