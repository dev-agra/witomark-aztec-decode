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
// RS_PARITY was 10 (t=5 correctable bytes), leaving 256-208=48 bits of grid
// capacity (nAvail, computed below) completely UNUSED — fillAvailable() just
// repeated the start of the codeword into that space, and the decoder threw
// the repeat away (codewordBits = unmasked.slice(0, MSG_BITS)), so those
// cells contributed zero error-correction value.
//
// Diagnosed directly against a real failing phone-upload photo: the
// extracted codeword had ZERO errors in all 16 data bytes, and errors in
// only 6 of the 10 parity bytes (bytes 20-25) — one byte over the t=5
// correction capacity (6 > 5), so a decode that was otherwise perfect
// failed outright. Raising parity to use the previously-wasted 48 bits
// (RS_PARITY=16 exactly fills nAvail=256 with real parity, t=8) converts
// that same error pattern into a correctable one (6 <= 8), using capacity
// the grid already had — no geometry change, no marker size change.
//
// Briefly dropped to 15 to pay for a white buffer cell-pair OUTSIDE the
// spoke's safe position (ring5) — then the spoke was moved one ring INWARD
// instead (ring4, see SPOKE_INNER below), which gets a free buffer on BOTH
// sides from the quiet zone that was already reserved there, so the parity
// byte didn't need to be spent after all. Back to 16 (t=8).
export const RS_PARITY = 16;
export const MSG_BITS = (ID_LEN + RS_PARITY) * 8; // 256

// ── Marker geometry ────────────────────────────────────────────────────
// CELL-NATIVE design: every hard edge in the marker — bullseye rings, the
// orientation spoke, and the data cells — is built from whole CELL_PX
// blocks, decided per GRID CELL (row/col ring-index), never by a continuous
// pixel distance. That's a deliberate change from an earlier version that
// computed ring/spoke edges as continuous Euclidean/Chebyshev thresholds in
// pixel space: those boundaries only line up with cell edges along the
// cardinal directions straight out from center — off-axis, a continuous
// threshold slices through the MIDDLE of cells, giving mixed-color cells
// and a marker that doesn't look built from a uniform grid at all (visible
// directly: a grid overlay showed ring/spoke edges cutting across cell
// lines, not along them). Deciding color per whole CELL by its own
// Chebyshev CELL-INDEX distance from center guarantees every cell is a
// single solid color and the whole marker is left/right and top/bottom
// symmetric by construction (built from |rowOffset|, |colOffset|).
//
// G=20 and 7mm physical size are both fixed requirements. Measured
// directly (see BULLSEYE_RING_CELLS below) that constrains how many
// alternating bullseye rings can fit alongside the orientation spoke and
// the mandatory corner-clearance margin while still leaving the required
// 256 bits of data capacity.
export const G = 20;           // data grid cells per side
export const CELL_PX = 8;      // native px per cell — every cell, finder or data, is this big
export const S = G * CELL_PX;  // 160 native px
export const DCX = S / 2, DCY = S / 2;
const CENTER_CELL = (G - 1) / 2; // 9.5 — grid lines meet exactly at the marker's center

/** Chebyshev CELL-ring distance of cell (r,c) from the exact center: 0 for
 *  the innermost 2x2 block of cells, 1 for the ring of cells around that,
 *  etc. Always a whole number since G is even (center sits on a grid line,
 *  not inside a cell), which is what makes every ring exactly one cell
 *  thick and symmetric on all 4 sides. */
function cellRingIndex(r: number, c: number): number {
  return Math.round(Math.max(Math.abs(r - CENTER_CELL), Math.abs(c - CENTER_CELL)) - 0.5);
}

// Bullseye: alternating black/white CELL rings, innermost (ring 0) black,
// out to BULLSEYE_RING_CELLS-1. Verified by direct search over every
// (bullseye size, spoke depth) combination: 3 rings (black dot-block,
// white ring, black ring — the same 3-band structure as a classic QR
// finder pattern) is the LARGEST that still leaves exactly the required
// 256 bits free at G=20 once the corner-clearance margin below is
// honored; 4 rings does not fit (204 of 256 needed). This is one fewer
// alternation than an earlier sub-cell-precision version had room for —
// an unavoidable consequence of every band now costing a full cell
// (8px) instead of a fraction of one.
export const BULLSEYE_RING_CELLS = 3;
// Kept for the detector's ray-based scale calibration, which measures
// ring-transition distances along continuous rays cast from the detected
// center — outer-to-inner pixel boundary of each bullseye ring.
export const RINGS = Array.from({ length: BULLSEYE_RING_CELLS }, (_, i) => (BULLSEYE_RING_CELLS - i) * CELL_PX); // [24, 16, 8]

