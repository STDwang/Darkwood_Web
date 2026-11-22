// Tier 1 全端布局与触控审计门禁
// 遍历 baseline.json 全部 4 个视口，在标题页与开局游玩页分别检查 5 项硬指标
// 运行方式：node tools/checks/layout-check.mjs

import { ensureDevServer, launchBrowser, loadBaseline, waitForGameReady } from './_browser.mjs';

/**
 * 在页面内执行完整布局审计，返回违规明细列表
 */
async function auditCurrentView(page, { mobile, minTouchPx }) {
  return page.evaluate(
    ({ isMobile, minTouch }) => {
      const violations = [];
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const isVisible = (el) => {
        if (!el || !(el instanceof Element)) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (parseFloat(style.opacity) < 0.05) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return false;
        // 向上检查祖先是否隐藏
        let cur = el.parentElement;
        while (cur) {
          const ps = getComputedStyle(cur);
          if (ps.display === 'none' || ps.visibility === 'hidden' || parseFloat(ps.opacity) < 0.05) {
            return false;
          }
          cur = cur.parentElement;
        }
        return true;
      };

      const describeEl = (el) => {
        const tag = el.tagName.toLowerCase();
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 28);
        const aria = el.getAttribute('aria-label') || '';
        return `${tag}${aria ? `[aria="${aria}"]` : ''}${text ? `("${text}")` : ''}`;
      };

      // 1. 零 position: sticky
      const allEls = document.querySelectorAll('*');
      for (const el of allEls) {
        if (!isVisible(el)) continue;
        if (getComputedStyle(el).position === 'sticky') {
          violations.push(`发现禁止的 position: sticky -> ${describeEl(el)}`);
        }
      }

      // 2. 不得横向溢出
      if (document.documentElement.scrollWidth > vw + 1) {
        violations.push(
          `页面横向溢出: scrollWidth=${document.documentElement.scrollWidth} > innerWidth=${vw}`
        );
      }

      // 3. 可见按钮检查：视口内、不被 overflow:hidden 裁切、移动端短边 >= 44px、中心点 elementFromPoint 命中
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
      let checkedButtons = 0;
      for (const btn of buttons) {
        if (!isVisible(btn)) continue;
        checkedButtons++;
        const rect = btn.getBoundingClientRect();
        const label = describeEl(btn);

        if (isMobile) {
          const shortSide = Math.min(rect.width, rect.height);
          if (shortSide < minTouch - 0.2) {
            violations.push(
              `移动端按钮短边不足 ${minTouch}px: ${label} (${rect.width.toFixed(1)}x${rect.height.toFixed(1)})`
            );
          }
        }

        if (rect.left < -1 || rect.top < -1 || rect.right > vw + 1 || rect.bottom > vh + 1) {
          violations.push(
            `按钮越出视口 [${vw}x${vh}]: ${label} rect=(${rect.left.toFixed(1)},${rect.top.toFixed(1)},${rect.right.toFixed(1)},${rect.bottom.toFixed(1)})`
          );
        }

        // 检查是否被祖先 overflow:hidden 裁切
        let p = btn.parentElement;
        while (p && p !== document.body) {
          const ps = getComputedStyle(p);
          const clipX = ps.overflowX === 'hidden' || ps.overflowX === 'clip';
          const clipY = ps.overflowY === 'hidden' || ps.overflowY === 'clip';
          if (clipX || clipY) {
            const pr = p.getBoundingClientRect();
            if (
              (clipX && (rect.left < pr.left - 1.5 || rect.right > pr.right + 1.5)) ||
              (clipY && (rect.top < pr.top - 1.5 || rect.bottom > pr.bottom + 1.5))
            ) {
              violations.push(`按钮被 overflow:hidden 裁切: ${label}`);
              break;
            }
          }
          p = p.parentElement;
        }

        // 中心点命中检查
        const cx = rect.left + rect.width * 0.5;
        const cy = rect.top + rect.height * 0.5;
        if (cx >= 0 && cx <= vw && cy >= 0 && cy <= vh) {
          const hit = document.elementFromPoint(cx, cy);
          if (!hit || (hit !== btn && !btn.contains(hit))) {
            violations.push(
              `按钮中心点 (${cx.toFixed(0)},${cy.toFixed(0)}) 被遮挡: ${label} -> 命中 ${hit ? describeEl(hit) : 'null'}`
            );
          }
        }
      }

      // 4. 所有可见叶节点文字框：视口内、不被 overflow:hidden 裁切、两两不实质重叠 (>12%)
      const textBoxes = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = (node.nodeValue || '').trim();
        if (!text) continue;
        const parent = node.parentElement;
        if (!parent || !isVisible(parent)) continue;
        if (parent.closest('svg')) continue;

        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        if (rect.width < 1.5 || rect.height < 1.5) continue;

        const snippet = text.replace(/\s+/g, ' ').slice(0, 24);
        if (rect.left < -1 || rect.top < -1 || rect.right > vw + 1 || rect.bottom > vh + 1) {
          violations.push(
            `文字越出视口 [${vw}x${vh}]: "${snippet}" rect=(${rect.left.toFixed(1)},${rect.top.toFixed(1)},${rect.right.toFixed(1)},${rect.bottom.toFixed(1)})`
          );
        }

        // 检查是否被祖先 overflow:hidden 裁切（同时检查自身 scrollWidth > clientWidth）
        const selfStyle = getComputedStyle(parent);
        if (
          (selfStyle.overflowX === 'hidden' || selfStyle.overflowX === 'clip') &&
          parent.scrollWidth > parent.clientWidth + 1.5
        ) {
          violations.push(
            `文字被自身 overflow:hidden 横向裁切: "${snippet}" (scrollW=${parent.scrollWidth} > clientW=${parent.clientWidth})`
          );
        } else {
          let anc = parent.parentElement;
          while (anc && anc !== document.body) {
            const as = getComputedStyle(anc);
            const clipX = as.overflowX === 'hidden' || as.overflowX === 'clip';
            const clipY = as.overflowY === 'hidden' || as.overflowY === 'clip';
            if (clipX || clipY) {
              const ar = anc.getBoundingClientRect();
              if (
                (clipX && (rect.left < ar.left - 1.5 || rect.right > ar.right + 1.5)) ||
                (clipY && (rect.top < ar.top - 1.5 || rect.bottom > ar.bottom + 1.5))
              ) {
                violations.push(`文字被容器 overflow:hidden 裁切: "${snippet}"`);
                break;
              }
            }
            anc = anc.parentElement;
          }
        }

        textBoxes.push({
          text: snippet,
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          area: rect.width * rect.height,
        });
      }

      // 两两检测文字重叠（交集面积 > 较小面积的 12%）
      for (let i = 0; i < textBoxes.length; i++) {
        const a = textBoxes[i];
        for (let j = i + 1; j < textBoxes.length; j++) {
          const b = textBoxes[j];
          const iw = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const ih = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (iw <= 0 || ih <= 0) continue;
          const inter = iw * ih;
          const minArea = Math.min(a.area, b.area);
          if (minArea > 0 && inter / minArea > 0.12) {
            violations.push(
              `文字重叠 (${((inter / minArea) * 100).toFixed(0)}%): "${a.text}" 与 "${b.text}"`
            );
          }
        }
      }

      return { checkedButtons, checkedTexts: textBoxes.length, violations };
    },
    { isMobile: mobile, minTouch: minTouchPx }
  );
}

