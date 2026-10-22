"use client";
// Watermark BER per burst frame, as a plain table (decode page, inside "Debug details").

import React from "react";
import { WM_PAIR_PRESETS, samePair, type CoeffPair } from "@/lib/watermark";
import type { FrameScore } from "@/lib/wm-scoring";

interface Props {
  frames: FrameScore[];
  pair: CoeffPair;
  onPair: (p: CoeffPair) => void;
  progress: { done: number; target: number } | null;
}

export function WmDebugPanel({ frames, pair, onPair, progress }: Props) {
  const presetIdx = WM_PAIR_PRESETS.findIndex((p) => samePair(p.pair, pair));
  return (
    <div className="mt-3 rounded-xl border border-gray-200 p-3 text-left">
      <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-400">
        <span>Watermark BER per frame</span>
        {progress && <span>{progress.done}/{progress.target}</span>}
      </div>
      <label className="mb-2 flex items-center gap-1 text-ref text-gray-500">
        Pair
        <select
          value={presetIdx}
          onChange={(e) => { const i = Number(e.target.value); if (i >= 0) onPair(WM_PAIR_PRESETS[i].pair); }}
          className="rounded border border-gray-300 px-1 py-0.5 text-black"
        >
          {presetIdx < 0 && <option value={-1}>Custom ({pair[0].join(",")}/{pair[1].join(",")})</option>}
          {WM_PAIR_PRESETS.map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}
        </select>
      </label>
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="text-left text-gray-400"><th className="py-0.5 font-normal">Frame</th><th className="text-right font-normal">BER</th></tr>
        </thead>
        <tbody className="font-mono text-black">
          {frames.map((f) => (
            <tr key={f.index} className="border-t border-gray-100">
              <td className="py-0.5">{f.index + 1}</td>
              <td className="text-right">{f.reading?.usable && f.reading.ber !== null ? `${f.reading.ber.toFixed(1)}%` : "n/a"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
