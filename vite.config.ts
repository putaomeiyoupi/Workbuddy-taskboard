import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // 相对路径：产物既能被静态服务从根提供，也能从任意子路径（如预览面板的
  // /static-html/<hash>/index.html）打开，避免绝对路径 /assets/... 404 导致白屏
  base: './',
  plugins: [react()],
  server: {
    // 🔴 2026-09-16 改（审计 H1 的配套项）：原先绑 '0.0.0.0'。
    //    本 dev server 带 `/api` proxy ⇒ 局域网内任意机器可经
    //    `http://<本机IP>:5173/api/...` 打到后端，**绕过**后端「只绑回环」的收紧。
    //    改为回环后，dev 期也只有本机能访问。
    //    ⚠️ 若确需用手机等其它设备联调：把这里改回 '0.0.0.0'，
    //       并同时明白后端也会被经代理暴露（此时应给后端加前置鉴权）。
    host: '127.0.0.1',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  css: {
    preprocessorOptions: {
      less: {
        javascriptEnabled: true
      }
    }
  }
});
