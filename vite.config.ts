import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {defineConfig, type Plugin} from 'vite';

// 项目根目录（兼容所有 Node 版本，不依赖 __dirname / import.meta.dirname）
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));

// 单文件发行插件：把打包后的 JS / CSS 全部内联进 index.html，
// 产物可以直接双击用 file:// 打开（浏览器禁止 file:// 下加载外部 module 脚本）。
// 仅在 `vite build --mode single`（npm run build:single）时启用。
function singleFileRelease(outName: string): Plugin {
  return {
    name: 'blackwood-single-file-release',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const htmlKey = Object.keys(bundle).find((k) => k.endsWith('.html'));
      if (!htmlKey) return;
      const htmlAsset = bundle[htmlKey] as {type: string; source: string | Uint8Array};
      let html =
        typeof htmlAsset.source === 'string'
          ? htmlAsset.source
          : new TextDecoder().decode(htmlAsset.source);

      for (const key of Object.keys(bundle)) {
        const item = bundle[key] as any;
        const base = key.split('/').pop() as string;
        const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (item.type === 'chunk' && key.endsWith('.js')) {
          const re = new RegExp(`<script[^>]*src="[^"]*${escaped}"[^>]*></script>`);
          if (re.test(html)) {
            const code = String(item.code).replace(/<\/script/gi, '<\\/script');
            html = html.replace(re, () => `<script type="module">\n${code}\n</script>`);
            delete bundle[key];
          }
        } else if (item.type === 'asset' && key.endsWith('.css')) {
          const re = new RegExp(`<link[^>]*href="[^"]*${escaped}"[^>]*>`);
          if (re.test(html)) {
            const css = typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source);
            html = html.replace(re, () => `<style>\n${css}\n</style>`);
            delete bundle[key];
          }
        }
      }
      // 清理已无意义的 modulepreload 链接
      html = html.replace(/<link rel="modulepreload"[^>]*>/g, '');
      htmlAsset.source = html;
    },
    closeBundle() {
      // 额外复制一份到项目根目录，方便直接双击
      const built = path.resolve(ROOT_DIR, 'dist', 'index.html');
      if (fs.existsSync(built)) {
        fs.copyFileSync(built, path.resolve(ROOT_DIR, outName));
      }
    },
  };
}

export default defineConfig(({mode}) => {
  const single = mode === 'single';
  return {
    // 相对路径，保证 dist/ 与单文件产物在 file:// 下都能工作
    base: './',
    plugins: [
      react(),
      tailwindcss(),
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(ROOT_DIR, 'dist');
          const srcAssets = path.resolve(ROOT_DIR, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
        },
      },
      ...(single ? [singleFileRelease('Blackwood_Ember.html')] : []),
    ],
    resolve: {
      alias: {
        '@': path.resolve(ROOT_DIR, '.'),
      },
    },
    build: single
      ? {
          modulePreload: false,
          cssCodeSplit: false,
          assetsInlineLimit: 100_000_000,
          chunkSizeWarningLimit: 100_000,
        }
      : {},
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
