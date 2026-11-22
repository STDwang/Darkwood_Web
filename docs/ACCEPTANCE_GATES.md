# 自动化验收门禁与反作弊约束规范（Acceptance Gates）

本文档定义《幽林余烬》的 **Tier 1 快检** 与 **Tier 2 专项门禁**。所有门禁均运行于真实本地服务 + 无头 Chromium（支持 WebGL2 与 Canvas2D 回退）。

---

## 一、反作弊铁律（Non-Negotiable Rules）

1. **禁止同提交放宽阈值**：严禁在同一次代码改动中既改游戏实现又放宽 `tools/checks/baseline.json` 或门禁脚本的断言条件。
2. **主美指标不可靠“贴黑膜”作弊**：`palette-check` 同时校验平均亮度 `L` **下限与上限**、高光 `p95` **下限与上限**（双尺约束），防止把整屏压成纯黑蒙混过关。
3. **手感指标不可靠“僵硬限速”作弊**：`sim-check` 同时校验零穿墙/零越界（下限尺）与实际探索搜刮/位移进度（上限尺）。
4. **Bug 必沉淀为探针（Feedback-to-Gate）**：每修复一个试玩或视觉 Bug，必须在对应门禁脚本中补一条永久断言。

---

## 二、门禁分层清单

### Tier 1：快检门禁（每次子 Agent 提交必跑）
| 脚本 | 命令 | 过关硬标准 |
|---|---|---|
| 类型检查 | `npm run lint` | `tsc --noEmit` 0 错误 |
| 物理与逻辑模拟 | `npx tsx tools/checks/sim-check.ts` | 28 容器无重叠、射线可见性稳定、天气/揭顶收敛、120s 压测 p95 `< 2.5ms`、零 `NaN`/越界、家具/制作/逃生状态机通过 |
| 无头冒烟 | `node tools/checks/smoke-check.mjs` | 零 `pageerror`、零 `console.error`、零 `404`、零外部域名请求、标题→开局→模拟→暂停→重开全闭环 |
| 全端布局审计 | `node tools/checks/layout-check.mjs` | 覆盖 `1280×720`、`1920×1080`、`844×390`、`390×844`；触控按钮短边 `≥ 44px`；零 `position: sticky`；零越安全区；零遮挡（`elementFromPoint`）；零文字压叠 |
| 弹层返回栈 | `node tools/checks/layer-check.mjs` | 暂停/制作/日志/设置弹层支持 4 路退出（按钮/遮罩/`Esc`/`popstate`），关闭后绝不误触底层开局 |

### Tier 2：专项门禁（对应阶段或触及渲染/玩法时必跑）
| 脚本 | 触发时机 | 过关硬标准 |
|---|---|---|
| 主美色彩与曝光校验 | `node tools/checks/palette-check.mjs`（M1 起强制） | 白天林地、黄昏、黑夜林地、黑夜庇护所 4 机位的 `L / p95 / dark / colorful / greenDom` 全部命中 `baseline.json` 区间 |
| 性能压测（含 2x CPU 降速） | `node tools/checks/perf-check.mjs`（M0/M1/M4） | 1x JS p95 `< 2.5ms`；2x CPU 降速 JS p95 `< 8.0ms`；超 `16.7ms` 帧数 `≤ 2`；`drawCalls ≤ 180` |
| 双后端与像素回归 | `node tools/checks/shotdiff.mjs`（重构渲染/优化时） | `?v-shader=a`（Canvas2D）与 `?v-shader=b`（WebGL2）均零报错；非视觉重构前后像素差异率处于对照组底噪内 |

---

## 三、人工主美 / 策划终审清单（每阶段里程碑闸口）

自动门禁全部绿灯后，主美/策划将人工审阅以下 6 张标准截图并签字放行：
1. `0_title.png`：标题页氛围、排版克制感、零丑陋遮挡。
2. `1_day_hideout.png`：庇护所室内布局、家具可辨识度、地板/墙顶腐朽质感。
3. `2_day_forest.png`：林地低饱和冷腐油画质感、枯枝根须与树冠层次、视野锥内外过渡。
4. `3_dusk.png`：黄昏压迫感与色彩过渡。
5. `4_night_forest.png`：黑夜手电光锥、视野外隐匿感、声波/威胁提示可读性。
6. `5_night_hideout.png`：黑夜庇护所暖黄吊灯、门窗缝隙条状光束、家具堵门防线视觉。
