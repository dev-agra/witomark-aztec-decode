// Marker-specific blur measurement. Given where the detector found the marker
// (center, scale, rotation), measure how much blur the capture has relative to
// the marker's own cell size — which is what decides whether the data cells
// are readable (cell-level blur, not raw pixel sharpness).
//
// Two measures, both exposure-independent because the black/white levels are
// taken from the marker's own finder cells:
//   edgeWidthCells  20%-80% rise distance of the outer ring's edge, in cells
//   finderMod/dataMod/ratio  mean distance of each cell's 9-point average from
//                    the black/white midpoint, as a fraction of the half-range.
//                    The finder cells are solid multi-cell bands and survive
//                    blur; the 1-cell checkerboard DATA cells are what blur
//                    erases first, so dataMod/finderMod falls with blur.

import { G, CELL_PX, DCX, DCY, RINGS, buildReservedMask, bullseyeCellColor, isSpokeCell } from "./aztec-marker";
import { sampleBilinear } from "./aztec-detector";

export interface SharpnessEstimate { cx: number; cy: number; scale: number; rotationRad: number }

export interface SharpnessMetrics {
  /** White minus black level of the finder cells (0-255): print/exposure contrast. */
  contrast: number;
  finderMod: number;
  dataMod: number;
  /** dataMod / finderMod: ~1 on a sharp capture, falls toward 0 as cells blur together. */
  ratio: number;
  /** Median 20-80% edge rise of the outer ring, in cells (smaller = sharper). */
  edgeWidthCells: number | null;
}

const OFFSETS = [-0.25, 0, 0.25];

export function measureMarkerSharpness(
  gray: Uint8Array | Uint8ClampedArray, size: number, est: SharpnessEstimate
): SharpnessMetrics | null {
  const cos = Math.cos(est.rotationRad), sin = Math.sin(est.rotationRad);
  const toScene = (nx: number, ny: number): [number, number] =>
    [est.cx + (nx * cos - ny * sin) * est.scale, est.cy + (nx * sin + ny * cos) * est.scale];

  const reserved = buildReservedMask();
  const darkAvg: number[] = [], lightAvg: number[] = [];
  const dataAvg: number[] = [];
  const finderAvg: { v: number; light: boolean }[] = [];
  for (let r = 0; r < G; r++) {
    for (let c = 0; c < G; c++) {
      const bull = bullseyeCellColor(r, c);
      const expectLight = bull !== null ? bull === 255 : isSpokeCell(r, c) ? false : null;
      const isData = expectLight === null && !reserved[r][c];
      if (expectLight === null && !isData) continue;
      let sum = 0;
      for (const ox of OFFSETS) for (const oy of OFFSETS) {
        const [x, y] = toScene((c * CELL_PX + CELL_PX / 2 + ox * CELL_PX) - DCX, (r * CELL_PX + CELL_PX / 2 + oy * CELL_PX) - DCY);
        sum += sampleBilinear(gray, size, x, y);
      }
      const avg = sum / 9;
      if (expectLight === null) dataAvg.push(avg);
      else { finderAvg.push({ v: avg, light: expectLight }); (expectLight ? lightAvg : darkAvg).push(avg); }
    }
  }
  if (darkAvg.length === 0 || lightAvg.length === 0 || dataAvg.length === 0) return null;
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const black = mean(darkAvg), white = mean(lightAvg);
  const contrast = white - black;
  if (contrast < 20) return null; // no usable contrast to measure against
  const thr = (black + white) / 2, half = contrast / 2;
  const mod = (a: number[]) => mean(a.map((v) => Math.min(1.5, Math.abs(v - thr) / half)));
  const finderMod = mod(finderAvg.map((f) => f.v));
  const dataMod = mod(dataAvg);

  // Edge width across the outer ring's boundary, along the native axis normals
  // (not radial lines, which cross a flat edge at an angle and stretch it).
  const widths: number[] = [];
  const R = RINGS[0];
  const span = CELL_PX * 1.5, step = 0.5 / est.scale; // 0.5 scene px per sample, in native units
  for (const side of [0, 1, 2, 3]) {
    for (const u of [-0.5, -0.25, 0, 0.25, 0.5]) {
      const lat = u * R;
      const point = (s: number): [number, number] =>
        side === 0 ? toScene(R + s, lat) : side === 1 ? toScene(-R - s, lat) : side === 2 ? toScene(lat, R + s) : toScene(lat, -R - s);
      // outward: dark ring -> light quiet zone
      const samples: { s: number; v: number }[] = [];
      for (let s = -span; s <= span; s += step) { const [x, y] = point(s); samples.push({ s, v: (sampleBilinear(gray, size, x, y) - black) / contrast }); }
      const cross = (level: number) => {
        for (let i = 1; i < samples.length; i++) {
          if (samples[i - 1].v < level && samples[i].v >= level) {
            const t = (level - samples[i - 1].v) / (samples[i].v - samples[i - 1].v);
            return samples[i - 1].s + t * (samples[i].s - samples[i - 1].s);
          }
        }
        return null;
      };
      const a = cross(0.2), b = cross(0.8);
      if (a !== null && b !== null && b > a) widths.push((b - a) / CELL_PX);
    }
  }
  widths.sort((x, y) => x - y);
  const edgeWidthCells = widths.length >= 6 ? widths[Math.floor(widths.length / 2)] : null;

  return { contrast, finderMod, dataMod, ratio: finderMod > 0 ? dataMod / finderMod : 0, edgeWidthCells };
}
