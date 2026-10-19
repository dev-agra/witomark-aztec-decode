"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// TEMPORARY — zoomed crops of m1's real pixels: finder-pattern band
// (solid, robust) vs data checkerboard (isolated cells, blur-vulnerable).
// Not part of the product.
import React, { useRef, useState } from "react";
import { findCandidateCenters, findBullseyeCenters, resolveOrientation, refineScaleFromBoundary, computeOtsuThreshold } from "@/lib/aztec-detector";
import { CELL_PX, DCX, DCY } from "@/lib/aztec-marker";

function grayscaleFromImageData(data: ImageData): Uint8ClampedArray {
  const { data: d, width, height } = data;
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) g[i] = (d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) >> 8;
  return g;
}

const FILE = "m1.jpeg";

const DebugBlurPage = () => {
  const [log, setLog] = useState<string[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const run = async () => {
    const lines: string[] = [];
    const img = new Image();
    await new Promise<void>((resolve) => { img.onload = () => resolve(); img.src = `/test-samples/${FILE}`; });
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

    let best: any = null;
    const designSpokeAngle = -Math.PI / 2;
    for (const c of candidates) {
      const angle = resolveOrientation(gray, w, c.cx, c.cy, c.coarseScale, threshold);
      if (!Number.isFinite(angle)) continue;
      const rotation = angle - designSpokeAngle;
      const refined = refineScaleFromBoundary(gray, w, c.cx, c.cy, rotation, c.coarseScale, threshold);
      if (!best || refined.okRays > best.okRays) best = { c, angle, okRays: refined.okRays, scaleToUse: Number.isFinite(refined.scale) ? refined.scale : c.coarseScale, rotation };
    }
    if (!best) { lines.push("no candidate found"); setLog(lines); return; }
    lines.push(`candidate: cx=${best.c.cx.toFixed(1)} cy=${best.c.cy.toFixed(1)} scale=${best.scaleToUse.toFixed(3)} angle=${(best.angle*180/Math.PI).toFixed(1)}deg`);

    const cosr = Math.cos(best.rotation), sinr = Math.sin(best.rotation);
    function sceneOf(r: number, c: number): [number, number] {
      const ddx = (c * CELL_PX + CELL_PX / 2) - DCX, ddy = (r * CELL_PX + CELL_PX / 2) - DCY;
      const rx = ddx * cosr - ddy * sinr, ry = ddx * sinr + ddy * cosr;
      return [best.c.cx + rx * best.scaleToUse, best.c.cy + ry * best.scaleToUse];
    }

    // crop a region covering cell rows/cols [r0,r1] x [c0,c1], draw a grid
    // line per cell boundary, zoomed way up, directly on real pixels
    function cropRegion(r0: number, r1: number, c0: number, c1: number, zoom: number) {
      // bounding box in scene space across all 4 corners of the cell range
      const corners = [sceneOf(r0, c0), sceneOf(r0, c1 + 1), sceneOf(r1 + 1, c0), sceneOf(r1 + 1, c1 + 1)];
      const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
      const pad = 2 * best.scaleToUse;
      const sx = Math.min(...xs) - pad, sy = Math.min(...ys) - pad;
      const sw = Math.max(...xs) - sx + pad, sh = Math.max(...ys) - sy + pad;
      const crop = document.createElement("canvas");
      crop.width = Math.round(sw * zoom); crop.height = Math.round(sh * zoom);
      const cctx = crop.getContext("2d")!;
      cctx.imageSmoothingEnabled = false;
      cctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
      // draw cell grid lines by projecting each cell corner into crop space
      cctx.strokeStyle = "#00ff00"; cctx.lineWidth = 1;
      for (let r = r0; r <= r1 + 1; r++) {
        cctx.beginPath();
        for (let c = c0; c <= c1 + 1; c++) {
          const [x, y] = sceneOf(r, c);
          const px = (x - sx) * zoom, py = (y - sy) * zoom;
          if (c === c0) cctx.moveTo(px, py); else cctx.lineTo(px, py);
        }
        cctx.stroke();
      }
      for (let c = c0; c <= c1 + 1; c++) {
        cctx.beginPath();
        for (let r = r0; r <= r1 + 1; r++) {
          const [x, y] = sceneOf(r, c);
          const px = (x - sx) * zoom, py = (y - sy) * zoom;
          if (r === r0) cctx.moveTo(px, py); else cctx.lineTo(px, py);
        }
        cctx.stroke();
      }
      return crop.toDataURL("image/png");
    }

    // finder-pattern band: row 7, cols 5-14 (solid ring2 edge + quiet margin)
    const finderUrl = cropRegion(6, 8, 5, 14, 14);
    await fetch("/api/debug-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "blur_finder.png", dataUrl: finderUrl }) });

    // data checkerboard region: rows 2-7, cols 2-7 — solidly inside the
    // data area (past the quiet-zone boundary, well short of the marker's
    // own outer perimeter, so this isn't background bleeding in)
    const dataUrl = cropRegion(2, 7, 2, 7, 14);
    await fetch("/api/debug-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "blur_data.png", dataUrl }) });

    lines.push("saved blur_finder.png and blur_data.png");
    setLog([...lines]);
  };

  return (
    <div className="min-h-screen bg-white p-4">
      <h1 className="text-xl font-bold mb-2">finder vs data blur comparison (temporary)</h1>
      <button onClick={run} className="border px-3 py-1 mb-4">Run</button>
      <div className="mb-4 whitespace-pre-wrap font-mono text-xs bg-gray-100 p-3 rounded">{log.join("\n")}</div>
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
};

export default DebugBlurPage;
