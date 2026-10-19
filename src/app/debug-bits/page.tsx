"use client";
// TEMPORARY — compares m1's extracted bits against the KNOWN correct
// codeword (ID="DEVANSH", confirmed via m2/m3 decoding successfully) to
// precisely count bit/byte errors instead of guessing. Not part of the product.
import React, { useRef, useState } from "react";
import {
  findCandidateCenters, findBullseyeCenters, resolveOrientation, refineScaleFromBoundary,
  computeOtsuThreshold, fitHomographyFromBoundary, extractGridHomography, sampleBilinear,
} from "@/lib/aztec-detector";
import { G, CELL_PX, DCX, DCY, buildReservedMask, makeMask, encodeBits, ID_LEN, RS_PARITY, MSG_BITS, bullseyeCellColor, isSpokeCell } from "@/lib/aztec-marker";
import { decodeWithErasures } from "@/lib/rs-erasures";

// same as extractGridTuned, but also returns a per-cell CONFIDENCE value
// (distance of the 9-point average from the threshold — small = ambiguous,
// large = confident), used to flag low-confidence cells as RS erasures
// instead of forcing a hard guess on them
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

// local copy of extractGrid, parameterized by sample offsets, for tuning
function extractGridTuned(
  grayscale: Uint8ClampedArray, size: number, cx: number, cy: number, scale: number, spokeAngle: number, threshold: number, offsets: number[]
): number[][] {
  const designSpokeAngle = -Math.PI / 2;
  const rotation = spokeAngle - designSpokeAngle;
  const cosr = Math.cos(rotation), sinr = Math.sin(rotation);
  const bits: number[][] = Array.from({ length: G }, () => new Array(G).fill(0));
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
      bits[r][c] = sum / n >= threshold ? 1 : 0;
    }
  }
  return bits;
}

// alternative aggregation: threshold EACH of the 9 points individually,
// then majority-vote the binary decisions, instead of averaging raw values
function extractGridMajorityVote(
  grayscale: Uint8ClampedArray, size: number, cx: number, cy: number, scale: number, spokeAngle: number, threshold: number, offsets: number[]
): number[][] {
  const designSpokeAngle = -Math.PI / 2;
  const rotation = spokeAngle - designSpokeAngle;
  const cosr = Math.cos(rotation), sinr = Math.sin(rotation);
  const bits: number[][] = Array.from({ length: G }, () => new Array(G).fill(0));
  for (let r = 0; r < G; r++) {
    for (let c = 0; c < G; c++) {
      const baseDdx = (c * CELL_PX + CELL_PX / 2) - DCX, baseDdy = (r * CELL_PX + CELL_PX / 2) - DCY;
      let lightVotes = 0, n = 0;
      for (const ox of offsets) {
        for (const oy of offsets) {
          const ddx = baseDdx + ox * CELL_PX, ddy = baseDdy + oy * CELL_PX;
          const rx = ddx * cosr - ddy * sinr, ry = ddx * sinr + ddy * cosr;
          const v = sampleBilinear(grayscale, size, cx + rx * scale, cy + ry * scale);
          if (v >= threshold) lightVotes++;
          n++;
        }
      }
      bits[r][c] = lightVotes * 2 >= n ? 1 : 0;
    }
  }
  return bits;
}

// simple separable box blur, used as the "local average" reference for unsharp masking
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

// unsharp mask: boost the difference between the pixel and its local average,
// which (unlike thresholding) uses NEIGHBORING pixels and can partially
// restore edge contrast that blur attenuated but didn't fully erase
function unsharpMask(gray: Uint8ClampedArray, w: number, h: number, radius: number, amount: number): Uint8ClampedArray {
  const blurred = boxBlur(gray, w, h, radius);
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i] + amount * (gray[i] - blurred[i]);
    out[i] = Math.max(0, Math.min(255, Math.round(v)));
  }
  return out;
}

function grayscaleFromImageData(data: ImageData): Uint8ClampedArray {
  const { data: d, width, height } = data;
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) g[i] = (d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) >> 8;
  return g;
}

