"use client";
// TEMPORARY — standard decode vs decode + registration fallback, on the real samples and a blur sweep. Not part of the product.
import React, { useState } from "react";
import { decodeFromGrayscale } from "@/lib/aztec-detector";
import { decodeWithFallbacks } from "@/lib/decode";
import { measureMarkerSharpness } from "@/lib/sharpness";
import { registrationDecode } from "@/lib/registration";

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

function frame(img: HTMLImageElement, blurPx: number) {
  const k = 700 / Math.max(img.width, img.height);
  const w = Math.round(img.width * k), h = Math.round(img.height * k);
  const big = document.createElement("canvas"); big.width = img.width; big.height = img.height;
  const bctx = big.getContext("2d")!;
  if (blurPx > 0) bctx.filter = `blur(${blurPx}px)`;
  bctx.drawImage(img, 0, 0);
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!; ctx.drawImage(big, 0, 0, w, h);
  return { g: gray(ctx.getImageData(0, 0, w, h)), w };
}

function both(g: Uint8ClampedArray, w: number) {
  let t = performance.now();
  const a = decodeFromGrayscale(g, w, "aztec-seed-v1");
  const ta = performance.now() - t;
  t = performance.now();
  const b = decodeWithFallbacks(g, w, "aztec-seed-v1", null, { registration: true });
  const tb = performance.now() - t;
  return { a, ta, b, tb };
}

const Page = () => {
  const [log, setLog] = useState<string[]>([]);
  const runCost = async () => {
    const L: string[] = ["COST on a frame that never decodes (wrong seed, marker found): ms per decode call, desktop"];
    for (const name of ["n1.jpeg", "m1.jpeg", "m3.jpeg"]) {
      const { g, w } = frame(await load(name), 0);
      const time = (opts: Parameters<typeof decodeWithFallbacks>[4]) => {
        const t = performance.now(); let r; for (let i = 0; i < 5; i++) r = decodeWithFallbacks(g, w, "some-other-seed", null, opts); return { ms: (performance.now() - t) / 5, r: r! };
      };
      const a = time({ registration: false }), b = time({ registration: true, registrationStarts: 2, registrationBudgetMs: 150 }), c = time({ registration: true });
      L.push(`${name.padEnd(9)} standard only ${a.ms.toFixed(0)}ms | live opts (2 climbs, 150ms budget) ${b.ms.toFixed(0)}ms | full (5 climbs) ${c.ms.toFixed(0)}ms | estimate ${a.r.markerEstimate ? "yes" : "no"}`);
      setLog([...L]);
    }
  };
  const run = async () => {
    const L: string[] = ["REAL SAMPLES at 700px canvas: standard | + registration fallback (time includes the standard pass)"];
    for (const name of ["p1.jpeg", "m1.jpeg", "m2.jpeg", "m3.jpeg", "n1.jpeg", "n2.jpeg", "n3.jpeg"]) {
      const { g, w } = frame(await load(name), 0);
      const { a, ta, b, tb } = both(g, w);
      if ((name === "n1.jpeg" || name === "n2.jpeg") && a.markerEstimate) {
        const e = a.markerEstimate;
        L.push(`   ${name} estimate: ${(e.scale * 8).toFixed(1)}px/cell okRays ${e.okRays} finderWrong ${e.finderWrong}`);
        registrationDecode(g, w, e, "aztec-seed-v1", { diag: (d) => L.push(`     start ${(d.startDs * 100).toFixed(0)}% -> ds ${(d.ds * 100).toFixed(1)}% dx ${d.dx.toFixed(2)} dy ${d.dy.toFixed(2)} dr ${d.dr.toFixed(2)} RS ${d.ok ? "OK" : "fails"}`) });
      }
      L.push(`${name.padEnd(9)} ${a.status === "DECODE_OK" ? `OK "${a.id}"` : "fails"} ${ta.toFixed(0)}ms | ${b.status === "DECODE_OK" ? `OK "${b.id}" via ${b.method ?? "standard"}` : "fails"} ${tb.toFixed(0)}ms`);
      setLog([...L]);
    }
    for (const name of ["m2.jpeg", "m3.jpeg"]) {
      const img = await load(name);
      L.push(`BLUR SWEEP ${name} (native px): standard | + registration | edge width (cells)`);
      for (const bl of [0, 4, 6, 8, 10, 12, 15]) {
        const { g, w } = frame(img, bl);
        const { a, b, tb } = both(g, w);
        const e = b.markerEstimate;
        const m = e ? measureMarkerSharpness(g, w, e) : null;
        L.push(`  blur ${String(bl).padStart(2)}: ${a.status === "DECODE_OK" ? "OK   " : "fails"} | ${b.status === "DECODE_OK" ? `OK via ${b.method ?? "standard"}` : "fails"} ${tb.toFixed(0)}ms | edge ${m?.edgeWidthCells?.toFixed(2) ?? "-"}`);
        setLog([...L]);
      }
    }
    setLog([...L]);
  };
  return (
    <div className="p-4">
      <button onClick={run} className="border px-3 py-1 mb-3 mr-2">Run</button><button onClick={runCost} className="border px-3 py-1 mb-3">Cost</button>
      <div className="whitespace-pre-wrap font-mono text-xs bg-gray-100 p-3 rounded">{log.join("\n")}</div>
    </div>
  );
};
export default Page;
