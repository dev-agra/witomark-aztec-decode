"use client";
// AZTEC-STYLE SQUARE BULLSEYE MARKER — generator UI.
//
// Client-side only — nothing is sent anywhere. Encodes 1-16 characters into
// a 20x20-cell square-bullseye marker (RS(16,16), seeded XOR mask, filling
// the grid's full bit capacity — see aztec-marker.ts).

import React, { useState, useCallback, useRef, useEffect } from "react";
import Link from "next/link";
import { Download } from "lucide-react";
import {
  ID_LEN, RS_PARITY, G, CELL_PX, PHYSICAL_MM, PER_PX_MM, REQUIRED_DPI, MSG_BITS,
  renderMarker, validateId, buildReservedMask, type RenderedMarker,
} from "@/lib/aztec-marker";
import { DEFAULT_WM_STRENGTH, DEFAULT_WM_PAIR, WM_PAIR_PRESETS, WM_BLOCK, samePair, type CoeffPair } from "@/lib/watermark";
import { pngWithDpi, dataUrlToBytes } from "@/lib/png-dpi";

function randomId(len: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const nAvail = (() => {
  const reserved = buildReservedMask();
  let n = 0;
  for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) n++;
  return n;
})();

// 8x8 DCT coefficient picker. Rows = vertical frequency u, columns = horizontal frequency v. The watermark
// bit is the ORDER of two coefficients: bit 1 when A > B. Click a cell to set the highlighted slot; clicking
// the other slot's cell swaps them. (0,0) is the DC term (block brightness) and can't be used.
function CoeffGrid({ pair, onChange }: { pair: CoeffPair; onChange: (p: CoeffPair) => void }) {
  const [slot, setSlot] = useState<0 | 1>(0);
  const click = (u: number, v: number) => {
    if (u === 0 && v === 0) return;
    const other = pair[slot === 0 ? 1 : 0];
    if (other[0] === u && other[1] === v) {
      onChange([pair[1], pair[0]]); // clicked the other slot's cell: swap A and B
      return;
    }
    const next: CoeffPair = slot === 0 ? [[u, v], pair[1]] : [pair[0], [u, v]];
    onChange(next);
    setSlot(slot === 0 ? 1 : 0);
  };
  const presetIdx = WM_PAIR_PRESETS.findIndex((p) => samePair(p.pair, pair));
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-ref text-gray-600">
        Pair
        <select
          value={presetIdx >= 0 ? String(presetIdx) : "custom"}
          onChange={(e) => { if (e.target.value !== "custom") onChange(WM_PAIR_PRESETS[Number(e.target.value)].pair); }}
          className="flex-1 rounded border border-gray-300 px-2 py-1 text-black"
        >
          {WM_PAIR_PRESETS.map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}
          {presetIdx < 0 && <option value="custom">Custom ({pair[0][0]},{pair[0][1]})/({pair[1][0]},{pair[1][1]})</option>}
        </select>
      </div>
      <div className="flex items-center gap-2 text-ref text-gray-600">
        Next click sets
        {([0, 1] as const).map((k) => (
          <button
            key={k} type="button" onClick={() => setSlot(k)}
            className={`rounded px-2 py-0.5 font-mono ${slot === k ? (k === 0 ? "bg-emerald-600 text-white" : "bg-sky-600 text-white") : "border border-gray-300 text-gray-600"}`}
          >
            {k === 0 ? "A" : "B"}
          </button>
        ))}
        <span className="text-gray-400">bit 1 = A larger than B</span>
      </div>
      <div className="inline-block self-start">
        <div className="mb-1 pl-5 text-[10px] text-gray-400">horizontal frequency v →</div>
        <div className="flex">
          <div className="mr-1 flex flex-col justify-around text-[10px] text-gray-400" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
            vertical frequency u →
          </div>
          <div>
            <div className="flex pl-0">
              {Array.from({ length: WM_BLOCK }, (_, v) => <div key={v} className="w-7 text-center text-[10px] text-gray-400">{v}</div>)}
            </div>
            {Array.from({ length: WM_BLOCK }, (_, u) => (
              <div key={u} className="flex items-center">
                {Array.from({ length: WM_BLOCK }, (_, v) => {
                  const isA = pair[0][0] === u && pair[0][1] === v, isB = pair[1][0] === u && pair[1][1] === v;
                  const dc = u === 0 && v === 0;
                  return (
                    <button
                      key={v} type="button" disabled={dc} onClick={() => click(u, v)} title={dc ? "DC term — not usable" : `u=${u}, v=${v}`}
                      className={`h-7 w-7 border border-white text-[11px] font-mono ${
                        isA ? "bg-emerald-600 text-white" : isB ? "bg-sky-600 text-white" : dc ? "bg-gray-200 text-gray-400" : "bg-gray-100 text-gray-300 hover:bg-gray-200"
                      }`}
                    >
                      {isA ? "A" : isB ? "B" : dc ? "DC" : ""}
                    </button>
                  );
                })}
                <span className="ml-1 w-3 text-[10px] text-gray-400">{u}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="text-[11px] leading-snug text-gray-500">
        Low frequencies (top-left) survive blur but show more; high ones (bottom-right) are subtler but fragile. The
        scanner must read the same pair the marker was made with.
      </p>
    </div>
  );
}

const GeneratePage = () => {
  const [id, setId] = useState(randomId(8));
  const [seed, setSeed] = useState("aztec-seed-v1");
  const [error, setError] = useState<string | null>(null);
  // SQR-style DCT watermark (see lib/watermark.ts): on by default, like SQR.
  const [watermark, setWatermark] = useState(true);
  const [strength, setStrength] = useState(DEFAULT_WM_STRENGTH);
  const [pair, setPair] = useState<CoeffPair>(DEFAULT_WM_PAIR);
  const [rendered, setRendered] = useState<RenderedMarker | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const generate = useCallback(() => {
    setError(null);
    const check = validateId(id);
    if (!check.ok) {
      setRendered(null);
      setError(check.error);
      return;
    }
    try {
      const r = renderMarker(id, seed, { watermark: watermark ? { strength, pair } : false });
      setRendered(r);
    } catch (e) {
      setRendered(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id, seed, watermark, strength, pair]);

  useEffect(() => {
    generate();
  }, [generate]);

  useEffect(() => {
    if (!rendered || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = rendered.width;
    canvas.height = rendered.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(rendered.width, rendered.height);
    for (let i = 0, o = 0; i < rendered.pixels.length; i++, o += 4) {
      img.data[o] = img.data[o + 1] = img.data[o + 2] = rendered.pixels[i];
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [rendered]);

  const handleDownloadPng = () => {
    if (!canvasRef.current) return;
    // Tag the PNG with the design density so it prints at PHYSICAL_MM, as SQR's download does.
    const bytes = pngWithDpi(dataUrlToBytes(canvasRef.current.toDataURL("image/png")), REQUIRED_DPI);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `aztec-marker-${id}${rendered?.watermarked ? (samePair(pair, DEFAULT_WM_PAIR) ? "-wm" : `-wm-A${pair[0][0]}${pair[0][1]}-B${pair[1][0]}${pair[1][1]}`) : ""}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto max-w-md p-4">
        <div className="-mx-4 -mt-4 flex items-center justify-center border-b border-gray-100 px-4 py-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/witomark-logo.png" alt="Witomark" width={200} height={48} className="h-7 w-auto object-contain" />
        </div>

        <div className="mt-2 flex items-center justify-between">
          <h1 className="text-h2 font-bold text-black">Generate Aztec marker</h1>
          <Link href="/decode" className="text-ref text-gray-400 underline">
            Decode a marker →
          </Link>
        </div>
        <p className="mt-1 text-body text-gray-500">
          Client-side only — nothing is sent anywhere. Square (Aztec-style) concentric bullseye
          finder, {G}×{G} grid, RS({ID_LEN},{RS_PARITY}) message channel.
        </p>

        <div className="mt-5 flex flex-col gap-4">
          <Field label={`Fingerprint ID (1-${ID_LEN} characters)`}>
            <div className="flex gap-2">
              <input
                value={id}
                onChange={(e) => setId(e.target.value.toUpperCase().slice(0, ID_LEN))}
                maxLength={ID_LEN}
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm text-black"
              />
              <button
                onClick={() => setId(randomId(8))}
                className="rounded-lg border border-gray-300 px-3 py-2 text-ref text-gray-600"
              >
                Random
              </button>
            </div>
          </Field>

          <Field label="Seed (must match between generation and scanning)">
            <input
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm text-black"
            />
          </Field>

          <div className="rounded-lg border border-gray-200 p-3">
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={watermark} onChange={(e) => setWatermark(e.target.checked)} className="mt-1" />
              <span className="flex flex-col gap-1">
                <span className="text-btn text-black">DCT watermark (SQR-style)</span>
                <span className="text-ref text-gray-500">
                  One hidden bit per cell, derived from the ID. Survives only a high-resolution print and scan, so a
                  copy loses it.
                </span>
              </span>
            </label>
            {watermark && (
              <div className="mt-2 border-t border-gray-100 pt-2">
                <div className="flex items-center gap-2 text-ref text-gray-600">
                  Strength
                  <input
                    type="number" min={0} max={400} step={10} value={strength}
                    onChange={(e) => setStrength(Math.max(0, Math.min(400, Number(e.target.value) || 0)))}
                    className="w-20 rounded border border-gray-300 px-2 py-1 font-mono text-black"
                  />
                </div>
                <CoeffGrid pair={pair} onChange={setPair} />
              </div>
            )}
          </div>

          <button
            onClick={generate}
            className="rounded-full bg-black py-3 text-btn font-medium text-white"
          >
            Regenerate
          </button>

          {error && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-ref text-red-700">{error}</div>
          )}

          {rendered && !error && (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-gray-200 p-4">
              {/* Fixed, simple display — no zoom slider, no scrollbars.
                  Rendered at native resolution, scaled up by CSS to a fixed
                  280px box (square, since the marker always is). */}
              <canvas
                ref={canvasRef}
                className="rounded-lg border border-gray-300"
                style={{ imageRendering: "pixelated", width: "280px", height: "280px" }}
              />

              <div className="grid w-full grid-cols-2 gap-x-4 gap-y-1 text-ref text-gray-600">
                <Row k="Output size" v={`${rendered.width}×${rendered.height}px`} />
                <Row k="Grid" v={`${G}×${G} cells, ${CELL_PX}px each`} />
                <Row k="Physical size" v={`${PHYSICAL_MM}mm × ${PHYSICAL_MM}mm`} />
                <Row k="Required print DPI" v={REQUIRED_DPI.toFixed(0)} />
                <Row k="Per-pixel size" v={`${PER_PX_MM.toFixed(4)}mm`} />
                <Row k="Watermark" v={rendered.watermarked && rendered.watermarkPair ? `${G * G} bits, strength ${rendered.watermarkStrength}, A(${rendered.watermarkPair[0][0]},${rendered.watermarkPair[0][1]}) B(${rendered.watermarkPair[1][0]},${rendered.watermarkPair[1][1]})` : "off"} />
                <Row k="Message capacity" v={`${MSG_BITS} bits used / ${nAvail} available`} />
              </div>

              <button
                onClick={handleDownloadPng}
                className="flex w-full items-center justify-center gap-2 rounded-full border border-gray-300 py-2.5 text-btn text-black"
              >
                <Download className="h-4 w-4" /> Download PNG
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-ref uppercase tracking-wide text-gray-400">{label}</span>
      {children}
    </label>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-400">{k}</span>
      <span className="font-mono text-black">{v}</span>
    </div>
  );
}

export default GeneratePage;
