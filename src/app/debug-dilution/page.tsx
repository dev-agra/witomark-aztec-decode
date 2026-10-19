"use client";
// TEMPORARY — visualizes the depth-fraction dilution problem on real n1
// pixels: 5 sample points for the original 32-40 window vs 5 for a widened
// 32-50 window, at the SAME trial scale, at the true spoke angle. Not part
// of the product.
import React, { useRef, useState } from "react";
import { computeOtsuThreshold, sampleBilinear } from "@/lib/aztec-detector";

function grayscaleFromImageData(data: ImageData): Uint8ClampedArray {
  const { data: d, width, height } = data;
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) g[i] = (d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) >> 8;
  return g;
}

const CX = 371, CY = 411.8, COARSE_SCALE = 0.969, TRIAL_FACTOR = 1.3;
const SPOKE_INNER = 32, SPOKE_OUTER = 40, SPOKE_SEARCH_OUTER = 50;
const TRUE_ANGLE_DEG = 270;

const DebugDilutionPage = () => {
  const [log, setLog] = useState<string[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const run = async () => {
    const lines: string[] = [];
    const img = new Image();
    await new Promise<void>((resolve) => { img.onload = () => resolve(); img.src = "/test-samples/n1.jpeg"; });
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

    const scale = COARSE_SCALE * TRIAL_FACTOR;
    const rad = (TRUE_ANGLE_DEG * Math.PI) / 180;
    const cosA = Math.cos(rad), sinA = Math.sin(rad);

    function sampleWindow(outer: number) {
      const pts = [];
      for (let i = 0; i < 5; i++) {
        const t = i / 4;
        const rNative = SPOKE_INNER + t * (outer - SPOKE_INNER);
        const rPx = rNative * scale;
        const x = CX + cosA * rPx, y = CY + sinA * rPx;
        const v = sampleBilinear(gray, w, x, y);
        pts.push({ rNative, rPx, x, y, v, dark: v < threshold });
      }
      return pts;
    }

    const narrow = sampleWindow(SPOKE_OUTER);
    const wide = sampleWindow(SPOKE_SEARCH_OUTER);
    const narrowFrac = narrow.filter((p) => p.dark).length / 5;
    const wideFrac = wide.filter((p) => p.dark).length / 5;
    lines.push(`scale=${scale.toFixed(3)} (coarseScale=${COARSE_SCALE} x trial factor=${TRIAL_FACTOR})`);
    lines.push(`narrow window (32-40 native): ${narrow.map(p => `${p.rPx.toFixed(1)}px=${Math.round(p.v)}${p.dark?"D":"L"}`).join(" ")}  -> darkFraction=${narrowFrac}`);
    lines.push(`wide window (32-50 native):   ${wide.map(p => `${p.rPx.toFixed(1)}px=${Math.round(p.v)}${p.dark?"D":"L"}`).join(" ")}  -> darkFraction=${wideFrac}`);

    const crop = document.createElement("canvas");
    const sx = CX - 95, sy = CY - 95, sw = 190, sh = 190, zoom = 4;
    crop.width = sw * zoom; crop.height = sh * zoom;
    const cctx = crop.getContext("2d")!;
    cctx.imageSmoothingEnabled = false;
    cctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw * zoom, sh * zoom);
    const toCrop = (x: number, y: number) => [(x - sx) * zoom, (y - sy) * zoom];

    // draw narrow-window arc (yellow) and wide-window arc (purple) for context
    const [ccx, ccy] = toCrop(CX, CY);
    cctx.strokeStyle = "#eda100"; cctx.lineWidth = 2; cctx.setLineDash([4, 4]);
    cctx.beginPath(); cctx.arc(ccx, ccy, SPOKE_INNER * scale * zoom, 0, 2 * Math.PI); cctx.stroke();
    cctx.beginPath(); cctx.arc(ccx, ccy, SPOKE_OUTER * scale * zoom, 0, 2 * Math.PI); cctx.stroke();
    cctx.strokeStyle = "#6250d6";
    cctx.beginPath(); cctx.arc(ccx, ccy, SPOKE_SEARCH_OUTER * scale * zoom, 0, 2 * Math.PI); cctx.stroke();
    cctx.setLineDash([]);

    narrow.forEach((p, i) => {
      const [x, y] = toCrop(p.x, p.y);
      cctx.fillStyle = p.dark ? "#008300" : "#E24B4A";
      cctx.beginPath(); cctx.arc(x, y, 7, 0, 2 * Math.PI); cctx.fill();
      cctx.fillStyle = "#000"; cctx.font = "13px monospace";
      cctx.fillText(`n${i}`, x + 8, y - 8);
    });
    wide.forEach((p, i) => {
      const [x, y] = toCrop(p.x, p.y);
      cctx.strokeStyle = p.dark ? "#008300" : "#E24B4A"; cctx.lineWidth = 3;
      cctx.beginPath(); cctx.arc(x, y, 10, 0, 2 * Math.PI); cctx.stroke();
      cctx.fillStyle = "#000"; cctx.font = "13px monospace";
      cctx.fillText(`w${i}`, x + 8, y + 14);
    });

    cctx.fillStyle = "#378ADD";
    cctx.font = "16px monospace";
    cctx.fillText(`narrow dark=${narrowFrac}  wide dark=${wideFrac}`, 10, 24);

    const dataUrl = crop.toDataURL("image/png");
    await fetch("/api/debug-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "n1_dilution.png", dataUrl }) });
    lines.push("saved n1_dilution.png");
    setLog(lines);
  };

  return (
    <div className="min-h-screen bg-white p-4">
      <h1 className="text-xl font-bold mb-2">dilution visual (temporary)</h1>
      <button onClick={run} className="border px-3 py-1 mb-4">Run</button>
      <div className="mb-4 whitespace-pre-wrap font-mono text-xs bg-gray-100 p-3 rounded">{log.join("\n")}</div>
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
};

export default DebugDilutionPage;
