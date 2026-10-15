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
import { decodeFromGrayscale, type DecodeDebugInfo } from "@/lib/aztec-detector";

function grayscaleFromImageData(data: ImageData): Uint8ClampedArray {
  const { data: d, width, height } = data;
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) {
    g[i] = (d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) >> 8;
  }
  return g;
}

type Mode = "idle" | "upload" | "camera";

const DecodePage = () => {
  const [seed, setSeed] = useState("aztec-seed-v1");
  const [mode, setMode] = useState<Mode>("idle");
  const [result, setResult] = useState<DecodeDebugInfo | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const runDecodeOnCanvas = useCallback((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const gray = grayscaleFromImageData(imgData);
    return decodeFromGrayscale(gray, canvas.width, seed);
  }, [seed]);

  // ── Upload path ──
  const handleFile = useCallback((file: File) => {
    setMode("upload");
    setResult(null);
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
      const r = runDecodeOnCanvas(canvas);
      setResult(r);
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
    setScanning(false);
  }, []);

  const startCamera = useCallback(async () => {
    setMode("camera");
    setResult(null);
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

      if (!workCanvasRef.current) workCanvasRef.current = document.createElement("canvas");
      const loop = () => {
        rafRef.current = requestAnimationFrame(loop);
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
        const r = runDecodeOnCanvas(canvas);
        if (r && r.status === "DECODE_OK") {
          setResult(r);
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
              {scanning && (
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 font-mono text-[11px] text-[#1CE882]">
                  Scanning…
                </div>
              )}
            </div>
            {cameraError && <p className="text-ref text-red-600">{cameraError}</p>}
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
