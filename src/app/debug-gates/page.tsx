"use client";
// TEMPORARY — checks the size/motion gates on real sample photos. Not part of the product.
import React, { useState } from "react";
import { decodeFromGrayscale } from "@/lib/aztec-detector";
import { evaluateSize, markerSidePx, pxPerCell, MotionTracker, makeThumb, chooseGuidance } from "@/lib/scan-gates";

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

// draw img scaled to 700-long-side, optionally shifted / zoomed about the canvas center
function render(img: HTMLImageElement, dx = 0, dy = 0, zoom = 1) {
  const k = 700 / Math.max(img.width, img.height);
  const w = Math.round(img.width * k), h = Math.round(img.height * k);
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2 + dx, h / 2 + dy); ctx.scale(zoom, zoom); ctx.translate(-w / 2, -h / 2);
  ctx.drawImage(img, 0, 0, w, h);
  return { g: gray(ctx.getImageData(0, 0, w, h)), w, h };
}

const Page = () => {
  const [log, setLog] = useState<string[]>([]);
  const run = async () => {
    const lines: string[] = [];
    lines.push("== size gate on real samples (700px canvas, guide = 0.625*min side) ==");
    for (const name of ["p1.jpeg", "m1.jpeg", "m2.jpeg", "m3.jpeg", "n1.jpeg", "n2.jpeg", "n3.jpeg"]) {
      const img = await load(name);
      const { g, w, h } = render(img);
      const r = decodeFromGrayscale(g, w, "aztec-seed-v1");
      const guide = 0.625 * Math.min(w, h);
      const e = r.markerEstimate;
      lines.push(`${name} ${w}x${h}: ${r.status}${r.id ? ` "${r.id}"` : ""} | estimate ${e ? `scale ${e.scale.toFixed(2)} ok${e.okRays} finderWrong ${e.finderWrong}/38 side ${markerSidePx(e.scale).toFixed(0)}px ${pxPerCell(e.scale).toFixed(1)}px/cell guide ${guide.toFixed(0)}px -> ${evaluateSize(e.scale, guide)}` : "none"}`);
      setLog([...lines]);
    }

    lines.push("== motion math on m2: known 6px shift and 1.1x zoom ==");
    const m2 = await load("m2.jpeg");
    const cases: [string, number, number, number][] = [["still", 0, 0, 1], ["still again", 0, 0, 1], ["shift 6px", 6, 0, 1], ["zoom 1.1x", 0, 0, 1.1], ["shift 20px", 20, 0, 1]];
    const tracker = new MotionTracker();
    for (const [label, dx, dy, z] of cases) {
      const { g, w, h } = render(m2, dx, dy, z);
      const r = decodeFromGrayscale(g, w, "aztec-seed-v1");
      const e = r.markerEstimate;
      if (!e) { lines.push(`${label}: no estimate`); continue; }
      const half = 0.3125 * Math.min(w, h);
      const m = tracker.push({ cx: e.cx, cy: e.cy, scale: e.scale, thumb: makeThumb(g, w, w / 2, h / 2, half) });
      const guide = 0.625 * Math.min(w, h);
      lines.push(`${label}: center (${e.cx.toFixed(1)},${e.cy.toFixed(1)}) scale ${e.scale.toFixed(3)} | jitter ${m.jitterCells?.toFixed(2) ?? "-"} cells, scaleChange ${m.scaleChange?.toFixed(3) ?? "-"}, thumbDiff ${m.thumbDiff?.toFixed(1) ?? "-"}, stableTicks ${m.stableTicks}, steady ${m.steady} -> guidance ${chooseGuidance(evaluateSize(e.scale, guide), m)}`);
      setLog([...lines]);
    }
    setLog([...lines]);
  };
  return (
    <div className="p-4">
      <button onClick={run} className="border px-3 py-1 mb-3">Run</button>
      <div className="whitespace-pre-wrap font-mono text-xs bg-gray-100 p-3 rounded">{log.join("\n")}</div>
    </div>
  );
};
export default Page;
