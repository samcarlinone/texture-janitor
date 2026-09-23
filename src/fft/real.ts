import type { FFTPlan } from './plan.ts'

/** Number of non-redundant bins in the spectrum of a real signal of length n. */
export const halfLength = (n: number): number => (n >> 1) + 1

/**
 * Forward-transform two real signals with one complex FFT (any length n).
 *
 * `z` is the plan's work buffer (length >= 2n). The caller has written
 * z[2j] = a[j] and z[2j+1] = b[j]. Afterwards `outA` and `outB` hold bins
 * 0..n/2 of each signal's spectrum as interleaved complex. The other bins
 * follow from Hermitian symmetry X[n-k] = conj(X[k]).
 */
export function forwardRealPair(plan: FFTPlan, z: Float64Array, outA: Float64Array, outB: Float64Array): void {
  const n = plan.n
  plan.forward(z)
  const nh = halfLength(n)
  for (let k = 0; k < nh; k++) {
    const m = k === 0 ? 0 : n - k
    const zr = z[2 * k]
    const zi = z[2 * k + 1]
    // conj(Z[n-k])
    const cr = z[2 * m]
    const ci = -z[2 * m + 1]
    // A = (Z + conj Zm) / 2 ; B = -i·(Z - conj Zm) / 2
    outA[2 * k] = 0.5 * (zr + cr)
    outA[2 * k + 1] = 0.5 * (zi + ci)
    outB[2 * k] = 0.5 * (zi - ci)
    outB[2 * k + 1] = -0.5 * (zr - cr)
  }
}

/**
 * Inverse of `forwardRealPair`: from half spectra `inA` and `inB`, write the
 * unnormalized real signals into `z` as z[2j] = n·a[j] and z[2j+1] = n·b[j].
 *
 * Only the Hermitian-consistent part of the input is used: the imaginary
 * parts of the self-conjugate bins (DC and, for even n, Nyquist) are
 * dropped, as a real-output inverse would do.
 */
export function inverseRealPair(plan: FFTPlan, inA: Float64Array, inB: Float64Array, z: Float64Array): void {
  const n = plan.n
  const nh = halfLength(n)
  const nyq = n % 2 === 0 ? n >> 1 : -1
  for (let k = 0; k < nh; k++) {
    let ar = inA[2 * k]
    let ai = inA[2 * k + 1]
    let br = inB[2 * k]
    let bi = inB[2 * k + 1]
    if (k === 0 || k === nyq) {
      ai = 0
      bi = 0
    }
    // Z[k] = A + i·B
    z[2 * k] = ar - bi
    z[2 * k + 1] = ai + br
    if (k !== 0 && k !== nyq) {
      // Z[n-k] = conj(A) + i·conj(B)
      ar = inA[2 * k]
      ai = -inA[2 * k + 1]
      br = inB[2 * k]
      bi = -inB[2 * k + 1]
      const m = n - k
      z[2 * m] = ar - bi
      z[2 * m + 1] = ai + br
    }
  }
  plan.inverse(z)
}
