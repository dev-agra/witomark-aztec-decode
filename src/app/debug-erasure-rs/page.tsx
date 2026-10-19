"use client";
// TEMPORARY — validates the new errors-and-erasures RS decoder against
// SYNTHETIC, controlled corruption (known ground truth, known corrupted
// positions) before trusting it on any real photo. Not part of the product.
import React, { useState } from "react";
import { encodeBits, rsDecodeBits, ID_LEN, RS_PARITY } from "@/lib/aztec-marker";
import { decodeWithErasures } from "@/lib/rs-erasures";

function bitsToBytes(bits: number[]): Int32Array {
  const n = bits.length / 8;
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i * 8 + k];
    out[i] = b;
  }
  return out;
}
function bytesToBits(bytes: Int32Array): number[] {
  const out: number[] = [];
  for (const byte of bytes) for (let k = 7; k >= 0; k--) out.push((byte >> k) & 1);
  return out;
}

const DebugErasureRsPage = () => {
  const [log, setLog] = useState<string[]>([]);

  const run = () => {
    const lines: string[] = [];
    const trueBits = encodeBits("DEVANSH");
    const trueBytes = bitsToBytes(trueBits);
    const nBytes = ID_LEN + RS_PARITY; // 32, twoS=16

    // sanity check 1: no corruption at all -> should decode clean with both paths
    {
      const bytes = trueBytes.slice();
      const ok = decodeWithErasures(bytes, RS_PARITY, []);
      const matches = ok && Array.from(bytes).every((b, i) => b === trueBytes[i]);
      lines.push(`[clean, no corruption] decodeWithErasures ok=${ok} matchesTruth=${matches}`);
    }

    // sanity check 2: v=0 (errors-only) should behave IDENTICALLY to the
    // existing reedsolomon decoder for the same corrupted codeword
    {
      const bytes = trueBytes.slice();
      // flip 8 bytes (t=8 is the stated correction capacity, RS_PARITY=16 -> twoS=16, e_max=8)
      const flipPositions = [0, 3, 7, 10, 15, 20, 24, 29];
      for (const p of flipPositions) bytes[p] = bytes[p] ^ 0xFF;
      const bytesForLib = bytes.slice();
      const libOk = (() => { try { const r = rsDecodeBits(bytesToBits(bytesForLib)); return r === "DEVANSH"; } catch { return false; } })();
      const bytesForOurs = bytes.slice();
      const oursOk = decodeWithErasures(bytesForOurs, RS_PARITY, []);
      const oursMatches = oursOk && Array.from(bytesForOurs).every((b, i) => b === trueBytes[i]);
      lines.push(`[errors-only, 8 flipped bytes, at t=8 capacity] library decode ok=${libOk}, our decoder (v=0) ok=${oursOk} matchesTruth=${oursMatches} -- should both succeed and agree`);
    }

    // sanity check 3: 9 flipped bytes, errors-only -- should FAIL (exceeds t=8)
    {
      const bytes = trueBytes.slice();
      const flipPositions = [0, 3, 7, 10, 13, 15, 20, 24, 29];
      for (const p of flipPositions) bytes[p] = bytes[p] ^ 0xFF;
      const oursOk = decodeWithErasures(bytes.slice(), RS_PARITY, []);
      lines.push(`[errors-only, 9 flipped bytes, OVER t=8 capacity] our decoder (v=0) ok=${oursOk} -- should FAIL (false)`);
    }

    // THE KEY TEST: same 9 corrupted bytes as above, but now the caller
    // flags ALL 9 corrupted positions as erasures (simulating "we know
    // these 9 cells were low-confidence reads, don't trust them blindly").
    // Correction budget: 2*0 unknown errors + 9 erasures = 9 <= twoS=16,
    // well within budget -- should SUCCEED where errors-only failed.
    {
      const bytes = trueBytes.slice();
      const flipPositions = [0, 3, 7, 10, 13, 15, 20, 24, 29];
      for (const p of flipPositions) bytes[p] = bytes[p] ^ 0xFF;
      const oursOk = decodeWithErasures(bytes, RS_PARITY, flipPositions);
      const matches = oursOk && Array.from(bytes).every((b, i) => b === trueBytes[i]);
      lines.push(`[9 corrupted bytes, ALL 9 flagged as erasures] ok=${oursOk} matchesTruth=${matches} -- should SUCCEED (erasures cost half of unknown errors)`);
    }

    // push further: how many erasures can it handle if ALL erasures (no
    // unknown errors at all)? Capacity should be v <= twoS = 16
    {
      const bytes = trueBytes.slice();
      const flipPositions = Array.from({ length: 16 }, (_, i) => i * 2); // 16 positions spread out
      for (const p of flipPositions) bytes[p] = bytes[p] ^ 0xFF;
      const oursOk = decodeWithErasures(bytes, RS_PARITY, flipPositions);
      const matches = oursOk && Array.from(bytes).every((b, i) => b === trueBytes[i]);
      lines.push(`[16 corrupted bytes, ALL 16 flagged as erasures, v=twoS=16] ok=${oursOk} matchesTruth=${matches} -- should SUCCEED (erasure-only capacity is the full twoS)`);
    }

    // one past capacity: 17 erasures should fail outright (v > twoS)
    {
      const bytes = trueBytes.slice();
      const oursOk = decodeWithErasures(bytes, RS_PARITY, Array.from({ length: 17 }, (_, i) => i));
      lines.push(`[17 erasure positions, v > twoS=16] ok=${oursOk} -- should FAIL (false)`);
    }

    // mixed case: 4 unknown errors + 7 erasures (not overlapping) =>
    // 2*4+7=15 <= 16, should succeed
    {
      const bytes = trueBytes.slice();
      const errorPositions = [1, 5, 9, 14]; // unknown to the decoder
      const erasurePositions = [2, 6, 11, 16, 21, 25, 30]; // flagged, also corrupted
      for (const p of [...errorPositions, ...erasurePositions]) bytes[p] = bytes[p] ^ 0xFF;
      const oursOk = decodeWithErasures(bytes, RS_PARITY, erasurePositions);
      const matches = oursOk && Array.from(bytes).every((b, i) => b === trueBytes[i]);
      lines.push(`[mixed: 4 unknown errors + 7 erasures, 2*4+7=15<=16] ok=${oursOk} matchesTruth=${matches} -- should SUCCEED`);
    }

    setLog(lines);
  };

  return (
    <div className="min-h-screen bg-white p-4">
      <h1 className="text-xl font-bold mb-2">errors-and-erasures RS decoder validation (temporary)</h1>
      <button onClick={run} className="border px-3 py-1 mb-4">Run</button>
      <div className="whitespace-pre-wrap font-mono text-xs bg-gray-100 p-3 rounded">{log.join("\n")}</div>
    </div>
  );
};

export default DebugErasureRsPage;
