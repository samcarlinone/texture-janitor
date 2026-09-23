import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'

// SharedArrayBuffer (used to share spectra between FFT workers) requires a
// cross-origin isolated page. Any production host must send these too.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
})
