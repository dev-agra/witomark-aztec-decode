"use client";
// TEMPORARY — self-supervised registration refinement: maximize data-cell confidence by coordinate descent
// from the detector's estimate; RS decides. Not part of the product.
import React, { useState } from "react";
import { decodeFromGrayscale, extractGrid, sampleBilinear } from "@/lib/aztec-detector";
import { G, CELL_PX, DCX, DCY, buildReservedMask, makeMask, encodeBits, rsDecodeBits, MSG_BITS, bullseyeCellColor, isSpokeCell } from "@/lib/aztec-marker";

function gray(data: ImageData): Uint8ClampedArray {
  const { data: d, width, height } = data;
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) g[i] = (d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) >> 8;
  return g;
}

const OFF = [-0.25, 0, 0.25];
const reserved = buildReservedMask();
let nAvail = 0;
for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) nAvail++;
const mask = makeMask("aztec-seed-v1", nAvail);

// per-cell 9-point averages for the whole grid at a geometry
function cellAverages(g: Uint8ClampedArray, w: number, cx: number, cy: number, scale: number, rot: number): Float32Array {
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const out = new Float32Array(G * G);
  for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) {
    let sum = 0;
    for (const ox of OFF) for (const oy of OFF) {
      const nx = (c * CELL_PX + CELL_PX / 2 + ox * CELL_PX) - DCX, ny = (r * CELL_PX + CELL_PX / 2 + oy * CELL_PX) - DCY;
      sum += sampleBilinear(g, w, cx + (nx * cos - ny * sin) * scale, cy + (nx * sin + ny * cos) * scale);
    }
    out[r * G + c] = sum / 9;
  }
  return out;
}

// levels from the marker's finder cells at the NOMINAL geometry, computed once (recomputing them per candidate
// lets the search game the normalisation)
function levelsOf(avgs: Float32Array) {
  let bs = 0, bn = 0, ws = 0, wn = 0;
  for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) {
    const bull = bullseyeCellColor(r, c);
    const light = bull !== null ? bull === 255 : isSpokeCell(r, c) ? false : null;
    if (light === null) continue;
    if (light) { ws += avgs[r * G + c]; wn++; } else { bs += avgs[r * G + c]; bn++; }
  }
  const black = bs / bn, white = ws / wn;
  return { thr: (black + white) / 2, half: Math.max(10, (white - black) / 2) };
}

function dataConfidence(avgs: Float32Array, lv: { thr: number; half: number }): number {
  let s = 0, n = 0;
  for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) {
    if (reserved[r][c] || bullseyeCellColor(r, c) !== null || isSpokeCell(r, c)) continue;
    s += Math.min(1, Math.abs(avgs[r * G + c] - lv.thr) / lv.half); n++;
  }
  return s / n;
}

interface P { ds: number; dx: number; dy: number; dr: number }

const LIM = { dsMin: -0.06, dsMax: 0.2, dMax: 0.3, drMax: 2 };

function refine(g: Uint8ClampedArray, w: number, est: { cx: number; cy: number; scale: number; rotationRad: number }, start: P, lv: { thr: number; half: number }) {
  const cellPx = CELL_PX * est.scale;
  const geom = (p: P) => ({ cx: est.cx + p.dx * cellPx, cy: est.cy + p.dy * cellPx, sc: est.scale * (1 + p.ds), rot: est.rotationRad + (p.dr * Math.PI) / 180 });
  const ok = (p: P) => p.ds >= LIM.dsMin && p.ds <= LIM.dsMax && Math.abs(p.dx) <= LIM.dMax && Math.abs(p.dy) <= LIM.dMax && Math.abs(p.dr) <= LIM.drMax;
  const f = (p: P) => { const q = geom(p); return dataConfidence(cellAverages(g, w, q.cx, q.cy, q.sc, q.rot), lv); };
  let p = { ...start }, best = f(p), evals = 1;
  for (const [sDs, sD, sDr] of [[0.04, 0.2, 1], [0.02, 0.1, 0.5], [0.01, 0.05, 0.25], [0.005, 0.025, 0.12]]) {
    let improved = true, guard = 0;
    while (improved && guard++ < 12) {
      improved = false;
      for (const key of ["ds", "dx", "dy", "dr"] as (keyof P)[]) {
        const step = key === "ds" ? sDs : key === "dr" ? sDr : sD;
        for (const sign of [1, -1]) {
          const q = { ...p, [key]: p[key] + sign * step };
          if (!ok(q)) continue;
          const v = f(q); evals++;
          if (v > best + 1e-6) { best = v; p = q; improved = true; break; }
        }
      }
    }
  }
  return { p, conf: best, evals, g: geom(p) };
}

