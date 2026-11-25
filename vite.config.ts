import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readFileSync, existsSync } from 'fs'

const isWebBuild = process.env.VITE_BACKEND === 'web'

// Read version: prefer tauri.conf.json, fall back to package.json (e.g. Docker builds)
const tauriConfPath = resolve(__dirname, 'src-tauri/tauri.conf.json')
const pkg = existsSync(tauriConfPath)
  ? JSON.parse(readFileSync(tauriConfPath, 'utf-8'))
  : JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**', '**/src-tauri/target/**'],
    },
    // Proxy /api to Axum in web dev mode
    ...(isWebBuild
      ? {
          proxy: {
            '/api': {
              target: 'http://localhost:3001',
              changeOrigin: true,
            },
          },
        }
      : {}),
  },
  // Only exclude Tauri deps in Tauri mode; for web builds they're not imported
  optimizeDeps: {
    exclude: isWebBuild
      ? []
      : [
          '@tauri-apps/api',
          '@tauri-apps/plugin-dialog',
          '@tauri-apps/plugin-fs',
          '@tauri-apps/plugin-log',
          '@tauri-apps/plugin-shell',
        ],
  },
  build: {
    // Web builds target modern browsers; Tauri builds target specific engines
    target: isWebBuild
      ? 'es2022'
      : process.env.TAURI_ENV_PLATFORM === 'windows' 
      ? 'chrome105' 
      : 'safari13',
    // Don't minify for debug builds
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      onwarn(warning, warn) {
        if (
          warning.message.includes('spawn') &&
          warning.message.includes('child-process-proxy')
        ) {
          return
        }
        warn(warning)
      },
    },
  },
})
