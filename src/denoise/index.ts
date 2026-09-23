export { toOpponent, fromOpponent, type Planes } from './color.ts'
export { estimateSigma, estimateNoiseRGBA, type NoiseEstimate } from './noise.ts'
export { padReflect } from './pad.ts'
export { nlm, nlmParams, nlmHalo, type NlmParams } from './nlm.ts'
export { bm3d, bm3dParams, bm3dHalo, type Bm3dParams } from './bm3d.ts'
export { wienerGains } from './wiener.ts'

export type DenoiseAlgo = 'wiener' | 'nlm' | 'bm3d'
export type Quality = 'fast' | 'balanced' | 'best'
/** BM3D noise model: the measured per-frequency spectrum, or flat (white). */
export type NoiseModel = 'measured' | 'white'

/**
 * Default strength / chroma multipliers on the estimated noise level,
 * calibrated on real camera noise from the Natural Image Noise Dataset
 * (ISO6400 vs ISO200, textured and flat crops, PSNR and SSIM). The
 * flat-block estimate reads low on signal-dependent sensor noise, since
 * the flattest blocks tend to be the darkest and least noisy.
 */
export function denoiseDefaults(algo: DenoiseAlgo, model: NoiseModel): { strength: number; chroma: number } {
  if (algo === 'wiener') return { strength: 2, chroma: 1 }
  if (algo === 'nlm') return { strength: 1.25, chroma: 1.25 }
  return model === 'measured' ? { strength: 1.5, chroma: 1.25 } : { strength: 1.75, chroma: 1.5 }
}