// The bullseye's own corner-clearance distance (diagonal cell of the
// outermost ring reaches ring0*sqrt(2) in Euclidean terms, farther than its
// flat-side radius) sets the INNERMOST ring (ring5, 40-48px) that's safe for
// a rotation-independent circular orientation scan to use without dipping
// back into the black rings at some rotations (confirmed directly in an
// earlier version: this produced a spot-on-looking but completely wrong
// angle reading). The spoke itself, however, doesn't need to sit in that
// exact ring — only the SCAN RADIUS does, and resolveOrientation always
// scans at the midpoint of SPOKE_INNER..SPOKE_OUTER regardless of which
// ring that is. Placed one ring further in (ring4, 32-40) instead: the scan
// midpoint (36px) still clears the corner (33.9px) with margin, and this
// position sits fully inside the quiet zone on BOTH sides (ring3 and ring5
// are already reserved via QUIET_R below, independent of where the spoke
// is) — giving the spoke a guaranteed white buffer on all 4 sides for free,
// with no extra reserved cells needed. The ring4 placement's inner-edge
// margin is technically tighter than ring5's (confirmed: -1.9px at the
// spoke's own inner edge vs the corner, vs comfortable margin at ring5) —
// verified directly against the full rotation/scale/blur/noise stress suite
// at N=400 before relying on this: 98.3% vs 98.5% for ring5, statistically
// indistinguishable, with every failure in both runs clustered at the same
// pre-existing ~90-96deg edge case, none near the 45deg diagonals where a
// real corner violation would actually show up. Not verified against the
// specific real-world degradation modes (JPEG compression, print ink
// erosion) found elsewhere in this project — if marker reads ever start
// clustering specifically around 45/135/225/315deg rotations, this margin
// is the first place to look.
const SPOKE_SAFE_INNER = Math.ceil((RINGS[0] * Math.SQRT2) / CELL_PX) * CELL_PX; // 40 — the corner-clearance-safe ring boundary
export const SPOKE_INNER = SPOKE_SAFE_INNER - CELL_PX; // 32
export const SPOKE_OUTER = SPOKE_INNER + CELL_PX; // 40 — exactly one cell row tall
export const QUIET_R = SPOKE_SAFE_INNER + CELL_PX; // 48 — fixed at the corner-clearance-safe boundary, independent of the spoke's own position
const QUIET_RING_CELLS = QUIET_R / CELL_PX - 1; // 5 — cell ring-indices 0..5 are bullseye+quiet, all reserved
const SPOKE_ROW = CENTER_CELL - 0.5 - SPOKE_INNER / CELL_PX; // row index of the spoke's single cell-row, directly above center
const SPOKE_COLS = [Math.floor(CENTER_CELL), Math.ceil(CENTER_CELL)]; // the 2 center columns

export const PHYSICAL_MM = 7.0;
export const PER_PX_MM = PHYSICAL_MM / S;
export const REQUIRED_DPI = 25.4 / PER_PX_MM;

/** True for the exactly-2 cells making up the orientation spoke: one whole
 *  cell-row directly "north" of center (the canonical "up" orientation),
 *  spanning the 2 center columns. A plain cell-index check, not a
 *  continuous distance threshold — guarantees a perfect, fully cell-aligned
 *  rectangle with no rounding at its corners. Fully surrounded by the
 *  already-reserved quiet zone on all 4 sides (see QUIET_R above). */
export function isSpokeCell(r: number, c: number): boolean {
  return r === SPOKE_ROW && (c === SPOKE_COLS[0] || c === SPOKE_COLS[1]);
}

/** Solid fill color for a bullseye cell (0=black, 255=white), or null if
 *  (r,c) isn't part of the bullseye. */
export function bullseyeCellColor(r: number, c: number): number | null {
  const k = cellRingIndex(r, c);
  if (k >= BULLSEYE_RING_CELLS) return null;
  return k % 2 === 0 ? 0 : 255;
}

/** G x G mask: true = reserved for the bullseye/spoke, false = usable for the message. */
export function buildReservedMask(): boolean[][] {
  const reserved: boolean[][] = Array.from({ length: G }, () => new Array(G).fill(false));
  for (let r = 0; r < G; r++) {
    for (let c = 0; c < G; c++) {
      // The spoke (ring4) is already inside the quiet zone reserved below
      // (ring0..5), so this check never actually needs to fire for
      // reservation — kept for clarity/safety in case the spoke's ring
      // position ever changes again without updating QUIET_RING_CELLS.
      if (cellRingIndex(r, c) <= QUIET_RING_CELLS) { reserved[r][c] = true; continue; }
      if (isSpokeCell(r, c)) { reserved[r][c] = true; continue; }
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
      const x0 = c * CELL_PX, y0 = r * CELL_PX;
      let v: number;
      const bullseye = bullseyeCellColor(r, c);
      if (bullseye !== null) v = bullseye;
      else if (isSpokeCell(r, c)) v = 0;
      else if (reserved[r][c]) continue; // quiet-zone cell: stays white (background fill)
      else v = cellBits[r][c] ? 255 : 0;
      fillRect(x0, y0, x0 + CELL_PX, y0 + CELL_PX, v);
    }
  }
  return { width: S, height: S, pixels: px };
}
