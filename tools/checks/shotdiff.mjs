// Tier 2 双后端冒烟与像素回归门禁（shotdiff）
// 1. 测量对照组底噪：同一默认配置同机位两次独立加载的像素差，确保渲染确定性；
// 2. 双后端冒烟校验：?v-shader=a (Canvas2D) 与 ?v-shader=b (WebGL2) 均零报错且画布非空；
// 3. 调色板 A/B 区分校验：?v-palette=a vs ?v-palette=b 存在显著视觉差异。
// 运行方式：node tools/checks/shotdiff.mjs

import { ensureDevServer, launchBrowser, waitForGameReady } from './_browser.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * 在指定 URL 参数下独立打开新上下文、推进固定帧并抓取标准机位像素与诊断信息
 */
async function captureShot(browser, url, shotCfg) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  const consoleErrors = [];

  page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    await waitForGameReady(page);

    const res = await page.evaluate(async (cfg) => {
      const g = window.__game;
      const eng = g.m.Game;

      g.reset(19847, true);
      eng.enemies.length = 0;
      eng.player.x = cfg.x;
      eng.player.y = cfg.y;
      eng.player.angle = Math.PI * 0.45;
      eng.player.battery = 100;
      eng.player.flashlightOn = cfg.flashlight;
      eng.generatorOn = true;
      eng.generatorFuel = 80;

      g.tod(cfg.phase);
      g.weather(cfg.weather);
      eng.weather.lightningFlash = 0;

      g.view(cfg.x, cfg.y);
      for (let i = 0; i < 40; i++) {
        eng.step(1 / 60, 1280, 720, {
          mx: 0,
          my: 0,
          aimAngle: Math.PI * 0.45,
          sprint: false,
          attack: false,
          interact: false,
          toggleLight: false,
        });
      }
      eng.weather.lightningFlash = 0;
      g.view(cfg.x, cfg.y);

      const frame = await g.capture();
      const stats = g.stats();
      g.view(null, null);

      // 计算平均亮度确认画布非黑屏
      const d = frame.data;
      const total = frame.w * frame.h;
      let sumL = 0;
      for (let i = 0; i < d.length; i += 4) {
        sumL += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      }

      return {
        w: frame.w,
        h: frame.h,
        data: Array.from(d),
        meanL: total > 0 ? sumL / total : 0,
        backend: stats.backend,
        drawCalls: stats.drawCalls,
      };
    }, shotCfg);

    return {
      ...res,
      pageErrors,
      consoleErrors,
    };
  } finally {
    await ctx.close();
  }
}

/**
 * 计算两帧同尺寸 RGBA 图像的平均通道差与显著变化像素占比（单通道差 > 8 视为变化）
 */
function diffFrames(a, b) {
  assert(a.w === b.w && a.h === b.h, `画布尺寸不一致: ${a.w}x${a.h} vs ${b.w}x${b.h}`);
  const da = a.data;
  const db = b.data;
  const pixels = a.w * a.h;
  let sumAbs = 0;
  let changed = 0;

  for (let i = 0; i < da.length; i += 4) {
    const dr = Math.abs(da[i] - db[i]);
    const dg = Math.abs(da[i + 1] - db[i + 1]);
    const dbv = Math.abs(da[i + 2] - db[i + 2]);
    sumAbs += (dr + dg + dbv) / 3;
    if (dr > 8 || dg > 8 || dbv > 8) {
      changed++;
    }
  }

  return {
    meanDiff: sumAbs / pixels,
    changedRatio: changed / pixels,
  };
}

