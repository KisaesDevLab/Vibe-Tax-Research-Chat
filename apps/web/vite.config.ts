import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Runtime base-path sentinel — a single image serves any prefix.
//
// Production builds bake `/__VIBE_BASE_PATH__/` into every asset URL
// and import.meta.env.BASE_URL. The web container's
// docker-entrypoint.d/40-base-path.sh hook reads VITE_BASE_PATH at
// startup and `sed -i` replaces the sentinel across the html/js/css/
// json/map files in /usr/share/nginx/html before nginx starts.
//
// Single-app  : VITE_BASE_PATH=/        → assets at /assets/...
// Multi-app   : VITE_BASE_PATH=/tax/    → assets at /tax/assets/...
//
// No rebuild required to switch modes — same image, two URLs. Same
// pattern as Vibe-Payroll-Time, Vibe-Trial-Balance, and Vibe MyBooks;
// keep all four in sync if any of them gets a fix.
const BASE_PATH_SENTINEL = '/__VIBE_BASE_PATH__/';

export default defineConfig(({ command }) => {
  // `vite dev` keeps `base: '/'` so HMR + the dev proxy work without
  // the substitution step. Production builds use the sentinel so the
  // container entrypoint can rewrite it at startup.
  const basePath = command === 'build' ? BASE_PATH_SENTINEL : '/';

  return {
    base: basePath,
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/api': {
          target: process.env.VITE_API_BASE_URL ?? 'http://localhost:4000',
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
