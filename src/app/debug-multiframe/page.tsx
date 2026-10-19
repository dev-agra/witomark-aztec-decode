"use client";
// TEMPORARY — multi-frame capture improvement, built per explicit request.
// Takes several photos of the SAME physical marker, detects each frame
// independently, resamples each onto one shared canonical (rectified,
// upright, fixed-scale) pixel grid using that frame's own detected
// center/scale/rotation, AVERAGES the grayscale values across frames pixel
// by pixel, then runs the normal single-frame decode pipeline once on that
// averaged image. This is the "average aligned pixels before thresholding"
// approach, meant to reduce RANDOM per-frame degradation (sensor noise,
// JPEG re-compression artifacts, slight hand shake / focus hunting) — it is
// NOT expected to fix SYSTEMATIC blur that's identical in every frame (e.g.
// a fixed too-far capture distance), per the m1 diagnosis earlier.
//
// Not part of the product. No real multi-frame burst data was available
// when this was built — only smoke-tested with repeated copies of a single
// image (mathematically must reproduce the single-frame baseline exactly,
// since identical frames carry zero new information; this checks the
// plumbing, not the technique's real-world benefit). Needs real burst
// photos of one marker to actually validate.
import React, { useRef, useState } from "react";
import {
  findCandidateCenters, findBullseyeCenters, resolveOrientation, refineScaleFromBoundary,
  computeOtsuThreshold, sampleBilinear, extractGrid,
} from "@/lib/aztec-detector";
import { G, CELL_PX, buildReservedMask, makeMask, rsDecodeBits, ID_LEN, RS_PARITY, MSG_BITS } from "@/lib/aztec-marker";
import { decodeWithErasures } from "@/lib/rs-erasures";

function grayscaleFromImageData(data: ImageData): Uint8ClampedArray {
  const { data: d, width, height } = data;
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) g[i] = (d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) >> 8;
  return g;
}

const CANON_PX_PER_UNIT = 2; // canonical resolution: 2 pixels per native marker unit
const CANON_RADIUS_UNITS = (G * CELL_PX / 2) * 1.15; // half-grid diagonal plus a small margin
const CANON_SIZE = Math.round(CANON_RADIUS_UNITS * 2 * CANON_PX_PER_UNIT);
const designSpokeAngle = -Math.PI / 2;

async function detectFrame(gray: Uint8ClampedArray, w: number) {
  const threshold = computeOtsuThreshold(gray);
  const finderCandidates = findBullseyeCenters(gray, w, threshold);
  const blobCandidates = findCandidateCenters(gray, w, threshold);
  const candidates = [...finderCandidates, ...blobCandidates];
  let best: any = null;
  for (const c of candidates) {
    const angle = resolveOrientation(gray, w, c.cx, c.cy, c.coarseScale, threshold);
    if (!Number.isFinite(angle)) continue;
    const rotation = angle - designSpokeAngle;
    const refined = refineScaleFromBoundary(gray, w, c.cx, c.cy, rotation, c.coarseScale, threshold);
    const scaleToUse = Number.isFinite(refined.scale) ? refined.scale : c.coarseScale;
    if (!best || refined.okRays > best.okRays) best = { cx: c.cx, cy: c.cy, angle, okRays: refined.okRays, scaleToUse, rotation, threshold };
  }
  return best;
}

// resample one frame onto the shared canonical (upright, fixed-scale) grid,
// using that frame's own detected cx/cy/scale/rotation
function buildCanonicalFrame(gray: Uint8ClampedArray, w: number, cx: number, cy: number, scale: number, rotation: number): Float32Array {
  const cosr = Math.cos(rotation), sinr = Math.sin(rotation);
  const out = new Float32Array(CANON_SIZE * CANON_SIZE);
  for (let py = 0; py < CANON_SIZE; py++) {
    const ny = (py - CANON_SIZE / 2) / CANON_PX_PER_UNIT;
    for (let px = 0; px < CANON_SIZE; px++) {
      const nx = (px - CANON_SIZE / 2) / CANON_PX_PER_UNIT;
      const rx = nx * cosr - ny * sinr, ry = nx * sinr + ny * cosr;
      out[py * CANON_SIZE + px] = sampleBilinear(gray, w, cx + rx * scale, cy + ry * scale);
    }
  }
  return out;
}

