// Test markers that carry their own watermark settings in the ID, so a scan session can fill in
// "strength" and "pair encoded" without anyone typing them.
//
//   S120P3113-A   strength 120, pair (3,1)/(1,3), copy A
//
// P is the four coefficient digits u1 v1 u2 v2 (each 0-7). The watermark bits come from crc32(id), so
// every variant/copy carries a different bit string.

import type { CoeffPair } from "./watermark";

export const SHEET_STRENGTHS = [60, 90, 120, 160];
export const SHEET_PAIRS: CoeffPair[] = [
  [[3, 1], [1, 3]], [[2, 1], [1, 2]], [[3, 2], [2, 3]], [[4, 2], [2, 4]], [[1, 1], [2, 2]], [[1, 0], [0, 1]],
];
export const SHEET_COPIES = ["A", "B", "C"];

export const pairCode = (p: CoeffPair): string => `${p[0][0]}${p[0][1]}${p[1][0]}${p[1][1]}`;

export function variantId(strength: number, pair: CoeffPair, copy: string): string {
  return `S${String(strength).padStart(3, "0")}P${pairCode(pair)}-${copy}`;
}

export function parseVariantId(id: string): { strength: number; pair: CoeffPair } | null {
  const m = /^S(\d{2,3})P([0-7])([0-7])([0-7])([0-7])/.exec(id);
  if (!m) return null;
  return { strength: Number(m[1]), pair: [[Number(m[2]), Number(m[3])], [Number(m[4]), Number(m[5])]] };
}

export const formatPair = (p: CoeffPair): string => `(${p[0][0]},${p[0][1]})/(${p[1][0]},${p[1][1]})`;
