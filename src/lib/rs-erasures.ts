// Errors-and-erasures Reed-Solomon decoder, built on the SAME GenericGF /
// GenericGFPoly machinery the `reedsolomon` npm package uses internally
// (QR_CODE_FIELD_256: primitive 0x011D, size 256, generatorBase 0) — so it
// operates on codewords IDENTICAL to the existing encoder/decoder in
// aztec-marker.ts, just with a decoder that can also take a list of
// low-confidence byte positions ("erasures") instead of only guessing.
//
// The `reedsolomon` package's own decoder only runs the errors-only
// Euclidean algorithm (no erasure support — confirmed by reading its
// source: decode(received, twoS) has no erasure-position parameter). Each
// unknown-position error costs 2 units of the twoS parity budget to locate
// AND correct; a position the caller has already flagged as unreliable
// costs only 1 unit, since only its correction (not its location) needs
// solving. So flagging genuinely low-confidence cells as erasures (instead
// of forcing a hard 0/1 guess) can raise the number of bad cells that get
// fixed for the same RS_PARITY spend: 2*unknownErrors + erasures <= twoS,
// vs unknownErrors*2 <= twoS for the errors-only path.
/* eslint-disable @typescript-eslint/no-explicit-any */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for this package; see src/types/reedsolomon.d.ts
import * as ReedSolomonLib from "reedsolomon";

const { GenericGF, GenericGFPoly } = ReedSolomonLib as any;
const field = GenericGF.QR_CODE_FIELD_256();

function truncateMod(poly: any, n: number): any {
  const coeffs: Int32Array = poly.getCoefficients();
  if (coeffs.length <= n) return poly;
  return new GenericGFPoly(field, coeffs.subarray(coeffs.length - n));
}

function findErrorLocations(locator: any): Int32Array {
  const numErrors = locator.getDegree();
  if (numErrors === 0) return new Int32Array(0);
  if (numErrors === 1) return new Int32Array([locator.getCoefficient(1)]);
  const result = new Int32Array(numErrors);
  let e = 0;
  for (let i = 1; i < field.size && e < numErrors; i++) {
    if (locator.evaluateAt(i) === 0) {
      result[e] = field.inverse(i);
      e++;
    }
  }
  if (e !== numErrors) throw new Error("locator degree does not match number of roots found");
  return result;
}

function findErrorMagnitudes(evaluator: any, locations: Int32Array): Int32Array {
  const s = locations.length;
  const result = new Int32Array(s);
  for (let i = 0; i < s; i++) {
    const xiInverse = field.inverse(locations[i]);
    let denominator = 1;
    for (let j = 0; j < s; j++) {
      if (i !== j) {
        denominator = field.multiply(denominator, GenericGF.addOrSubtract(1, field.multiply(locations[j], xiInverse)));
      }
    }
    result[i] = field.multiply(evaluator.evaluateAt(xiInverse), field.inverse(denominator));
    if (field.generatorBase !== 0) result[i] = field.multiply(result[i], xiInverse);
  }
  return result;
}

/**
 * Errors-and-erasures RS decode, in place on `received` (mutated on
 * success). `erasurePositions` are 0-based byte indices into `received`
 * the caller has flagged as low-confidence (does NOT need to know which
 * ones are actually wrong — just "don't trust this one"). Returns true if
 * the codeword was already valid or was successfully corrected, false if
 * uncorrectable with the given erasures + remaining parity budget.
 */
