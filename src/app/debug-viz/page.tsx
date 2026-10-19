"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// TEMPORARY — visualizes detected bullseye, center, and stub for n1-n3. Not part of the product.
import React, { useRef, useState } from "react";
import {
  findCandidateCenters, findBullseyeCenters, resolveOrientation, refineScaleFromBoundary, extractGrid,
  computeOtsuThreshold, sampleBilinear,
} from "@/lib/aztec-detector";
import { G, CELL_PX, RINGS, buildReservedMask, makeMask, rsDecodeBits, MSG_BITS } from "@/lib/aztec-marker";

function grayscaleFromImageData(data: ImageData): Uint8ClampedArray {
  const { data: d, width, height } = data;
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) g[i] = (d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) >> 8;
  return g;
}

// local reimplementation of connected-components, just for visualization
function connectedComponents(bin: Uint8Array, w: number, h: number, minArea: number) {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const comps: { area: number; minx: number; maxx: number; miny: number; maxy: number; cx: number; cy: number }[] = [];
  let next = 0;
  for (let s = 0; s < w * h; s++) {
    if (bin[s] !== 1 || labels[s] !== 0) continue;
    next++;
    let sp = 0; stack[sp++] = s; labels[s] = next;
    let minx = w, maxx = -1, miny = h, maxy = -1, sx = 0, sy = 0, n = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % w, py = (p - px) / w;
      n++; sx += px; sy += py;
      if (px < minx) minx = px; if (px > maxx) maxx = px;
      if (py < miny) miny = py; if (py > maxy) maxy = py;
      if (px > 0 && bin[p - 1] === 1 && !labels[p - 1]) { labels[p - 1] = next; stack[sp++] = p - 1; }
      if (px < w - 1 && bin[p + 1] === 1 && !labels[p + 1]) { labels[p + 1] = next; stack[sp++] = p + 1; }
      if (py > 0 && bin[p - w] === 1 && !labels[p - w]) { labels[p - w] = next; stack[sp++] = p - w; }
      if (py < h - 1 && bin[p + w] === 1 && !labels[p + w]) { labels[p + w] = next; stack[sp++] = p + w; }
    }
    if (n >= minArea) comps.push({ area: n, minx, maxx, miny, maxy, cx: sx / n, cy: sy / n });
  }
  return comps;
}

function findStubBlob(gray: Uint8ClampedArray, w: number, h: number, cx: number, cy: number, coarseScale: number, threshold: number) {
  const SPOKE_OUTER = 40;
  const innerR = RINGS[0] * Math.SQRT2 * coarseScale * 0.85;
  const outerR = SPOKE_OUTER * coarseScale * 1.4;
  const half = Math.ceil(outerR);
  const minX = Math.max(0, Math.floor(cx - half)), maxX = Math.min(w - 1, Math.ceil(cx + half));
  const minY = Math.max(0, Math.floor(cy - half)), maxY = Math.min(h - 1, Math.ceil(cy + half));
  const pw = maxX - minX + 1, ph = maxY - minY + 1;
  const bin = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) bin[y * pw + x] = sampleBilinear(gray, w, minX + x, minY + y) < threshold ? 1 : 0;
  const comps = connectedComponents(bin, pw, ph, 3);
  const expectedArea = 2 * CELL_PX * CELL_PX * coarseScale * coarseScale;
  let best: any = null, bestScore = -Infinity;
  for (const comp of comps) {
    const compCx = minX + comp.cx, compCy = minY + comp.cy;
    const dist = Math.hypot(compCx - cx, compCy - cy);
    if (dist < innerR || dist > outerR) continue;
    const bw = comp.maxx - comp.minx + 1, bh = comp.maxy - comp.miny + 1;
    const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
    if (aspect < 1.3 || aspect > 3.5) continue;
    if (comp.area < expectedArea * 0.4 || comp.area > expectedArea * 2.5) continue;
    if (Math.max(bw, bh) > CELL_PX * coarseScale * 3) continue;
    const score = -(Math.abs(aspect - 2) + Math.abs(comp.area - expectedArea) / expectedArea);
    if (score > bestScore) { bestScore = score; best = { x0: minX + comp.minx, y0: minY + comp.miny, x1: minX + comp.maxx, y1: minY + comp.maxy, cx: compCx, cy: compCy }; }
  }
  return { best, innerR, outerR };
}

const FILES = ["m1.jpeg"];