async function loadGray(file: File): Promise<{ gray: Uint8ClampedArray; w: number; h: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = reject; img.src = url; });
    const maxSide = 900;
    const k = Math.min(1, maxSide / Math.max(img.width, img.height));
    const w = Math.round(img.width * k), h = Math.round(img.height * k);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, w, h);
    const gray = grayscaleFromImageData(ctx.getImageData(0, 0, w, h));
    return { gray, w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function save(name: string, dataUrl: string) {
  await fetch("/api/debug-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, dataUrl }) });
}

function toPngDataUrl(gray: Uint8ClampedArray | Float32Array, size: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const imgData = ctx.createImageData(size, size);
  for (let i = 0, o = 0; i < size * size; i++, o += 4) {
    const v = Math.max(0, Math.min(255, Math.round(gray[i])));
    imgData.data[o] = imgData.data[o + 1] = imgData.data[o + 2] = v;
    imgData.data[o + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL("image/png");
}

function attemptDecode(gray: Uint8ClampedArray, w: number, cx: number, cy: number, scale: number, angle: number, threshold: number, label: string, lines: string[]) {
  const reserved = buildReservedMask();
  let nAvail = 0;
  for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) nAvail++;
  const maskBits = makeMask("aztec-seed-v1", nAvail);
  const bits = extractGrid(gray, w, cx, cy, scale, angle, threshold);
  const flat: number[] = [];
  for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) flat.push(bits[r][c]);
  const unmasked = flat.map((b, i) => b ^ maskBits[i]).slice(0, MSG_BITS);
  const recovered = rsDecodeBits(unmasked);
  lines.push(`${label}: errors-only decode -> ${recovered !== null ? `"${recovered}"` : "FAILED"}`);
  return recovered;
}

const DebugMultiframePage = () => {
  const [log, setLog] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const runUploaded = async () => {
    const files = fileRef.current?.files;
    if (!files || files.length === 0) { setLog(["select 2+ images of the SAME physical marker first"]); return; }
    await runOnFiles(Array.from(files));
  };

  const runSmokeTest = async () => {
    // plumbing self-check only: feed the SAME frame 3x. Averaging identical
    // frames carries zero new information, so this must reproduce the
    // single-frame result exactly -- it does NOT test whether multi-frame
    // actually helps (no real burst data available yet for that).
    const res = await fetch("/test-samples/m1.jpeg");
    const blob = await res.blob();
    const file = new File([blob], "m1.jpeg", { type: blob.type });
    await runOnFiles([file, file, file], true);
  };

  async function runOnFiles(files: File[], isSmokeTest = false) {
    const lines: string[] = [];
    lines.push(isSmokeTest ? "SMOKE TEST: same frame x3 (plumbing check only, not a real multi-frame result)" : `${files.length} uploaded frames`);
    setLog([...lines]);

    const sum = new Float32Array(CANON_SIZE * CANON_SIZE);
    const count = new Float32Array(CANON_SIZE * CANON_SIZE);
    let usedFrames = 0;

    for (let i = 0; i < files.length; i++) {
      const { gray, w } = await loadGray(files[i]);
      const best = await detectFrame(gray, w);
      if (!best) { lines.push(`frame ${i}: no candidate detected -- skipped`); setLog([...lines]); continue; }
      lines.push(`frame ${i}: cx=${best.cx.toFixed(1)} cy=${best.cy.toFixed(1)} scale=${best.scaleToUse.toFixed(3)} okRays=${best.okRays}`);
      attemptDecode(gray, w, best.cx, best.cy, best.scaleToUse, best.angle, best.threshold, `  frame ${i} alone`, lines);

      const canon = buildCanonicalFrame(gray, w, best.cx, best.cy, best.scaleToUse, best.rotation);
      for (let p = 0; p < canon.length; p++) { sum[p] += canon[p]; count[p] += 1; }
      usedFrames++;
      setLog([...lines]);
    }

    if (usedFrames === 0) { lines.push("no frame detected anything -- cannot average"); setLog([...lines]); return; }

    const averaged = new Float32Array(sum.length);
    for (let p = 0; p < sum.length; p++) averaged[p] = count[p] > 0 ? sum[p] / count[p] : 0;

    await save("multiframe_averaged.png", toPngDataUrl(averaged, CANON_SIZE));
    lines.push(`averaged ${usedFrames}/${files.length} frames onto a shared ${CANON_SIZE}x${CANON_SIZE} canonical grid, saved multiframe_averaged.png`);

    // decode the averaged canonical image: it's already upright (rotation=0)
    // and at a fixed known scale (CANON_PX_PER_UNIT), centered at its own middle
    const canonGray = new Uint8ClampedArray(averaged.length);
    for (let p = 0; p < averaged.length; p++) canonGray[p] = Math.max(0, Math.min(255, Math.round(averaged[p])));
    const canonThreshold = computeOtsuThreshold(canonGray);
    const cx = CANON_SIZE / 2, cy = CANON_SIZE / 2;
    const recovered = attemptDecode(canonGray, CANON_SIZE, cx, cy, CANON_PX_PER_UNIT, designSpokeAngle, canonThreshold, "AVERAGED (multi-frame)", lines);

    // also try erasure-aware decode on the averaged image for good measure
    if (recovered === null) {
      const reserved = buildReservedMask();
      let nAvail = 0;
      for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) nAvail++;
      const maskBits = makeMask("aztec-seed-v1", nAvail);
      const bits = extractGrid(canonGray, CANON_SIZE, cx, cy, CANON_PX_PER_UNIT, designSpokeAngle, canonThreshold);
      const flat: number[] = [];
      for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) flat.push(bits[r][c]);
      const unmasked = flat.map((b, i) => b ^ maskBits[i]).slice(0, MSG_BITS);
      const nBytes = ID_LEN + RS_PARITY;
      const codeword = new Int32Array(nBytes);
      for (let i = 0; i < nBytes; i++) { let b = 0; for (let k = 0; k < 8; k++) b = (b << 1) | unmasked[i * 8 + k]; codeword[i] = b; }
      const ok = decodeWithErasures(codeword, RS_PARITY, []);
      lines.push(`AVERAGED (multi-frame), errors-only via custom decoder: ok=${ok}`);
    }

    setLog([...lines]);
  }

  return (
    <div className="min-h-screen bg-white p-4">
      <h1 className="text-xl font-bold mb-2">multi-frame averaging (temporary)</h1>
      <p className="text-sm text-gray-600 mb-2">Select 2+ photos of the SAME physical marker, taken in quick succession.</p>
      <input ref={fileRef} type="file" accept="image/*" multiple className="mb-2 block" />
      <div className="flex gap-2 mb-4">
        <button onClick={runUploaded} className="border px-3 py-1">Run on uploaded frames</button>
        <button onClick={runSmokeTest} className="border px-3 py-1">Run plumbing smoke test (m1 x3)</button>
      </div>
      <div className="whitespace-pre-wrap font-mono text-xs bg-gray-100 p-3 rounded">{log.join("\n")}</div>
    </div>
  );
};

export default DebugMultiframePage;
