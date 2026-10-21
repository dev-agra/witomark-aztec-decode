"use client";
// TEMPORARY — checks camera-tiers.ts and auto-zoom.ts logic. Not part of the product.
import React, { useState } from "react";
import { pickCameraTier, filterIosBackCamera, clampZoom, type CameraCaps } from "@/lib/camera-tiers";
import { AutoZoom } from "@/lib/auto-zoom";

const cap = (label: string, focusMin: number | null, focusMax: number | null = null, zoomMax: number | null = 8): CameraCaps =>
  ({ deviceId: label, label, focusMin, focusMax, zoomMin: 1, zoomMax });

// lagMs = how long after a request the camera's frames actually show the new zoom
function sim(base: number, startZoom: number, zMin: number, zMax: number, ticks = 60, lagMs = 0, ignoreZoom = false) {
  const az = new AutoZoom();
  let zoom = startZoom, shown = startZoom, now = 0; const trace: string[] = []; let changes = 0;
  let pendingShow: { at: number; z: number } | null = null;
  for (let i = 0; i < ticks; i++) {
    now += 120;
    if (pendingShow && now >= pendingShow.at) { shown = pendingShow.z; pendingShow = null; }
    const px = base * shown; // measured from the frame the camera actually shows
    const nz = az.next({ nowMs: now, zoom, zoomMin: zMin, zoomMax: zMax, step: 0.1, pxPerCell: px, steady: true });
    if (nz !== null) { zoom = nz; changes++; trace.push(`${(now / 1000).toFixed(2)}s->${nz.toFixed(1)}x`); if (!ignoreZoom) pendingShow = { at: now + lagMs, z: nz }; }
  }
  if (ignoreZoom) zoom = startZoom;
  return `start ${startZoom}x (${(base * startZoom).toFixed(1)}px/cell) -> final request ${zoom.toFixed(1)}x (${(base * shown).toFixed(1)}px/cell shown), ${changes} adjustments${az.active ? "" : " [auto-zoom gave up]"}: ${trace.join(" ")}`;
}

const Page = () => {
  const [log, setLog] = useState<string[]>([]);
  const run = () => {
    const L: string[] = [];
    const t = (name: string, c: CameraCaps[]) => { const r = pickCameraTier(c); L.push(`${name}: ${r ? `"${r.cap.label}" band ${r.tier.band} zoom ${r.tier.zoom}x feed ${r.tier.feedPx}` : "null (fallback)"}`); };
    L.push("== pickCameraTier ==");
    t("focus 0.05", [cap("A", 0.05)]);
    t("focus 0.10999", [cap("A", 0.10999)]);
    t("focus 0.11 (edge)", [cap("A", 0.11)]);
    t("focus 0.12", [cap("A", 0.12)]);
    t("focus 0.20", [cap("A", 0.2)]);
    t("focus 0.21 (out)", [cap("A", 0.21)]);
    t("focus 0.005 (below)", [cap("A", 0.005)]);
    t("no focusDistance", [cap("A", null)]);
    t("two cams, bands 2 and 0 -> band 0 wins", [cap("Far", 0.2), cap("Near", 0.05)]);
    t("same band, widest focus range wins", [cap("Narrow", 0.12, 0.3), cap("Wide", 0.13, 1.0)]);
    t("same band, no max: plain Back Camera", [cap("Back Ultra Wide Camera", 0.12), cap("Back Camera", 0.13)]);
    t("same band, no max/no exact label: skip wide", [cap("Back Wide Camera", 0.12), cap("Rear Main", 0.13)]);
    const ios = filterIosBackCamera([{ label: "Back Triple Camera" }, { label: "Back Camera" }, { label: "Front Camera" }], true);
    L.push(`iOS filter keeps: ${ios.map((d) => d.label).join(", ")}`);
    L.push(`iOS filter, no plain Back Camera present: ${filterIosBackCamera([{ label: "Back Triple Camera" }], true).map((d) => d.label).join(", ")}`);
    L.push(`non-iOS filter keeps all: ${filterIosBackCamera([{ label: "a" }, { label: "b" }], false).length}`);
    L.push(`clampZoom(5.6, 1, 4) = ${clampZoom(5.6, 1, 4)}; clampZoom(4,1,8) = ${clampZoom(4, 1, 8)}; clampZoom(0.5,1,8) = ${clampZoom(0.5, 1, 8)}; clampZoom(4,null,null) = ${clampZoom(4, null, null)}`);

    L.push("== AutoZoom on a model where marker px/cell = base * zoom (target 12, hold band 9.4-16.2) ==");
    L.push("far (base 1.5):   " + sim(1.5, 1, 1, 8));
    L.push("tier too high:    " + sim(3, 8, 1, 8));
    L.push("already in band:  " + sim(3, 4, 1, 8));
    L.push("needs > max zoom: " + sim(1.5, 2, 1, 4));
    L.push("needs < min zoom: " + sim(12, 3, 1, 8));
    L.push("== with 450ms camera lag (stale frames) ==");
    L.push("far, lag 450:        " + sim(1.5, 1, 1, 8, 80, 450));
    L.push("far (base 1.6), lag:  " + sim(1.6, 4, 1, 8, 80, 450));
    L.push("too big, lag 450:     " + sim(6, 4, 1, 8, 80, 450));
    L.push("lag 900:              " + sim(1.6, 4, 1, 8, 80, 900));
    L.push("camera ignores zoom:   " + sim(1.6, 4, 1, 8, 80, 0, true));

    const az = new AutoZoom();
    const inp = { nowMs: 1000, zoom: 1, zoomMin: 1, zoomMax: 8, step: 0.1, pxPerCell: 4, steady: true };
    const a = az.next(inp), b = az.next({ ...inp, nowMs: 1300 }), c = az.next({ ...inp, nowMs: 1900 });
    L.push(`rate limit: first ${a}, +300ms ${b}, +900ms ${c}`);
    const az2 = new AutoZoom();
    L.push(`not steady -> ${az2.next({ ...inp, steady: false })}; no marker -> ${az2.next({ ...inp, pxPerCell: null })}`);
    const az3 = new AutoZoom(); az3.disable();
    L.push(`after manual disable -> ${az3.next(inp)} (active=${az3.active})`);
    setLog(L);
  };
  return (
    <div className="p-4">
      <button onClick={run} className="border px-3 py-1 mb-3">Run</button>
      <div className="whitespace-pre-wrap font-mono text-xs bg-gray-100 p-3 rounded">{log.join("\n")}</div>
    </div>
  );
};
export default Page;
