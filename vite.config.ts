import { defineConfig } from 'vite';

// demo 页面放在 demo/ 目录，src/ 直接以 TS 源码被引用（零构建依赖）。
export default defineConfig({
  root: 'demo',
});
