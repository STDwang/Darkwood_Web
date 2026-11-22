// Tier 1 弹层返回栈与 4 路退出闭环门禁
// 验证标题页 settings 与游玩页 pause/craft/journal/settings 的 4 种退出路径（按钮/遮罩/Esc/history.back）
// 运行方式：node tools/checks/layer-check.mjs

import { ensureDevServer, launchBrowser, waitForGameReady } from './_browser.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const EXIT_PATHS = ['closeBtn', 'scrim', 'esc', 'historyBack'];

/**
 * 执行指定退出路径关闭最顶层弹层
 */
async function triggerExit(page, method) {
  if (method === 'closeBtn') {
    await page.locator('button[aria-label="关闭"]').click();
  } else if (method === 'scrim') {
    // 点击遮罩左上角安全空白处（面板居中，(12, 12) 必在遮罩上）
    await page.mouse.click(12, 12);
  } else if (method === 'esc') {
    await page.keyboard.press('Escape');
  } else if (method === 'historyBack') {
    await page.evaluate(() => window.history.back());
  }
  await page.waitForTimeout(160);
}

async function getUiSnapshot(page) {
  return page.evaluate(() => ({
    mode: window.__game.stats().mode,
    open: window.__game.ui().open,
    top: window.__game.ui().layerTop(),
  }));
}

async function main() {
  const server = await ensureDevServer();
  const browser = await launchBrowser();

  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();

    await page.goto(`${server.url}/`, { waitUntil: 'networkidle' });
    await waitForGameReady(page);
    await page.waitForTimeout(700);

    // 1. 标题页 settings 弹层 4 路退出验证（绝不误触开局）
    for (const method of EXIT_PATHS) {
      await page.getByRole('button', { name: '设置' }).click();
      await page.waitForTimeout(140);

      let snap = await getUiSnapshot(page);
      assert(
        snap.open && snap.top === 'settings' && snap.mode === 'title',
        `[title:settings:${method}] 打开失败: ${JSON.stringify(snap)}`
      );

      await triggerExit(page, method);
      snap = await getUiSnapshot(page);
      assert(
        !snap.open && snap.top === null && snap.mode === 'title',
        `[title:settings:${method}] 关闭后状态异常（疑似误触开局或未关闭）: ${JSON.stringify(snap)}`
      );
    }
    console.log('✓ 标题页 settings 弹层 4 路退出通过（全程保持 title）');

    // 2. 进入游玩态
    await page.evaluate(() => window.__game.ui().go());
    await page.waitForTimeout(180);
    let playSnap = await getUiSnapshot(page);
    assert(playSnap.mode === 'play', `开局失败，当前 mode=${playSnap.mode}`);

    // 3. 游玩页 pause / craft / journal 弹层 4 路退出验证
    const playDirectLayers = [
      { id: 'pause', open: async () => page.locator('button[aria-label="暂停"]').click() },
      { id: 'craft', open: async () => page.keyboard.press('KeyC') },
      { id: 'journal', open: async () => page.keyboard.press('KeyJ') },
    ];

    for (const layer of playDirectLayers) {
      for (const method of EXIT_PATHS) {
        await layer.open();
        await page.waitForTimeout(140);

        let snap = await getUiSnapshot(page);
        assert(
          snap.open && snap.top === layer.id && snap.mode === 'hold',
          `[play:${layer.id}:${method}] 打开后未进入 hold: ${JSON.stringify(snap)}`
        );

        await triggerExit(page, method);
        snap = await getUiSnapshot(page);
        assert(
          !snap.open && snap.top === null && snap.mode === 'play',
          `[play:${layer.id}:${method}] 关闭后未恢复 play: ${JSON.stringify(snap)}`
        );
      }
      console.log(`✓ 游玩页 ${layer.id} 弹层 4 路退出通过（hold ⇄ play）`);
    }

    // 4. 游玩页嵌套弹层 pause -> settings 4 路退出验证
    for (const method of EXIT_PATHS) {
      await page.locator('button[aria-label="暂停"]').click();
      await page.waitForTimeout(140);
      await page.getByRole('button', { name: '设置' }).click();
      await page.waitForTimeout(140);

      let snap = await getUiSnapshot(page);
      assert(
        snap.open && snap.top === 'settings' && snap.mode === 'hold',
        `[play:settings:${method}] 打开嵌套 settings 失败: ${JSON.stringify(snap)}`
      );

      // 第一次退出：关闭 settings，退回 pause，仍保持 hold
      await triggerExit(page, method);
      snap = await getUiSnapshot(page);
      assert(
        snap.open && snap.top === 'pause' && snap.mode === 'hold',
        `[play:settings:${method}] 退出顶层后未回退至 pause: ${JSON.stringify(snap)}`
      );

      // 第二次退出：关闭 pause，恢复 play
      await triggerExit(page, method);
      snap = await getUiSnapshot(page);
      assert(
        !snap.open && snap.top === null && snap.mode === 'play',
        `[play:settings:${method}] 全部关闭后未恢复 play: ${JSON.stringify(snap)}`
      );
    }
    console.log('✓ 游玩页 pause -> settings 嵌套弹层 4 路退出通过（hold -> hold -> play）');

    await ctx.close();
  } finally {
    await browser.close();
    await server.stop();
  }
}

main().catch((err) => {
  console.error(`✗ layer-check 失败: ${err.message || err}`);
  process.exit(1);
});
