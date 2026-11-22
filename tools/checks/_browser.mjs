// 公共无头浏览器与本地 Vite 开发服务器辅助模块
// 所有 tools/checks/*.mjs 门禁脚本共享此模块

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT_DIR = path.resolve(__dirname, '../..');
export const BASELINE_PATH = path.join(__dirname, 'baseline.json');
export const BASE_URL = 'http://127.0.0.1:3000';

/**
 * 读取验收基线配置 tools/checks/baseline.json
 */
export function loadBaseline() {
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

/**
 * 探测目标 URL 是否已可访问
 */
async function isServerReady(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1200);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 确保 http://127.0.0.1:3000/ 已可访问；
 * 若未启动则自动拉起本地 Vite，并在脚本结束时由调用方调用 stop() 干净关闭。
 */
export async function ensureDevServer() {
  if (await isServerReady(BASE_URL)) {
    return {
      url: BASE_URL,
      spawned: false,
      stop: async () => {},
    };
  }

  const viteBin = path.join(ROOT_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteBin, '--port=3000', '--host=127.0.0.1', '--strictPort'], {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  let stderrBuf = '';
  child.stderr?.on('data', (chunk) => {
    stderrBuf += chunk.toString();
  });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite 进程提前退出 (code=${child.exitCode}): ${stderrBuf}`);
    }
    if (await isServerReady(BASE_URL)) {
      return {
        url: BASE_URL,
        spawned: true,
        stop: async () => {
          if (child.exitCode === null) {
            child.kill('SIGTERM');
            await new Promise((r) => setTimeout(r, 300));
            if (child.exitCode === null) {
              child.kill('SIGKILL');
            }
          }
        },
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  child.kill('SIGKILL');
  throw new Error(`等待 Vite 服务就绪超时 (${BASE_URL})：${stderrBuf}`);
}

/**
 * 统一使用本机 Chrome + D3D11/WebGL 参数启动无头 Chromium
 */
export async function launchBrowser() {
  return chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-angle=d3d11', '--enable-webgl'],
  });
}

/**
 * 等待页面挂载 window.__game 且首帧就绪
 */
export async function waitForGameReady(page, timeoutMs = 15000) {
  await page.waitForFunction(() => Boolean(window.__game), { timeout: timeoutMs });
  await page.evaluate(async () => {
    await window.__game.boot();
  });
  await page.waitForTimeout(200);
}