const DebugVizPage = () => {
  const [log, setLog] = useState<string[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const run = async () => {
    const lines: string[] = [];
    const reserved = buildReservedMask();
    let nAvail = 0;
    for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) nAvail++;
    const maskBits = makeMask("aztec-seed-v1", nAvail);
    const designSpokeAngle = -Math.PI / 2;

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
      const threshold = computeOtsuThreshold(gray);

      const finderCandidates = findBullseyeCenters(gray, w, threshold);
      const blobCandidates = findCandidateCenters(gray, w, threshold);
      const candidates = [...finderCandidates, ...blobCandidates];

      // pick the candidate with the best (highest) okRays as "the detected bullseye"
      let best: any = null;
      for (const c of candidates) {
        const angle = resolveOrientation(gray, w, c.cx, c.cy, c.coarseScale, threshold);
        if (!Number.isFinite(angle)) continue;
        const rotation = angle - designSpokeAngle;
        const refined = refineScaleFromBoundary(gray, w, c.cx, c.cy, rotation, c.coarseScale, threshold);
        const scaleToUse = Number.isFinite(refined.scale) ? refined.scale : c.coarseScale;
        const bits = extractGrid(gray, w, c.cx, c.cy, scaleToUse, angle, threshold);
        const flat: number[] = [];
        for (let r = 0; r < G; r++) for (let col = 0; col < G; col++) if (!reserved[r][col]) flat.push(bits[r][col]);
        const unmasked = flat.map((b, i) => b ^ maskBits[i]);
        const recovered = rsDecodeBits(unmasked.slice(0, MSG_BITS));
        if (!best || refined.okRays > best.okRays) best = { c, angle, okRays: refined.okRays, recovered, scaleToUse };
      }
      if (!best) { lines.push(`${name}: no candidate found an orientation at all`); setLog([...lines]); continue; }

      const stubInfo = findStubBlob(gray, w, h, best.c.cx, best.c.cy, best.c.coarseScale, threshold);
      lines.push(`${name}: center=(${best.c.cx.toFixed(1)},${best.c.cy.toFixed(1)}) coarseScale=${best.c.coarseScale.toFixed(3)} angle=${(best.angle*180/Math.PI).toFixed(1)}deg okRays=${best.okRays} recovered=${best.recovered} stubFound=${!!stubInfo.best}`);

      // render the extracted grid for visual inspection
      const bestBits = extractGrid(gray, w, best.c.cx, best.c.cy, best.scaleToUse, best.angle, threshold);
      const gridCanvas = document.createElement("canvas");
      const cell = 12;
      gridCanvas.width = G * cell; gridCanvas.height = G * cell;
      const gctx = gridCanvas.getContext("2d")!;
      for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) {
        gctx.fillStyle = bestBits[r][c] ? "#ffffff" : "#000000";
        gctx.fillRect(c * cell, r * cell, cell, cell);
      }
      const gridUrl = gridCanvas.toDataURL("image/png");
      await fetch("/api/debug-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `grid_${name}.png`, dataUrl: gridUrl }) });
      const ascii = bestBits.map((row) => row.map((b) => (b ? "." : "#")).join("")).join("\n");
      lines.push(ascii);
      setLog([...lines]);

      // draw visualization
      const crop = document.createElement("canvas");
      const sx = Math.max(0, best.c.cx - 110), sy = Math.max(0, best.c.cy - 110), sw = 220, sh = 220, zoom = 3.5;
      crop.width = sw * zoom; crop.height = sh * zoom;
      const cctx = crop.getContext("2d")!;
      cctx.imageSmoothingEnabled = false;
      cctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw * zoom, sh * zoom);
      const toCrop = (x: number, y: number) => [(x - sx) * zoom, (y - sy) * zoom];

      // bullseye: circle at outer ring radius (RINGS[0] * scale)
      const [ccx, ccy] = toCrop(best.c.cx, best.c.cy);
      cctx.strokeStyle = "#6250d6"; cctx.lineWidth = 3;
      cctx.beginPath(); cctx.arc(ccx, ccy, RINGS[0] * best.scaleToUse * zoom, 0, 2 * Math.PI); cctx.stroke();
      cctx.font = "16px monospace"; cctx.fillStyle = "#6250d6";
      cctx.fillText("bullseye", ccx - RINGS[0] * best.scaleToUse * zoom, ccy - RINGS[0] * best.scaleToUse * zoom - 8);

      // center point
      cctx.fillStyle = "#000"; cctx.beginPath(); cctx.arc(ccx, ccy, 6, 0, 2 * Math.PI); cctx.fill();
      cctx.fillStyle = "#000"; cctx.fillText("center", ccx + 10, ccy + 4);

      // stub blob box
      if (stubInfo.best) {
        const [x0, y0] = toCrop(stubInfo.best.x0, stubInfo.best.y0);
        const [x1, y1] = toCrop(stubInfo.best.x1, stubInfo.best.y1);
        cctx.strokeStyle = "#E24B4A"; cctx.lineWidth = 3;
        cctx.strokeRect(x0 - 4, y0 - 4, (x1 - x0) + 8, (y1 - y0) + 8);
        cctx.fillStyle = "#E24B4A";
        cctx.fillText("stub", x0, y0 - 10);
      }

      const dataUrl = crop.toDataURL("image/png");
      await fetch("/api/debug-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `viz_${name}.png`, dataUrl }) });
    }
    lines.push("saved viz_n1.jpeg.png, viz_n2.jpeg.png, viz_n3.jpeg.png");
    setLog([...lines]);
  };

  return (
    <div className="min-h-screen bg-white p-4">
      <h1 className="text-xl font-bold mb-2">bullseye/center/stub visualization (temporary)</h1>
      <button onClick={run} className="border px-3 py-1 mb-4">Run</button>
      <div className="mb-4 whitespace-pre-wrap font-mono text-xs bg-gray-100 p-3 rounded">{log.join("\n")}</div>
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
};

export default DebugVizPage;
