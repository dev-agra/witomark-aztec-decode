"use client";
// Debug panel (decode page, `?debug`): per-frame watermark BER bars with the
// threshold line, summary tiles, and a per-candidate table for the selected frame.

import React, { useState } from "react";
import { WM_PAIR_PRESETS, samePair, type CoeffPair } from "@/lib/watermark";
import { summarize, WM_TARGET_FRAMES, type FrameScore, type WmVerdict } from "@/lib/wm-scoring";

const VERDICT_STYLE: Record<WmVerdict, { label: string; cls: string }> = {
  genuine: { label: "Genuine", cls: "text-green-600" },
  counterfeit: { label: "Counterfeit", cls: "text-red-600" },
  blurred: { label: "Blurred — rescan", cls: "text-amber-600" },
  "no-reading": { label: "No reading", cls: "text-gray-500" },
};

interface Props {
  frames: FrameScore[];
  threshold: number;
  onThreshold: (t: number) => void;
  pair: CoeffPair;
  onPair: (p: CoeffPair) => void;
  /** Frames still being collected (live), or null when finished / single-frame. */
  progress: { done: number; target: number } | null;
}

export function WmDebugPanel({ frames, threshold, onThreshold, pair, onPair, progress }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const sum = summarize(frames, threshold);
  const sel = frames.find((f) => f.index === (selected ?? sum.bestIndex ?? frames[0]?.index)) ?? null;
  const v = VERDICT_STYLE[sum.verdict];
  const presetIdx = WM_PAIR_PRESETS.findIndex((p) => samePair(p.pair, pair));

  // chart geometry: BER 0..60% (the unrelated-bits ceiling is ~50)
  const W = 320, H = 120, PAD = 4, MAXV = 60;
  const bw = Math.min(18, (W - PAD * 2) / Math.max(frames.length, WM_TARGET_FRAMES));
  const y = (b: number) => H - (Math.min(b, MAXV) / MAXV) * (H - 8);

  return (
    <div className="mt-3 rounded-xl border border-gray-200 p-3 text-left">
      <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-400">
        <span>Watermark verification</span>
        {progress && <span>Scoring frames {progress.done}/{progress.target}</span>}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Tile k="Best BER" v={sum.best === null ? "—" : `${sum.best.toFixed(1)}%`} />
        <Tile k="Frames scored" v={`${sum.scored}/${frames.length}`} />
        <Tile k={`Within ${sum.margin || 6} pts of best`} v={sum.scored ? `${sum.withinMargin}/${sum.scored}` : "—"} />
        <Tile k="Verdict" v={v.label} cls={v.cls} />
      </div>

      <svg viewBox={`0 0 ${W} ${H + 14}`} className="mt-3 w-full" role="img" aria-label="Watermark BER per frame">
        {[0, 20, 40, 60].map((g) => (
          <g key={g}>
            <line x1={PAD} x2={W - PAD} y1={y(g)} y2={y(g)} stroke="currentColor" strokeOpacity={0.1} />
            <text x={W - PAD} y={y(g) - 2} textAnchor="end" fontSize={7} fill="currentColor" fillOpacity={0.4}>{g}%</text>
          </g>
        ))}
        {frames.map((f, i) => {
          const b = f.reading?.usable ? f.reading.ber : null;
          const x = PAD + i * bw;
          const isBest = f.index === sum.bestIndex;
          const isSel = f.index === sel?.index;
          return (
            <g key={f.index} onClick={() => setSelected(f.index)} style={{ cursor: "pointer" }}>
              <rect x={x} y={0} width={bw} height={H} fill="transparent" />
              {b === null || b === undefined ? (
                <rect x={x + 2} y={H - 3} width={bw - 4} height={3} fill="currentColor" fillOpacity={0.25} />
              ) : (
                <rect
                  x={x + 2} y={y(b)} width={bw - 4} height={H - y(b)} rx={1.5}
                  fill={b <= threshold ? (isBest ? "#16a34a" : "#4ade80") : isBest ? "#dc2626" : "#f87171"}
                  stroke={isSel ? "currentColor" : "none"} strokeWidth={1}
                />
              )}
              <text x={x + bw / 2} y={H + 10} textAnchor="middle" fontSize={6} fill="currentColor" fillOpacity={isSel ? 0.9 : 0.4}>{f.index + 1}</text>
            </g>
          );
        })}
        <line x1={PAD} x2={W - PAD} y1={y(threshold)} y2={y(threshold)} stroke="#d97706" strokeDasharray="4 3" strokeWidth={1} />
        <text x={PAD + 2} y={y(threshold) - 2} fontSize={7} fill="#d97706">threshold {threshold}%</text>
      </svg>
      <p className="text-[10px] text-gray-400">Grey stub = frame not scored (no decode, or marker too small / alignment failed). Tap a bar for its candidates.</p>

      <div className="mt-2 flex flex-wrap items-center gap-3 text-ref text-gray-500">
        <label className="flex items-center gap-1">
          Threshold %
          <input
            type="number" min={1} max={50} value={threshold}
            onChange={(e) => onThreshold(Math.max(1, Math.min(50, Number(e.target.value) || 32)))}
            className="w-14 rounded border border-gray-300 px-1 py-0.5 font-mono text-black"
          />
        </label>
        <label className="flex items-center gap-1">
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
      </div>

      {sel && (
        <div className="mt-3 overflow-x-auto">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-gray-400">
            Frame {sel.index + 1} — {sel.decoded ? `${sel.id} via ${sel.method}` : "no decode"}, {sel.candidatesTried} candidate(s) tried
            {sel.note ? ` — ${sel.note}` : ""}
          </div>
          <table className="w-full min-w-[300px] border-collapse text-[11px]">
            <thead>
              <tr className="text-left text-gray-400">
                <th className="py-0.5 pr-2 font-normal">Cand</th>
                <th className="pr-2 font-normal">Center</th>
                <th className="pr-2 font-normal">px/cell</th>
                <th className="pr-2 font-normal">Finder</th>
                <th className="pr-2 font-normal">Decode</th>
                <th className="pr-2 font-normal">ρ</th>
                <th className="font-normal">BER</th>
              </tr>
            </thead>
            <tbody className="font-mono text-black">
              {sel.candidates.length === 0 && (
                <tr><td colSpan={7} className="py-1 text-gray-400">No candidates this frame.</td></tr>
              )}
              {sel.candidates.map((c, i) => (
                <tr key={i} className={c.decoded ? "bg-green-50" : ""}>
                  <td className="py-0.5 pr-2">#{i + 1}</td>
                  <td className="pr-2">{c.cx.toFixed(0)},{c.cy.toFixed(0)}</td>
                  <td className="pr-2">{c.pxPerCell.toFixed(1)}</td>
                  <td className="pr-2">{c.finderWrong === 0 ? "38/38" : `${38 - c.finderWrong}/38`}</td>
                  <td className="pr-2">{c.decoded ? "OK" : "—"}</td>
                  <td className="pr-2">{c.reading?.rho != null ? c.reading.rho.toFixed(2) : "—"}</td>
                  <td>
                    {c.reading
                      ? c.reading.usable && c.reading.ber !== null ? `${c.reading.ber.toFixed(1)}%` : <span title={c.reading.reason}>unusable</span>
                      : <span className="text-gray-400">not scored</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sel.reading && !sel.reading.usable && sel.reading.reason && (
            <p className="mt-1 text-[10px] text-amber-600">{sel.reading.reason}</p>
          )}
          {sel.reading && (
            <p className="mt-1 text-[10px] text-gray-400">
              align {sel.reading.iterations} iters, {sel.reading.ms.toFixed(0)} ms, {sel.reading.pxPerCell.toFixed(1)} px/cell
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Tile({ k, v, cls = "text-black" }: { k: string; v: string; cls?: string }) {
  return (
    <div className="rounded-lg bg-gray-50 px-2 py-1.5">
      <div className="text-[10px] text-gray-400">{k}</div>
      <div className={`font-mono text-sm font-semibold ${cls}`}>{v}</div>
    </div>
  );
}