async function main() {
  const baseline = loadBaseline();
  const minTouchPx = baseline.layout.minTouchPx;
  const viewports = baseline.layout.viewports;

  const server = await ensureDevServer();
  const browser = await launchBrowser();
  const allFailures = [];

  try {
    for (const vp of viewports) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        hasTouch: vp.mobile,
        isMobile: vp.mobile,
      });
      const page = await ctx.newPage();

      await page.goto(`${server.url}/`, { waitUntil: 'networkidle' });
      await waitForGameReady(page);
      // 等待 #veil 淡出过渡结束
      await page.waitForTimeout(750);

      // 1. 审计标题页
      const titleRes = await auditCurrentView(page, { mobile: vp.mobile, minTouchPx });
      if (titleRes.violations.length > 0) {
        for (const v of titleRes.violations) {
          allFailures.push(`[${vp.name} ${vp.width}x${vp.height} | title] ${v}`);
        }
      } else {
        console.log(
          `✓ [${vp.name} ${vp.width}x${vp.height} | title] 通过 (buttons=${titleRes.checkedButtons}, texts=${titleRes.checkedTexts})`
        );
      }

      // 2. 切入开局游玩页并审计
      await page.evaluate(() => window.__game.ui().go());
      await page.waitForTimeout(300);
      const playRes = await auditCurrentView(page, { mobile: vp.mobile, minTouchPx });
      if (playRes.violations.length > 0) {
        for (const v of playRes.violations) {
          allFailures.push(`[${vp.name} ${vp.width}x${vp.height} | play] ${v}`);
        }
      } else {
        console.log(
          `✓ [${vp.name} ${vp.width}x${vp.height} | play] 通过 (buttons=${playRes.checkedButtons}, texts=${playRes.checkedTexts})`
        );
      }

      await ctx.close();
    }
  } finally {
    await browser.close();
    await server.stop();
  }

  if (allFailures.length > 0) {
    console.error(`\n✗ layout-check 发现 ${allFailures.length} 项布局/触控违规:`);
    for (const f of allFailures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }

  console.log(`\n✓ layout-check 全部 ${viewports.length} 个视口 × 2 状态通过`);
}

main().catch((err) => {
  console.error(`✗ layout-check 异常: ${err.message || err}`);
  process.exit(1);
});
