// Tier 1 无头冒烟门禁：零 pageerror / 零 console.error / 零 404 / 零外链 / 主闭环 + Canvas2D 回退
// 运行方式：node tools/checks/smoke-check.mjs

import { ensureDevServer, launchBrowser, waitForGameReady } from './_browser.mjs';

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

/**
 * 判断请求 URL 是否为允许的离线本地来源
 */
function isAllowedRequestUrl(rawUrl) {
  if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) return true;
  try {
    const u = new URL(rawUrl);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  } catch {
    return false;
  }
}

/**
 * 在页面上挂载网络/控制台/异常监听器，返回错误收集器
 */
function attachWatchers(page) {
  const issues = {
    pageErrors: [],
    consoleErrors: [],
    httpErrors: [],
    externalRequests: [],
  };

  page.on('pageerror', (err) => {
    issues.pageErrors.push(String(err));
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      issues.consoleErrors.push(msg.text());
    }
  });
  page.on('response', (res) => {
    if (res.status() >= 400) {
      issues.httpErrors.push(`${res.status()} ${res.url()}`);
    }
  });
  page.on('request', (req) => {
    const url = req.url();
    if (!isAllowedRequestUrl(url)) {
      issues.externalRequests.push(url);
    }
  });

  return issues;
}

function assertNoIssues(label, issues) {
  assert(
    issues.pageErrors.length === 0,
    `[${label}] 捕获到 pageerror (${issues.pageErrors.length}): ${issues.pageErrors.join(' | ')}`
  );
  assert(
    issues.consoleErrors.length === 0,
    `[${label}] 捕获到 console.error (${issues.consoleErrors.length}): ${issues.consoleErrors.join(' | ')}`
  );
  assert(
    issues.httpErrors.length === 0,
    `[${label}] 捕获到 HTTP >= 400 (${issues.httpErrors.length}): ${issues.httpErrors.join(' | ')}`
  );
  assert(
    issues.externalRequests.length === 0,
    `[${label}] 捕获到外部域名请求 (${issues.externalRequests.length}): ${issues.externalRequests.join(' | ')}`
  );
}

async function main() {
  const server = await ensureDevServer();
  const browser = await launchBrowser();

  try {
    // 1. 默认 WebGL2 主流程闭环
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    const issues = attachWatchers(page);

    await page.goto(`${server.url}/`, { waitUntil: 'networkidle' });
    await waitForGameReady(page);

    const titleStats = await page.evaluate(() => window.__game.stats());
    assert(titleStats.mode === 'title', `初始状态应为 title，实际为 ${titleStats.mode}`);

    // 开局
    await page.evaluate(() => window.__game.ui().go());
    await page.waitForTimeout(150);
    const playStats = await page.evaluate(() => window.__game.stats());
    assert(playStats.mode === 'play', `开局后应为 play，实际为 ${playStats.mode}`);

    // 模拟 3 秒
    const simStats = await page.evaluate(() => window.__game.sim(3));
    assert(
      Number.isFinite(simStats.x) && Number.isFinite(simStats.y) && Number.isFinite(simStats.hp),
      `sim(3) 返回异常数值: ${JSON.stringify(simStats)}`
    );

    // 打开暂停 -> hold
    await page.evaluate(() => window.__game.ui().menu(true));
    await page.waitForTimeout(120);
    const holdCheck = await page.evaluate(() => ({
      mode: window.__game.stats().mode,
      open: window.__game.ui().open,
      top: window.__game.ui().layerTop(),
    }));
    assert(
      holdCheck.mode === 'hold' && holdCheck.open && holdCheck.top === 'pause',
      `打开暂停后状态异常: ${JSON.stringify(holdCheck)}`
    );

    // 关闭暂停 -> 恢复 play
    await page.evaluate(() => window.__game.ui().menu(false));
    await page.waitForTimeout(120);
    const resumeCheck = await page.evaluate(() => ({
      mode: window.__game.stats().mode,
      open: window.__game.ui().open,
    }));
    assert(
      resumeCheck.mode === 'play' && !resumeCheck.open,
      `关闭暂停后未恢复 play: ${JSON.stringify(resumeCheck)}`
    );

    // 重开闭环
    await page.evaluate(() => {
      window.__game.reset(19847, true);
      window.__game.sim(1);
    });
    const resetStats = await page.evaluate(() => window.__game.stats());
    assert(resetStats.mode === 'play', `reset 后应为 play，实际为 ${resetStats.mode}`);

    // 验证 view() 与 capture() 契约可用
    const capCheck = await page.evaluate(async () => {
      window.__game.view(0, 120);
      const cap = await window.__game.capture();
      window.__game.view(null, null);
      return { w: cap.w, h: cap.h, len: cap.data.length };
    });
    assert(
      capCheck.w > 0 && capCheck.h > 0 && capCheck.len === capCheck.w * capCheck.h * 4,
      `capture() 返回尺寸异常: ${JSON.stringify(capCheck)}`
    );

    assertNoIssues('default', issues);
    console.log(
      `✓ 主流程闭环通过 (backend=${resetStats.backend}, drawCalls=${resetStats.drawCalls}, capture=${capCheck.w}x${capCheck.h})`
    );
    await ctx.close();

    // 2. Canvas2D 回退验证 (?v-shader=a)
    const ctx2d = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page2d = await ctx2d.newPage();
    const issues2d = attachWatchers(page2d);

    await page2d.goto(`${server.url}/?v-shader=a`, { waitUntil: 'networkidle' });
    await waitForGameReady(page2d);
    await page2d.evaluate(() => {
      window.__game.ui().go();
      window.__game.sim(1, undefined, { draw: true });
    });
    await page2d.waitForTimeout(150);

    const stats2d = await page2d.evaluate(() => window.__game.stats());
    assert(
      stats2d.backend === 'canvas2d',
      `?v-shader=a 应回退至 canvas2d，实际为 ${stats2d.backend}`
    );
    assertNoIssues('canvas2d-fallback', issues2d);
    console.log(`✓ Canvas2D 回退通过 (backend=${stats2d.backend}, 0 error, 0 404, 0 外链)`);
    await ctx2d.close();
  } finally {
    await browser.close();
    await server.stop();
  }
}

main().catch((err) => {
  console.error(`✗ smoke-check 失败: ${err.message || err}`);
  process.exit(1);
});
