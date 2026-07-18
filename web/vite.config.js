import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Dev mode: vite on 5556, the simulator API is proxied to 5555.
// Prod: `npm run build` → dist, served by the simulator itself (src/ui.js).
export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5556,
    proxy: {
      '/api': 'http://localhost:5555',
      '/events': 'http://localhost:5555',
    },
  },
  build: { outDir: 'dist' },
})
