// Tier 2 主美色彩与曝光校验门禁
// 截取 day_forest / dusk_forest / night_forest / night_hideout 4 个标准机位
// 统一计算 L (平均亮度), p95 (高光分位), dark (L<12 占比), colorful (色彩丰度), greenDom (绿通道主导占比)
// 用法：
//   node tools/checks/palette-check.mjs              (严格按 baseline.json 断言)
//   node tools/checks/palette-check.mjs --report-only (仅打印报告，不 exit 1)

import { ensureDevServer, launchBrowser, loadBaseline, waitForGameReady } from './_browser.mjs';

const REPORT_ONLY = process.argv.includes('--report-only');

const SHOTS = [
  {
    key: 'day_forest',
    label: '白昼林地（室外）',
    phase: 'day',
    weather: 'mist',
    x: 0,
    y: 340,
    flashlight: true,
    generator: true,
  },
  {
    key: 'dusk_forest',
    label: '黄昏林地（室外）',
    phase: 'dusk',
    weather: 'mist',
    x: 0,
    y: 340,
    flashlight: true,
    generator: true,
  },
  {
    key: 'night_forest',
    label: '黑夜林地（手电开）',
    phase: 'night',
    weather: 'mist',
    x: 0,
    y: 340,
    flashlight: true,
    generator: true,
  },
  {
    key: 'night_hideout',
    label: '黑夜庇护所（发电机开）',
    phase: 'night',
    weather: 'mist',
    x: 0,
    y: 25,
    flashlight: false,
    generator: true,
  },
];

async function captureMetrics(page, shot) {
  return page.evaluate(async (cfg) => {
    const g = window.__game;
    const eng = g.m.Game;

    // 重置为干净状态，避免随机敌怪/闪电干扰机位复现
    g.reset(19847, true);
    eng.enemies.length = 0;
    eng.player.x = cfg.x;
    eng.player.y = cfg.y;
    eng.player.angle = Math.PI * 0.45;
    eng.player.battery = 100;
    eng.player.flashlightOn = cfg.flashlight;
    eng.generatorOn = cfg.generator;
    eng.generatorFuel = 80;

    g.tod(cfg.phase);
    g.weather(cfg.weather);
    eng.weather.lightningFlash = 0;

    // 锁定检查相机并推进若干帧，使屋顶揭顶/天气参数充分收敛
    g.view(cfg.x, cfg.y);
    for (let i = 0; i < 45; i++) {
      eng.step(1 / 60, 1280, 720, { moveX: 0, moveY: 0, aimX: 0.2, aimY: 0.98 });
    }
    eng.weather.lightningFlash = 0;
    g.view(cfg.x, cfg.y);

    const { w, h, data } = await g.capture();
    const total = w * h;
    if (total === 0) {
      throw new Error('capture() 返回空画布');
    }

    const hist = new Uint32Array(256);
    let sumL = 0;
    let darkCount = 0;
    let greenDomCount = 0;

    // Hasler & Süsstrunk 色彩丰度统计量（Welford / 一次遍历累加）
    let sumRg = 0;
    let sumYb = 0;
    let sumRg2 = 0;
    let sumYb2 = 0;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const gVal = data[i + 1];
      const b = data[i + 2];

      const l = 0.2126 * r + 0.7152 * gVal + 0.0722 * b;
      sumL += l;
      const lBin = l < 0 ? 0 : l > 255 ? 255 : l | 0;
      hist[lBin]++;
      if (l < 12) darkCount++;

      // 绿通道显著主导像素判定
      if (gVal > r + 4 && gVal > b + 4) {
        greenDomCount++;
      }

      const rg = r - gVal;
      const yb = 0.5 * (r + gVal) - b;
      sumRg += rg;
      sumYb += yb;
      sumRg2 += rg * rg;
      sumYb2 += yb * yb;
    }

    const meanL = sumL / total;
    const dark = darkCount / total;
    const greenDom = greenDomCount / total;

    // 计算 p95 亮度分位
    const target95 = total * 0.95;
    let acc = 0;
    let p95 = 0;
    for (let b = 0; b < 256; b++) {
      acc += hist[b];
      if (acc >= target95) {
        p95 = b;
        break;
      }
    }

    const muRg = sumRg / total;
    const muYb = sumYb / total;
    const varRg = Math.max(0, sumRg2 / total - muRg * muRg);
    const varYb = Math.max(0, sumYb2 / total - muYb * muYb);
    const colorful = Math.sqrt(varRg + varYb) + 0.3 * Math.sqrt(muRg * muRg + muYb * muYb);

    g.view(null, null);
    return { L: meanL, p95, dark, colorful, greenDom };
  }, shot);
}