const KNOWN_ID = "DEVANSH";
const SEED = "aztec-seed-v1";
const FILE = "m1.jpeg";

const DebugBitsPage = () => {
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

    const reserved = buildReservedMask();
    let nAvail = 0;
    for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) nAvail++;
    const maskBits = makeMask(SEED, nAvail);
    const trueMsgBits = encodeBits(KNOWN_ID); // the REAL codeword, ground truth
    const designSpokeAngle = -Math.PI / 2;

    // Select the candidate by okRays only (realistic — no ground-truth
    // cheating), then hold center/angle/scale FIXED and sweep only the
    // per-cell sample footprint, to isolate that one variable.
    let best: any = null;
    for (const c of candidates) {
      const angle = resolveOrientation(gray, w, c.cx, c.cy, c.coarseScale, threshold);
      if (!Number.isFinite(angle)) continue;
      const rotation = angle - designSpokeAngle;
      const refined = refineScaleFromBoundary(gray, w, c.cx, c.cy, rotation, c.coarseScale, threshold);
      if (!best || refined.okRays > best.okRays) best = { c, angle, okRays: refined.okRays, scaleToUse: Number.isFinite(refined.scale) ? refined.scale : c.coarseScale, rotation };
    }
    if (!best) { lines.push("no candidate found an orientation at all"); setLog(lines); return; }
    lines.push(`candidate: cx=${best.c.cx.toFixed(1)} cy=${best.c.cy.toFixed(1)} coarseScale=${best.c.coarseScale.toFixed(3)} angle=${(best.angle*180/Math.PI).toFixed(1)}deg okRays=${best.okRays} scale=${best.scaleToUse.toFixed(3)}`);

    // pre-binarize the WHOLE image to pure 0/255 using the same Otsu
    // threshold, BEFORE sampling — snaps every pixel to a hard decision
    // first, so bilinear sampling near a cell boundary interpolates
    // between hard 0/255 values instead of the original smooth blur
    const grayBin = new Uint8ClampedArray(gray.length);
    for (let i = 0; i < gray.length; i++) grayBin[i] = gray[i] < threshold ? 0 : 255;

    function countMismatches(bits: number[][]): number {
      const flat: number[] = [];
      for (let r = 0; r < G; r++) for (let col = 0; col < G; col++) if (!reserved[r][col]) flat.push(bits[r][col]);
      const unmasked = flat.map((b, i) => b ^ maskBits[i]);
      let m = 0;
      for (let i = 0; i < trueMsgBits.length; i++) if (unmasked[i] !== trueMsgBits[i]) m++;
      return m;
    }

    const offsetConfigs: { label: string; offsets: number[] }[] = [
      { label: "single center point", offsets: [0] },
      { label: "3x3 @ ±0.10", offsets: [-0.10, 0, 0.10] },
      { label: "3x3 @ ±0.15", offsets: [-0.15, 0, 0.15] },
      { label: "3x3 @ ±0.25 (current)", offsets: [-0.25, 0, 0.25] },
      { label: "3x3 @ ±0.35", offsets: [-0.35, 0, 0.35] },
      { label: "5x5 @ ±0.05..0.20", offsets: [-0.20, -0.10, 0, 0.10, 0.20] },
    ];
    for (const cfg of offsetConfigs) {
      const bits = extractGridTuned(gray, w, best.c.cx, best.c.cy, best.scaleToUse, best.angle, threshold, cfg.offsets);
      const m = countMismatches(bits);
      lines.push(`${cfg.label}: mismatches=${m}/${trueMsgBits.length} (${(100*m/trueMsgBits.length).toFixed(1)}%)`);
      if (cfg.label.includes("current")) {
        // precise finder-pattern check: compare the STRUCTURAL (non-data) cells
        // directly against the known design, no masking involved at all
        let finderTotal = 0, finderWrong = 0;
        for (let r = 0; r < G; r++) {
          for (let c = 0; c < G; c++) {
            const bull = bullseyeCellColor(r, c);
            const expected = bull !== null ? (bull === 255 ? 1 : 0) : isSpokeCell(r, c) ? 0 : null;
            if (expected === null) continue;
            finderTotal++;
            if (bits[r][c] !== expected) finderWrong++;
          }
        }
        lines.push(`  finder-pattern cells (rings+spoke, unmasked, ground truth): ${finderWrong}/${finderTotal} wrong`);
      }
    }

    // majority-vote variant, same offset configs, for direct comparison
    for (const cfg of offsetConfigs) {
      const bits = extractGridMajorityVote(gray, w, best.c.cx, best.c.cy, best.scaleToUse, best.angle, threshold, cfg.offsets);
      const m = countMismatches(bits);
      lines.push(`[majority-vote, raw grayscale] ${cfg.label}: mismatches=${m}/${trueMsgBits.length} (${(100*m/trueMsgBits.length).toFixed(1)}%)`);
    }

    // pre-binarized image: hard 0/255 edges everywhere BEFORE sampling,
    // then the same average and majority-vote aggregations on top
    for (const cfg of offsetConfigs) {
      const bitsAvg = extractGridTuned(grayBin, w, best.c.cx, best.c.cy, best.scaleToUse, best.angle, threshold, cfg.offsets);
      const mAvg = countMismatches(bitsAvg);
      lines.push(`[pre-binarized, average] ${cfg.label}: mismatches=${mAvg}/${trueMsgBits.length} (${(100*mAvg/trueMsgBits.length).toFixed(1)}%)`);
      const bitsVote = extractGridMajorityVote(grayBin, w, best.c.cx, best.c.cy, best.scaleToUse, best.angle, threshold, cfg.offsets);
      const mVote = countMismatches(bitsVote);
      lines.push(`[pre-binarized, vote]    ${cfg.label}: mismatches=${mVote}/${trueMsgBits.length} (${(100*mVote/trueMsgBits.length).toFixed(1)}%)`);
    }

    // sweep the GLOBAL threshold value itself — lower/higher than Otsu's
    // pick — on the raw grayscale, current 3x3 @ ±0.25 sampling, to test
    // directly whether moving the cutoff helps rather than assuming it can't
    lines.push(`--- threshold sweep (Otsu picked ${threshold}) ---`);
    for (let t = threshold - 40; t <= threshold + 40; t += 10) {
      const bits = extractGridTuned(gray, w, best.c.cx, best.c.cy, best.scaleToUse, best.angle, t, [-0.25, 0, 0.25]);
      const m = countMismatches(bits);
      const tag = t === threshold ? " (Otsu)" : "";
      lines.push(`threshold=${t}${tag}: mismatches=${m}/${trueMsgBits.length} (${(100*m/trueMsgBits.length).toFixed(1)}%)`);
    }

    // unsharp-mask sharpening BEFORE thresholding — genuinely different from
    // simple binarization because it uses NEIGHBORING pixels (local average)
    // to boost edge contrast, instead of just moving a per-pixel cutoff
    const cellPxScaled = CELL_PX * best.scaleToUse;
    const sharpenConfigs = [
      { label: "unsharp r=1 amt=1", radius: Math.max(1, cellPxScaled * 0.5), amount: 1 },
      { label: "unsharp r=1 amt=2", radius: Math.max(1, cellPxScaled * 0.5), amount: 2 },
      { label: "unsharp r=1 amt=4", radius: Math.max(1, cellPxScaled * 0.5), amount: 4 },
      { label: "unsharp r=0.5cell amt=3", radius: Math.max(1, cellPxScaled * 0.25), amount: 3 },
      { label: "unsharp r=1cell amt=3", radius: Math.max(1, cellPxScaled * 1.0), amount: 3 },
    ];
    for (const cfg of sharpenConfigs) {
      const sharpened = unsharpMask(gray, w, h, cfg.radius, cfg.amount);
      const sharpThreshold = computeOtsuThreshold(sharpened);
      const bits = extractGridTuned(sharpened, w, best.c.cx, best.c.cy, best.scaleToUse, best.angle, sharpThreshold, [-0.25, 0, 0.25]);
      const m = countMismatches(bits);
      lines.push(`[${cfg.label}] radius=${cfg.radius.toFixed(1)}px newThreshold=${sharpThreshold}: mismatches=${m}/${trueMsgBits.length} (${(100*m/trueMsgBits.length).toFixed(1)}%)`);
    }

    // ERASURE-AWARE RS DECODE: flag the LEAST CONFIDENT cells (closest to
    // the threshold) as erasures instead of forcing a hard guess, and sweep
    // how many erasures it takes to actually decode "DEVANSH". Validated
    // separately against synthetic known-corruption cases (/debug-erasure-rs)
    // before trusting it here.
    const { bits: confBits, conf: confGrid } = extractGridWithConfidence(gray, w, best.c.cx, best.c.cy, best.scaleToUse, best.angle, threshold, [-0.25, 0, 0.25]);
    const flatBits: number[] = [], flatConf: number[] = [];
    for (let r = 0; r < G; r++) for (let col = 0; col < G; col++) if (!reserved[r][col]) { flatBits.push(confBits[r][col]); flatConf.push(confGrid[r][col]); }
    const unmaskedBits = flatBits.map((b, i) => b ^ maskBits[i]).slice(0, MSG_BITS);
    const bitConf = flatConf.slice(0, MSG_BITS);
    const nBytes = ID_LEN + RS_PARITY; // 32
    const byteMinConf: number[] = [];
    for (let i = 0; i < nBytes; i++) {
      let m = Infinity;
      for (let k = 0; k < 8; k++) m = Math.min(m, bitConf[i * 8 + k]);
      byteMinConf.push(m);
    }
    const byteOrderByConfidence = byteMinConf.map((_, i) => i).sort((a, b) => byteMinConf[a] - byteMinConf[b]);
    function bitsToBytesArr(bits: number[]): Int32Array {
      const out = new Int32Array(nBytes);
      for (let i = 0; i < nBytes; i++) {
        let b = 0;
        for (let k = 0; k < 8; k++) b = (b << 1) | bits[i * 8 + k];
        out[i] = b;
      }
      return out;
    }
    lines.push(`--- erasure-aware RS decode sweep (flagging k least-confident bytes as erasures) ---`);
    for (let k = 0; k <= 16; k += 2) {
      const erasurePositions = byteOrderByConfidence.slice(0, k);
      const bytes = bitsToBytesArr(unmaskedBits);
      const ok = decodeWithErasures(bytes, RS_PARITY, erasurePositions);
      let recovered: string | null = null;
      if (ok) {
        const chars = Array.from(bytes.slice(0, ID_LEN)).map((b) => String.fromCharCode(b as number));
        recovered = chars.join("").replace(/\0+$/, "");
      }
      lines.push(`k=${k} erasures: ok=${ok} recovered=${JSON.stringify(recovered)} ${recovered === "DEVANSH" ? "<<< MATCH" : ""}`);
    }

    // homography path, with default offsets, for comparison
    const homography = fitHomographyFromBoundary(gray, w, best.c.cx, best.c.cy, best.rotation, best.scaleToUse, threshold);
    if (homography) {
      const hBits = extractGridHomography(gray, w, homography, threshold);
      const hM = countMismatches(hBits);
      lines.push(`homography path: mismatches=${hM}/${trueMsgBits.length} (${(100*hM/trueMsgBits.length).toFixed(1)}%)`);
    } else {
      lines.push("homography path: fit failed (too few boundary points)");
    }
    lines.push(`(RS can correct up to ${RS_PARITY / 2} of ${ID_LEN + RS_PARITY} bytes)`);
    setLog(lines);
  };

  return (
    <div className="min-h-screen bg-white p-4">
      <h1 className="text-xl font-bold mb-2">m1 bit-error diagnostic vs known ground truth (temporary)</h1>
      <button onClick={run} className="border px-3 py-1 mb-4">Run</button>
      <div className="mb-4 whitespace-pre-wrap font-mono text-xs bg-gray-100 p-3 rounded">{log.join("\n")}</div>
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
};

export default DebugBitsPage;