export function decodeWithErasures(received: Int32Array, twoS: number, erasurePositions: number[]): boolean {
  const n = received.length;
  const v = erasurePositions.length;
  if (v > twoS) return false;

  const poly = new GenericGFPoly(field, received);
  const syndromeCoefficients = new Int32Array(twoS);
  let noError = true;
  for (let i = 0; i < twoS; i++) {
    const ev = poly.evaluateAt(field.exp(i + field.generatorBase));
    syndromeCoefficients[syndromeCoefficients.length - 1 - i] = ev;
    if (ev !== 0) noError = false;
  }
  if (noError) return true;

  // erasure locator Lambda(x) = prod_j (1 + X_j * x), X_j = alpha^(n-1-pos_j)
  // (same location-number convention as the error positions below: position
  // p corresponds to root X = alpha^(n-1-p))
  let lambda = field.one;
  for (const pos of erasurePositions) {
    if (pos < 0 || pos >= n) throw new Error("erasure position out of range");
    const X = field.exp(n - 1 - pos);
    lambda = lambda.multiply(new GenericGFPoly(field, new Int32Array([X, 1])));
  }

  const syndrome = new GenericGFPoly(field, syndromeCoefficients);
  // T(x) = Lambda(x) * S(x) mod x^twoS. Running the ordinary (un-seeded)
  // Euclidean algorithm on (x^twoS, T(x)) and stopping once deg(r) < eMax
  // yields t=sigma1 (new-error locator) and r=omega_total directly — no
  // further combination with Lambda needed for omega, only for sigma.
  const T = truncateMod(lambda.multiply(syndrome), twoS);

  // Max degree the NEW-error locator (sigma1) is allowed to reach, so that
  // combined with the v known erasures it stays within budget:
  // 2*(unknown errors) + v <= twoS.
  const sigma1MaxDegree = Math.floor((twoS - v) / 2);
  if (sigma1MaxDegree < 0) return false;

  // The loop below has the invariant deg(t) + deg(r_prev) == twoS once it
  // starts reducing (same bookkeeping as the library's errors-only
  // algorithm, where a=x^twoS is unchanged here too) — so to bound the
  // final deg(t) <= sigma1MaxDegree, the stopping threshold on deg(r) must
  // be twoS - sigma1MaxDegree, NOT sigma1MaxDegree itself. (At v=0 the two
  // coincide at twoS/2, which is why testing only the errors-only path
  // doesn't catch this — confirmed by a failing erasure test before this
  // fix.)
  const stopThreshold = twoS - sigma1MaxDegree;

  let rLast = field.buildMonomial(twoS, 1);
  let r = T;
  let tLast = field.zero;
  let t = field.one;
  if (rLast.getDegree() < r.getDegree()) { const tmp = rLast; rLast = r; r = tmp; }

  while (r.getDegree() >= stopThreshold) {
    const rLastLast = rLast, tLastLast = tLast;
    rLast = r; tLast = t;
    if (rLast.isZero()) return false;
    r = rLastLast;
    let q = field.zero;
    const dltInverse = field.inverse(rLast.getCoefficient(rLast.getDegree()));
    while (r.getDegree() >= rLast.getDegree() && !r.isZero()) {
      const degreeDiff = r.getDegree() - rLast.getDegree();
      const scale = field.multiply(r.getCoefficient(r.getDegree()), dltInverse);
      q = q.addOrSubtract(field.buildMonomial(degreeDiff, scale));
      r = r.addOrSubtract(rLast.multiplyByMonomial(degreeDiff, scale));
    }
    t = q.multiply(tLast).addOrSubtract(tLastLast);
    if (r.getDegree() >= rLast.getDegree()) return false;
  }

  const sigmaTildeAtZero = t.getCoefficient(0);
  if (!sigmaTildeAtZero) return false;
  const inv = field.inverse(sigmaTildeAtZero);
  const sigma1 = t.multiply(inv);
  const omegaTotal = r.multiply(inv);
  const sigmaTotal = lambda.multiply(sigma1);

  let errorLocations: Int32Array, errorMagnitudes: Int32Array;
  try {
    errorLocations = findErrorLocations(sigmaTotal);
    errorMagnitudes = findErrorMagnitudes(omegaTotal, errorLocations);
  } catch {
    return false;
  }

  for (let i = 0; i < errorLocations.length; i++) {
    const position = n - 1 - field.log(errorLocations[i]);
    if (position < 0 || position >= n) return false;
    received[position] = GenericGF.addOrSubtract(received[position], errorMagnitudes[i]);
  }
  return true;
}
