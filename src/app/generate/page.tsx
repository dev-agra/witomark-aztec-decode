"use client";
// AZTEC-STYLE SQUARE BULLSEYE MARKER — generator UI.
//
// Client-side only — nothing is sent anywhere. Encodes 1-16 characters into
// a 24x24-cell square-bullseye marker (RS(16,10), seeded XOR mask, no
// repetition — see aztec-marker.ts for why 24x24 and not 20x20).

import React, { useState, useCallback, useRef, useEffect } from "react";
import Link from "next/link";
import { Download } from "lucide-react";
import {
  ID_LEN, G, CELL_PX, PHYSICAL_MM, PER_PX_MM, REQUIRED_DPI, MSG_BITS,
  renderMarker, validateId, buildReservedMask, type RenderedMarker,
} from "@/lib/aztec-marker";

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

const GeneratePage = () => {
  const [id, setId] = useState(randomId(8));
  const [seed, setSeed] = useState("aztec-seed-v1");
  const [displayScale, setDisplayScale] = useState(6);
  const [error, setError] = useState<string | null>(null);
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
      const r = renderMarker(id, seed);
      setRendered(r);
    } catch (e) {
      setRendered(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id, seed]);

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
    const a = document.createElement("a");
    a.href = canvasRef.current.toDataURL("image/png");
    a.download = `aztec-marker-${id}.png`;
    a.click();
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
          finder, {G}×{G} grid, RS({ID_LEN},10) message channel.
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
              <div className="w-full overflow-auto">
                <canvas
                  ref={canvasRef}
                  className="border border-gray-300"
                  style={{
                    imageRendering: "pixelated",
                    width: `${rendered.width * displayScale}px`,
                    height: `${rendered.height * displayScale}px`,
                    maxWidth: "none",
                  }}
                />
              </div>

              <div className="flex w-full items-center gap-3">
                <span className="text-ref text-gray-400">Display</span>
                <input
                  type="range"
                  min={1}
                  max={16}
                  step={1}
                  value={displayScale}
                  onChange={(e) => setDisplayScale(Number(e.target.value))}
                  className="flex-1"
                />
                <span className="w-10 text-right font-mono text-ref text-black">{displayScale}×</span>
              </div>

              <div className="grid w-full grid-cols-2 gap-x-4 gap-y-1 text-ref text-gray-600">
                <Row k="Output size" v={`${rendered.width}×${rendered.height}px`} />
                <Row k="Grid" v={`${G}×${G} cells, ${CELL_PX}px each`} />
                <Row k="Physical size" v={`${PHYSICAL_MM}mm × ${PHYSICAL_MM}mm`} />
                <Row k="Required print DPI" v={REQUIRED_DPI.toFixed(0)} />
                <Row k="Per-pixel size" v={`${PER_PX_MM.toFixed(4)}mm`} />
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
