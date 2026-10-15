/* eslint-disable @typescript-eslint/no-explicit-any */
// AZTEC-STYLE SQUARE BULLSEYE MARKER — generator.
//
// Ported and validated in an earlier prototyping session: concentric SQUARE
// (Chebyshev-distance) bullseye finder + radial orientation spoke + RS(16,10)
// message channel with seeded XOR masking. Verified end-to-end (encode ->
// render -> simulate rotated/scaled/blurred/noisy capture -> detect -> decode)
// at 93-100% success across randomized trials before this app was built.
//
// Capacity note, confirmed by direct computation: 16 characters needs a
// 24x24 grid, NOT 20x20 — a 20x20 grid does not have enough available bits
// (76 vs 208 needed) once the quiet zone is sized correctly to clear the
// square bullseye's CORNER distance (ring0*sqrt(2)), which is required for
// rotation-safe orientation detection. See aztec-detector.ts for why.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for this package; see src/types/reedsolomon.d.ts
import * as ReedSolomonLib from "reedsolomon";

const { GenericGF, ReedSolomonEncoder, ReedSolomonDecoder } = ReedSolomonLib as any;
const rsField = GenericGF.QR_CODE_FIELD_256();
const rsEncoder = new ReedSolomonEncoder(rsField);
const rsDecoder = new ReedSolomonDecoder(rsField);

// ── Fixed encoding parameters ─────────────────────────────────────────
export const ID_LEN = 16;
export const RS_PARITY = 10;
export const MSG_BITS = (ID_LEN + RS_PARITY) * 8; // 208

// ── Marker geometry ────────────────────────────────────────────────────
export const G = 24;           // data grid cells per side
export const CELL_PX = 8;      // native px per cell
export const S = G * CELL_PX;  // 192 native px
export const DCX = S / 2, DCY = S / 2;

export const RINGS = [40, 31, 22, 13, 5]; // alternating ring radii, outer to inner (px)
export const SPOKE_HALF_WIDTH = 6;
// Orientation scan must clear the square bullseye's CORNER distance
// (ring0*sqrt(2) ~= 56.57), not just its flat-side radius — otherwise a
// rotation-independent circular scan can dip back inside the black rings
// at some rotations (confirmed directly: this was a real bug that produced
// garbage orientation angles before the fix).
export const SPOKE_INNER = Math.ceil(RINGS[0] * Math.SQRT2) + 1; // 58
export const SPOKE_OUTER = SPOKE_INNER + 10; // 68
export const QUIET_R = SPOKE_OUTER + 2; // 70, Chebyshev

export const PHYSICAL_MM = 7.0;
export const PER_PX_MM = PHYSICAL_MM / S;
export const REQUIRED_DPI = 25.4 / PER_PX_MM;

export function squareBullseyePixel(d: number): number | null {
  if (d <= RINGS[4]) return 0;
  if (d <= RINGS[3]) return 255;
  if (d <= RINGS[2]) return 0;
  if (d <= RINGS[1]) return 255;
  if (d <= RINGS[0]) return 0;
  return null;
}

export function inSpoke(x: number, y: number): boolean {
  const dx = x - DCX, dy = y - DCY;
  if (dy >= 0) return false; // only the "up" direction (design canonical orientation)
  const dist = Math.hypot(dx, dy);
  if (dist < SPOKE_INNER || dist > SPOKE_OUTER) return false;
  return Math.abs(dx) <= SPOKE_HALF_WIDTH;
}

/** G x G mask: true = reserved for the bullseye/spoke, false = usable for the message. */
export function buildReservedMask(): boolean[][] {
  const reserved: boolean[][] = Array.from({ length: G }, () => new Array(G).fill(false));
  for (let r = 0; r < G; r++) {
    for (let c = 0; c < G; c++) {
      const px = c * CELL_PX + CELL_PX / 2, py = r * CELL_PX + CELL_PX / 2;
      const d = Math.max(Math.abs(px - DCX), Math.abs(py - DCY)); // Chebyshev
      if (d <= QUIET_R) { reserved[r][c] = true; continue; }
      if (inSpoke(px, py)) { reserved[r][c] = true; continue; }
    }
  }
  return reserved;
}

