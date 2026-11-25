// 小红书小工具离线构建专用音频入口：
// 1) 雨声与雷声 100% 启用内置程序化物理雨滴引擎（不含 .webm，严守小工具白名单与轻量体积）；
// 2) 核心战斗与砍伐音效（枪声 / 砍树 / 砍怪）使用极轻量 CC0 .mp3（共 <19KB，Vite 自动 Base64 内联进 app.js，零外链、零额外文件）。
import { AudioFX } from './audio';
import sfxGunshot from '../assets/audio/sfx_gunshot.mp3';
import sfxChopWood from '../assets/audio/sfx_chop_wood.mp3';
import sfxHitFlesh from '../assets/audio/sfx_hit_flesh.mp3';

AudioFX.registerCombatSfx({
  gunshot: sfxGunshot,
  chopWood: sfxChopWood,
  hitFlesh: sfxHitFlesh,
});
