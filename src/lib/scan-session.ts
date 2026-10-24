// "Decode in Session": records of decoded markers with their per-frame watermark BERs, exported to .xlsx.

import { buildXlsx, type Cell } from "./xlsx-lite";
import { WM_TARGET_FRAMES } from "./wm-scoring";

export interface FrameRecord { frame: number; rho: number | null; ber: number | null; note: string }

export interface SessionRecord {
  n: number;
  time: string;
  id: string;
  method: string;
  /** Watermark settings the marker was generated with (from the ID, or typed in); null = unknown / unwatermarked. */
  strength: number | null;
  pairEncoded: string;
  /** Coefficient pair the BERs were read with. */
  pairRead: string;
  seed: string;
  notes: string;
  frames: FrameRecord[];
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export function recordStats(r: SessionRecord) {
  const bers = r.frames.map((f) => f.ber).filter((b): b is number => b !== null);
  const rhos = r.frames.map((f) => f.rho).filter((b): b is number => b !== null);
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    best: bers.length ? Math.min(...bers) : null,
    worst: bers.length ? Math.max(...bers) : null,
    mean: mean(bers),
    meanRho: mean(rhos),
    count: bers.length,
  };
}

export function buildSessionWorkbook(records: SessionRecord[]): Uint8Array {
  const nBer = Math.max(WM_TARGET_FRAMES, ...records.map((r) => r.frames.length));
  const head: Cell[] = [
    "#", "Time", "Decoded ID", "Decode method", "Strength (encoded)", "Pair (encoded)", "Pair (read with)", "Seed",
    "Frames", "Best BER %", "Mean BER %", "Worst BER %", "Mean rho", "Notes",
    ...Array.from({ length: nBer }, (_, i) => `BER ${i + 1} %`),
  ];
  const session: Cell[][] = [head, ...records.map((r) => {
    const st = recordStats(r);
    return [
      r.n, r.time, r.id, r.method, r.strength, r.pairEncoded, r.pairRead, r.seed,
      st.count, st.best === null ? null : round(st.best), st.mean === null ? null : round(st.mean), st.worst === null ? null : round(st.worst),
      st.meanRho === null ? null : round(st.meanRho), r.notes,
      ...Array.from({ length: nBer }, (_, i) => (r.frames[i]?.ber == null ? null : round(r.frames[i].ber!))),
    ];
  })];
  const frames: Cell[][] = [["#", "Decoded ID", "Frame", "rho", "BER %", "Note"]];
  for (const r of records) for (const f of r.frames) {
    frames.push([r.n, r.id, f.frame, f.rho === null ? null : round(f.rho), f.ber === null ? null : round(f.ber), f.note]);
  }
  return buildXlsx([
    { name: "Session", rows: session, widths: [5, 20, 18, 14, 12, 16, 16, 16, 8, 11, 11, 11, 9, 24, ...Array(nBer).fill(10)] },
    { name: "Frames", rows: frames, widths: [5, 18, 7, 8, 9, 30] },
  ]);
}

export function downloadXlsx(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function sessionFilename(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `Decode in Session ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}.xlsx`;
}
