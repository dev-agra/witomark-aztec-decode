"use client";
// TEMPORARY — calls the REAL decodeFromGrayscale directly against all 3
// real test photos. Not part of the product.
import React, { useRef, useState } from "react";
import { decodeFromGrayscale } from "@/lib/aztec-detector";

function grayscaleFromImageData(data: ImageData): Uint8ClampedArray {
  const { data: d, width, height } = data;
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) g[i] = (d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) >> 8;
  return g;
}

const FILES = ["m1.jpeg", "m2.jpeg", "m3.jpeg", "n1.jpeg", "n2.jpeg", "n3.jpeg"];

const DebugN1Page = () => {
  const [log, setLog] = useState<string[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const run = async () => {
    const lines: string[] = [];
    for (const name of FILES) {
      const img = new Image();
      await new Promise<void>((resolve) => { img.onload = () => resolve(); img.src = `/test-samples/${name}`; });
      const maxSide = 900;
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * k), h = Math.round(img.height * k);
      const canvas = canvasRef.current!;
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, w, h);
      const imgData = ctx.getImageData(0, 0, w, h);
      const gray = grayscaleFromImageData(imgData);
      const t0 = performance.now();
      const result = decodeFromGrayscale(gray, w, "aztec-seed-v1");
      const ms = (performance.now() - t0).toFixed(0);
      lines.push(`${name}: status=${result.status} id=${result.id} candidatesTried=${result.candidatesTried} time=${ms}ms`);
      setLog([...lines]);
    }
  };

  return (
    <div className="min-h-screen bg-white p-4">
      <h1 className="text-xl font-bold mb-2">real decodeFromGrayscale on n1/n2/n3 (temporary)</h1>
      <button onClick={run} className="border px-3 py-1 mb-4">Run</button>
      <div className="mb-4 whitespace-pre-wrap font-mono text-xs bg-gray-100 p-3 rounded">{log.join("\n")}</div>
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
};

export default DebugN1Page;
