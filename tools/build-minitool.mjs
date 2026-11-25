// 小红书小工具（MiniTool）离线静态包构建、Chrome 61 / ES2017 语法降级、合规自检与标准 ZIP 打包脚本
// 产出：
//   - ./dist-minitool/       （仅含顶层 index.html, style.css, app.js）
//   - ./Blackwood_Ember_minitool.zip （顶层直含 index.html，POSIX 正斜杠路径）

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import esbuild from 'esbuild';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT_DIR, 'dist-minitool');
const ZIP_PATH = path.join(ROOT_DIR, 'Blackwood_Ember_minitool.zip');

/**
 * 递归查找目录下指定后缀的文件
 */
function findFilesByExt(dir, ext) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...findFilesByExt(full, ext));
    else if (ent.name.toLowerCase().endsWith(ext)) out.push(full);
  }
  return out;
}

/**
 * 解包 CSS 中的 @layer 块并降级 Tailwind v4 的 @property / @supports 初始化与 inset 简写，兼容 Chrome 61
 */
function downgradeCssForChrome61(rawCss) {
  let css = rawCss;

  // 1. 移除单行 @layer 顺序声明（如 @layer properties, theme, base, components, utilities;）
  css = css.replace(/@layer\s+[^{;]+;/g, '');

  // 2. 将 Tailwind v4 `@layer properties` 内包裹在苛刻 @supports 里的 `--tw-*` 默认变量提出来直接生效，避免 Chrome 61 缺少初始值导致阴影失效
  css = css.replace(/@supports\s*\(\(\(-webkit-hyphens:\s*none\)\)[\s\S]*?\)\s*\{([\s\S]*?)\n\s*\}/g, '$1');

  // 3. 移除 Chrome 61 不识别的 `@property --xxx { ... }` 规则块
  css = removeAtBlock(css, '@property');

  // 4. 逐层解包所有 `@layer <name> { ... }`（保留块内全部选择器与规则）
  css = unwrapAtBlock(css, '@layer');

  // 5. 将 `inset:` 简写展开为 Chrome 61 原生支持的 top/right/bottom/left
  css = css.replace(/(^|[;{]\s*)inset\s*:\s*([^;{}]+?)\s*(!important)?\s*(?=[;}])/gm, (_m, pre, val, imp) => {
    const bang = imp ? ' !important' : '';
    const parts = val.trim().split(/\s+/);
    let t = parts[0],
      r = parts[0],
      b = parts[0],
      l = parts[0];
    if (parts.length === 2) {
      t = b = parts[0];
      r = l = parts[1];
    } else if (parts.length === 3) {
      t = parts[0];
      r = l = parts[1];
      b = parts[2];
    } else if (parts.length >= 4) {
      t = parts[0];
      r = parts[1];
      b = parts[2];
      l = parts[3];
    }
    return `${pre}top:${t}${bang};right:${r}${bang};bottom:${b}${bang};left:${l}${bang}`;
  });

  return css;
}

function removeAtBlock(css, keyword) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const idx = css.indexOf(keyword, i);
    if (idx < 0) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, idx);
    const braceStart = css.indexOf('{', idx);
    const semi = css.indexOf(';', idx);
    if (semi >= 0 && (braceStart < 0 || semi < braceStart)) {
      i = semi + 1;
      continue;
    }
    if (braceStart < 0) break;
    let depth = 1;
    let k = braceStart + 1;
    while (k < css.length && depth > 0) {
      if (css[k] === '{') depth++;
      else if (css[k] === '}') depth--;
      k++;
    }
    i = k;
  }
  return out;
}

function unwrapAtBlock(css, keyword) {
  let cur = css;
  for (let pass = 0; pass < 4; pass++) {
    if (!cur.includes(keyword)) break;
    let out = '';
    let i = 0;
    while (i < cur.length) {
      const idx = cur.indexOf(keyword, i);
      if (idx < 0) {
        out += cur.slice(i);
        break;
      }
      out += cur.slice(i, idx);
      const braceStart = cur.indexOf('{', idx);
      const semi = cur.indexOf(';', idx);
      if (semi >= 0 && (braceStart < 0 || semi < braceStart)) {
        i = semi + 1;
        continue;
      }
      if (braceStart < 0) {
        out += cur.slice(idx);
        break;
      }
      let depth = 1;
      let k = braceStart + 1;
      while (k < cur.length && depth > 0) {
        if (cur[k] === '{') depth++;
        else if (cur[k] === '}') depth--;
        k++;
      }
      // 仅剥除外层 @layer { ... }，保留内部样式文本
      out += cur.slice(braceStart + 1, k - 1);
      i = k;
    }
    cur = out;
  }
  return cur;
}

