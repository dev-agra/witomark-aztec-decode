// Registration refinement: rescues captures whose grid is sampled slightly
// off-position.
//
// Found on the real samples (known "DEVANSH" codeword): m1, n1, n2 and n3 all
// failed the normal decode, yet the data cells were read confidently — the
// detector's refined scale was ~10% too small, so cells beyond the center were
// sampled on the wrong neighbors. With the geometry nudged to about +10% scale
// every one of them decodes (m1 0/256 bits wrong). They were NOT blur-limited,
// as first assumed: their outer-ring edges are as sharp as the captures that
// decode.
//
// Method: from the detector's estimate, hill-climb scale / shift / rotation to
// maximize how confidently the 256 data cells read (distance from the
// black/white midpoint), inside a bounded trust region. That objective alone
// is NOT trustworthy — on n1 a wrong geometry scores higher than the correct
// one — so the maximum is never taken on faith. Each start's local optimum is
// handed to Reed-Solomon, which is the real judge, and the first RS-valid
// decode wins. Starts are ordered so the common (+~10%) basin is tried first.

import {
  G, CELL_PX, DCX, DCY, buildReservedMask, makeMask, rsDecodeBits, MSG_BITS, bullseyeCellColor, isSpokeCell,
} from "./aztec-marker";
import { extractGrid, sampleBilinear, type MarkerEstimate, type AlignedGeometry } from "./aztec-detector";

const reserved = buildReservedMask();
let nAvail = 0;
for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) nAvail++;
const maskCache = new Map<string, number[]>();
function maskFor(seed: string): number[] {
  let m = maskCache.get(seed);
  if (!m) { m = makeMask(seed, nAvail); maskCache.set(seed, m); }
  return m;
}

// Native-space sample points, precomputed once.
const OFF9: [number, number][] = [];
for (const ox of [-0.25, 0, 0.25]) for (const oy of [-0.25, 0, 0.25]) OFF9.push([ox, oy]);

function nativePoints(cells: [number, number][], offs: [number, number][]): Float32Array {
  const out: number[] = [];
  for (const [r, c] of cells) for (const [ox, oy] of offs) {
    out.push((c * CELL_PX + CELL_PX / 2 + ox * CELL_PX) - DCX, (r * CELL_PX + CELL_PX / 2 + oy * CELL_PX) - DCY);
  }
  return Float32Array.from(out);
}

const finderDark: [number, number][] = [], finderLight: [number, number][] = [], dataCells: [number, number][] = [];
for (let r = 0; r < G; r++) {
  for (let c = 0; c < G; c++) {
    const bull = bullseyeCellColor(r, c);
    const light = bull !== null ? bull === 255 : isSpokeCell(r, c) ? false : null;
    if (light === true) finderLight.push([r, c]);
    else if (light === false) finderDark.push([r, c]);
    else if (!reserved[r][c]) dataCells.push([r, c]);
  }
}
const PTS_DARK = nativePoints(finderDark, OFF9);
const PTS_LIGHT = nativePoints(finderLight, OFF9);
// 9 samples per cell, same as the real extraction: a 5-sample objective placed n1 0.1 cell
// off and missed the geometry RS needs (tested), so the climb uses the full footprint.
const PTS_DATA = nativePoints(dataCells, OFF9);

function meanSample(g: Uint8Array | Uint8ClampedArray, w: number, pts: Float32Array, from: number, count: number,
  cx: number, cy: number, sc: number, cos: number, sin: number): number {
  let sum = 0;
  for (let k = 0; k < count; k++) {
    const nx = pts[from + 2 * k], ny = pts[from + 2 * k + 1];
    sum += sampleBilinear(g, w, cx + (nx * cos - ny * sin) * sc, cy + (nx * sin + ny * cos) * sc);
  }
  return sum / count;
}

function groupMean(g: Uint8Array | Uint8ClampedArray, w: number, pts: Float32Array, perCell: number,
  cx: number, cy: number, sc: number, cos: number, sin: number): number {
  const cells = pts.length / (2 * perCell);
  let s = 0;
  for (let i = 0; i < cells; i++) s += meanSample(g, w, pts, i * perCell * 2, perCell, cx, cy, sc, cos, sin);
  return s / cells;
}

interface Levels { thr: number; half: number }

function levelsAt(g: Uint8Array | Uint8ClampedArray, w: number, est: { cx: number; cy: number; scale: number; rotationRad: number }): Levels | null {
  const cos = Math.cos(est.rotationRad), sin = Math.sin(est.rotationRad);
  const black = groupMean(g, w, PTS_DARK, OFF9.length, est.cx, est.cy, est.scale, cos, sin);
  const white = groupMean(g, w, PTS_LIGHT, OFF9.length, est.cx, est.cy, est.scale, cos, sin);
  if (white - black < 20) return null;
  return { thr: (black + white) / 2, half: (white - black) / 2 };
}

