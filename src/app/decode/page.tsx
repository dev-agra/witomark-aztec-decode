"use client";
// AZTEC-STYLE SQUARE BULLSEYE MARKER — decoder UI.
//
// Two capture paths: upload an image file (simplest, most reliable for
// testing a generated/printed marker), or scan live with the camera
// (continuous detection loop, same general shape as the ts-poc project's
// /ts/poc page: grab a frame, run detection, stop on success).

import React, { useRef, useState, useCallback, useEffect } from "react";
import Link from "next/link";
import { RotateCcw, Upload, Camera } from "lucide-react";
import { decodeFromGrayscale, type DecodeDebugInfo, type AlignedGeometry, type Roi } from "@/lib/aztec-detector";
import { S as MARKER_S } from "@/lib/aztec-marker";

function grayscaleFromImageData(data: ImageData): Uint8ClampedArray {
  const { data: d, width, height } = data;
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) {
    g[i] = (d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) >> 8;
  }
  return g;
}

function grayscaleToCanvas(gray: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const imgData = ctx.createImageData(w, h);
  for (let i = 0, o = 0; i < gray.length; i++, o += 4) {
    imgData.data[o] = imgData.data[o + 1] = imgData.data[o + 2] = gray[i];
    imgData.data[o + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

// Coverage: a bit more than the marker's own native width, so the aligned
// view includes a thin margin of surrounding context, not just the exact
// marker edge.
const ALIGN_COVERAGE = MARKER_S * 1.15;

// Draws SOURCE (the full captured frame, as a canvas) de-rotated, scaled,
// and centered on the marker into DEST at OUT x OUT — this is a genuine
// geometric alignment (undoing the detected rotation+scale+position), not
// a naive axis-aligned bounding-box crop. The derivation: extractGrid maps
// a native marker-space offset (ddx,ddy) to a source pixel via
// (x,y) = (cx,cy) + scale*Rot(rotation)*(ddx,ddy). Inverting that and
// expressing it as a canvas transform (translate, then rotate(-rotation),
// then scale) reproduces exactly that mapping in reverse — verified
// numerically against extractGrid's own formula before relying on it here.
function drawAligned(
  dest: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  outSize: number,
  geo: AlignedGeometry
) {
  dest.save();
  dest.fillStyle = "#ffffff";
  dest.fillRect(0, 0, outSize, outSize);
  const A = outSize / (ALIGN_COVERAGE * geo.scale);
  const cosNeg = Math.cos(-geo.rotationRad), sinNeg = Math.sin(-geo.rotationRad);
  const rcx = cosNeg * geo.cx - sinNeg * geo.cy;
  const rcy = sinNeg * geo.cx + cosNeg * geo.cy;
  const Bx = outSize / 2 - A * rcx, By = outSize / 2 - A * rcy;
  dest.translate(Bx, By);
  dest.rotate(-geo.rotationRad);
  dest.scale(A, A);
  dest.drawImage(source, 0, 0);
  dest.restore();
}

// Builds the two ALIGNED debug images (de-rotated + cropped, not a raw
// bounding-box crop) for the "Analyse" panel shown after a decode attempt —
// uses successGeometry when a decode actually succeeded (the FINAL refined
// scale/rotation that was used), falling back to bestGeometry (the top
// candidate's own best-effort geometry) on failure, so you can still see
// roughly where/how it was looking even when nothing decoded.
function buildAlignedCrops(
  sourceCanvas: HTMLCanvasElement,
  gray: Uint8ClampedArray,
  geo: AlignedGeometry
): { originalUrl: string; grayUrl: string } {
  const OUT = 220;
  const grayCanvasFull = grayscaleToCanvas(gray, sourceCanvas.width, sourceCanvas.height);

  const origOut = document.createElement("canvas");
  origOut.width = OUT; origOut.height = OUT;
  drawAligned(origOut.getContext("2d")!, sourceCanvas, OUT, geo);

  const grayOut = document.createElement("canvas");
  grayOut.width = OUT; grayOut.height = OUT;
  drawAligned(grayOut.getContext("2d")!, grayCanvasFull, OUT, geo);

  return { originalUrl: origOut.toDataURL(), grayUrl: grayOut.toDataURL() };
}

type Mode = "idle" | "upload" | "camera";

const DecodePage = () => {
  const [seed, setSeed] = useState("aztec-seed-v1");
  const [mode, setMode] = useState<Mode>("idle");
  const [result, setResult] = useState<DecodeDebugInfo | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  // Zoom — range comes from the track's own capabilities (same pattern as
  // ts-poc's /ts/poc page), so the slider only appears on devices that
  // actually support optical/digital zoom.
  const [zoomRange, setZoomRange] = useState<{ min: number; max: number; step: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [debugCrops, setDebugCrops] = useState<{ originalUrl: string; grayUrl: string } | null>(null);
  // Live status text, updated every throttled tick — replaces a silent
  // "Scanning..." with the actual per-attempt outcome, so a failing real
  // capture is diagnosable WHILE it's happening, not just invisible.
  const [liveStatus, setLiveStatus] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastDecodeAtRef = useRef(0);
  const scanStartAtRef = useRef(0);
  const lastAttemptRef = useRef<{ result: DecodeDebugInfo; crops: { originalUrl: string; grayUrl: string } | null } | null>(null);
  // Live aligned-marker preview drawn directly into this canvas every
  // throttled tick (not via React state/data-URLs — far cheaper than
  // re-encoding a PNG 8x/sec). Updates the moment ANY candidate resolves
  // orientation, independent of whether the full decode has succeeded yet.
  const livePreviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [hasLivePreview, setHasLivePreview] = useState(false);

  const applyZoom = useCallback((value: number) => {
    setZoom(value);
    // Fire-and-forget — some devices reject values nominally within range;
    // a failed zoom change should never break an in-progress scan.
    trackRef.current?.applyConstraints({ advanced: [{ zoom: value } as never] }).catch(() => {});
  }, []);

  const runDecodeOnCanvas = useCallback((canvas: HTMLCanvasElement, roi: Roi | null = null) => {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const gray = grayscaleFromImageData(imgData);
    const result = decodeFromGrayscale(gray, canvas.width, seed, roi);
    // Prefer the geometry actually used for a successful decode (the FINAL
    // refined scale/rotation); fall back to the best candidate's own
    // best-effort geometry on failure, so there's still something to show.
    const geo = result.successGeometry ?? result.bestGeometry;
    const crops = geo ? buildAlignedCrops(canvas, gray, geo) : null;
    return { result, crops, geo, canvas, gray };
  }, [seed]);

  // ── Upload path ──
  const handleFile = useCallback((file: File) => {
    setMode("upload");
    setResult(null);
    setDebugCrops(null);
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      // Decode at a reasonable working resolution — large uploaded photos
      // are downscaled for speed; the detector only needs enough pixels to
      // resolve the ~5-8px smallest ring features comfortably.
      const maxSide = 900;
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      canvas.width = Math.round(img.width * k);
      canvas.height = Math.round(img.height * k);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const out = runDecodeOnCanvas(canvas);
      setResult(out?.result ?? null);
      setDebugCrops(out?.crops ?? null);
    };
    img.src = url;
  }, [runDecodeOnCanvas]);

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  // ── Camera path ──
  const stopCamera = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    trackRef.current = null;
    setZoomRange(null);
    setScanning(false);
    setHasLivePreview(false);
    setLiveStatus(null);
  }, []);

  const startCamera = useCallback(async () => {
    setMode("camera");
    setResult(null);
    setDebugCrops(null);
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 1280 } },
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      setScanning(true);

      const track = stream.getVideoTracks()[0];
      trackRef.current = track;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const caps = track.getCapabilities?.() as any;
      if (caps?.zoom) {
        const min = typeof caps.zoom.min === "number" ? caps.zoom.min : 1;
        const max = typeof caps.zoom.max === "number" ? caps.zoom.max : 1;
        const step = typeof caps.zoom.step === "number" && caps.zoom.step > 0 ? caps.zoom.step : 0.1;
        setZoomRange(max > min ? { min, max, step } : null);
        setZoom(min);
      } else {
        setZoomRange(null);
      }
      // Continuous/auto focus — missing before, and a real contributor to
      // "can't detect the marker": a phone camera's default focus can sit
      // anywhere until something asks it to keep refocusing. Same pattern
      // ts-poc's /ts/poc page already uses.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const focusModes: string[] = (caps as any)?.focusMode ?? [];
      const focusMode = focusModes.includes("continuous") ? "continuous" : focusModes.includes("auto") ? "auto" : null;
      if (focusMode) await track.applyConstraints({ advanced: [{ focusMode } as never] }).catch(() => {});

      if (!workCanvasRef.current) workCanvasRef.current = document.createElement("canvas");
      lastDecodeAtRef.current = 0;
      scanStartAtRef.current = performance.now();
      lastAttemptRef.current = null;
      // Throttled to ~8 decode attempts/sec, not every animation frame.
      // The full pipeline (connected components over the whole frame, then
      // orientation+calibration+extraction per candidate) is expensive, and
      // a real-world frame with browser chrome / status-bar icons / window
      // borders visible can produce dozens of candidate blobs — running
      // that every single rAF tick (30-60/sec) was the actual cause of the
      // visible lag/stuck-"Scanning..." behavior, not the algorithm itself.
      const DECODE_INTERVAL_MS = 120;
      // If nothing decodes within this window, STOP and show the last
      // attempt's actual diagnostics instead of scanning silently forever.
      // Previously Cancel just discarded everything — there was no way to
      // see WHY a real failing capture wasn't working, which made the
      // "still not decoding" problem undiagnosable without this.
      const SCAN_TIMEOUT_MS = 10000;
      const loop = () => {
        rafRef.current = requestAnimationFrame(loop);
        const now = performance.now();
        if (now - lastDecodeAtRef.current < DECODE_INTERVAL_MS) return;
        lastDecodeAtRef.current = now;

        const v = videoRef.current;
        if (!v || v.readyState < 2) return;
        const canvas = workCanvasRef.current!;
        const vw = v.videoWidth, vh = v.videoHeight;
        if (!vw || !vh) return;
        const maxSide = 700;
        const k = maxSide / Math.max(vw, vh);
        canvas.width = Math.round(vw * k);
        canvas.height = Math.round(vh * k);
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);

        // Restrict candidate search to what the green guide box actually
        // shows — previously the guide was purely cosmetic and the detector
        // scanned the ENTIRE frame, including background outside it. The
        // video element is h-80 w-80 (320 CSS px) with object-cover, and the
        // guide box is a centered 200px square within that. object-cover
        // uniformly scales the video so its SHORTER side exactly fills 320px
        // (no crop on that axis) and crops the longer side symmetrically
        // around the center — so in ORIGINAL video pixel coordinates, the
        // guide box is always a centered square of side
        // (200/320) * min(videoWidth, videoHeight), regardless of aspect
        // ratio or which axis get cropped. The work canvas is a uniform
        // (non-cropped) downscale of the full video by k, so the same square
        // just scales by k too.
        const DISPLAY_BOX = 320, GUIDE_BOX = 200;
        const roiSide = (GUIDE_BOX / DISPLAY_BOX) * Math.min(vw, vh) * k;
        const roi = { cx: canvas.width / 2, cy: canvas.height / 2, halfSize: roiSide / 2 };

        const out = runDecodeOnCanvas(canvas, roi);
        if (!out) return;
        lastAttemptRef.current = { result: out.result, crops: out.crops };

        // Live preview: draw the aligned marker the moment ANY geometry is
        // available, regardless of whether the full decode has succeeded —
        // this is the "as soon as the marker is in the green zone" feedback
        // requested, shown directly in the camera overlay.
        const liveCanvas = livePreviewCanvasRef.current;
        if (liveCanvas && out.geo) {
          drawAligned(liveCanvas.getContext("2d")!, out.canvas, liveCanvas.width, out.geo);
          setHasLivePreview(true);
        } else {
          setHasLivePreview(false);
        }

        // Live status text — what's actually happening this tick, not a
        // static "Scanning...".
        if (out.result.status === "BULLSEYE_NOT_FOUND") {
          setLiveStatus("No bullseye-like candidate found yet…");
        } else {
          const rayInfo = out.result.okRays !== null ? `, calibration ${out.result.okRays}/7` : "";
          setLiveStatus(`${out.result.candidatesTried} candidate(s) examined${rayInfo} — no valid decode yet`);
        }

        if (out.result.status === "DECODE_OK") {
          setResult(out.result);
          setDebugCrops(out.crops);
          stopCamera();
          return;
        }

        if (now - scanStartAtRef.current > SCAN_TIMEOUT_MS) {
          const last = lastAttemptRef.current!;
          setResult(last.result);
          setDebugCrops(last.crops);
          stopCamera();
        }
      };
      rafRef.current = requestAnimationFrame(loop);
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      setCameraError(`Unable to start the camera (${msg}).`);
    }
  }, [runDecodeOnCanvas, stopCamera]);

  useEffect(() => {
    return () => stopCamera();
  }, [stopCamera]);

  const handleReset = () => {
    stopCamera();
    setMode("idle");
    setResult(null);
    setDebugCrops(null);
    setPreviewUrl(null);
    setCameraError(null);
  };

  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto max-w-md p-4">
        <div className="-mx-4 -mt-4 flex items-center justify-center border-b border-gray-100 px-4 py-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/witomark-logo.png" alt="Witomark" width={200} height={48} className="h-7 w-auto object-contain" />
        </div>

        <div className="mt-2 flex items-center justify-between">
          <h1 className="text-h2 font-bold text-black">Decode Aztec marker</h1>
          <Link href="/generate" className="text-ref text-gray-400 underline">
            Generate a marker →
          </Link>
        </div>
        <p className="mt-1 text-body text-gray-500">
          Upload a photo/screenshot of a marker, or scan live with the camera.
        </p>

        <div className="mt-3 flex items-center gap-2">
          <label className="text-ref text-gray-400">Seed (must match generation):</label>
          <input
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            className="flex-1 rounded-lg border border-gray-300 px-2 py-1 font-mono text-ref text-black"
          />
        </div>

        {mode === "idle" && (
          <div className="mt-5 flex flex-col gap-3">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center justify-center gap-2 rounded-full bg-black py-3 text-btn font-medium text-white"
            >
              <Upload className="h-4 w-4" /> Upload image
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onFileInputChange} />
            <button
              onClick={startCamera}
              className="flex items-center justify-center gap-2 rounded-full border border-black py-3 text-btn font-medium text-black"
            >
              <Camera className="h-4 w-4" /> Scan with camera
            </button>
          </div>
        )}

        {mode === "camera" && (
          <div className="mt-5 flex flex-col items-center gap-3">
            <div className="relative mx-auto w-fit overflow-hidden rounded-2xl bg-black shadow-lg">
              <video ref={videoRef} className="h-80 w-80 object-cover" autoPlay playsInline muted />
              {/* Corner-bracket guide — not a full box, just alignment
                  helpers (same visual language as ts-poc's /ts/poc reticle).
                  The actual detect-and-decode loop already runs continuously
                  in the background on every frame and stops itself the
                  moment a decode succeeds — this overlay doesn't trigger
                  anything, it's purely a framing aid for the person holding
                  the phone. */}
              {scanning && (
                <div
                  className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
                  style={{ width: "200px", height: "200px" }}
                >
                  <div className="absolute left-0 top-0 h-6 w-6 rounded-tl-md border-l-4 border-t-4 border-[#1CE882]" />
                  <div className="absolute right-0 top-0 h-6 w-6 rounded-tr-md border-r-4 border-t-4 border-[#1CE882]" />
                  <div className="absolute bottom-0 left-0 h-6 w-6 rounded-bl-md border-b-4 border-l-4 border-[#1CE882]" />
                  <div className="absolute bottom-0 right-0 h-6 w-6 rounded-br-md border-b-4 border-r-4 border-[#1CE882]" />
                </div>
              )}
              {scanning && (
                <div className="absolute bottom-3 left-1/2 max-w-[90%] -translate-x-1/2 whitespace-nowrap rounded-full bg-black/60 px-3 py-1 font-mono text-[11px] text-[#1CE882]">
                  {liveStatus ?? "Scanning…"}
                </div>
              )}
              {/* Live aligned-marker preview — the de-rotated, cropped view
                  of whatever candidate is currently being examined, updated
                  every throttled tick. Visible the instant the detector
                  resolves SOME orientation, well before (or even without) a
                  full decode — direct visual confirmation that it's looking
                  at the right thing, not just a silent "Scanning...". */}
              <canvas
                ref={livePreviewCanvasRef}
                width={72}
                height={72}
                className={`absolute right-3 top-3 rounded-lg border-2 border-[#1CE882] bg-white shadow-lg transition-opacity ${hasLivePreview ? "opacity-100" : "opacity-0"}`}
              />
            </div>
            {cameraError && <p className="text-ref text-red-600">{cameraError}</p>}

            {/* Only rendered when the track actually reports a zoom
                capability range — no dead control on devices without it. */}
            {zoomRange && (
              <div className="flex w-full items-center gap-3">
                <span className="text-ref text-gray-400">Zoom</span>
                <input
                  type="range"
                  min={zoomRange.min}
                  max={zoomRange.max}
                  step={zoomRange.step}
                  value={zoom}
                  onChange={(e) => applyZoom(Number(e.target.value))}
                  className="flex-1"
                />
                <span className="w-12 text-right font-mono text-ref text-black">{zoom.toFixed(1)}×</span>
              </div>
            )}

            <button
              onClick={handleReset}
              className="flex w-full items-center justify-center gap-2 rounded-full border border-gray-300 py-2.5 text-btn text-black"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Cancel
            </button>
          </div>
        )}

        {mode === "upload" && previewUrl && (
          <div className="mt-5 flex flex-col items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt="Uploaded" className="max-h-80 rounded-xl border border-gray-200 object-contain" />
          </div>
        )}

        {result && (
          <div className="mt-5 flex flex-col rounded-2xl border border-gray-300 bg-white p-4">
            {result.status === "DECODE_OK" ? (
              <>
                <h3 className="text-h2 font-bold text-green-600">Decoded</h3>
                <p className="mt-2 font-mono text-lg text-black">{result.id}</p>
              </>
            ) : (
              <>
                <h3 className="text-h2 font-bold text-red-600">Decode failed</h3>
                <p className="mt-1 text-body text-gray-500">
                  {result.status === "BULLSEYE_NOT_FOUND" && "No bullseye-like candidate found in the image."}
                  {result.status === "ALL_CANDIDATES_RS_FAILED" &&
                    `Found ${result.candidatesTried} candidate(s), but none decoded. Check lighting/focus, or that the seed matches generation.`}
                </p>
              </>
            )}

            {debugCrops && (
              <div className="mt-3 rounded-xl border border-gray-200 p-3">
                <div className="mb-2 text-[10px] uppercase tracking-wide text-gray-400">
                  Analyse — region the detector actually looked at
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col items-center gap-1">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={debugCrops.originalUrl} alt="Original crop" className="w-full rounded border border-gray-300" style={{ imageRendering: "pixelated" }} />
                    <span className="text-[10px] text-gray-400">Original (color)</span>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={debugCrops.grayUrl} alt="Grayscale crop" className="w-full rounded border border-gray-300" style={{ imageRendering: "pixelated" }} />
                    <span className="text-[10px] text-gray-400">Grayscale (what the detector sees)</span>
                  </div>
                </div>
              </div>
            )}

            <details className="mt-3 text-left">
              <summary className="cursor-pointer text-ref text-gray-400">Debug details</summary>
              <div className="mt-2 flex flex-col gap-1.5 text-ref text-gray-600">
                <Row k="Status" v={result.status} />
                <Row k="Candidates tried" v={String(result.candidatesTried)} />
                <Row
                  k="Center"
                  v={result.detectedCenter ? `(${result.detectedCenter[0].toFixed(1)}, ${result.detectedCenter[1].toFixed(1)})` : "—"}
                />
                <Row k="Coarse scale" v={result.coarseScale?.toFixed(3) ?? "—"} />
                <Row k="Refined scale" v={result.refinedScale?.toFixed(3) ?? "—"} />
                <Row k="Rotation" v={result.rotationDeg !== null ? `${result.rotationDeg.toFixed(1)}°` : "—"} />
                <Row k="Calibration rays OK" v={result.okRays !== null ? `${result.okRays}/7` : "—"} />
              </div>
            </details>

            <button
              onClick={handleReset}
              className="mt-4 flex items-center justify-center gap-2 rounded-full bg-black py-3 text-btn font-medium text-white"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Scan again
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-400">{k}</span>
      <span className="font-mono text-black">{v}</span>
    </div>
  );
}

export default DecodePage;
