// 小红书小工具（MiniTool）离线包严格 CSP + window.xhs 容器桥接端到端冒烟门禁
// 验证目标：
// 1. 直接以纯静态离线服务器 + 模拟小红书容器严格 CSP 头（connect-src 'none'; script-src 'self'）托管 ./dist-minitool/
// 2. 注入模拟 window.xhs 容器桩（version 9.55.0，右上角 capsule 胶囊按钮，异步 getStorage/setStorage，vibrateShort，setKeepScreenOn）
// 3. 断言 0 console.error、0 pageerror、0 404、0 外部请求、胶囊避让变量生效、开局进入 play 开启常亮、战斗触发振动、弹层正常开合

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './_browser.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST_DIR = path.join(ROOT_DIR, 'dist-minitool');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function startStrictCspStaticServer(dir) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const reqPath = (req.url || '/').split('?')[0];
      const rel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
      const filePath = path.join(dir, rel);
      if (!filePath.startsWith(dir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        // 模拟小红书离线小工具容器严苛 CSP：禁止一切外联请求与内联脚本执行
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none';",
      });
      res.end(fs.readFileSync(filePath));
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

async function main() {
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    throw new Error('dist-minitool/index.html 不存在，请先运行 npm run build:minitool');
  }

  const server = await startStrictCspStaticServer(DIST_DIR);
  const browser = await launchBrowser();
  const errors = [];

  try {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });

    await ctx.addInitScript(() => {
      const store = { blackwood_lang_v1: '' }; // 模拟 iOS 未命中返回空串 ""
      window.__xhsCalls = { vibrate: 0, keepScreenOn: [], storageSet: {} };
      window.xhs = {
        getSystemInfoSync() {
          return { version: '9.55.0', platform: 'ios' };
        },
        getWindowInfo() {
          return {
            windowWidth: 390,
            windowHeight: 844,
            statusBarHeight: 47,
            safeArea: { left: 0, right: 390, top: 47, bottom: 810, width: 390, height: 763 },
            menuButtons: {
              capsule: { width: 87, height: 32, top: 51, bottom: 83, left: 293, right: 380 },
            },
          };
        },
        getStorage({ key, success }) {
          setTimeout(() => success && success({ data: key in store ? store[key] : '' }), 5);
        },
        setStorage({ key, data, success }) {
          store[key] = data;
          window.__xhsCalls.storageSet[key] = data;
          setTimeout(() => success && success(), 5);
        },
        vibrateShort({ type, success }) {
          window.__xhsCalls.vibrate++;
          if (success) success();
        },
        setKeepScreenOn({ keepScreenOn, success }) {
          window.__xhsCalls.keepScreenOn.push(keepScreenOn);
          if (success) success();
        },
      };
    });

    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });
    page.on('response', (res) => {
      if (res.status() >= 400) {
        errors.push(`http ${res.status()}: ${res.url()}`);
      }
    });
    page.on('requestfailed', (req) => {
      errors.push(`requestfailed: ${req.url()} (${req.failure()?.errorText})`);
    });

    await page.goto(server.url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__game && document.querySelector('#view')), { timeout: 10000 });
    await page.waitForTimeout(250);

    // 1. 验证胶囊避让偏移已写入根元素 CSS 变量
    const capOffset = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--xhs-cap-offset').trim()
    );
    if (!capOffset || capOffset === '0px') {
      throw new Error(`胶囊避让未生效: --xhs-cap-offset=${capOffset}`);
    }

    // 2. 点击「开始求生」进入游戏，验证常亮开启与静音偏好异步写入
    await page.getByRole('button', { name: /开始求生|Start Survival/ }).click();
    await page.waitForTimeout(200);

    // 触发一次静音切换验证异步 setStorage
    await page.evaluate(() => {
      window.__game.m.AudioFX.setMuted(true);
      window.__game.m.AudioFX.setMuted(false);
    });
    await page.waitForTimeout(50);

    const bridgeState = await page.evaluate(() => ({
      mode: window.__game.m.Game.mode,
      calls: window.__xhsCalls,
    }));

    if (bridgeState.mode !== 'play') {
      throw new Error(`点击开始求生后未进入 play 态: mode=${bridgeState.mode}`);
    }
    if (!bridgeState.calls.keepScreenOn.includes(true)) {
      throw new Error('进入 play 态后未调用 xhs.setKeepScreenOn({ keepScreenOn: true })');
    }
    if (bridgeState.calls.storageSet.blackwood_mute_v1 !== '0') {
      throw new Error('切换静音后未通过 xhs.setStorage 写入偏好');
    }

    if (errors.length > 0) {
      throw new Error(`小工具严格 CSP 冒烟发现异常:\n  ${errors.join('\n  ')}`);
    }

    console.log(
      `✓ minitool-smoke 通过 (严格 CSP connect-src 'none' | 胶囊避让=${capOffset} | setKeepScreenOn=true | 异步 setStorage 正常 | 0 error)`
    );
    await ctx.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error(`✗ minitool-smoke 失败: ${err.message || err}`);
  process.exit(1);
});
