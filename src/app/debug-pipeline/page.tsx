"use client";
// TEMPORARY — full step-by-step pipeline walkthrough on a real photo, for
// explaining how decode works. Not part of the product.
import React, { useRef, useState } from "react";
import {
  findCandidateCenters, findBullseyeCenters, resolveOrientation, refineScaleFromBoundary, extractGrid,
  computeOtsuThreshold,
} from "@/lib/aztec-detector";
import { G, CELL_PX, DCX, DCY, buildReservedMask, makeMask, rsDecodeBits, MSG_BITS } from "@/lib/aztec-marker";

function grayscaleFromImageData(data: ImageData): Uint8ClampedArray {
  const { data: d, width, height } = data;
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) g[i] = (d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) >> 8;
  return g;
}

const FILE = "m1.jpeg";
const SEED = "aztec-seed-v1";

async function save(name: string, dataUrl: string) {
  await fetch("/api/debug-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, dataUrl }) });
}

const DebugPipelinePage = () => {
  const [log, setLog] = useState<string[]>([]);

  const run = async () => {
    const lines: string[] = [];
    const img = new Image();
    await new Promise<void>((resolve) => { img.onload = () => resolve(); img.src = `/test-samples/${FILE}`; });
    const maxSide = 900;
    const k = Math.min(1, maxSide / Math.max(img.width, img.height));
    const w = Math.round(img.width * k), h = Math.round(img.height * k);

    // STEP 1: original -> grayscale
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, w, h);
    await save("m1_1_original.png", canvas.toDataURL("image/png"));

    const imgData = ctx.getImageData(0, 0, w, h);
    const gray = grayscaleFromImageData(imgData);
    const grayCanvas = document.createElement("canvas");
    grayCanvas.width = w; grayCanvas.height = h;
    const gctx = grayCanvas.getContext("2d")!;
    const grayImgData = gctx.createImageData(w, h);
    for (let i = 0, o = 0; i < gray.length; i++, o += 4) {
      grayImgData.data[o] = grayImgData.data[o + 1] = grayImgData.data[o + 2] = gray[i];
      grayImgData.data[o + 3] = 255;
    }
    gctx.putImageData(grayImgData, 0, 0);
    await save("m1_2_grayscale.png", grayCanvas.toDataURL("image/png"));
    lines.push("1-2: loaded image, converted to grayscale");

    // STEP 2: binarize (Otsu)
    const threshold = computeOtsuThreshold(gray);
    const binCanvas = document.createElement("canvas");
    binCanvas.width = w; binCanvas.height = h;
    const bctx = binCanvas.getContext("2d")!;
    const binImgData = bctx.createImageData(w, h);
    for (let i = 0, o = 0; i < gray.length; i++, o += 4) {
      const v = gray[i] < threshold ? 0 : 255;
      binImgData.data[o] = binImgData.data[o + 1] = binImgData.data[o + 2] = v;
      binImgData.data[o + 3] = 255;
    }
    bctx.putImageData(binImgData, 0, 0);
    await save("m1_3_binarized.png", binCanvas.toDataURL("image/png"));
    lines.push(`3: binarized with Otsu threshold=${threshold}`);

    // STEP 3: find candidates
    const finderCandidates = findBullseyeCenters(gray, w, threshold);
    const blobCandidates = findCandidateCenters(gray, w, threshold);
    const candidates = [...finderCandidates, ...blobCandidates];
    const candCanvas = document.createElement("canvas");
    candCanvas.width = w; candCanvas.height = h;
    const cctx = candCanvas.getContext("2d")!;
    cctx.drawImage(grayCanvas, 0, 0);
    candidates.forEach((c, i) => {
      const r = 18 * c.coarseScale;
      cctx.strokeStyle = "#ff8800"; cctx.lineWidth = 1.5;
      cctx.strokeRect(c.cx - r, c.cy - r, r * 2, r * 2);
      if (i < 3) { cctx.fillStyle = "#ff8800"; cctx.font = "11px monospace"; cctx.fillText(`#${i}`, c.cx - r, c.cy - r - 2); }
    });
    await save("m1_4_candidates.png", candCanvas.toDataURL("image/png"));
    lines.push(`4: found ${candidates.length} candidate bullseye centers (${finderCandidates.length} via finder-pattern scan, ${blobCandidates.length} via blob detection)`);

    // STEP 4: pick best candidate, find orientation (stub)
    const designSpokeAngle = -Math.PI / 2;
    let best: any = null;
    for (const c of candidates) {
      const angle = resolveOrientation(gray, w, c.cx, c.cy, c.coarseScale, threshold);
      if (!Number.isFinite(angle)) continue;
      const rotation = angle - designSpokeAngle;
      const refined = refineScaleFromBoundary(gray, w, c.cx, c.cy, rotation, c.coarseScale, threshold);
      if (!best || refined.okRays > best.okRays) best = { c, angle, okRays: refined.okRays, scaleToUse: Number.isFinite(refined.scale) ? refined.scale : c.coarseScale, rotation };
    }
    if (!best) { lines.push("no orientation found at all"); setLog(lines); return; }

    const stubCanvas = document.createElement("canvas");
    stubCanvas.width = w; stubCanvas.height = h;
    const sctx = stubCanvas.getContext("2d")!;
    const zoomSx = best.c.cx - 100, zoomSy = best.c.cy - 100, zoomSw = 200, zoomSh = 200;
    stubCanvas.width = zoomSw * 3; stubCanvas.height = zoomSh * 3;
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(grayCanvas, zoomSx, zoomSy, zoomSw, zoomSh, 0, 0, zoomSw * 3, zoomSh * 3);
    const toZoom = (x: number, y: number) => [(x - zoomSx) * 3, (y - zoomSy) * 3];
    const [ccx, ccy] = toZoom(best.c.cx, best.c.cy);
    sctx.fillStyle = "#000"; sctx.fillRect(ccx - 3, ccy - 3, 6, 6);
    const rMid = 36 * best.c.coarseScale;
    const [sx, sy] = toZoom(best.c.cx + Math.cos(best.angle) * rMid, best.c.cy + Math.sin(best.angle) * rMid);
    sctx.strokeStyle = "#E24B4A"; sctx.lineWidth = 3;
    sctx.beginPath(); sctx.arc(sx, sy, 10, 0, 2 * Math.PI); sctx.stroke();
    sctx.font = "16px monospace"; sctx.fillStyle = "#E24B4A"; sctx.fillText("stub found here", sx + 14, sy);
    await save("m1_5_orientation.png", stubCanvas.toDataURL("image/png"));
    lines.push(`5: selected candidate cx=${best.c.cx.toFixed(1)} cy=${best.c.cy.toFixed(1)}, found orientation stub at angle=${(best.angle * 180 / Math.PI).toFixed(1)}deg`);

    // STEP 5: scale calibration via boundary points (visualize the 32 ring points)
    const scaleCanvas = document.createElement("canvas");
    scaleCanvas.width = zoomSw * 3; scaleCanvas.height = zoomSh * 3;
    const scctx = scaleCanvas.getContext("2d")!;
    scctx.imageSmoothingEnabled = false;
    scctx.drawImage(grayCanvas, zoomSx, zoomSy, zoomSw, zoomSh, 0, 0, zoomSw * 3, zoomSh * 3);
    const cosr = Math.cos(best.rotation), sinr = Math.sin(best.rotation);
    for (let i = 0; i < 32; i++) {
      const phi = (i / 32) * 2 * Math.PI;
      const nx = 24 * Math.cos(phi) / Math.max(Math.abs(Math.cos(phi)), Math.abs(Math.sin(phi)));
      const ny = 24 * Math.sin(phi) / Math.max(Math.abs(Math.cos(phi)), Math.abs(Math.sin(phi)));
      const rx = nx * cosr - ny * sinr, ry = nx * sinr + ny * cosr;
      const px = best.c.cx + rx * best.scaleToUse, py = best.c.cy + ry * best.scaleToUse;
      const [zx, zy] = toZoom(px, py);
      scctx.fillStyle = "#6250d6"; scctx.beginPath(); scctx.arc(zx, zy, 3, 0, 2 * Math.PI); scctx.fill();
    }
    await save("m1_6_scale_points.png", scaleCanvas.toDataURL("image/png"));
    lines.push(`6: measured ring boundary at 32 points around the ring, refined scale=${best.scaleToUse.toFixed(3)}, okRays=${best.okRays}/32`);

    // STEP 6: extract grid
    const bits = extractGrid(gray, w, best.c.cx, best.c.cy, best.scaleToUse, best.angle, threshold);
    const gridCanvas = document.createElement("canvas");
    const cell = 12;
    gridCanvas.width = G * cell; gridCanvas.height = G * cell;
    const grctx = gridCanvas.getContext("2d")!;
    for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) {
      grctx.fillStyle = bits[r][c] ? "#ffffff" : "#000000";
      grctx.fillRect(c * cell, r * cell, cell, cell);
    }
    await save("m1_7_extracted_grid.png", gridCanvas.toDataURL("image/png"));
    lines.push("7: extracted the 20x20 bit grid (black=0, white=1) by sampling each cell");

    // STEP 7: unmask + RS decode
    const reserved = buildReservedMask();
    let nAvail = 0;
    for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) nAvail++;
    const maskBits = makeMask(SEED, nAvail);
    const flat: number[] = [];
    for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) flat.push(bits[r][c]);
    const unmasked = flat.map((b, i) => b ^ maskBits[i]);
    const recovered = rsDecodeBits(unmasked.slice(0, MSG_BITS));
    lines.push(`8: unmasked the ${nAvail} data bits (XOR with seed-derived pseudo-random mask) and ran Reed-Solomon decode`);
    lines.push(`RESULT: ${recovered ? `DECODED -> "${recovered}"` : "FAILED"}`);
    setLog([...lines]);
  };

  return (
    <div className="min-h-screen bg-white p-4">
      <h1 className="text-xl font-bold mb-2">full pipeline walkthrough (temporary)</h1>
      <button onClick={run} className="border px-3 py-1 mb-4">Run</button>
      <div className="whitespace-pre-wrap font-mono text-xs bg-gray-100 p-3 rounded">{log.join("\n")}</div>
    </div>
  );
};

export default DebugPipelinePage;
