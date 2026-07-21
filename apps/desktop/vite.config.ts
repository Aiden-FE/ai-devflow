import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// Renderer 构建为静态资源，由 Electron loadFile 加载。
// tailwindcss v4 通过 vite 插件接入，CSS-first 配置见 src/styles.css。
// @ 别名与 tsconfig paths 对齐（shadcn/ui 约定）。
export default defineConfig({
  root: '.',
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
});
