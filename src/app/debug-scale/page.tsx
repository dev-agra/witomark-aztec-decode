"use client";
// TEMPORARY — how reliable is markerEstimate.scale as the marker gets larger? Not part of the product.
import React, { useState } from "react";
import { decodeFromGrayscale } from "@/lib/aztec-detector";
import { CELL_PX } from "@/lib/aztec-marker";

function gray(data: ImageData): Uint8ClampedArray {
  const { data: d, width, height } = data;
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) g[i] = (d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) >> 8;
  return g;
}

const SAMPLES: Record<string, { pxCell: number; cx: number; cy: number }> = {
  "n1.jpeg": { pxCell: 13.4, cx: 612, cy: 688 },
  "m2.jpeg": { pxCell: 19.3, cx: 587, cy: 859 },
};

const Page = () => {
  const [log, setLog] = useState<string[]>([]);
  const run = async () => {
    const L: string[] = ["true native px/cell vs estimated (video 1280x960, detector on 700px canvas; est px/cell = est.scale/k*8)"];
    for (const name of Object.keys(SAMPLES)) {
      const meta = SAMPLES[name];
      const im = await new Promise<HTMLImageElement>((res) => { const i = new Image(); i.onload = () => res(i); i.src = "/test-samples/" + name; });
      L.push(`-- ${name}`);
      for (const truePx of [4, 6, 8, 12, 16, 20, 24, 32, 40]) {
        const FW = 1280, FH = 960, k = 700 / FW;
        const cv = document.createElement("canvas"); cv.width = FW; cv.height = FH;
        const c = cv.getContext("2d", { willReadFrequently: true })!;
        const s = truePx / meta.pxCell;
        c.fillStyle = "#fff"; c.fillRect(0, 0, FW, FH);
        c.drawImage(im, FW / 2 - meta.cx * s, FH / 2 - meta.cy * s, im.width * s, im.height * s);
        const cw = 700, ch = Math.round(FH * k);
        const c2 = document.createElement("canvas"); c2.width = cw; c2.height = ch;
        const x2 = c2.getContext("2d", { willReadFrequently: true })!; x2.drawImage(cv, 0, 0, cw, ch);
        const guide = 0.625 * Math.min(cw, ch);
        const r = decodeFromGrayscale(gray(x2.getImageData(0, 0, cw, ch)), cw, "aztec-seed-v1", { cx: cw / 2, cy: ch / 2, halfSize: guide / 2 });
        const e = r.markerEstimate;
        const estPx = e ? (e.scale / k) * CELL_PX : null;
        L.push(`true ${truePx}px/cell -> ${r.status}${r.id ? ` "${r.id}"` : ""} est ${estPx === null ? "none" : estPx.toFixed(1) + "px/cell (x" + (estPx / truePx).toFixed(2) + ") okRays " + e!.okRays + " finderWrong " + e!.finderWrong}`);
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