function dataConfidence(g: Uint8Array | Uint8ClampedArray, w: number, cx: number, cy: number, sc: number, rot: number, lv: Levels): number {
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const cells = dataCells.length;
  let s = 0;
  for (let i = 0; i < cells; i++) {
    const avg = meanSample(g, w, PTS_DATA, i * OFF9.length * 2, OFF9.length, cx, cy, sc, cos, sin);
    s += Math.min(1, Math.abs(avg - lv.thr) / lv.half);
  }
  return s / cells;
}

interface P { ds: number; dx: number; dy: number; dr: number }

// trust region (fractions / cells / degrees around the detector's estimate)
const LIM = { dsMin: -0.06, dsMax: 0.2, dMax: 0.3, drMax: 2 };
const STEPS: [number, number, number][] = [[0.04, 0.2, 1], [0.02, 0.1, 0.5], [0.01, 0.05, 0.25], [0.005, 0.025, 0.12]];
// first start lands in the common ~+10% basin; the rest cover other basins
const START_DS = [0.04, 0, 0.08, -0.03, 0.12];

function climb(g: Uint8Array | Uint8ClampedArray, w: number, est: MarkerEstimate, start: P, lv: Levels): P {
  const cellPx = CELL_PX * est.scale;
  const val = (p: P) => dataConfidence(g, w, est.cx + p.dx * cellPx, est.cy + p.dy * cellPx, est.scale * (1 + p.ds), est.rotationRad + (p.dr * Math.PI) / 180, lv);
  const inside = (p: P) => p.ds >= LIM.dsMin && p.ds <= LIM.dsMax && Math.abs(p.dx) <= LIM.dMax && Math.abs(p.dy) <= LIM.dMax && Math.abs(p.dr) <= LIM.drMax;
  let p = { ...start }, best = val(p);
  for (const [sDs, sD, sDr] of STEPS) {
    let improved = true, guard = 0;
    while (improved && guard++ < 12) {
      improved = false;
      for (const key of ["ds", "dx", "dy", "dr"] as (keyof P)[]) {
        const step = key === "ds" ? sDs : key === "dr" ? sDr : sD;
        for (const sign of [1, -1]) {
          const q = { ...p, [key]: p[key] + sign * step };
          if (!inside(q)) continue;
          const v = val(q);
          if (v > best + 1e-6) { best = v; p = q; improved = true; break; }
        }
      }
    }
  }
  return p;
}

export interface RegistrationResult { id: string; geometry: AlignedGeometry; startDs: number; optimaTried: number }

export interface RegistrationOptions {
  /** Try only the first N starts (default: all). */
  maxStarts?: number;
  /** Stop starting new climbs once this many ms have elapsed (default: none). */
  budgetMs?: number;
  diag?: (info: { startDs: number; ds: number; dx: number; dy: number; dr: number; ok: boolean }) => void;
}

/** Returns the first RS-valid decode found by refining around `est`, or null. */
export function registrationDecode(
  g: Uint8Array | Uint8ClampedArray, w: number, est: MarkerEstimate, seed: string, opts: RegistrationOptions = {}
): RegistrationResult | null {
  const lv = levelsAt(g, w, est);
  if (!lv) return null;
  const mask = maskFor(seed);
  const cellPx = CELL_PX * est.scale;
  const tried = new Set<string>();
  const t0 = performance.now();
  for (const ds0 of START_DS.slice(0, opts.maxStarts ?? START_DS.length)) {
    if (opts.budgetMs !== undefined && performance.now() - t0 > opts.budgetMs) break;
    const p = climb(g, w, est, { ds: ds0, dx: 0, dy: 0, dr: 0 }, lv);
    const key = `${p.ds.toFixed(3)}|${p.dx.toFixed(2)}|${p.dy.toFixed(2)}|${p.dr.toFixed(2)}`;
    if (tried.has(key)) continue;
    tried.add(key);
    const geometry: AlignedGeometry = {
      cx: est.cx + p.dx * cellPx, cy: est.cy + p.dy * cellPx,
      scale: est.scale * (1 + p.ds), rotationRad: est.rotationRad + (p.dr * Math.PI) / 180,
    };
    const bits = extractGrid(g, w, geometry.cx, geometry.cy, geometry.scale, geometry.rotationRad - Math.PI / 2, lv.thr);
    const flat: number[] = [];
    for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) flat.push(bits[r][c]);
    const id = rsDecodeBits(flat.map((b, i) => b ^ mask[i]).slice(0, MSG_BITS));
    opts.diag?.({ startDs: ds0, ds: p.ds, dx: p.dx, dy: p.dy, dr: p.dr, ok: id !== null });
    if (id !== null) return { id, geometry, startDs: ds0, optimaTried: tried.size };
  }
  return null;
}
