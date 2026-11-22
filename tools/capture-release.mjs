// 最终发布对比截图集生成脚本（docs/art/release_v1/）
// 生成 6 张 1280x720 标准实机截图：
//   0_title.png / 1_day_hideout.png / 2_day_forest.png / 3_dusk_forest.png / 4_night_forest.png / 5_night_hideout.png

import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, ensureDevServer, launchBrowser, waitForGameReady } from './checks/_browser.mjs';

const OUT_DIR = path.join(ROOT_DIR, 'docs', 'art', 'release_v1');

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const server = await ensureDevServer();
  const browser = await launchBrowser();

  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();

    // 1. 0_title.png：标题页实时画面（带雨幕、门廊外扫射手电与标题 UI）
    await page.goto(`${server.url}/?manual`, { waitUntil: 'networkidle' });
    await waitForGameReady(page);
    await page.evaluate(() => {
      const g = window.__game;
      const eng = g.m.Game;
      g.reset(19847, false);
      g.weather('drizzle');
      eng.weather.lightningFlash = 0;
      for (let i = 0; i < 75; i++) {
        g.frame(1 / 60);
      }
      eng.weather.lightningFlash = 0;
      g.frame(1 / 60);
    });
    await page.screenshot({ path: path.join(OUT_DIR, '0_title.png') });
    console.log('✓ 0_title.png');

    // 其余 5 张游玩实机机位
    const shots = [
      {
        file: '1_day_hideout.png',
        phase: 'day',
        weather: 'drizzle',
        x: 0,
        y: 25,
        angle: Math.PI * 0.5,
        flashlight: false,
        generator: true,
      },
      {
        file: '2_day_forest.png',
        phase: 'day',
        weather: 'drizzle',
        x: 0,
        y: 340,
        angle: Math.PI * 0.45,
        flashlight: true,
        generator: true,
      },
      {
        file: '3_dusk_forest.png',
        phase: 'dusk',
        weather: 'drizzle',
        x: 0,
        y: 340,
        angle: Math.PI * 0.45,
        flashlight: true,
        generator: true,
      },
      {
        file: '4_night_forest.png',
        phase: 'night',
        weather: 'storm',
        x: 0,
        y: 340,
        angle: Math.PI * 0.45,
        flashlight: true,
        generator: true,
      },
      {
        file: '5_night_hideout.png',
        phase: 'night',
        weather: 'drizzle',
        x: 0,
        y: 25,
        angle: Math.PI * 0.5,
        flashlight: false,
        generator: true,
      },
    ];

    for (const s of shots) {
      await page.evaluate((cfg) => {
        const g = window.__game;
        const eng = g.m.Game;
        g.reset(19847, true);
        eng.enemies.length = 0;
        eng.player.x = cfg.x;
        eng.player.y = cfg.y;
        eng.player.angle = cfg.angle;
        eng.player.battery = 100;
        eng.player.flashlightOn = cfg.flashlight;
        eng.generatorOn = cfg.generator;
        eng.generatorFuel = 80;
        g.tod(cfg.phase);
        g.weather(cfg.weather);
        eng.weather.lightningFlash = 0;
        g.view(cfg.x, cfg.y);
        for (let i = 0; i < 55; i++) {
          eng.step(1 / 60, 1280, 720, {
            mx: 0,
            my: 0,
            aimAngle: cfg.angle,
            sprint: false,
            attack: false,
            interact: false,
            toggleLight: false,
          });
        }
        eng.weather.lightningFlash = 0;
        g.view(cfg.x, cfg.y);
        g.frame(1 / 60);
      }, s);
      await page.waitForTimeout(80);
      await page.screenshot({ path: path.join(OUT_DIR, s.file) });
      console.log(`✓ ${s.file}`);
    }

    await ctx.close();
  } finally {
    await browser.close();
    await server.stop();
  }
}

main().catch((err) => {
  console.error(`✗ 截图生成失败: ${err.message || err}`);
  process.exit(1);
});
