// Tier 2 性能预算门禁（1x / 2x CPU 降速 1200 帧无绘制仿真 + 正常帧 drawCalls 校验）
// 运行方式：node tools/checks/perf-check.mjs

import { ensureDevServer, launchBrowser, loadBaseline, waitForGameReady } from './_browser.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * 在页面内运行 1200 帧无绘制仿真并返回 p50 / p95 / max / 超 16.7ms 帧数
 */
async function runSimBenchmark(page, frames = 1200) {
  return page.evaluate((count) => {
    const g = window.__game;
    g.reset(19847, true);
    g.noDraw(true);
    const pilot = g.pilot();
    const eng = g.m.Game;

    // 预热 60 帧触发 JIT 优化
    for (let i = 0; i < 60; i++) {
      eng.step(1 / 60, 1280, 720, pilot(eng.simTime));
    }

    const times = new Float64Array(count);
    let overBudget = 0;

    for (let i = 0; i < count; i++) {
      const t0 = performance.now();
      const inp = pilot(eng.simTime);
      eng.step(1 / 60, 1280, 720, inp);
      const dtMs = performance.now() - t0;
      times[i] = dtMs;
      if (dtMs > 16.7) overBudget++;
      if (eng.mode === 'dead') {
        g.reset(19847 + i, true);
      }
    }

    const sorted = Array.from(times).sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const max = sorted[sorted.length - 1];
    return { frames: count, p50, p95, max, overBudget };
  }, frames);
}

async function main() {
  const baseline = loadBaseline();
  const perfSpec = baseline.perf;

  const server = await ensureDevServer();
  const browser = await launchBrowser();

  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();

    // 使用 ?manual 避免额外 rAF 干扰单帧耗时统计
    await page.goto(`${server.url}/?manual`, { waitUntil: 'networkidle' });
    await waitForGameReady(page);

    // 1. 1x 原速 1200 帧 JS 仿真压测
    const r1x = await runSimBenchmark(page, 1200);
    console.log(
      `[1x CPU] 1200 帧 | p50=${r1x.p50.toFixed(3)}ms | p95=${r1x.p95.toFixed(3)}ms (<= ${perfSpec.js1xP95MaxMs}ms) | max=${r1x.max.toFixed(2)}ms | >16.7ms=${r1x.overBudget} (<= ${perfSpec.overBudgetFramesMax})`
    );
    assert(
      r1x.p95 <= perfSpec.js1xP95MaxMs,
      `1x CPU p95=${r1x.p95.toFixed(3)}ms 超出预算 ${perfSpec.js1xP95MaxMs}ms`
    );
    assert(
      r1x.overBudget <= perfSpec.overBudgetFramesMax,
      `1x CPU 超 16.7ms 帧数=${r1x.overBudget} 超出上限 ${perfSpec.overBudgetFramesMax}`
    );

    // 2. 2x CPU 降速 1200 帧 JS 仿真压测
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 2 });
    const r2x = await runSimBenchmark(page, 1200);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

    console.log(
      `[2x CPU] 1200 帧 | p50=${r2x.p50.toFixed(3)}ms | p95=${r2x.p95.toFixed(3)}ms (<= ${perfSpec.js2xP95MaxMs}ms) | max=${r2x.max.toFixed(2)}ms | >16.7ms=${r2x.overBudget} (<= ${perfSpec.overBudgetFramesMax})`
    );
    assert(
      r2x.p95 <= perfSpec.js2xP95MaxMs,
      `2x CPU p95=${r2x.p95.toFixed(3)}ms 超出预算 ${perfSpec.js2xP95MaxMs}ms`
    );
    assert(
      r2x.overBudget <= perfSpec.overBudgetFramesMax,
      `2x CPU 超 16.7ms 帧数=${r2x.overBudget} 超出上限 ${perfSpec.overBudgetFramesMax}`
    );

    // 3. 恢复绘制，检查正常渲染帧 drawCalls
    const drawStats = await page.evaluate(() => {
      const g = window.__game;
      g.noDraw(false);
      g.reset(19847, true);
      for (let i = 0; i < 10; i++) {
        g.frame(1 / 60);
      }
      return g.stats();
    });

    console.log(
      `[Render] backend=${drawStats.backend} | drawCalls=${drawStats.drawCalls} (<= ${perfSpec.drawCallsMax})`
    );
    assert(
      drawStats.drawCalls <= perfSpec.drawCallsMax,
      `正常帧 drawCalls=${drawStats.drawCalls} 超出预算 ${perfSpec.drawCallsMax}`
    );

    console.log('✓ perf-check 全部性能预算指标通过');
    await ctx.close();
  } finally {
    await browser.close();
    await server.stop();
  }
}

main().catch((err) => {
  console.error(`✗ perf-check 失败: ${err.message || err}`);
  process.exit(1);
});