function checkSpec(metrics, spec) {
  const errs = [];
  if (metrics.L < spec.L[0] || metrics.L > spec.L[1]) {
    errs.push(`L=${metrics.L.toFixed(2)} 不在 [${spec.L[0]}, ${spec.L[1]}]`);
  }
  if (metrics.p95 < spec.p95[0] || metrics.p95 > spec.p95[1]) {
    errs.push(`p95=${metrics.p95.toFixed(1)} 不在 [${spec.p95[0]}, ${spec.p95[1]}]`);
  }
  if (metrics.dark < spec.dark[0] || metrics.dark > spec.dark[1]) {
    errs.push(`dark=${metrics.dark.toFixed(3)} 不在 [${spec.dark[0]}, ${spec.dark[1]}]`);
  }
  if (metrics.colorful > spec.colorfulMax) {
    errs.push(`colorful=${metrics.colorful.toFixed(2)} > ${spec.colorfulMax}`);
  }
  if (metrics.greenDom > spec.greenDomMax) {
    errs.push(`greenDom=${metrics.greenDom.toFixed(3)} > ${spec.greenDomMax}`);
  }
  return errs;
}

async function main() {
  const baseline = loadBaseline();
  const server = await ensureDevServer();
  const browser = await launchBrowser();
  const failures = [];

  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();

    // 使用 ?manual 避免后台 rAF 在取帧间隙改写状态
    await page.goto(`${server.url}/?manual`, { waitUntil: 'networkidle' });
    await waitForGameReady(page);

    console.log(
      `=== 主美色彩与曝光报告 (${REPORT_ONLY ? 'report-only 模式' : '严格门禁模式'}) ===`
    );

    for (const shot of SHOTS) {
      const spec = baseline.palette[shot.key];
      const m = await captureMetrics(page, shot);
      const errs = checkSpec(m, spec);
      const mark = errs.length === 0 ? '✓' : REPORT_ONLY ? '!' : '✗';
      console.log(
        `${mark} ${shot.key.padEnd(14)} (${shot.label}) | L=${m.L.toFixed(2)} [${spec.L[0]}..${spec.L[1]}] | p95=${m.p95.toFixed(0)} [${spec.p95[0]}..${spec.p95[1]}] | dark=${m.dark.toFixed(3)} [${spec.dark[0]}..${spec.dark[1]}] | colorful=${m.colorful.toFixed(2)} (<=${spec.colorfulMax}) | greenDom=${m.greenDom.toFixed(3)} (<=${spec.greenDomMax})`
      );
      if (errs.length > 0) {
        console.log(`    差距: ${errs.join('; ')}`);
        failures.push(`${shot.key}: ${errs.join('; ')}`);
      }
    }

    await ctx.close();
  } finally {
    await browser.close();
    await server.stop();
  }

  if (failures.length > 0 && !REPORT_ONLY) {
    console.error(`\n✗ palette-check 失败 (${failures.length} 个场景未达标)`);
    process.exit(1);
  }
  if (REPORT_ONLY) {
    console.log(`\n[report-only] 色彩基线采样完成（当前未达标场景数：${failures.length}/4）`);
  } else {
    console.log('\n✓ palette-check 全部 4 个标准机位命中主美区间');
  }
}

main().catch((err) => {
  console.error(`✗ palette-check 异常: ${err.message || err}`);
  process.exit(1);
});
