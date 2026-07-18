import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Дев-режим: vite на 5556, API симулятора проксируется на 5555.
// Прод: `npm run build` → dist, его раздаёт сам симулятор (src/ui.js).
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
