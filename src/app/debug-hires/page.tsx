"use client";
// TEMPORARY — does decoding a native-resolution crop around the marker beat the 700px canvas? Not part of the product.
import React, { useState } from "react";
import { decodeFromGrayscale, computeOtsuThreshold, extractGrid } from "@/lib/aztec-detector";
import { G, CELL_PX, buildReservedMask, makeMask, encodeBits } from "@/lib/aztec-marker";

function gray(data: ImageData): Uint8ClampedArray {
  const { data: d, width, height } = data;
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) g[i] = (d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) >> 8;
  return g;
}

async function load(name: string) {
  const img = new Image();
  await new Promise<void>((res) => { img.onload = () => res(); img.src = `/test-samples/${name}`; });
  return img;
}

// bit/byte errors of the grid read at an estimated geometry, vs the KNOWN codeword
function bitErrors(g: Uint8ClampedArray, w: number, est: { cx: number; cy: number; scale: number; rotationRad: number }) {
  const thr = computeOtsuThreshold(g);
  const ang = est.rotationRad - Math.PI / 2;
  const bits = extractGrid(g, w, est.cx, est.cy, est.scale, ang, thr);
  const reserved = buildReservedMask();
  let nAvail = 0;
  for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) nAvail++;
  const mask = makeMask("aztec-seed-v1", nAvail);
  const flat: number[] = [];
  for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) flat.push(bits[r][c]);
  const un = flat.map((b, i) => b ^ mask[i]);
  const truth = encodeBits("DEVANSH");
  let bitWrong = 0; const byteWrong = new Set<number>();
  for (let i = 0; i < truth.length; i++) if (un[i] !== truth[i]) { bitWrong++; byteWrong.add(i >> 3); }
  return `${bitWrong}/256 bits (${((100 * bitWrong) / 256).toFixed(0)}%), ${byteWrong.size}/32 bytes wrong`;
}

const Page = () => {
  const [log, setLog] = useState<string[]>([]);
  const runBits = async () => {
    const lines: string[] = ["bit errors vs known DEVANSH codeword (RS fixes <=8 bytes; erasure-aware could reach 16 known-position bytes)"];
    for (const name of ["m1.jpeg", "m2.jpeg", "m3.jpeg"]) {
      const img = await load(name);
      const k = 700 / Math.max(img.width, img.height);
      const w = Math.round(img.width * k), h = Math.round(img.height * k);
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true })!; ctx.drawImage(img, 0, 0, w, h);
      const g0 = gray(ctx.getImageData(0, 0, w, h));
      const est = decodeFromGrayscale(g0, w, "aztec-seed-v1").markerEstimate;
      if (!est) continue;
      lines.push(`${name}: 700px canvas        ${bitErrors(g0, w, est)}`);
      const side = (G * CELL_PX * est.scale) / k, ccx = est.cx / k, ccy = est.cy / k, half = side * 0.85;
      const sx = Math.max(0, Math.round(ccx - half)), sy = Math.max(0, Math.round(ccy - half));
      const sw = Math.min(img.width, Math.round(ccx + half)) - sx, sh = Math.min(img.height, Math.round(ccy + half)) - sy;
      for (const f of [1, 0.75, 0.5]) {
        const cw = Math.round(sw * f), ch = Math.round(sh * f);
        const c2 = document.createElement("canvas"); c2.width = cw; c2.height = ch;
        const x2 = c2.getContext("2d", { willReadFrequently: true })!; x2.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);
        const g2 = gray(x2.getImageData(0, 0, cw, ch));
        const e2 = decodeFromGrayscale(g2, cw, "aztec-seed-v1").markerEstimate;
        lines.push(`${name}: native crop x${f}      ${e2 ? bitErrors(g2, cw, e2) : "no estimate"}`);
      }
      setLog([...lines]);
    }
    setLog([...lines]);
  };
  const run = async () => {
    const lines: string[] = [];
    for (const name of ["p1.jpeg", "m1.jpeg", "m2.jpeg", "m3.jpeg", "n1.jpeg", "n2.jpeg", "n3.jpeg"]) {
      const img = await load(name);
      const k = 700 / Math.max(img.width, img.height);
      const w = Math.round(img.width * k), h = Math.round(img.height * k);
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true })!; ctx.drawImage(img, 0, 0, w, h);
      const base = decodeFromGrayscale(gray(ctx.getImageData(0, 0, w, h)), w, "aztec-seed-v1");
      const est = base.markerEstimate;
      lines.push(`${name} native ${img.width}x${img.height} (k=${k.toFixed(3)})  700px canvas: ${base.status}${base.id ? ` "${base.id}"` : ""}  est ${est ? `scale ${est.scale.toFixed(2)} (${(est.scale * CELL_PX).toFixed(1)} px/cell)` : "none"}`);
      if (!est) { setLog([...lines]); continue; }
      const side = (G * CELL_PX * est.scale) / k; // marker side in native px
      const ccx = est.cx / k, ccy = est.cy / k;
      const half = side * 0.85; // crop = 1.7x marker side
      const sx = Math.max(0, Math.round(ccx - half)), sy = Math.max(0, Math.round(ccy - half));
      const sw = Math.min(img.width, Math.round(ccx + half)) - sx, sh = Math.min(img.height, Math.round(ccy + half)) - sy;
      lines.push(`  crop ${sw}x${sh} native px around marker (side ${side.toFixed(0)}px native = ${(side / G).toFixed(1)} px/cell)`);
      for (const f of [1, 0.75, 0.5, 0.35]) {
        const cw = Math.round(sw * f), ch = Math.round(sh * f);
        const c2 = document.createElement("canvas"); c2.width = cw; c2.height = ch;
        const x2 = c2.getContext("2d", { willReadFrequently: true })!;
        x2.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);
        const t0 = performance.now();
        const r = decodeFromGrayscale(gray(x2.getImageData(0, 0, cw, ch)), cw, "aztec-seed-v1");
        const dt = performance.now() - t0;
        const e = r.markerEstimate;
        lines.push(`    crop x${f} (${cw}x${ch}): ${r.status}${r.id ? ` "${r.id}"` : ""} tried=${r.candidatesTried} ${dt.toFixed(0)}ms  est ${e ? `scale ${e.scale.toFixed(2)} (${(e.scale * CELL_PX).toFixed(1)} px/cell) finderWrong ${e.finderWrong}/38` : "none"}`);
        setLog([...lines]);
      }
    }
    setLog([...lines]);
  };
  return (
    <div className="p-4">
      <button onClick={run} className="border px-3 py-1 mb-3 mr-2">Run</button><button onClick={runBits} className="border px-3 py-1 mb-3">Bit errors</button>
      <div className="whitespace-pre-wrap font-mono text-xs bg-gray-100 p-3 rounded">{log.join("\n")}</div>
    </div>
  );
};
export default Page;
