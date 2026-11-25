// 生成小红书小工具发布所需的全套合规素材（存于 ./release-minitool/，不打入离线包内）：
//   1. icon.png  (512x512, 1:1, PNG <= 5MiB)
//   2. cover.png (900x1200, 3:4, PNG <= 10MiB，由实机游戏画面渲染合成)
//   3. release-info.json (符合 form-limits.md 限制的 10 字内名称、简介、指令说明与 CLI 命令速查)
//   4. 顺带截取 4 个昼夜机位实机预览图存于 ./release-minitool/previews/ 供目视终验

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDevServer, launchBrowser, waitForGameReady } from './checks/_browser.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT_DIR, 'release-minitool');
const PREVIEW_DIR = path.join(OUT_DIR, 'previews');

async function main() {
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  const server = await ensureDevServer();
  const browser = await launchBrowser();

  try {
    // 1. 截取 4 张 1280x720 实机优化效果截图（白昼林地、黄昏窗光柱、黑夜手电视野锥与怪物、黑夜庇护所）
    const ctxDesktop = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const page = await ctxDesktop.newPage();
    await page.goto(`${server.url}/?manual`, { waitUntil: 'networkidle' });
    await waitForGameReady(page);

    const scenes = [
      { name: '01_day_forest.png', phase: 'day', weather: 'drizzle', x: 0, y: 340, flash: true, gen: true, spawnEnemy: false },
      { name: '02_night_forest_cone.png', phase: 'night', weather: 'storm', x: 0, y: 310, flash: true, gen: true, spawnEnemy: true },
      { name: '03_night_hideout.png', phase: 'night', weather: 'storm', x: 0, y: 20, flash: false, gen: true, spawnEnemy: false },
    ];

    for (const sc of scenes) {
      await page.evaluate((cfg) => {
        const g = window.__game;
        const eng = g.m.Game;
        g.reset(19847, true);
        eng.enemies.length = 0;
        eng.player.x = cfg.x;
        eng.player.y = cfg.y;
        eng.player.angle = Math.PI * 0.32;
        eng.player.battery = 92;
        eng.player.flashlightOn = cfg.flash;
        eng.generatorOn = cfg.gen;
        eng.generatorFuel = 85;
        g.tod(cfg.phase);
        g.weather(cfg.weather);
        eng.weather.lightningFlash = 0;
        if (cfg.spawnEnemy) {
          eng.spawnEnemyAt(cfg.x + 95, cfg.y + 135, 'stalker');
          eng.spawnEnemyAt(cfg.x + 42, cfg.y + 150, 'banshee');
          if (eng.enemies[0]) {
            eng.enemies[0].angle = Math.atan2(cfg.y - eng.enemies[0].y, cfg.x - eng.enemies[0].x);
            eng.enemies[0].windupDur = 0.4;
            eng.enemies[0].windup = 0.15;
          }
          if (eng.enemies[1]) {
            eng.enemies[1].angle = Math.atan2(cfg.y - eng.enemies[1].y, cfg.x - eng.enemies[1].x);
            eng.enemies[1].windupDur = 0.4;
            eng.enemies[1].windup = 0.12;
          }
        }
        g.view(cfg.x, cfg.y);
        for (let i = 0; i < 42; i++) {
          eng.step(1 / 60, 1280, 720, { moveX: 0, moveY: 0, aimX: Math.cos(Math.PI * 0.32), aimY: Math.sin(Math.PI * 0.32) });
        }
        eng.weather.lightningFlash = 0;
        g.view(cfg.x, cfg.y);
        g.m.Renderer?.render?.(eng);
      }, sc);
      await page.waitForTimeout(80);
      await page.screenshot({ path: path.join(PREVIEW_DIR, sc.name), type: 'png' });
    }

    // 2. 生成 3:4 封面图 cover.png (900x1200)：竖屏高精实机黑夜林地视野锥 + 腐朽屋檐漏光 + 暗金骨白题签
    const ctxCover = await browser.newContext({ viewport: { width: 450, height: 600 }, deviceScaleFactor: 2 });
    const coverPage = await ctxCover.newPage();
    await coverPage.goto(`${server.url}/?manual`, { waitUntil: 'networkidle' });
    await waitForGameReady(coverPage);
    await coverPage.evaluate(() => {
      const g = window.__game;
      const eng = g.m.Game;
      g.reset(19847, true);
      eng.enemies.length = 0;
      eng.player.x = -12;
      eng.player.y = 248;
      eng.player.angle = Math.PI * 0.38;
      eng.player.flashlightOn = true;
      eng.player.battery = 100;
      eng.generatorOn = true;
      eng.generatorFuel = 90;
      g.tod('night');
      g.weather('storm');
      eng.spawnEnemyAt(38, 362, 'banshee');
      if (eng.enemies[0]) {
        eng.enemies[0].angle = Math.atan2(248 - 362, -12 - 38);
        eng.enemies[0].windupDur = 0.4;
        eng.enemies[0].windup = 0.14;
      }
      g.view(-4, 224);
      for (let i = 0; i < 40; i++) {
        eng.step(1 / 60, 450, 600, { moveX: 0, moveY: 0, aimX: Math.cos(Math.PI * 0.38), aimY: Math.sin(Math.PI * 0.38) });
      }
      eng.weather.lightningFlash = 0;
      eng.toasts.length = 0;
      g.view(-4, 224);

      // 使用样式表彻底隐藏游戏内 HUD，叠加专属暗黑电影海报级封面题签
      const hideStyle = document.createElement('style');
      hideStyle.textContent = '.hud2, .hud2-toasts { display: none !important; }';
      document.head.appendChild(hideStyle);
      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:40;pointer-events:none;display:flex;flex-direction:column;justify-content:space-between;padding:34px 28px 38px;' +
        'background:linear-gradient(180deg,rgba(5,6,5,0.72) 0%,rgba(5,6,5,0.06) 32%,rgba(5,6,5,0.14) 62%,rgba(5,6,5,0.92) 100%);';
      overlay.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;color:rgba(201,182,142,0.82);font-size:11px;letter-spacing:0.24em;font-family:serif;">
          <span style="display:inline-block;width:18px;height:1px;background:#b87b3b;"></span>
          <span>东欧暗林俯视恐怖求生</span>
        </div>
        <div>
          <div style="font-family:'Noto Serif SC','Songti SC',serif;font-size:44px;font-weight:700;letter-spacing:0.28em;color:#e4dcc9;text-shadow:0 4px 18px rgba(0,0,0,0.95);">幽林余烬</div>
          <div style="margin-top:6px;font-family:Georgia,serif;font-size:11px;letter-spacing:0.52em;color:rgba(196,174,136,0.75);">BLACKWOOD EMBER</div>
          <div style="margin-top:14px;font-size:13px;line-height:1.6;color:rgba(208,198,178,0.86);letter-spacing:0.06em;">白昼搜集残木与燃油 · 黑夜守住微弱锥光撑到破晓</div>
        </div>
      `;
      document.body.appendChild(overlay);
    });
    await coverPage.waitForTimeout(120);
    await coverPage.screenshot({ path: path.join(OUT_DIR, 'cover.png'), type: 'png' });

    // 3. 生成 1:1 图标 icon.png (512x512)：东欧暗黑版画风格枯枝环绕余烬火把徽章
    const ctxIcon = await browser.newContext({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 2 });
    const iconPage = await ctxIcon.newPage();
    await iconPage.setContent(`<!doctype html>
<html>
<body style="margin:0;width:256px;height:256px;overflow:hidden;background:#0a0b09;display:flex;align-items:center;justify-content:center;">
  <canvas id="ic" width="512" height="512" style="width:256px;height:256px;"></canvas>
  <script>
    const c = document.getElementById('ic');
    const g = c.getContext('2d');
    // 暗沉东欧油画底纹渐变
    const bg = g.createRadialGradient(256, 236, 24, 256, 256, 270);
    bg.addColorStop(0, '#2a2117');
    bg.addColorStop(0.52, '#141310');
    bg.addColorStop(1, '#070807');
    g.fillStyle = bg;
    g.fillRect(0, 0, 512, 512);

    // 暖琥珀视野锥光束向上切开黑暗
    const cone = g.createRadialGradient(256, 330, 12, 256, 175, 245);
    cone.addColorStop(0, 'rgba(232, 178, 102, 0.52)');
    cone.addColorStop(0.55, 'rgba(184, 123, 59, 0.18)');
    cone.addColorStop(1, 'rgba(184, 123, 59, 0)');
    g.fillStyle = cone;
    g.beginPath();
    g.moveTo(256, 345);
    g.lineTo(84, 48);
    g.lineTo(428, 48);
    g.closePath();
    g.fill();

    // 四周盘绕的黑色扭曲枯树根剪影框
    g.strokeStyle = '#050605';
    g.lineCap = 'round';
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const r0 = 252;
      const r1 = 165 + (i % 3) * 18;
      g.lineWidth = 14 - (i % 3) * 3;
      g.beginPath();
      g.moveTo(256 + Math.cos(a) * r0, 256 + Math.sin(a) * r0);
      g.quadraticCurveTo(
        256 + Math.cos(a + 0.16) * 208,
        256 + Math.sin(a + 0.16) * 208,
        256 + Math.cos(a - 0.08) * r1,
        256 + Math.sin(a - 0.08) * r1
      );
      g.stroke();
    }

    // 做旧暗铜双环纹章边框
    g.strokeStyle = 'rgba(184, 146, 92, 0.52)';
    g.lineWidth = 3.5;
    g.beginPath();
    g.arc(256, 256, 214, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = 'rgba(217, 209, 191, 0.22)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(256, 256, 204, 0, Math.PI * 2);
    g.stroke();

    // 中心火把木柄与缠布炭头
    g.strokeStyle = '#4e3622';
    g.lineWidth = 22;
    g.beginPath();
    g.moveTo(256, 396);
    g.lineTo(256, 286);
    g.stroke();
    g.fillStyle = '#2d1c12';
    g.strokeStyle = '#0d0907';
    g.lineWidth = 4;
    g.beginPath();
    g.ellipse(256, 278, 26, 18, 0, 0, Math.PI * 2);
    g.fill();
    g.stroke();

    // 三层油画余烬火焰（暗红 -> 暖琥珀 -> 骨白内核）
    const layers = [
      { fill: '#9c321c', w: 54, h: 128, y: 266 },
      { fill: '#d6893e', w: 36, h: 96, y: 268 },
      { fill: '#f4e6c6', w: 18, h: 54, y: 270 },
    ];
    for (const L of layers) {
      g.fillStyle = L.fill;
      g.beginPath();
      g.moveTo(256, L.y - L.h);
      g.bezierCurveTo(256 + L.w * 1.15, L.y - L.h * 0.42, 256 + L.w, L.y, 256, L.y + 8);
      g.bezierCurveTo(256 - L.w, L.y, 256 - L.w * 1.15, L.y - L.h * 0.42, 256, L.y - L.h);
      g.fill();
    }

    // 飘散火星微粒
    g.fillStyle = '#ecc07a';
    for (const [ex, ey, er] of [[218, 156, 3.5], [292, 142, 4], [248, 112, 3], [278, 178, 2.8]]) {
      g.beginPath();
      g.arc(ex, ey, er, 0, Math.PI * 2);
      g.fill();
    }
  </script>
</body>
</html>`);
    await iconPage.screenshot({ path: path.join(OUT_DIR, 'icon.png'), type: 'png' });

    await ctxDesktop.close();
    await ctxCover.close();
    await ctxIcon.close();
  } finally {
    await browser.close();
    await server.stop();
  }

  // 4. 写入发布元数据清单 release-info.json
  const releaseInfo = {
    name: '幽林余烬',
    subtitle: 'Blackwood Ember',
    description:
      '东欧油画风俯视恐怖求生小工具。白昼探索迷雾林地搜刮木材、燃油与信号零件，黑夜点亮发电机与手电锥光，钉死门窗抵御暗处怪物直至破晓撤离。',
    instructions:
      '触屏端：左侧虚拟摇杆移动/外推冲刺，右侧摇杆瞄准，右下角按钮挥击/射击、开关手电、交互与切换武器；桌面端：WASD移动，鼠标瞄准，左键攻击，F开关手电，E交互，Q切换火把/手枪。',
    artifacts: {
      zip: path.resolve(ROOT_DIR, 'Blackwood_Ember_minitool.zip'),
      distDir: path.resolve(ROOT_DIR, 'dist-minitool'),
      icon: path.join(OUT_DIR, 'icon.png'),
      cover: path.join(OUT_DIR, 'cover.png'),
    },
    redappCommands: {
      checkLogin: 'redapp whoami',
      loginForMinitool: 'redapp login --scope minitool_publish',
      createAndUpload:
        'redapp create --source antigravity --name "幽林余烬" --icon "./release-minitool/icon.png" --cover "./release-minitool/cover.png" --desc "东欧油画风俯视恐怖求生游戏。白昼搜刮木材与燃油，黑夜在手电锥光与实时阴影中坚守庇护所直至破晓。" --zip "./Blackwood_Ember_minitool.zip"',
      previewSimulator: 'redapp dev ./dist-minitool',
      previewQr: 'redapp preview --source antigravity --app-id <APP_ID> --qrcode terminal',
      submitAfterQrConfirm: 'redapp submit --source antigravity --app-id <APP_ID> --confirm',
    },
  };
  fs.writeFileSync(path.join(OUT_DIR, 'release-info.json'), JSON.stringify(releaseInfo, null, 2), 'utf8');
  console.log('✓ 发布素材已生成至 ./release-minitool/ (icon.png 512x512, cover.png 900x1200, release-info.json)');
}

main().catch((err) => {
  console.error('✗ 生成发布素材失败:', err);
  process.exit(1);
});