async function main() {
  const server = await ensureDevServer();
  const browser = await launchBrowser();

  const SHOT_DAY = {
    phase: 'day',
    weather: 'mist',
    x: 0,
    y: 340,
    flashlight: true,
  };

  try {
    console.log('=== Tier 2 双后端冒烟与像素回归门禁 (shotdiff) ===');

    // 1. 对照组底噪：默认配置（WebGL2 + palette=b）同机位两次独立加载
    const ref1 = await captureShot(browser, `${server.url}/?manual&v-shader=b&v-palette=b`, SHOT_DAY);
    const ref2 = await captureShot(browser, `${server.url}/?manual&v-shader=b&v-palette=b`, SHOT_DAY);

    assert(ref1.pageErrors.length === 0 && ref1.consoleErrors.length === 0, `WebGL2(1) 存在报错: ${ref1.pageErrors.concat(ref1.consoleErrors).join('; ')}`);
    assert(ref2.pageErrors.length === 0 && ref2.consoleErrors.length === 0, `WebGL2(2) 存在报错: ${ref2.pageErrors.concat(ref2.consoleErrors).join('; ')}`);

    const noise = diffFrames(ref1, ref2);
    console.log(
      `✓ [对照组底噪] WebGL2 同机位重复采样 | meanDiff=${noise.meanDiff.toFixed(3)} (<= 2.0) | changed=${(noise.changedRatio * 100).toFixed(3)}% (<= 2.0%)`
    );
    assert(noise.meanDiff <= 2.0, `对照组底噪过高: meanDiff=${noise.meanDiff.toFixed(3)}`);
    assert(noise.changedRatio <= 0.02, `对照组变化像素占比过高: ${(noise.changedRatio * 100).toFixed(2)}%`);

    // 2. 双后端冒烟校验：Canvas2D (?v-shader=a) vs WebGL2 (?v-shader=b)
    const c2d = await captureShot(browser, `${server.url}/?manual&v-shader=a&v-palette=b`, SHOT_DAY);
    assert(c2d.pageErrors.length === 0 && c2d.consoleErrors.length === 0, `Canvas2D 存在报错: ${c2d.pageErrors.concat(c2d.consoleErrors).join('; ')}`);
    assert(ref1.backend === 'webgl2', `预期 WebGL2 后端，实际为 ${ref1.backend}`);
    assert(c2d.backend === 'canvas2d', `预期 Canvas2D 后端，实际为 ${c2d.backend}`);
    assert(ref1.meanL > 10, `WebGL2 画面过暗异常: L=${ref1.meanL.toFixed(2)}`);
    assert(c2d.meanL > 10, `Canvas2D 画面过暗异常: L=${c2d.meanL.toFixed(2)}`);
    console.log(
      `✓ [双后端冒烟] WebGL2 (L=${ref1.meanL.toFixed(2)}, drawCalls=${ref1.drawCalls}) & Canvas2D (L=${c2d.meanL.toFixed(2)}, drawCalls=${c2d.drawCalls}) 均零报错`
    );

    // 3. 调色板 A/B 视觉区分校验：?v-palette=a vs ?v-palette=b
    const palA = await captureShot(browser, `${server.url}/?manual&v-shader=b&v-palette=a`, SHOT_DAY);
    assert(palA.pageErrors.length === 0 && palA.consoleErrors.length === 0, `palette=a 存在报错: ${palA.pageErrors.concat(palA.consoleErrors).join('; ')}`);

    const palDiff = diffFrames(palA, ref1);
    const minChanged = Math.max(0.05, noise.changedRatio * 3);
    console.log(
      `✓ [调色板 A/B] ?v-palette=a vs ?v-palette=b | meanDiff=${palDiff.meanDiff.toFixed(3)} (> 2.0) | changed=${(palDiff.changedRatio * 100).toFixed(2)}% (> ${(minChanged * 100).toFixed(2)}%)`
    );
    assert(palDiff.meanDiff > 2.0, `调色板 A/B 差异过小: meanDiff=${palDiff.meanDiff.toFixed(3)}`);
    assert(
      palDiff.changedRatio > minChanged,
      `调色板 A/B 变化像素占比不足: ${(palDiff.changedRatio * 100).toFixed(2)}% <= ${(minChanged * 100).toFixed(2)}%`
    );

    console.log('\n✓ shotdiff 全部像素回归与双后端门禁通过');
  } finally {
    await browser.close();
    await server.stop();
  }
}

main().catch((err) => {
  console.error(`✗ shotdiff 失败: ${err.message || err}`);
  process.exit(1);
});