// ── Deterministic seeded mask (xorshift32) — same algorithm as ts-poc's
// ts-marker-generator.ts, reimplemented standalone for this project. ──
function stringHash32(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function xorshift32(seed: number): () => number {
  let x = seed || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
}
export function makeMask(seedString: string, nPixels: number): number[] {
  const rng = xorshift32(stringHash32(seedString));
  const mask: number[] = [];
  for (let i = 0; i < nPixels; i++) mask.push(rng() & 1);
  return mask;
}

/** Repeat the codeword to fill nPixels, padding the remainder with its start. */
export function fillAvailable(msgBits: number[], nPixels: number): number[] {
  const z = msgBits.length;
  const reps = Math.floor(nPixels / z);
  const leftover = nPixels - reps * z;
  const out: number[] = [];
  for (let i = 0; i < reps; i++) out.push(...msgBits);
  out.push(...msgBits.slice(0, leftover));
  return out.slice(0, nPixels);
}

/** Validates and normalizes a 1-16 character fingerprint ID. */
export function validateId(id: string): { ok: true } | { ok: false; error: string } {
  if (id.length < 1) return { ok: false, error: "Must be at least 1 character" };
  if (id.length > ID_LEN) return { ok: false, error: `Must be at most ${ID_LEN} characters` };
  for (const ch of id) {
    if (ch.charCodeAt(0) > 255) return { ok: false, error: "Only single-byte characters are supported" };
  }
  return { ok: true };
}

/** RS-encodes a 1-16 char ID (right-padded with \0 to ID_LEN) into MSG_BITS bits. */
export function encodeBits(id: string): number[] {
  const check = validateId(id);
  if (!check.ok) throw new Error(check.error);
  const padded = id.padEnd(ID_LEN, "\0");
  const codeword = new Int32Array(ID_LEN + RS_PARITY);
  for (let i = 0; i < ID_LEN; i++) codeword[i] = padded.charCodeAt(i);
  rsEncoder.encode(codeword, RS_PARITY);
  const bits: number[] = [];
  for (const byte of codeword) {
    for (let k = 7; k >= 0; k--) bits.push((byte >> k) & 1);
  }
  return bits;
}

/** Decodes MSG_BITS bits back to the original (trimmed) ID, or null if RS correction fails. */
export function rsDecodeBits(bits: number[]): string | null {
  const nBytes = ID_LEN + RS_PARITY;
  if (bits.length !== nBytes * 8) return null;
  const codeword = new Int32Array(nBytes);
  for (let i = 0; i < nBytes; i++) {
    let byte = 0;
    for (let k = 0; k < 8; k++) byte = (byte << 1) | bits[i * 8 + k];
    codeword[i] = byte;
  }
  try {
    rsDecoder.decode(codeword, RS_PARITY);
    const chars = Array.from(codeword.slice(0, ID_LEN)).map((b: any) => String.fromCharCode(b));
    return chars.join("").replace(/\0+$/, "");
  } catch {
    return null;
  }
}

export interface PaintedMarker {
  cellBits: number[][]; // G x G, 0/1 for rendering (reserved cells are 0, overwritten separately)
  reserved: boolean[][];
  nAvail: number;
}

/** Computes the masked message bits laid out onto the G x G grid (message cells only). */
export function paintGrid(id: string, seed: string): PaintedMarker {
  const reserved = buildReservedMask();
  let nAvail = 0;
  for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) nAvail++;

  const msgBits = encodeBits(id);
  if (nAvail < msgBits.length) {
    throw new Error(`Grid too small: ${nAvail} available bits < ${msgBits.length} needed`);
  }
  const filled = fillAvailable(msgBits, nAvail);
  const maskBits = makeMask(seed, nAvail);
  const masked = filled.map((b, i) => b ^ maskBits[i]);

  const cellBits: number[][] = Array.from({ length: G }, () => new Array(G).fill(0));
  let k = 0;
  for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (!reserved[r][c]) cellBits[r][c] = masked[k++];

  return { cellBits, reserved, nAvail };
}

export interface RenderedMarker {
  width: number;
  height: number;
  pixels: Uint8Array; // 0 = black, 255 = white, row-major, native S x S
}

/** Renders the full marker (bullseye + spoke + data cells) at native S x S resolution. */
export function renderMarker(id: string, seed: string): RenderedMarker {
  const { cellBits, reserved } = paintGrid(id, seed);
  const px = new Uint8Array(S * S).fill(255);
  const fillRect = (x0: number, y0: number, x1: number, y1: number, v: number) => {
    for (let y = Math.max(0, y0); y < Math.min(S, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(S, x1); x++) px[y * S + x] = v;
  };
  for (let r = 0; r < G; r++) {
    for (let c = 0; c < G; c++) {
      if (reserved[r][c]) continue;
      const v = cellBits[r][c] ? 255 : 0;
      const x0 = c * CELL_PX, y0 = r * CELL_PX;
      fillRect(x0, y0, x0 + CELL_PX, y0 + CELL_PX, v);
    }
  }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (inSpoke(x + 0.5, y + 0.5)) px[y * S + x] = 0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.max(Math.abs(x + 0.5 - DCX), Math.abs(y + 0.5 - DCY));
      const v = squareBullseyePixel(d);
      if (v !== null) px[y * S + x] = v;
    }
  }
  return { width: S, height: S, pixels: px };
}
