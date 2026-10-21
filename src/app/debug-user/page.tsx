"use client";
// TEMPORARY — registration fallback across every real capture, incl. the user's phone screenshots. Not part of the product.
import React, { useState } from "react";
import { decodeFromGrayscale } from "@/lib/aztec-detector";
import { decodeWithFallbacks } from "@/lib/decode";

function gray(data: ImageData): Uint8ClampedArray {
  const { data: d, width, height } = data;
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) g[i] = (d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) >> 8;
  return g;
}

interface Case { name: string; label: string; crop?: [number, number, number, number]; f: number; truth: string }
const CASES: Case[] = [];
for (const [n, t] of [["m1.jpeg", "DEVANSH"], ["m2.jpeg", "DEVANSH"], ["m3.jpeg", "DEVANSH"], ["n1.jpeg", "DEVANSH"], ["n2.jpeg", "DEVANSH"], ["n3.jpeg", "DEVANSH"]] as [string, string][])
  CASES.push({ name: n, label: "700px canvas", f: 0, truth: t });
for (const [n, t] of [["u1.jpeg", "LABELBLIND"], ["u2.jpeg", "ABCDEFGH12345678"]] as [string, string][])
  for (const f of [0.5, 0.7, 1, 1.4, 2]) CASES.push({ name: n, label: `phone screenshot crop x${f}`, crop: [120, 540, 280, 260], f, truth: t });

const Page = () => {
  const [log, setLog] = useState<string[]>([]);
  const run = async () => {
    const L: string[] = [];
    let okFull = 0, okLive = 0, okStd = 0;
    for (const c of CASES) {
      const img = await new Promise<HTMLImageElement>((res) => { const i = new Image(); i.onload = () => res(i); i.src = "/test-samples/" + c.name; });
      let w: number, h: number;
      const cv = document.createElement("canvas");
      let ctx: CanvasRenderingContext2D;
      if (c.crop) {
        const [sx, sy, sw, sh] = c.crop; w = Math.round(sw * c.f); h = Math.round(sh * c.f);
        cv.width = w; cv.height = h; ctx = cv.getContext("2d", { willReadFrequently: true })!; ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
      } else {
        const k = 700 / Math.max(img.width, img.height); w = Math.round(img.width * k); h = Math.round(img.height * k);
        cv.width = w; cv.height = h; ctx = cv.getContext("2d", { willReadFrequently: true })!; ctx.drawImage(img, 0, 0, w, h);
      }
      const g = gray(ctx.getImageData(0, 0, w, h));
      const std = decodeFromGrayscale(g, w, "aztec-seed-v1");
      let t = performance.now();
      const full = decodeWithFallbacks(g, w, "aztec-seed-v1", null, { registration: true });
      const tFull = performance.now() - t;
      t = performance.now();
      const live = decodeWithFallbacks(g, w, "aztec-seed-v1", null, { registration: true, registrationStarts: 3, registrationBudgetMs: 400 });
      const tLive = performance.now() - t;
      const ok = (r: typeof std) => r.status === "DECODE_OK" && r.id === c.truth;
      if (ok(std)) okStd++; if (ok(full)) okFull++; if (ok(live)) okLive++;
      const tag = (r: typeof std) => (r.status === "DECODE_OK" ? (r.id === c.truth ? `OK(${r.method ?? "std"})` : `WRONG ID ${r.id}`) : "fails");
      L.push(`${c.name} ${c.label.padEnd(28)} standard ${tag(std).padEnd(16)} | full ${tag(full).padEnd(16)} ${tFull.toFixed(0).padStart(4)}ms | live opts ${tag(live).padEnd(16)} ${tLive.toFixed(0).padStart(4)}ms`);
      setLog([...L]);
    }
    L.push(`TOTAL of ${CASES.length}: standard ${okStd} | full fallback ${okFull} | live-opts fallback ${okLive}`);
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
