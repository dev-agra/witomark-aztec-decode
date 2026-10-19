"use client";
// TEMPORARY — zooms into individual cells and marks the exact 9 sample
// points extractGrid uses, showing the real mechanism. Not part of the product.
import React, { useRef, useState } from "react";
import { findCandidateCenters, findBullseyeCenters, resolveOrientation, refineScaleFromBoundary, computeOtsuThreshold, sampleBilinear } from "@/lib/aztec-detector";
import { G, CELL_PX, DCX, DCY } from "@/lib/aztec-marker";

function grayscaleFromImageData(data: ImageData): Uint8ClampedArray {
  const { data: d, width, height } = data;
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) g[i] = (d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) >> 8;
  return g;
}

function boxBlur(gray: Uint8ClampedArray, w: number, h: number, radius: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const r = Math.max(1, Math.round(radius));
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += gray[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / (2 * r + 1);
      const addX = Math.min(w - 1, x + r + 1), subX = Math.max(0, x - r);
      sum += gray[y * w + addX] - gray[y * w + subX];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / (2 * r + 1);
      const addY = Math.min(h - 1, y + r + 1), subY = Math.max(0, y - r);
      sum += tmp[addY * w + x] - tmp[subY * w + x];
    }
  }
  return out;
}

function unsharpMask(gray: Uint8ClampedArray, w: number, h: number, radius: number, amount: number): Uint8ClampedArray {
  const blurred = boxBlur(gray, w, h, radius);
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i] + amount * (gray[i] - blurred[i]);
    out[i] = Math.max(0, Math.min(255, Math.round(v)));
  }
  return out;
}

const FILE = "m1.jpeg";
const OFFSETS = [-0.25, 0, 0.25];

