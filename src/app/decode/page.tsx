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
import { type DecodeDebugInfo, type AlignedGeometry, type Roi } from "@/lib/aztec-detector";
import { decodeWithFallbacks, type DecodeOptions } from "@/lib/decode";
import { measureMarkerSharpness } from "@/lib/sharpness";
import { S as MARKER_S } from "@/lib/aztec-marker";
import { planHiresCrop, planBurstCrop, HIRES_EVERY_N_TICKS, type CropPlan } from "@/lib/hires-crop";
import { verifyWatermark, type WmGeometry } from "@/lib/wm-align";
import { WmPool, type WmResult } from "@/lib/wm-pool";
import { DEFAULT_WM_PAIR, type CoeffPair } from "@/lib/watermark";
import { WM_TARGET_FRAMES, type FrameScore, type CandidateScore } from "@/lib/wm-scoring";
import { WmDebugPanel } from "./WmDebugPanel";
import { selectCamera, loadCachedTier, saveCachedTier, clampZoom, FEED_PX, type CameraTier } from "@/lib/camera-tiers";
import { AutoZoom } from "@/lib/auto-zoom";
import {
  MotionTracker, makeThumb, evaluateSize, evaluateBlur, chooseGuidance, markerSidePx, pxPerCell, GUIDANCE_TEXT,
  type MotionReading, type SizeState, type BlurState, type Guidance,
} from "@/lib/scan-gates";

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

// Coverage: exactly the marker's own native width — a tight crop with no
// surrounding context, per explicit instruction. Any padding that still
// shows up is NOT this margin (there isn't one); it's the visible symptom
// of the geometry estimate (scale/center) being imprecise for that capture.
const ALIGN_COVERAGE = MARKER_S;

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

interface WmInput { gray: Uint8ClampedArray; w: number; geo: WmGeometry; id: string; seed: string }

