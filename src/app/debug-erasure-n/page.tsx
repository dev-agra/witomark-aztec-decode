"use client";
// TEMPORARY — tries the validated errors-and-erasures RS decoder on n1-n3
// (no known ground truth, unlike m1-m3) to see whether any of them fall in
// the correctable range once low-confidence cells are flagged as erasures
// instead of forced hard guesses. Not part of the product.
import React, { useState } from "react";
import {
  findCandidateCenters, findBullseyeCenters, resolveOrientation, refineScaleFromBoundary,
  computeOtsuThreshold, sampleBilinear, extractGrid,
} from "@/lib/aztec-detector";
import { G, CELL_PX, DCX, DCY, buildReservedMask, makeMask, rsDecodeBits, ID_LEN, RS_PARITY, MSG_BITS } from "@/lib/aztec-marker";
import { decodeWithErasures } from "@/lib/rs-erasures";

function grayscaleFromImageData(data: ImageData): Uint8ClampedArray {
  const { data: d, width, height } = data;
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) g[i] = (d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) >> 8;
  return g;
}

function extractGridWithConfidence(
  grayscale: Uint8ClampedArray, size: number, cx: number, cy: number, scale: number, spokeAngle: number, threshold: number, offsets: number[]
): { bits: number[][]; conf: number[][] } {
  const designSpokeAngle = -Math.PI / 2;
  const rotation = spokeAngle - designSpokeAngle;
  const cosr = Math.cos(rotation), sinr = Math.sin(rotation);
  const bits: number[][] = Array.from({ length: G }, () => new Array(G).fill(0));
  const conf: number[][] = Array.from({ length: G }, () => new Array(G).fill(0));
  for (let r = 0; r < G; r++) {
    for (let c = 0; c < G; c++) {
      const baseDdx = (c * CELL_PX + CELL_PX / 2) - DCX, baseDdy = (r * CELL_PX + CELL_PX / 2) - DCY;
      let sum = 0, n = 0;
      for (const ox of offsets) {
        for (const oy of offsets) {
          const ddx = baseDdx + ox * CELL_PX, ddy = baseDdy + oy * CELL_PX;
          const rx = ddx * cosr - ddy * sinr, ry = ddx * sinr + ddy * cosr;
          sum += sampleBilinear(grayscale, size, cx + rx * scale, cy + ry * scale);
          n++;
        }
      }
      const avg = sum / n;
      bits[r][c] = avg >= threshold ? 1 : 0;
      conf[r][c] = Math.abs(avg - threshold);
    }
  }
  return { bits, conf };
}

const FILES = ["n1.jpeg", "n2.jpeg", "n3.jpeg"];
const nBytes = ID_LEN + RS_PARITY; // 32

function bitsToBytesArr(bits: number[]): Int32Array {
  const out = new Int32Array(nBytes);
  for (let i = 0; i < nBytes; i++) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i * 8 + k];
    out[i] = b;
  }
  return out;
}

const DebugErasureNPage = () => {
  const [log, setLog] = useState<string[]>([]);

  const run = async () => {
    const lines: string[] = [];
    const reserved = buildReservedMask();
    let nAvail = 0;
    for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) nAvail++;
    const maskBits = makeMask("aztec-seed-v1", nAvail);
    const designSpokeAngle = -Math.PI / 2;

    for (const name of FILES) {
      lines.push(`=== ${name} ===`);
      const img = new Image();
      await new Promise<void>((resolve) => { img.onload = () => resolve(); img.src = `/test-samples/${name}`; });
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

      const finderCandidates = findBullseyeCenters(gray, w, threshold);
      const blobCandidates = findCandidateCenters(gray, w, threshold);
      const candidates = [...finderCandidates, ...blobCandidates];

      let best: any = null;
      for (const c of candidates) {
        const angle = resolveOrientation(gray, w, c.cx, c.cy, c.coarseScale, threshold);
        if (!Number.isFinite(angle)) continue;
        const rotation = angle - designSpokeAngle;
        const refined = refineScaleFromBoundary(gray, w, c.cx, c.cy, rotation, c.coarseScale, threshold);
        if (!best || refined.okRays > best.okRays) best = { c, angle, okRays: refined.okRays, scaleToUse: Number.isFinite(refined.scale) ? refined.scale : c.coarseScale, rotation };
      }
      if (!best) { lines.push("no candidate found an orientation at all"); setLog([...lines]); continue; }
      lines.push(`candidate: cx=${best.c.cx.toFixed(1)} cy=${best.c.cy.toFixed(1)} okRays=${best.okRays} scale=${best.scaleToUse.toFixed(3)}`);

      // plain (current product) path, for reference
      const plainBits = extractGrid(gray, w, best.c.cx, best.c.cy, best.scaleToUse, best.angle, threshold);
      const plainFlat: number[] = [];
      for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) plainFlat.push(plainBits[r][c]);
      const plainUnmasked = plainFlat.map((b, i) => b ^ maskBits[i]).slice(0, MSG_BITS);
      const plainRecovered = rsDecodeBits(plainUnmasked);
      lines.push(`plain errors-only decode: ${plainRecovered !== null ? `DECODED -> "${plainRecovered}"` : "FAILED"}`);

      // erasure-aware sweep
      const { bits: confBits, conf: confGrid } = extractGridWithConfidence(gray, w, best.c.cx, best.c.cy, best.scaleToUse, best.angle, threshold, [-0.25, 0, 0.25]);
      const flatBits: number[] = [], flatConf: number[] = [];
      for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) { flatBits.push(confBits[r][c]); flatConf.push(confGrid[r][c]); }
      const unmaskedBits = flatBits.map((b, i) => b ^ maskBits[i]).slice(0, MSG_BITS);
      const bitConf = flatConf.slice(0, MSG_BITS);
      const byteMinConf: number[] = [];
      for (let i = 0; i < nBytes; i++) {
        let m = Infinity;
        for (let kk = 0; kk < 8; kk++) m = Math.min(m, bitConf[i * 8 + kk]);
        byteMinConf.push(m);
      }
      const byteOrderByConfidence = byteMinConf.map((_, i) => i).sort((a, b) => byteMinConf[a] - byteMinConf[b]);

      let firstSuccessK: number | null = null;
      for (let kk = 0; kk <= 16; kk += 1) {
        const erasurePositions = byteOrderByConfidence.slice(0, kk);
        const bytes = bitsToBytesArr(unmaskedBits);
        const ok = decodeWithErasures(bytes, RS_PARITY, erasurePositions);
        if (ok) {
          const chars = Array.from(bytes.slice(0, ID_LEN)).map((b) => String.fromCharCode(b as number));
          const recovered = chars.join("").replace(/\0+$/, "");
          const printable = /^[\x20-\x7E]*$/.test(recovered) && recovered.length > 0;
          lines.push(`  k=${kk}: ok=true recovered=${JSON.stringify(recovered)} ${printable ? "(looks printable/plausible)" : "(looks like garbage -- likely a false positive, over-budget)"}`);
          if (firstSuccessK === null) firstSuccessK = kk;
        }
      }
      if (firstSuccessK === null) lines.push(`  no k in 0..16 produced an RS-valid decode at all`);
      setLog([...lines]);
    }
  };

  return (
    <div className="min-h-screen bg-white p-4">
      <h1 className="text-xl font-bold mb-2">erasure-aware RS decode on n1-n3 (temporary)</h1>
      <button onClick={run} className="border px-3 py-1 mb-4">Run</button>
      <div className="whitespace-pre-wrap font-mono text-xs bg-gray-100 p-3 rounded">{log.join("\n")}</div>
    </div>
  );
};

export default DebugErasureNPage;