async function save(name: string, dataUrl: string) {
  await fetch("/api/debug-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, dataUrl }) });
}

const DebugCellSamplePage = () => {
  const [log, setLog] = useState<string[]>([]);

  const run = async () => {
    const lines: string[] = [];
    const img = new Image();
    await new Promise<void>((resolve) => { img.onload = () => resolve(); img.src = `/test-samples/${FILE}`; });
    const maxSide = 900;
    const k = Math.min(1, maxSide / Math.max(img.width, img.height));
    const w = Math.round(img.width * k), h = Math.round(img.height * k);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    const gray = grayscaleFromImageData(imgData);
    const threshold = computeOtsuThreshold(gray);

    // pre-binarized version: every pixel snapped to pure 0 or 255, drawn
    // into its own canvas so we can crop/compare it the same way
    const grayBin = new Uint8ClampedArray(gray.length);
    for (let i = 0; i < gray.length; i++) grayBin[i] = gray[i] < threshold ? 0 : 255;
    const binCanvas = document.createElement("canvas");
    binCanvas.width = w; binCanvas.height = h;
    const binCtx = binCanvas.getContext("2d")!;
    const binImgData = binCtx.createImageData(w, h);
    for (let i = 0, o = 0; i < grayBin.length; i++, o += 4) {
      binImgData.data[o] = binImgData.data[o + 1] = binImgData.data[o + 2] = grayBin[i];
      binImgData.data[o + 3] = 255;
    }
    binCtx.putImageData(binImgData, 0, 0);

    // sharpened (unsharp-mask) version: boosts contrast against each
    // pixel's LOCAL AVERAGE (uses neighbors), genuinely different from
    // binarization — tested empirically to confirm/deny it helps
    const sharpRadius = CELL_PX * 0.5; // will be re-scaled per-candidate below via coarseScale, placeholder here
    const sharpened = unsharpMask(gray, w, h, 3, 2); // radius~3px, amount=2 — same config tested in debug-bits
    const sharpThreshold = computeOtsuThreshold(sharpened);
    const sharpCanvas = document.createElement("canvas");
    sharpCanvas.width = w; sharpCanvas.height = h;
    const sharpCtx = sharpCanvas.getContext("2d")!;
    const sharpImgData = sharpCtx.createImageData(w, h);
    for (let i = 0, o = 0; i < sharpened.length; i++, o += 4) {
      sharpImgData.data[o] = sharpImgData.data[o + 1] = sharpImgData.data[o + 2] = sharpened[i];
      sharpImgData.data[o + 3] = 255;
    }
    sharpCtx.putImageData(sharpImgData, 0, 0);

    const finderCandidates = findBullseyeCenters(gray, w, threshold);
    const blobCandidates = findCandidateCenters(gray, w, threshold);
    const candidates = [...finderCandidates, ...blobCandidates];
    const designSpokeAngle = -Math.PI / 2;
    let best: any = null;
    for (const c of candidates) {
      const angle = resolveOrientation(gray, w, c.cx, c.cy, c.coarseScale, threshold);
      if (!Number.isFinite(angle)) continue;
      const rotation = angle - designSpokeAngle;
      const refined = refineScaleFromBoundary(gray, w, c.cx, c.cy, rotation, c.coarseScale, threshold);
      if (!best || refined.okRays > best.okRays) best = { c, angle, okRays: refined.okRays, scaleToUse: Number.isFinite(refined.scale) ? refined.scale : c.coarseScale, rotation };
    }
    if (!best) { lines.push("no candidate found"); setLog(lines); return; }

    const cosr = Math.cos(best.rotation), sinr = Math.sin(best.rotation);
    function cellScenePoint(r: number, c: number, ox: number, oy: number): [number, number] {
      const ddx = (c * CELL_PX + CELL_PX / 2 + ox * CELL_PX) - DCX;
      const ddy = (r * CELL_PX + CELL_PX / 2 + oy * CELL_PX) - DCY;
      const rx = ddx * cosr - ddy * sinr, ry = ddx * sinr + ddy * cosr;
      return [best.c.cx + rx * best.scaleToUse, best.c.cy + ry * best.scaleToUse];
    }

    // crop a 2x2 cell region (one finder cell pair, one data cell pair) and
    // mark the 9 sample points PER CELL that extractGrid actually samples.
    // sourceCanvas/sourcePixels let this draw from either the raw
    // grayscale or the pre-binarized version, for direct comparison.
    function illustrateCells(cells: [number, number][], zoom: number, sourceCanvas: HTMLCanvasElement, sourcePixels: Uint8ClampedArray, decisionThreshold: number = threshold) {
      const allPts = cells.flatMap(([r, c]) => [cellScenePoint(r, c, -0.5, -0.5), cellScenePoint(r, c, 0.5, 0.5)]);
      const xs = allPts.map((p) => p[0]), ys = allPts.map((p) => p[1]);
      const pad = 0.6 * CELL_PX * best.scaleToUse;
      const sx = Math.min(...xs) - pad, sy = Math.min(...ys) - pad;
      const sw = Math.max(...xs) - sx + pad, sh = Math.max(...ys) - sy + pad;
      const crop = document.createElement("canvas");
      crop.width = Math.round(sw * zoom); crop.height = Math.round(sh * zoom);
      const cctx = crop.getContext("2d")!;
      cctx.imageSmoothingEnabled = false;
      cctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
      const toCrop = (x: number, y: number): [number, number] => [(x - sx) * zoom, (y - sy) * zoom];

      for (const [r, c] of cells) {
        // cell boundary (green)
        const corners = [cellScenePoint(r, c, -0.5, -0.5), cellScenePoint(r, c, 0.5, -0.5), cellScenePoint(r, c, 0.5, 0.5), cellScenePoint(r, c, -0.5, 0.5)];
        cctx.strokeStyle = "#1baf7a"; cctx.lineWidth = 2;
        cctx.beginPath();
        corners.forEach((p, i) => { const [x, y] = toCrop(p[0], p[1]); if (i === 0) cctx.moveTo(x, y); else cctx.lineTo(x, y); });
        cctx.closePath(); cctx.stroke();

        // the 9 sample points this cell actually uses, colored by what they read
        let sum = 0;
        for (const ox of OFFSETS) {
          for (const oy of OFFSETS) {
            const [px, py] = cellScenePoint(r, c, ox, oy);
            const v = sampleBilinear(sourcePixels, w, px, py);
            sum += v;
            const [zx, zy] = toCrop(px, py);
            cctx.fillStyle = v < decisionThreshold ? "#E24B4A" : "#378ADD";
            cctx.beginPath(); cctx.arc(zx, zy, 4, 0, 2 * Math.PI); cctx.fill();
          }
        }
        const avg = sum / 9;
        const decision = avg >= decisionThreshold ? 1 : 0;
        const [lx, ly] = toCrop(corners[0][0], corners[0][1]);
        cctx.font = "13px monospace"; cctx.fillStyle = "#000";
        cctx.fillText(`r${r}c${c} avg=${avg.toFixed(0)} -> ${decision}`, lx + 4, ly + 16);
      }
      return crop.toDataURL("image/png");
    }

    // find the MOST internally-ambiguous data cell — the one whose 9 own
    // sample points disagree with each other the most (closest to a 50/50
    // split), rather than just picking any opposite-color pair. This is
    // the direct visual of "the 9 points can't agree," not just "two
    // adjacent cells differ."
    function cellDisagreement(r: number, c: number): number {
      let darkCount = 0;
      for (const ox of OFFSETS) for (const oy of OFFSETS) {
        const [px, py] = cellScenePoint(r, c, ox, oy);
        if (sampleBilinear(gray, w, px, py) < threshold) darkCount++;
      }
      return Math.min(darkCount, 9 - darkCount); // 0 = unanimous, 4 = maximally split (9 points, can't be exactly 50/50)
    }
    let worst: [number, number] | null = null, worstScore = -1;
    for (let r = 0; r < G; r++) {
      for (let c = 0; c < G; c++) {
        const score = cellDisagreement(r, c);
        if (score > worstScore) { worstScore = score; worst = [r, c]; }
      }
    }
    if (worst) {
      const [r, c] = worst;
      const neighbor: [number, number] = c < G - 1 ? [r, c + 1] : [r, c - 1];
      // SAME cell: raw grayscale (before) vs unsharp-masked (after), side by side
      const beforeUrl = illustrateCells([worst, neighbor], 24, canvas, gray, threshold);
      await save("m1_cellsample_before_raw.png", beforeUrl);
      const afterUrl = illustrateCells([worst, neighbor], 24, sharpCanvas, sharpened, sharpThreshold);
      await save("m1_cellsample_after_sharpened.png", afterUrl);
      lines.push(`most ambiguous cell: r${r}c${c}, ${worstScore}/9 points disagreed with the majority (on raw grayscale)`);
      lines.push(`before threshold=${threshold}, after (sharpened) threshold=${sharpThreshold}`);
    }

    lines.push("saved m1_cellsample_before_raw.png and m1_cellsample_after_sharpened.png");
    lines.push(`red dot = sampled value below threshold i.e. 'dark', blue = above i.e. 'light'`);
    setLog([...lines]);
  };

  return (
    <div className="min-h-screen bg-white p-4">
      <h1 className="text-xl font-bold mb-2">cell sampling mechanism (temporary)</h1>
      <button onClick={run} className="border px-3 py-1 mb-4">Run</button>
      <div className="whitespace-pre-wrap font-mono text-xs bg-gray-100 p-3 rounded">{log.join("\n")}</div>
    </div>
  );
};

export default DebugCellSamplePage;