// `nativePerPx` converts the pixels the decoder worked in back to the sensor's, for the px/cell column.
function buildFrame(index: number, result: DecodeDebugInfo, nativePerPx: number, reading: FrameScore["reading"]): FrameScore {
  const candidates: CandidateScore[] = (result.candidateLog ?? []).map((c) => ({
    cx: c.cx, cy: c.cy, pxPerCell: c.scale * 8 * nativePerPx, finderWrong: c.finderWrong, okRays: c.okRays, decoded: c.decoded,
    reading: c.decoded ? reading : null,
  }));
  return {
    index, decoded: result.status === "DECODE_OK", id: result.id, method: result.method ?? "standard",
    candidatesTried: result.candidatesTried, reading, candidates,
    note: result.status === "DECODE_OK" ? undefined : result.status === "BULLSEYE_NOT_FOUND" ? "no bullseye found" : "no candidate decoded",
  };
}

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

  // zoom and focusMode must always travel in ONE applyConstraints call:
  // `advanced` replaces the track's stored constraint set, so sending focus
  // alone (or zoom alone) leaves the other out of the set, and a camera
  // session reset (screen lock, tab switch) then restores to 1x. The TS scan
  // page documents the same failure. `null` zoom = never touched, leave it.
  const autoZoomRef = useRef(new AutoZoom());
  const zoomLimitsRef = useRef<{ min: number; max: number; step: number } | null>(null);
  const cameraNoteRef = useRef("");
  const [autoZoomOn, setAutoZoomOn] = useState(false);
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hiresEligibleTicksRef = useRef(0);
  const regTickRef = useRef(0);
  // Watermark verification (`?debug` only): per-frame scores, and the pixels each
  // score came from so a pair change can re-read them without another scan.
  const debugRef = useRef(false);
  const [wmFrames, setWmFrames] = useState<FrameScore[]>([]);
  const [wmPair, setWmPair] = useState<CoeffPair>(DEFAULT_WM_PAIR);
  const [wmProgress, setWmProgress] = useState<{ done: number; target: number } | null>(null);
  const wmPairRef = useRef<CoeffPair>(DEFAULT_WM_PAIR);
  const wmInputsRef = useRef(new Map<number, WmInput>());
  const [wmPhase, setWmPhase] = useState<string | null>(null);
  const burstActiveRef = useRef(false);
  const poolRef = useRef<WmPool | null>(null);
  const rescoreGenRef = useRef(0);
  useEffect(() => {
    const on = new URLSearchParams(window.location.search).has("debug");
    debugRef.current = on;
  }, []);
  const motionRef = useRef(new MotionTracker());
  const guidanceStreakRef = useRef<{ g: Guidance; n: number }>({ g: null, n: 0 });
  // `?debug` in the URL appends the raw gate measurements to the live status,
  // for calibrating the provisional thresholds on a real device.
  const showGateDebugRef = useRef(false);
  const desiredFocusModeRef = useRef<string | null>(null);
  const zoomLatestRef = useRef<number | null>(null);
  const applyDesiredConstraints = useCallback((track: MediaStreamTrack, zoomOverride?: number) => {
    const set: Record<string, unknown> = {};
    const z = zoomOverride ?? zoomLatestRef.current;
    if (z !== null && z !== undefined) set.zoom = z;
    if (desiredFocusModeRef.current) set.focusMode = desiredFocusModeRef.current;
    if (Object.keys(set).length === 0) return Promise.resolve();
    return track.applyConstraints({ advanced: [set as never] });
  }, []);

  // After a suspend/resume the browser can keep reporting the old zoom while
  // the hardware is back at 1x, and re-sending the SAME value can be dropped
  // as a no-op. Nudge to a different value first to force a real re-program,
  // then apply the target; retry because the pipeline's own restart can land
  // after our first attempt and clobber it.
  const reassertZoom = useCallback(() => {
    const track = trackRef.current;
    const target = zoomLatestRef.current;
    if (!track || target === null) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const zc = (track.getCapabilities?.() as any)?.zoom;
    if (!zc || !(zc.max > zc.min)) return;
    const step = typeof zc.step === "number" && zc.step > 0 ? zc.step : 0.1;
    const nudge = target - step >= zc.min ? target - step : Math.min(target + step, zc.max);
    let attempt = 0;
    const tryApply = async () => {
      attempt++;
      try {
        if (nudge !== target) await applyDesiredConstraints(track, nudge);
        await applyDesiredConstraints(track, target);
      } catch { /* retried below */ }
      if (attempt < 3 && trackRef.current === track) setTimeout(tryApply, 500);
    };
    tryApply();
  }, [applyDesiredConstraints]);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") reassertZoom(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reassertZoom]);

  const applyZoom = useCallback((value: number) => {
    zoomLatestRef.current = value;
    setZoom(value);
    // Fire-and-forget — some devices reject values nominally within range;
    // a failed zoom change should never break an in-progress scan.
    const track = trackRef.current;
    if (track) applyDesiredConstraints(track, value).catch(() => {});
  }, [applyDesiredConstraints]);

  // Uploads always get the registration fallback; the live loop passes a throttled, time-boxed variant.
  const runDecodeOnCanvas = useCallback((canvas: HTMLCanvasElement, roi: Roi | null = null, buildCrops = true, decodeOpts: DecodeOptions = { registration: true }) => {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const gray = grayscaleFromImageData(imgData);
    const result = decodeWithFallbacks(gray, canvas.width, seed, roi, decodeOpts);
    // Prefer the geometry actually used for a successful decode (the FINAL
    // refined scale/rotation); fall back to the best candidate's own
    // best-effort geometry on failure, so there's still something to show.
    const geo = result.successGeometry ?? result.bestGeometry;
    const crops = geo && buildCrops ? buildAlignedCrops(canvas, gray, geo) : null;
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
      setWmFrames([]);
      wmInputsRef.current.clear();
      if (out) {
        // The watermark needs the photo's own pixels, not the 900px detection copy. Run after
        // the decode result has painted, since the alignment takes a moment.
        const r = out.result;
        const geo = r.successGeometry;
        if (r.status === "DECODE_OK" && geo && r.id) {
          setWmPhase("Verifying watermark…");
          setTimeout(() => {
            const kf = Math.min(1, 4000 / Math.max(img.width, img.height));
            const fc = document.createElement("canvas");
            fc.width = Math.round(img.width * kf); fc.height = Math.round(img.height * kf);
            const fctx = fc.getContext("2d", { willReadFrequently: true })!;
            fctx.drawImage(img, 0, 0, fc.width, fc.height);
            const gray = grayscaleFromImageData(fctx.getImageData(0, 0, fc.width, fc.height));
            const sc = fc.width / canvas.width;
            const fgeo: WmGeometry = { cx: geo.cx * sc, cy: geo.cy * sc, scale: geo.scale * sc, rotationRad: geo.rotationRad };
            wmInputsRef.current.set(0, { gray, w: fc.width, geo: fgeo, id: r.id!, seed });
            setWmFrames([buildFrame(0, r, sc, verifyWatermark(gray, fc.width, fgeo, r.id!, seed, wmPairRef.current))]);
            setWmPhase(null);
          }, 30);
        }
      }
    };
    img.src = url;
  }, [runDecodeOnCanvas, seed]);

  // Re-read every stored frame with a new coefficient pair, in parallel.
  const rescore = useCallback((pair: CoeffPair) => {
    wmPairRef.current = pair;
    setWmPair(pair);
    const gen = ++rescoreGenRef.current;
    poolRef.current?.terminate();
    const pool = new WmPool(Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 1)));
    poolRef.current = pool;
    const jobs = [...wmInputsRef.current.entries()].map(([idx, inp]) =>
      pool.run({ gray: inp.gray, w: inp.w, geo: inp.geo, id: inp.id, seed: inp.seed, pair }).then(({ reading }) => {
        if (gen !== rescoreGenRef.current) return;
        setWmFrames((fs) => fs.map((f) => f.index !== idx ? f : { ...f, reading, candidates: f.candidates.map((c) => c.decoded ? { ...c, reading } : c) }));
      }));
    void Promise.all(jobs).then(() => { if (poolRef.current === pool) { pool.terminate(); poolRef.current = null; } });
  }, []);

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

  // ── Watermark burst ──
  // Once the marker is found (decoded, or clearly locked on and steady), grab WM_TARGET_FRAMES fresh camera
  // frames in one quick pass — raw crops, no processing in between, so the camera keeps up and nothing
  // drifts while we compute. Only then does a pool of workers decode each crop, align it to the clean copy
  // and read its BER, all in parallel. Frames that didn't decode borrow the nearest decoded frame's
  // geometry, so every row ends up with a BER.
  const runWatermarkBurst = useCallback(async (
    v: HTMLVideoElement, geo: WmGeometry, hint: { result: DecodeDebugInfo; crops: { originalUrl: string; grayUrl: string } | null } | null,
  ) => {
    const gen = ++rescoreGenRef.current;
    const vw = v.videoWidth, vh = v.videoHeight;
    const plan = planBurstCrop(geo.cx, geo.cy, geo.scale, vw, vh);
    if (!plan) { stopCamera(); return; }
    poolRef.current?.terminate();
    const pool = new WmPool(Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 1)));
    poolRef.current = pool;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // 1. capture
    const cc = document.createElement("canvas");
    cc.width = plan.outW; cc.height = plan.outH;
    const cctx = cc.getContext("2d", { willReadFrequently: true })!;
    const grabs: Uint8ClampedArray[] = [];
    let lastTime = -1;
    const t0 = performance.now();
    // spread over ~1.25 s (one grab per ~62 ms), so the 20 frames see different moments of hand shake and focus
    const CAPTURE_MS = 1250, spacing = CAPTURE_MS / WM_TARGET_FRAMES;
    while (grabs.length < WM_TARGET_FRAMES && performance.now() - t0 < CAPTURE_MS + 1500) {
      if (gen !== rescoreGenRef.current) { pool.terminate(); return; }
      // a new camera frame only (currentTime 0 = a source that doesn't report it), and not before its slot
      if (performance.now() - t0 >= grabs.length * spacing && (v.currentTime === 0 || v.currentTime !== lastTime)) {
        lastTime = v.currentTime;
        cctx.drawImage(v, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.outW, plan.outH);
        grabs.push(grayscaleFromImageData(cctx.getImageData(0, 0, plan.outW, plan.outH)));
        setWmProgress({ done: grabs.length, target: WM_TARGET_FRAMES });
        setWmPhase(`Capturing frames ${grabs.length}/${WM_TARGET_FRAMES}…`);
      }
      await sleep(6);
    }
    stopCamera();

    // 2. decode + align + BER for every frame, in parallel
    let finished = 0;
    setWmPhase(`Reading frames 0/${grabs.length}…`);
    const results: WmResult[] = await Promise.all(grabs.map((gray) =>
      pool.run({ gray, w: plan.outW, seed, pair: wmPairRef.current, decode: true }).then((r) => {
        finished++;
        if (gen === rescoreGenRef.current) {
          setWmProgress({ done: finished, target: grabs.length });
          setWmPhase(`Reading frames ${finished}/${grabs.length}…`);
        }
        return r;
      })));
    if (gen !== rescoreGenRef.current) { pool.terminate(); return; }

    // 3. one ID for the burst: the most common decode, else the live decode's
    const votes = new Map<string, number>();
    for (const r of results) if (r.decode?.status === "DECODE_OK" && r.decode.id) votes.set(r.decode.id, (votes.get(r.decode.id) ?? 0) + 1);
    let id: string | null = hint?.result.id ?? null;
    let top = 0;
    for (const [k2, n] of votes) if (n > top) { top = n; id = k2; }
    const okIdx = results.map((r, i) => (r.reading && r.decode?.id === id ? i : -1)).filter((i) => i >= 0);
    if (!id || okIdx.length === 0) {
      // nothing in the burst decoded: show the live result and stop
      pool.terminate(); poolRef.current = null;
      setWmFrames([]); setWmProgress(null); setWmPhase("No frame in the burst could be decoded — rescan.");
      return;
    }

    // 4. frames that didn't decode as `id`: read them from the nearest good frame's geometry
    const fixed = await Promise.all(results.map(async (r, i) => {
      if (okIdx.includes(i)) return { r, geo: r.geo! };
      let nearest = okIdx[0];
      for (const j of okIdx) if (Math.abs(j - i) < Math.abs(nearest - i)) nearest = j;
      const g = results[nearest].geo!;
      const fr = await pool.run({ gray: grabs[i], w: plan.outW, seed, pair: wmPairRef.current, geo: g, id });
      return { r: fr, geo: g };
    }));
    pool.terminate();
    if (poolRef.current === pool) poolRef.current = null;
    if (gen !== rescoreGenRef.current) return;

    wmInputsRef.current.clear();
    const frames: FrameScore[] = fixed.map(({ r, geo: g }, i) => {
      wmInputsRef.current.set(i, { gray: grabs[i], w: plan.outW, geo: g, id: id!, seed });
      const decodedHere = okIdx.includes(i);
      const reading = r.reading ? { ...r.reading, weak: r.reading.weak ?? (decodedHere ? undefined : "borrowed geometry") } : null;
      return { index: i, decoded: decodedHere, id: id!, method: "burst", candidatesTried: 0, reading, candidates: [] };
    });
    setWmFrames(frames);
    // the result card: the live decode if there was one, else the best-reading frame's decode
    if (hint) { setResult(hint.result); setDebugCrops(hint.crops); }
    else {
      let bi = okIdx[0];
      for (const i of okIdx) if ((fixed[i].r.reading?.ber ?? 101) < (fixed[bi].r.reading?.ber ?? 101)) bi = i;
      setResult(results[bi].decode ?? null);
      setDebugCrops(null);
    }
    setWmProgress(null);
    setWmPhase(null);
  }, [stopCamera, seed]);

  const startCamera = useCallback(async () => {
    setMode("camera");
    setResult(null);
    setDebugCrops(null);
    setCameraError(null);
    try {
      const openStream = (deviceId?: string) => navigator.mediaDevices.getUserMedia({
        video: deviceId
          ? { deviceId: { exact: deviceId }, width: { ideal: FEED_PX }, height: { ideal: FEED_PX } }
          : { facingMode: "environment", width: { ideal: FEED_PX }, height: { ideal: FEED_PX } },
      });
      // Permission + the browser's default back camera first (labels are only
      // available after permission), then pick the camera/zoom tier. The tier
      // is best-effort: any failure falls back to the default camera at 1x,
      // which is how this page behaved before tiers existed.
      let stream = await openStream();
      let tier: CameraTier | null = null;
      cameraNoteRef.current = "default";
      try {
        const curId = stream.getVideoTracks()[0].getSettings().deviceId;
        const cached = loadCachedTier();
        const all = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = all.filter((d) => d.kind === "videoinput");
        if (cached && curId === cached.deviceId) {
          tier = cached.tier; cameraNoteRef.current = "cached";
        } else if (cached && videoInputs.some((d) => d.deviceId === cached.deviceId)) {
          stream.getTracks().forEach((t) => t.stop());
          stream = await openStream(cached.deviceId);
          tier = cached.tier; cameraNoteRef.current = "cached";
        } else {
          const backs = videoInputs.filter((d) => d.label.toLowerCase().includes("back"));
          const candidates = backs.length > 0 ? backs : videoInputs;
          if (candidates.length > 0) {
            stream.getTracks().forEach((t) => t.stop());
            const sel = await selectCamera(candidates, (m) => console.log(m));
            if (sel) {
              tier = sel.tier; saveCachedTier(sel.cap.deviceId, sel.tier);
              cameraNoteRef.current = `${sel.cap.label || "cam"} f${sel.cap.focusMin} band${sel.tier.band}`;
              stream = await openStream(sel.cap.deviceId);
            } else {
              stream = await openStream();
            }
          }
        }
      } catch (e) {
        console.log("[camera] tier selection failed, using default camera", e);
        tier = null;
      }
      if (stream.getVideoTracks()[0]?.readyState === "ended") { stream = await openStream(); tier = null; }
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      setScanning(true);

      const track = stream.getVideoTracks()[0];
      trackRef.current = track;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const caps = track.getCapabilities?.() as any;
      let initialZoom: number | null = null;
      if (caps?.zoom) {
        const min = typeof caps.zoom.min === "number" ? caps.zoom.min : 1;
        const max = typeof caps.zoom.max === "number" ? caps.zoom.max : 1;
        const step = typeof caps.zoom.step === "number" && caps.zoom.step > 0 ? caps.zoom.step : 0.1;
        setZoomRange(max > min ? { min, max, step } : null);
        zoomLimitsRef.current = max > min ? { min, max, step } : null;
        initialZoom = tier && max > min ? clampZoom(tier.zoom, min, max) : null;
        setZoom(initialZoom ?? min);
      } else {
        setZoomRange(null);
        zoomLimitsRef.current = null;
      }
      // Continuous/auto focus — missing before, and a real contributor to
      // "can't detect the marker": a phone camera's default focus can sit
      // anywhere until something asks it to keep refocusing. Same pattern
      // ts-poc's /ts/poc page already uses.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const focusModes: string[] = (caps as any)?.focusMode ?? [];
      desiredFocusModeRef.current = focusModes.includes("continuous") ? "continuous" : focusModes.includes("auto") ? "auto" : null;
      zoomLatestRef.current = initialZoom; // tier starting zoom; null = leave the camera at its default
      autoZoomRef.current.reset();
      autoZoomRef.current.noteApplied(performance.now());
      setAutoZoomOn(zoomLimitsRef.current !== null);
      await applyDesiredConstraints(track).catch(() => {});
      track.onunmute = () => reassertZoom();

      if (!workCanvasRef.current) workCanvasRef.current = document.createElement("canvas");
      lastDecodeAtRef.current = 0;
      scanStartAtRef.current = performance.now();
      lastAttemptRef.current = null;
      motionRef.current.reset();
      hiresEligibleTicksRef.current = 0;
      regTickRef.current = 0;
      wmInputsRef.current.clear();
      rescoreGenRef.current++;
      burstActiveRef.current = false;
      poolRef.current?.terminate();
      setWmFrames([]);
      setWmProgress(null);
      setWmPhase(null);
      guidanceStreakRef.current = { g: null, n: 0 };
      showGateDebugRef.current = new URLSearchParams(window.location.search).has("debug");
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

        // Debug crops (two PNG encodes) are only ever shown after a success
        // or the final timeout, so they're built lazily below — not on every
        // 120ms tick, which was pure wasted work on a phone.
        // The registration fallback is the expensive part of a failing tick, so
        // the live loop runs it on every 3rd tick, with at most 3 climbs (the right scale is often the third-ranked peak) and a
        // 600ms budget.
        const out = runDecodeOnCanvas(canvas, roi, false, {
          registration: regTickRef.current++ % 3 === 0, registrationStarts: 3, registrationBudgetMs: 600,
        });
        if (!out) return;
        lastAttemptRef.current = { result: out.result, crops: null };

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

        // Size + motion gates. Guidance only: decode above already ran and
        // is never skipped by these (see scan-gates.ts). Shown only after the
        // same guidance holds on 2 consecutive ticks, so a single noisy tick
        // can't flash a message.
        const est = out.result.markerEstimate;
        let reading: MotionReading | null = null;
        let sizeState: SizeState = "unknown";
        if (est) {
          const thumb = makeThumb(out.gray, canvas.width, roi.cx, roi.cy, roi.halfSize);
          reading = motionRef.current.push({ cx: est.cx, cy: est.cy, scale: est.scale, thumb });
          // Native video pixels, not detection-canvas pixels: a 3000px feed
          // downscaled to 700 would otherwise read as "too small" while the
          // real sensor has plenty of pixels on the marker.
          sizeState = evaluateSize(est.scale / k, roiSide / k);
        } else {
          motionRef.current.reset();
        }
        let blurState: BlurState = "unknown";
        let edgeWidth: number | null = null;
        if (est) {
          const sharp = measureMarkerSharpness(out.gray, canvas.width, est);
          edgeWidth = sharp?.edgeWidthCells ?? null;
          blurState = evaluateBlur(edgeWidth);
        }
        let guidance = chooseGuidance(sizeState, reading, blurState);
        const zl = zoomLimitsRef.current;
        const autoActive = !!zl && autoZoomRef.current.active;
        if (autoActive && zl) {
          // zoom can fix size, so don't tell the user to walk while it still can
          const zNow = zoomLatestRef.current ?? zl.min;
          if (guidance === "move_closer" && zNow < zl.max - zl.step) guidance = null;
          if (guidance === "move_back" && zNow > zl.min + zl.step) guidance = null;
        }
        let zoomChanged = false;
        if (est && autoActive && zl && trackRef.current) {
          const nz = autoZoomRef.current.next({
            nowMs: now, zoom: zoomLatestRef.current ?? zl.min, zoomMin: zl.min, zoomMax: zl.max, step: zl.step,
            pxPerCell: pxPerCell(est.scale / k), steady: reading ? reading.steady : false,
          });
          if (nz !== null) {
            zoomChanged = true;
            zoomLatestRef.current = nz;
            setZoom(nz);
            applyDesiredConstraints(trackRef.current, nz).catch(() => {});
            // marker size is about to change: the tick-to-tick comparison is meaningless
            motionRef.current.reset();
            hiresEligibleTicksRef.current = 0;
          }
        }
        const gs = guidanceStreakRef.current;
        if (guidance === gs.g) gs.n++; else { gs.g = guidance; gs.n = 1; }
        const shownGuidance = guidance && gs.n >= 2 ? GUIDANCE_TEXT[guidance] : null;

        // High-resolution fallback: the canvas decode failed but a marker is
        // clearly there, in range and not moving — re-read it from a crop of
        // the video's NATIVE pixels (downscaled to a moderate marker scale,
        // see hires-crop.ts). Runs only after the canvas decode fails, so it
        // can add decodes but never lose one.
        let finalOut = out;
        let hiresNote = "";
        let finalPlan: CropPlan | null = null;
        if (out.result.status !== "DECODE_OK" && est && !zoomChanged && sizeState === "ok" && (reading ? reading.stableNow : true)) {
          const plan = hiresEligibleTicksRef.current++ % HIRES_EVERY_N_TICKS === 0 ? planHiresCrop(est, k, vw, vh) : null;
          if (plan) {
            const t0 = performance.now();
            if (!cropCanvasRef.current) cropCanvasRef.current = document.createElement("canvas");
            const cc = cropCanvasRef.current;
            cc.width = plan.outW; cc.height = plan.outH;
            cc.getContext("2d", { willReadFrequently: true })!.drawImage(v, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.outW, plan.outH);
            const hi = runDecodeOnCanvas(cc, null, false);
            const ok = !!hi && hi.result.status === "DECODE_OK";
            if (ok && hi) { finalOut = hi; finalPlan = plan; }
            hiresNote = ` | hi-res ${plan.sw}x${plan.sh}->${plan.outW}x${plan.outH} ${ok ? "OK" : "no"} ${(performance.now() - t0).toFixed(0)}ms`;
          }
        }
        const cropsNow = () => (finalOut.geo ? buildAlignedCrops(finalOut.canvas, finalOut.gray, finalOut.geo) : null);

        // Live status text — what's actually happening this tick, not a
        // static "Scanning...".
        let status: string;
        if (shownGuidance) {
          status = shownGuidance;
        } else if (out.result.status === "BULLSEYE_NOT_FOUND") {
          status = "No bullseye-like candidate found yet…";
        } else {
          const rayInfo = out.result.okRays !== null ? `, calibration ${out.result.okRays}/32` : "";
          status = `${out.result.candidatesTried} candidate(s) examined${rayInfo} — no valid decode yet`;
        }
        if (showGateDebugRef.current && est) {
          status += ` | native ${markerSidePx(est.scale / k).toFixed(0)}px ${pxPerCell(est.scale / k).toFixed(1)}px/cell finder ${est.finderWrong}/38 edge ${edgeWidth === null ? "-" : edgeWidth.toFixed(2)} ${blurState}` +
            (reading && reading.jitterCells !== null ? ` jitter ${reading.jitterCells.toFixed(2)} dS ${reading.scaleChange?.toFixed(3)} thumb ${reading.thumbDiff?.toFixed(1)}` : "") +
            hiresNote + ` | cam ${cameraNoteRef.current} zoom ${(zoomLatestRef.current ?? 1).toFixed(1)}x${autoActive ? " auto" : ""}`;
        }
        setLiveStatus(status);

        // First decode: show it now, then burst-capture and verify the watermark (see runWatermarkBurst).
        if (burstActiveRef.current) return;
        const decodedNow = finalOut.result.status === "DECODE_OK" && !!finalOut.result.successGeometry && !!finalOut.result.id;
        // Marker located (finder pattern matches, in range) and held steady: no need to wait for a decode first
        const lockedOn = !decodedNow && !!est && sizeState === "ok" && !!reading && reading.steady;
        if (decodedNow || lockedOn) {
          burstActiveRef.current = true;
          let native: WmGeometry;
          let hint: { result: DecodeDebugInfo; crops: { originalUrl: string; grayUrl: string } | null } | null = null;
          if (decodedNow) {
            const r = finalOut.result, g = r.successGeometry!;
            hint = { result: r, crops: cropsNow() };
            // geometry in native video pixels, whichever canvas the decode ran on
            native = finalPlan
              ? { cx: g.cx / finalPlan.factor + finalPlan.sx, cy: g.cy / finalPlan.factor + finalPlan.sy, scale: g.scale / finalPlan.factor, rotationRad: g.rotationRad }
              : { cx: g.cx / k, cy: g.cy / k, scale: g.scale / k, rotationRad: g.rotationRad };
          } else {
            native = { cx: est!.cx / k, cy: est!.cy / k, scale: est!.scale / k, rotationRad: est!.rotationRad };
          }
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
          setLiveStatus(decodedNow ? "Decoded — capturing frames…" : "Marker found — capturing frames…");
          if (hint) { setResult(hint.result); setDebugCrops(hint.crops); }
          runWatermarkBurst(v, native, hint).catch((e) => {
            console.error("watermark burst failed", e);
            setWmProgress(null);
            setWmPhase("Watermark scoring failed: " + (e instanceof Error ? e.message : String(e)));
          });
          return;
        }

        if (finalOut.result.status === "DECODE_OK") {
          setResult(finalOut.result);
          setDebugCrops(cropsNow());
          stopCamera();
          return;
        }

        if (now - scanStartAtRef.current > SCAN_TIMEOUT_MS) {
          setResult(out.result);
          setDebugCrops(out.geo ? buildAlignedCrops(out.canvas, out.gray, out.geo) : null);
          stopCamera();
        }
      };
      rafRef.current = requestAnimationFrame(loop);
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      setCameraError(`Unable to start the camera (${msg}).`);
    }
  }, [runDecodeOnCanvas, stopCamera, applyDesiredConstraints, reassertZoom, runWatermarkBurst]);

  useEffect(() => {
    return () => stopCamera();
  }, [stopCamera]);

  const handleReset = () => {
    stopCamera();
    wmInputsRef.current.clear();
    rescoreGenRef.current++;
    burstActiveRef.current = false;
    poolRef.current?.terminate();
    setWmFrames([]);
    setWmProgress(null);
    setWmPhase(null);
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
                <span className="text-ref text-gray-400">Zoom{autoZoomOn ? " (auto)" : ""}</span>
                <input
                  type="range"
                  min={zoomRange.min}
                  max={zoomRange.max}
                  step={zoomRange.step}
                  value={zoom}
                  onChange={(e) => { autoZoomRef.current.disable(); setAutoZoomOn(false); applyZoom(Number(e.target.value)); }}
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

        {!result && wmPhase && <p className="mt-4 text-center text-body text-gray-500">{wmPhase}</p>}

        {result && (
          <div className="mt-5 flex flex-col rounded-2xl border border-gray-300 bg-white p-4">
            {result.status === "DECODE_OK" ? (
              <>
                <h3 className="text-h2 font-bold text-green-600">Decoded</h3>
                <p className="mt-2 font-mono text-lg text-black">{result.id}</p>
                {wmPhase && <p className="mt-1 text-body text-gray-500">{wmPhase}</p>}
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

            <details open className="mt-3 text-left">
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
                <Row k="Method" v={result.method ?? "standard"} />
                <Row k="Calibration rays OK" v={result.okRays !== null ? `${result.okRays}/32` : "—"} />
              </div>
              {(wmFrames.length > 0 || wmProgress) && (
                <WmDebugPanel frames={wmFrames} pair={wmPair} onPair={rescore} progress={wmProgress} />
              )}
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
