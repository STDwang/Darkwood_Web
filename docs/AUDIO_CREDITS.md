# 音频素材来源与授权（AUDIO_CREDITS）

《幽林余烬 · Blackwood Ember》中，除下列真实录音外，其余声音全部由 `src/game/audio.ts` 在运行时程序化合成。下列录音解码失败时（比如部分 Safari 不支持 WebM/Opus），游戏会静默回退到程序化雨声。

全部素材均为 **CC0 1.0 公有领域**，作者 **Joseph SARDIN**，来源 **BigSoundBank**（https://bigsoundbank.com）。CC0 不要求署名，这里仍列出以示致谢、方便追溯。

| 游戏内文件（src/assets/audio/） | 用途 | 原始素材 | 原始 URL | 截取段（原文件时间） | 时长 | 处理 | 编码 | 体积 |
|---|---|---|---|---|---|---|---|---|
| rain_light.webm | 室外淡雨/中雨层 | #0740 Rain and Thunder #2（立体声 XY 48k） | https://bigsoundbank.com/rain-and-storm-2-s0740.html | 94.0–115.6 s（无雷段） | 20.0 s 循环 | 尾部 1.6 s 与头部等功率交叉成无缝循环；去直流；高通 90 Hz；RMS 归一到 −28 dBFS，峰值限幅到 −1 dBFS | WebM/Opus 80 kbps 立体声 48 kHz | 192,909 B |
| rain_heavy.webm | 室外大雨层 | #0124 Rain and Thunder #1（立体声 44.1k，重采样到 48k） | https://bigsoundbank.com/rain-and-storm-s0124.html | 0.3–20.9 s（雷声之前的纯雨段） | 19.0 s 循环 | 同上；高通 100 Hz（去掉远雷低频残余） | WebM/Opus 80 kbps 立体声 | 172,978 B |
| rain_puddle.webm | 近处大雨滴打积水 | #1290 Rain on Puddle（单声道 48k） | https://bigsoundbank.com/rain-on-puddle-s1290.html | 10.0–27.6 s | 16.0 s 循环 | 同上；高通 80 Hz | WebM/Opus 44 kbps 单声道 | 94,785 B |
| rain_drip.webm | 雨后林间滴水 | #0555 Forest at Night After Rain（立体声） | https://bigsoundbank.com/forest-at-night-after-rain-s0555.html | 6.0–23.6 s | 16.0 s 循环 | 同上；三阶高通 170 Hz（去掉远处公路车流） | WebM/Opus 80 kbps 立体声 | 148,346 B |
| rain_roof.webm | 室内屋顶底料（再经游戏内 2.6 kHz 低通与木质中频 EQ，叠加程序化木瓦敲击层） | #0820 Rain and thunder in a tent（立体声） | https://bigsoundbank.com/rain-and-storm-in-a-tent-s0820.html | 2.0–23.6 s（无雷段） | 20.0 s 循环 | 同上；高通 60 Hz，低通 6 kHz | WebM/Opus 80 kbps 立体声 | 221,241 B |
| thunder_1.webm | 真实滚雷（与程序化裂响叠加） | #0740 Rain and Thunder #2 | https://bigsoundbank.com/rain-and-storm-2-s0740.html | 3.5–11.5 s | 8.0 s 单次 | 淡入 0.25 s，淡出 1.5 s；高通 25 Hz；峰值归一到 −1 dBFS | WebM/Opus 80 kbps 立体声 | 79,455 B |
| thunder_2.webm | 真实滚雷 | #0740 Rain and Thunder #2 | https://bigsoundbank.com/rain-and-storm-2-s0740.html | 122.5–130.5 s | 8.0 s 单次 | 同上 | WebM/Opus 80 kbps 立体声 | 73,983 B |

这些录音共 983,697 B（约 0.94 MiB）。单文件构建会把它们内联为 base64，HTML 约增加 1.31 MB。

雷声检测：逐 0.5 s 统计 20–120 Hz 频带能量，结合逐秒电平与低频占比，去掉低频突增的片段。

许可证：CC0 1.0 Universal，https://creativecommons.org/publicdomain/zero/1.0/
