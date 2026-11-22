// 真实雨声录音资源入口（全部 CC0 公有领域，来源与授权见 docs/AUDIO_CREDITS.md）。
// 只允许由 src/main.tsx 引入：audio.ts 绝不静态 import 音频文件——sim-check 在 Node 里加载 engine → audio.ts，Node 无法解析 .webm。
// 单文件构建（assetsInlineLimit 很大）下这些 import 自动内联为 data URL；普通 dev/build 下为本地资源 URL。
// 不使用动态 import()：单文件构建会拆出外部 chunk，file:// 下加载失败。
// 编码为 WebM 容器内的 Opus；解码失败（如部分 Safari）时 audio.ts 静默保持程序化雨。
import { AudioFX } from './audio';
import rainLight from '../assets/audio/rain_light.webm';
import rainHeavy from '../assets/audio/rain_heavy.webm';
import rainPuddle from '../assets/audio/rain_puddle.webm';
import rainDrip from '../assets/audio/rain_drip.webm';
import rainRoof from '../assets/audio/rain_roof.webm';
import thunder1 from '../assets/audio/thunder_1.webm';
import thunder2 from '../assets/audio/thunder_2.webm';

AudioFX.registerRecordings({
  outdoorLight: rainLight,
  outdoorHeavy: rainHeavy,
  puddleNear: rainPuddle,
  dripAfter: rainDrip,
  indoorRoof: rainRoof,
  thunder: [thunder1, thunder2],
});
