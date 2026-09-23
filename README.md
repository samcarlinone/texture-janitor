# Texture Janitor

A Fourier-domain image editor. The image is on the left, controls are in the middle, and the image's
2D spectrum is on the right. Paint on the spectrum and the image updates live, at the image's native
resolution.

# AI Usage

This project was created largely by AI, I cannot guarantee the quality of the code nor the correctness of the results.

## Features

- **Spectrum tools**: attenuate, amplify and restore brushes (with size, hardness and strength), plus
  select and pan. Every edit is mirrored through DC (k ↔ −k), so the result stays a real image.
- **Selections**: ellipse or rectangle with feathering. You can remove the selection (notch filter),
  keep only the selection (DC is kept), or apply the current brush to it.
- **Isolation, spectrum → image**: a selection spotlights where in the image those frequencies live
  (the amplitude envelope of the selected band).
- **Isolation, image → spectrum**: pick a region of the image to see its Hann-windowed spectrum. It is
  drawn on the global frequency axes, so its peaks line up with the full spectrum.
- **Checkpoints** (K): bake the current result into a new base image, stored at full resolution. Edits
  after a checkpoint apply to that image, so edit cost doesn't grow with the number of checkpoints.
  Each checkpoint keeps its own working edits and undo history; switch between them from the History
  stack at any time (switching re-runs one forward FFT).
- **Denoise** (spatial and spectral), each with Fast / Balanced / Best quality presets:
  - *Spectral Wiener*: global Wiener filter in the Fourier domain. Instant, no extra memory, applied as
    an undoable spectrum edit.
  - *Non-local means* (Buades, Coll & Morel, IPOL 2011), in the fast offset/box-filter form.
  - *Colour BM3D* (Dabov et al. 2007, parameters after Lebrun, IPOL 2012), with optional
    correlated-noise shrinkage (Mäkinen, Azzari & Foi, IEEE TIP 2020): each DCT coefficient is
    thresholded by its own measured noise level.
  - The noise level is estimated automatically per opponent-colour channel from the flattest 8×8 blocks
    (their DCT gives the noise spectrum). Strength and chroma sliders adjust it; defaults are calibrated
    on the [Natural Image Noise Dataset](https://commons.wikimedia.org/wiki/Natural_Image_Noise_Dataset).
  - A memory preset (tile size × threads) trades peak memory for speed; the panel shows an estimated time
    and peak memory before you run. With a region picked, Preview runs on just that region.
- **Projects** (`.tj`): save everything (every checkpoint and subregion, edits in both modes, and full
  undo/redo history) and reopen it later. With the File System Access API (Chromium), you pick a file
  once and it autosaves every 30 s. Other browsers download and upload `.tj` files instead. The file is
  an append-only log of compressed records, so a save writes only what changed: new images once, then
  history entries and patches of the edited tiles. Dead space is compacted away occasionally.
- **Memory meter** in the bottom bar: the app's own accounting by category, plus a browser measurement
  (Chrome) with shared memory counted once.
- Pan and zoom on both panes; hold C to compare with the active checkpoint, or B for the base image;
  full-resolution PNG export.

## How it works

- `src/fft/`: our own FFT library, with no dependencies. It gives exact DFTs of **any** length: a
  mixed-radix Stockham core (radix 4/2/3/5 plus generic primes ≤ 61) and Bluestein for larger prime
  factors. It includes a two-real-signals-per-complex-FFT pair transform and `RealFFT2D`, which stores
  only the non-redundant half spectrum and works in row/column ranges so threads can share one buffer.
- `src/engine/`: a pool of Web Workers on `SharedArrayBuffer`s holds the three RGB half spectra and a
  per-bin complex edit multiplier. While you brush a large image, the view shows an exact low-pass
  preview (the centred spectrum block inverse-transformed at about 1280 px). When you pause, it
  re-renders at full resolution. Small images always render at full resolution.
- The spectrum view is a 12-bit log-magnitude image with a max-pooled pyramid, so zooming out never
  hides isolated peaks.

## Denoising benchmark

Real camera noise from NIND: ISO6400 frames against the ISO200 reference of the same scene. There are
twelve 512×512 crops from three scenes (the nine most textured windows plus three flat ones), timed on
one thread; the app runs tiles in parallel. PSNR and SSIM are shown as *textured / flat*.

| Method (strength, chroma)        | PSNR dB       | SSIM          | s / crop |
|----------------------------------|---------------|---------------|----------|
| Noisy input                      | 23.43 / 24.77 | 0.647 / 0.539 | —        |
| Wiener (2×)                      | 28.33 / 35.34 | 0.849 / 0.959 | 0.04     |
| NL-means Fast (1×)               | 27.07 / 30.79 | 0.824 / 0.925 | 0.9      |
| BM3D Fast, measured (1.5×, 1.25×)| 28.98 / 32.78 | 0.836 / 0.916 | 1.6      |
| BM3D Fast, white (1.75×, 1.5×)   | 29.19 / 33.36 | 0.860 / 0.919 | 1.6      |
| BM3D Best, measured (1.75×, 1.25×)| 29.24 / 33.27 | 0.837 / 0.934 | 22.4     |

The measured-spectrum model is the default. It is far better on strongly correlated noise (heavily
processed JPEGs), and slightly behind the white model on clean sensor noise.

## Deployment note

`SharedArrayBuffer` needs a cross-origin-isolated page. The dev and preview servers already send the
headers below; any production host must send them too:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```