// 标准 CRC32 表（用于生成跨平台合规 ZIP）
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 将一组 { name, data: Buffer } 打包为标准 PKZIP Buffer（POSIX 正斜杠路径，Deflate 压缩）
 */
function createZipArchive(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const ent of entries) {
    const nameBuf = Buffer.from(ent.name.replace(/\\/g, '/'), 'utf8');
    const raw = ent.data;
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const localHdr = Buffer.alloc(30);
    localHdr.writeUInt32LE(0x04034b50, 0); // Local file header signature
    localHdr.writeUInt16LE(20, 4); // Version needed to extract (2.0)
    localHdr.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHdr.writeUInt16LE(method, 8);
    localHdr.writeUInt16LE(0, 10); // Mod time
    localHdr.writeUInt16LE(0x5979, 12); // Mod date
    localHdr.writeUInt32LE(crc, 14);
    localHdr.writeUInt32LE(body.length, 18);
    localHdr.writeUInt32LE(raw.length, 22);
    localHdr.writeUInt16LE(nameBuf.length, 26);
    localHdr.writeUInt16LE(0, 28);

    localParts.push(localHdr, nameBuf, body);

    const centralHdr = Buffer.alloc(46);
    centralHdr.writeUInt32LE(0x02014b50, 0); // Central directory file header signature
    centralHdr.writeUInt16LE(20, 4);
    centralHdr.writeUInt16LE(20, 6);
    centralHdr.writeUInt16LE(0x0800, 8);
    centralHdr.writeUInt16LE(method, 10);
    centralHdr.writeUInt16LE(0, 12);
    centralHdr.writeUInt16LE(0x5979, 14);
    centralHdr.writeUInt32LE(crc, 16);
    centralHdr.writeUInt32LE(body.length, 20);
    centralHdr.writeUInt32LE(raw.length, 24);
    centralHdr.writeUInt16LE(nameBuf.length, 28);
    centralHdr.writeUInt16LE(0, 30);
    centralHdr.writeUInt16LE(0, 32);
    centralHdr.writeUInt16LE(0, 34);
    centralHdr.writeUInt16LE(0, 36);
    centralHdr.writeUInt32LE(0, 38);
    centralHdr.writeUInt32LE(offset, 42);

    centralParts.push(centralHdr, nameBuf);
    offset += localHdr.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

async function main() {
  console.log('=== [1/4] 执行 Vite minitool 基础构建 ===');
  execSync('npx vite build --mode minitool', { cwd: ROOT_DIR, stdio: 'inherit' });

  const jsFiles = findFilesByExt(OUT_DIR, '.js');
  const cssFiles = findFilesByExt(OUT_DIR, '.css');
  if (jsFiles.length === 0 || cssFiles.length === 0) {
    throw new Error(`未找到构建产物: js=${jsFiles.length}, css=${cssFiles.length}`);
  }

  console.log('=== [2/4] 使用 esbuild 降级至 Chrome 61 + ES2017 单文件 IIFE ===');
  const tempEntry = jsFiles[0];
  const appJsPath = path.join(OUT_DIR, 'app.js');
  await esbuild.build({
    entryPoints: [tempEntry],
    bundle: true,
    format: 'iife',
    target: ['es2017', 'chrome61'],
    minify: true,
    legalComments: 'none',
    define: {
      __MINITOOL__: 'true',
      'process.env.NODE_ENV': '"production"',
    },
    outfile: appJsPath,
  });

  const rawCss = cssFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const compatCss = downgradeCssForChrome61(rawCss);
  const cssResult = await esbuild.transform(compatCss, {
    loader: 'css',
    target: ['chrome61'],
    minify: true,
    legalComments: 'none',
  });
  // 追加首屏无 JS 静态骨架样式（React 挂载后 #root 子节点即被完整替换）
  const bootCss =
    '.xhs-boot{display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;min-height:100vh;background:#070807;color:#d9d1bf;text-align:center;padding:24px;box-sizing:border-box}' +
    '.xhs-boot__title{margin:0;font-size:32px;letter-spacing:0.28em;font-weight:600;color:#d9d1bf}' +
    '.xhs-boot__sub{margin:12px 0 0;font-size:11px;letter-spacing:0.45em;color:#9e9482}' +
    '.xhs-boot__desc{margin:20px 0 0;font-size:13px;line-height:1.6;color:#b8afa0;max-width:320px}';
  const styleCssPath = path.join(OUT_DIR, 'style.css');
  fs.writeFileSync(styleCssPath, cssResult.code + bootCss, 'utf8');

  // 生成纯净离线 index.html（无内联脚本、无内联事件、无 type="module"、无外链 URL、含静态首屏骨架）
  const indexHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
    <title>幽林余烬</title>
    <link rel="icon" href="data:," />
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body class="bg-[#070807] text-[#e7e2d8] antialiased overflow-hidden">
    <div id="root">
      <div class="xhs-boot">
        <h1 class="xhs-boot__title">幽林余烬</h1>
        <p class="xhs-boot__sub">BLACKWOOD EMBER</p>
        <p class="xhs-boot__desc">在黑暗吞噬庇护所前，搜集一切能活下去的东西。</p>
      </div>
    </div>
    <script defer src="./app.js"></script>
  </body>
</html>
`;
  const indexHtmlPath = path.join(OUT_DIR, 'index.html');
  fs.writeFileSync(indexHtmlPath, indexHtml, 'utf8');

  // 清理多余构建中间目录与文件，确保只保留顶层纯净三件套
  for (const ent of fs.readdirSync(OUT_DIR)) {
    if (ent !== 'index.html' && ent !== 'style.css' && ent !== 'app.js') {
      fs.rmSync(path.join(OUT_DIR, ent), { recursive: true, force: true });
    }
  }

  console.log('=== [3/4] 静态合规红线扫描 ===');
  // 净化 React 运行时内置的错误帮助外链文本（如 https://react.dev/errors/），避免任何外链 URL 字面量残留
  let jsCode = fs.readFileSync(appJsPath, 'utf8');
  jsCode = jsCode
    .replace(/https?:\/\/react\.dev\/errors\//g, 'react-error:')
    .replace(/https?:\/\/reactjs\.org\/docs\/error-decoder\.html\?invariant=/g, 'react-error:');
  fs.writeFileSync(appJsPath, jsCode, 'utf8');

  const cssCode = fs.readFileSync(styleCssPath, 'utf8');
  const htmlCode = fs.readFileSync(indexHtmlPath, 'utf8');

  const forbiddenJs = [
    { name: 'localStorage', re: /\blocalStorage\b/ },
    { name: 'sessionStorage', re: /\bsessionStorage\b/ },
    { name: 'indexedDB', re: /\bindexedDB\b/ },
    { name: 'document.cookie', re: /document\.cookie\b/ },
    { name: 'fetch()', re: /\bfetch\s*\(/ },
    { name: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
    { name: 'WebSocket', re: /\bWebSocket\b/ },
    { name: 'eval()', re: /\beval\s*\(/ },
    { name: 'new Function()', re: /new\s+Function\s*\(/ },
    { name: 'window.open()', re: /window\.open\s*\(/ },
    { name: 'requestFullscreen', re: /\brequestFullscreen\b/ },
    { name: 'navigator.geolocation', re: /navigator\.geolocation\b/ },
  ];

  const violations = [];
  for (const rule of forbiddenJs) {
    if (rule.re.test(jsCode)) violations.push(`app.js 命中违禁标识符: ${rule.name}`);
  }
  if (/https?:\/\//i.test(htmlCode)) {
    violations.push('index.html 含外部 http(s):// 链接');
  }
  // 检查除标准 W3C XML/SVG/MathML/XHTML 命名空间常量外的任何 http(s)://
  const jsWithoutW3cNs = jsCode.replace(
    /http:\/\/www\.w3\.org\/(2000\/svg|1998\/Math\/MathML|1999\/xhtml|1999\/xlink|XML\/1998\/namespace)/g,
    ''
  );
  const leftoverUrls = [...new Set(jsWithoutW3cNs.match(/https?:\/\/[^\s"'`)]+/g) || [])];
  if (leftoverUrls.length > 0) {
    violations.push(`app.js 含非 W3C 命名空间的 URL: ${leftoverUrls.join(', ')}`);
  }
  if (cssCode.includes('@layer') || cssCode.includes('@property')) {
    violations.push('style.css 仍残留未降级的 @layer 或 @property');
  }
  if (violations.length > 0) {
    throw new Error(`静态合规扫描未通过:\n  - ${violations.join('\n  - ')}`);
  }

  console.log('=== [4/4] 生成标准顶层平铺离线包 Blackwood_Ember_minitool.zip ===');
  const entries = ['index.html', 'style.css', 'app.js'].map((name) => ({
    name,
    data: fs.readFileSync(path.join(OUT_DIR, name)),
  }));
  const zipBuf = createZipArchive(entries);
  fs.writeFileSync(ZIP_PATH, zipBuf);

  const rawTotalKb = (entries.reduce((s, e) => s + e.data.length, 0) / 1024).toFixed(1);
  const zipKb = (zipBuf.length / 1024).toFixed(1);
  console.log(`✓ 构建完成: dist-minitool (${rawTotalKb} KiB) -> Blackwood_Ember_minitool.zip (${zipKb} KiB)`);
}

main().catch((err) => {
  console.error('✗ build:minitool 失败:', err);
  process.exit(1);
});