const Page = () => {
  const [log, setLog] = useState<string[]>([]);
  const run = async () => {
    const L: string[] = ["data-confidence objective, coordinate descent from 5 starts (ds -3%..+12%); RS decides"];
    const truth = encodeBits("DEVANSH");
    for (const name of ["m1.jpeg", "m2.jpeg", "m3.jpeg", "n1.jpeg", "n2.jpeg", "n3.jpeg"]) {
      const img = await new Promise<HTMLImageElement>((res) => { const i = new Image(); i.onload = () => res(i); i.src = "/test-samples/" + name; });
      for (const [label, scaleTo] of [["700px canvas", 700]] as [string, number][]) {
        const k = scaleTo / Math.max(img.width, img.height);
        const w = Math.round(img.width * k), h = Math.round(img.height * k);
        const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
        const ctx = cv.getContext("2d", { willReadFrequently: true })!; ctx.drawImage(img, 0, 0, w, h);
        const g = gray(ctx.getImageData(0, 0, w, h));
        const base = decodeFromGrayscale(g, w, "aztec-seed-v1");
        const est = base.markerEstimate;
        if (!est) { L.push(`${name} ${label}: no estimate`); continue; }
        const lv = levelsOf(cellAverages(g, w, est.cx, est.cy, est.scale, est.rotationRad));
        const nominalConf = dataConfidence(cellAverages(g, w, est.cx, est.cy, est.scale, est.rotationRad), lv);
        const t0 = performance.now();
        const optima: { r: ReturnType<typeof refine>; ds0: number }[] = [];
        let totalEvals = 0;
        for (const ds0 of [-0.03, 0, 0.04, 0.08, 0.12]) {
          const r = refine(g, w, est, { ds: ds0, dx: 0, dy: 0, dr: 0 }, lv);
          totalEvals += r.evals;
          optima.push({ r, ds0 });
        }
        const ms = performance.now() - t0;
        const baseNote = base.status === "DECODE_OK" ? `baseline DECODES "${base.id}"` : "baseline FAILS";
        L.push(`${name} ${label}: ${baseNote} | ${totalEvals} evals ${ms.toFixed(0)}ms | nominal confidence ${nominalConf.toFixed(3)}`);
        const seen = new Set<string>();
        for (const { r, ds0 } of optima) {
          const q = r.g;
          const key = `${r.p.ds.toFixed(3)}|${r.p.dx.toFixed(2)}|${r.p.dy.toFixed(2)}|${r.p.dr.toFixed(2)}`;
          if (seen.has(key)) continue; seen.add(key);
          const grid = extractGrid(g, w, q.cx, q.cy, q.sc, q.rot - Math.PI / 2, lv.thr);
          const flat: number[] = [];
          for (let rr = 0; rr < G; rr++) for (let cc = 0; cc < G; cc++) if (!reserved[rr][cc]) flat.push(grid[rr][cc]);
          const un = flat.map((bb, i) => bb ^ mask[i]).slice(0, MSG_BITS);
          const id = rsDecodeBits(un);
          let e = 0; for (let i = 0; i < truth.length; i++) if (un[i] !== truth[i]) e++;
          L.push(`    start ${(ds0 * 100).toFixed(0).padStart(3)}% -> scale ${(r.p.ds >= 0 ? "+" : "")}${(r.p.ds * 100).toFixed(1)}%, shift (${r.p.dx.toFixed(2)},${r.p.dy.toFixed(2)}), rot ${r.p.dr.toFixed(2)}deg, conf ${r.conf.toFixed(3)}, ${e}/256 bits wrong, RS ${id !== null ? `DECODES "${id}"` : "fails"}`);
        }
        setLog([...L]);
      }
    }
    setLog([...L]);
  };
  return (
    <div className="p-4">
      <button onClick={run} className="border px-3 py-1 mb-3">Run</button>
      <div className="whitespace-pre-wrap font-mono text-xs bg-gray-100 p-3 rounded">{log.join("\n")}</div>
    </div>
  );
};
export default Page;
