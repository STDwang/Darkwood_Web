// 小红书小工具（MiniTool）容器能力安全桥接层
// - 严格遵循小红书小工具规范（2026-11-23）：
//   1) 存储统一走异步 getStorage / setStorage（客户端 build >= 9460），妥善处理 iOS 空串返回；
//      当容器版本未知（getBuildVersion() === null）、API 缺失或调用失败时，严格退化为纯内存态，
//      绝不回退读写 localStorage / sessionStorage / IndexedDB / Cookie。
//   2) 接入 getWindowInfo 安全区与右上角原生胶囊按钮（menuButtons.capsule）自动避让。
//   3) 接入 setKeepScreenOn（9.55+）游玩态屏幕常亮与 vibrateShort（9.50+）战斗/受击触感反馈。

declare const __MINITOOL__: boolean;

interface XhsMenuButtonRect {
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface XhsWindowInfo {
  windowWidth?: number;
  windowHeight?: number;
  statusBarHeight?: number;
  safeArea?: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
  };
  menuButtons?: {
    back?: XhsMenuButtonRect | null;
    share?: XhsMenuButtonRect | null;
    capsule?: XhsMenuButtonRect | null;
  };
}

interface XhsMiniToolApi {
  getSystemInfoSync?: () => { version?: string } | undefined;
  getWindowInfo?: () => XhsWindowInfo | undefined;
  getStorage?: (opts: {
    key: string;
    success?: (res: { data?: unknown }) => void;
    fail?: () => void;
  }) => void;
  setStorage?: (opts: {
    key: string;
    data: string;
    success?: () => void;
    fail?: () => void;
  }) => void;
  getStorageSync?: (key: string) => unknown;
  setStorageSync?: (key: string, data: string) => void;
  vibrateShort?: (opts?: {
    type?: 'heavy' | 'medium' | 'light';
    success?: () => void;
    fail?: () => void;
  }) => void;
  setKeepScreenOn?: (opts: {
    keepScreenOn: boolean;
    success?: () => void;
    fail?: () => void;
  }) => void;
}

function getXhs(): XhsMiniToolApi | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { xhs?: XhsMiniToolApi };
  return w.xhs && typeof w.xhs === 'object' ? w.xhs : null;
}

/** 是否运行在小红书小工具构建或容器内 */
export function isMiniToolEnv(): boolean {
  const miniFlag = typeof __MINITOOL__ !== 'undefined' && __MINITOOL__;
  return miniFlag || getXhs() !== null;
}

/** 解析小红书客户端版本号（如 "9.55.0" -> 9550）；未知或失败返回 null */
export function getXhsBuildVersion(): number | null {
  const xhs = getXhs();
  if (!xhs || typeof xhs.getSystemInfoSync !== 'function') return null;
  try {
    const info = xhs.getSystemInfoSync();
    const raw = info && typeof info.version === 'string' ? info.version.trim() : '';
    if (!raw) return null;
    const parts = raw.split('.');
    const major = parseInt(parts[0] || '', 10);
    const minor = parseInt(parts[1] || '0', 10);
    const patch = parseInt(parts[2] || '0', 10);
    if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
    return major * 1000 + minor * 10 + (Number.isFinite(patch) ? Math.min(9, patch) : 0);
  } catch {
    return null;
  }
}

// 内存态存储镜像（保证首帧同步读取与无存储权限时零报错降级）
const memoryStore = new Map<string, string>();

/**
 * 同步读取偏好值：
 * - 小工具构建/容器内：读取内存镜像（若为独立旧版 <9460 且具备同步接口则尝试读取一次）；
 *   版本未知或无接口时严格保持纯内存态，绝不触碰浏览器 Web Storage。
 * - 常规浏览器 Web 构建：读取标准持久化存储。
 */
export function safePrefGet(key: string): string | null {
  if (memoryStore.has(key)) {
    return memoryStore.get(key) ?? null;
  }
  const miniFlag = typeof __MINITOOL__ !== 'undefined' && __MINITOOL__;
  const xhs = getXhs();
  if (miniFlag || xhs) {
    const ver = getXhsBuildVersion();
    if (xhs && ver !== null && ver < 9460 && typeof xhs.getStorageSync === 'function') {
      try {
        const val = xhs.getStorageSync(key);
        if (typeof val === 'string' && val.length > 0) {
          memoryStore.set(key, val);
          return val;
        }
      } catch {
        // 静默退化为内存态
      }
    }
    return null;
  }
  if (!miniFlag && typeof window !== 'undefined') {
    try {
      const val = window.localStorage.getItem(key);
      if (typeof val === 'string') {
        memoryStore.set(key, val);
        return val;
      }
    } catch {
      // 忽略沙盒异常
    }
  }
  return null;
}

/**
 * 异步水合读取（用于小工具客户端 >= 9460 的异步 getStorage，兼容 iOS 空串返回）
 */
export function hydratePrefAsync(key: string, onLoaded: (val: string) => void): void {
  const xhs = getXhs();
  if (!xhs) return;
  const ver = getXhsBuildVersion();
  if (ver === null || ver < 9460 || typeof xhs.getStorage !== 'function') return;
  try {
    xhs.getStorage({
      key,
      success(res) {
        // 兼容 iOS 未命中时返回 data: "" 的行为，仅非空合法字符串才回填
        const raw = res ? res.data : undefined;
        if (typeof raw === 'string' && raw.length > 0) {
          memoryStore.set(key, raw);
          onLoaded(raw);
        }
      },
      fail() {
        // 失败保持内存态，绝不回退 Web Storage
      },
    });
  } catch {
    // 静默降级
  }
}

/**
 * 写入偏好值：
 * - 先更新内存态；
 * - 小工具容器 >= 9460 走异步 setStorage，< 9460 走同步兼容；版本未知或失败时仅保留内存态。
 */
export function safePrefSet(key: string, value: string): void {
  memoryStore.set(key, value);
  const miniFlag = typeof __MINITOOL__ !== 'undefined' && __MINITOOL__;
  const xhs = getXhs();
  if (miniFlag || xhs) {
    if (!xhs) return;
    const ver = getXhsBuildVersion();
    if (ver !== null && ver >= 9460 && typeof xhs.setStorage === 'function') {
      try {
        xhs.setStorage({
          key,
          data: value,
          fail() {
            // 静默保持内存态
          },
        });
      } catch {
        // 静默保持内存态
      }
    } else if (ver !== null && ver < 9460 && typeof xhs.setStorageSync === 'function') {
      try {
        xhs.setStorageSync(key, value);
      } catch {
        // 静默保持内存态
      }
    }
    return;
  }
  if (!miniFlag && typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // 忽略沙盒异常
    }
  }
}

/**
 * 读取小红书 getWindowInfo 安全区与右上角原生胶囊坐标，动态写入 CSS 变量避让
 * 在普通浏览器中保持 0px 偏移，不影响桌面与移动端标准布局
 */
export function applyXhsWindowMetrics(): void {
  if (typeof document === 'undefined') return;
  const xhs = getXhs();
  if (!xhs || typeof xhs.getWindowInfo !== 'function') return;
  try {
    const info = xhs.getWindowInfo();
    if (!info) return;
    const root = document.documentElement;
    const winW = info.windowWidth || window.innerWidth || 390;
    const winH = info.windowHeight || window.innerHeight || 844;

    if (info.safeArea) {
      const sa = info.safeArea;
      const topInset = Math.max(0, Math.round(sa.top));
      const bottomInset = Math.max(0, Math.round(winH - sa.bottom));
      const leftInset = Math.max(0, Math.round(sa.left));
      const rightInset = Math.max(0, Math.round(winW - sa.right));
      if (topInset > 0) root.style.setProperty('--st', `${topInset}px`);
      if (bottomInset > 0) root.style.setProperty('--sb', `${bottomInset}px`);
      if (leftInset > 0) root.style.setProperty('--sl', `${leftInset}px`);
      if (rightInset > 0) root.style.setProperty('--sr', `${rightInset}px`);
    }

    // 右上角胶囊与分享按钮下缘避让（9.49+ / 9.55+）
    const cap = info.menuButtons?.capsule;
    const share = info.menuButtons?.share;
    let rightBottom = 0;
    if (cap && Number.isFinite(cap.bottom) && cap.right > winW * 0.5) {
      rightBottom = Math.max(rightBottom, cap.bottom);
    }
    if (share && Number.isFinite(share.bottom) && share.right > winW * 0.5) {
      rightBottom = Math.max(rightBottom, share.bottom);
    }
    if (rightBottom > 0) {
      const safeTop = info.safeArea ? Math.max(0, info.safeArea.top) : 0;
      const extraDown = Math.max(0, Math.ceil(rightBottom - safeTop - 8));
      root.style.setProperty('--xhs-cap-offset', `${extraDown}px`);
    }
  } catch {
    // 容器不支持时静默回退至 CSS env(safe-area-inset-*)
  }
}

let lastVibrateAt = 0;

/**
 * 触发小红书容器短促触感振动（9.50+），内置节流防止密集帧调用
 */
export function triggerXhsVibrate(type: 'light' | 'medium' | 'heavy'): void {
  const xhs = getXhs();
  if (!xhs || typeof xhs.vibrateShort !== 'function') return;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (now - lastVibrateAt < 110) return;
  lastVibrateAt = now;
  const ver = getXhsBuildVersion();
  if (ver !== null && ver < 9500) return;
  try {
    xhs.vibrateShort({ type, fail() {} });
  } catch {
    // 静默忽略
  }
}

export type XhsRankPeriod = 'all' | 'week' | 'day';

export interface XhsRankEntry {
  rank: number;
  score: number;
  nickname: string;
}

export interface XhsMyRank {
  status: 'EXACT' | 'OVER_LIMIT' | 'NO_SCORE' | 'NOT_PARTICIPATING' | 'LOCAL';
  rank: number | null;
  score: number | null;
}

export interface XhsRankListResult {
  ok: boolean;
  reason?: 'unauthorized' | 'unsupported' | 'not_ready' | 'error';
  entries: XhsRankEntry[];
  myRank: XhsMyRank;
  localBest: number;
}

interface XhsMiniToolNamespace {
  getLaunchOptions?: () => Promise<{ miniToolEnv?: { buildVersion?: number | string; userDataPath?: string } }>;
  postNote?: (opts: {
    title?: string;
    content?: string;
    pageType?: 'video_publish' | 'photo_publish' | 'slides_edit';
    mediaInfo: {
      image_resources?: Array<{ url: string }>;
    };
  }) => Promise<{ errMsg?: string }>;
  writeTempFile?: (opts: { data: string }) => Promise<{ filePath?: string; errMsg?: string }>;
  share?: (opts: { type: 'card' | 'image'; image_resource?: string }) => Promise<{ errMsg?: string }>;
  submitScore?: (opts: { board?: number; score: number }) => Promise<{ score?: number; errMsg?: string }>;
  getRankList?: (opts: {
    board?: number;
    period?: XhsRankPeriod;
  }) => Promise<{ data?: Array<{ rank: number; score: number; nickname?: string | null }>; errMsg?: string }>;
  getMyRank?: (opts: {
    board?: number;
    period?: XhsRankPeriod;
  }) => Promise<{
    status?: 'EXACT' | 'OVER_LIMIT' | 'NO_SCORE' | 'NOT_PARTICIPATING';
    rank?: number | null;
    score?: number | null;
    errMsg?: string;
  }>;
}

function getMiniTool(): XhsMiniToolNamespace | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    xhs?: { miniTool?: XhsMiniToolNamespace; launchOptions?: { miniToolEnv?: { buildVersion?: number | string } } };
  };
  return w.xhs && w.xhs.miniTool && typeof w.xhs.miniTool === 'object' ? w.xhs.miniTool : null;
}

/** 按小工具官方在线文档 §3.6 解析客户端版本号（buildVersion 忽略末三位，如 9530001 -> 9530） */
async function getMiniToolClientVersion(): Promise<number> {
  if (typeof window !== 'undefined') {
    const w = window as unknown as {
      xhs?: { launchOptions?: { miniToolEnv?: { buildVersion?: number | string } } };
    };
    const syncVer = Number(w.xhs?.launchOptions?.miniToolEnv?.buildVersion) || 0;
    if (syncVer > 0) return Math.floor(syncVer / 1000);
  }
  const mt = getMiniTool();
  if (mt && typeof mt.getLaunchOptions === 'function') {
    try {
      const opts = await mt.getLaunchOptions();
      const asyncVer = Number(opts?.miniToolEnv?.buildVersion) || 0;
      if (asyncVer > 0) return Math.floor(asyncVer / 1000);
    } catch {
      // 回退旧接口
    }
  }
  const legacy = getXhsBuildVersion();
  return legacy ?? 0;
}

const BEST_SCORE_KEY = 'blackwood_best_score_v1';
let localBestScore = Math.max(0, Number(safePrefGet(BEST_SCORE_KEY)) || 0);

export function getLocalBestScore(): number {
  return localBestScore;
}

export function hydrateLocalBestScore(): void {
  hydratePrefAsync(BEST_SCORE_KEY, (saved) => {
    const n = Number(saved);
    if (Number.isFinite(n) && n > localBestScore) {
      localBestScore = Math.round(n);
    }
  });
}

function recordLocalBest(score: number): void {
  const s = Math.max(0, Math.min(999999, Math.round(score)));
  if (s > localBestScore) {
    localBestScore = s;
    safePrefSet(BEST_SCORE_KEY, String(s));
  }
}

// 排行榜本地 45 秒结果缓存（遵循文档防 150 QPS 限频要求）
const rankCache = new Map<string, { at: number; result: XhsRankListResult }>();
const RANK_CACHE_TTL_MS = 45_000;

/** 提交生存积分至小红书排行榜（客户端 9.51+，内测能力，未授权或失败静默保留本机最高分） */
export async function submitXhsScore(score: number, board = 1): Promise<{ submitted: boolean; best: number }> {
  const clamped = Math.max(0, Math.min(999999, Math.round(score)));
  recordLocalBest(clamped);
  const mt = getMiniTool();
  if (!mt || typeof mt.submitScore !== 'function') {
    return { submitted: false, best: localBestScore };
  }
  const ver = await getMiniToolClientVersion();
  if (ver > 0 && ver < 9510) {
    return { submitted: false, best: localBestScore };
  }
  try {
    const res = await mt.submitScore({ board, score: clamped });
    if (res && typeof res.score === 'number' && Number.isFinite(res.score)) {
      recordLocalBest(res.score);
    }
    // 成绩提交成功后清空缓存，便于下次打开榜单立即看到最新排名
    rankCache.clear();
    return { submitted: true, best: localBestScore };
  } catch {
    return { submitted: false, best: localBestScore };
  }
}

/** 查询小红书排行榜与本人名次（45s 缓存 + errCode 2002 有限退避 + 1005 未授权优雅降级） */
export async function fetchXhsRankList(period: XhsRankPeriod = 'all', board = 1): Promise<XhsRankListResult> {
  const cacheKey = `${board}:${period}`;
  const now = Date.now();
  const cached = rankCache.get(cacheKey);
  if (cached && now - cached.at < RANK_CACHE_TTL_MS) {
    return { ...cached.result, localBest: localBestScore };
  }

  const fallback: XhsRankListResult = {
    ok: false,
    reason: 'unsupported',
    entries: [],
    myRank: { status: 'LOCAL', rank: null, score: localBestScore > 0 ? localBestScore : null },
    localBest: localBestScore,
  };

  const mt = getMiniTool();
  if (!mt || typeof mt.getRankList !== 'function') {
    return fallback;
  }
  const ver = await getMiniToolClientVersion();
  if (ver > 0 && ver < 9510) {
    return fallback;
  }

  const delays = [500, 1200];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const [listRes, myRes] = await Promise.all([
        mt.getRankList({ board, period }),
        typeof mt.getMyRank === 'function' ? mt.getMyRank({ board, period }) : Promise.resolve(null),
      ]);
      const rawList = Array.isArray(listRes?.data) ? listRes.data : [];
      const entries: XhsRankEntry[] = rawList.map((item, idx) => ({
        rank: typeof item.rank === 'number' ? item.rank : idx + 1,
        score: typeof item.score === 'number' ? Math.round(item.score) : 0,
        nickname:
          typeof item.nickname === 'string' && item.nickname.trim().length > 0
            ? item.nickname.trim()
            : '迷雾行者',
      }));
      const myRank: XhsMyRank =
        myRes && myRes.status
          ? {
              status: myRes.status,
              rank: typeof myRes.rank === 'number' ? myRes.rank : null,
              score: typeof myRes.score === 'number' ? Math.round(myRes.score) : null,
            }
          : { status: 'NOT_PARTICIPATING', rank: null, score: null };

      const result: XhsRankListResult = {
        ok: true,
        entries,
        myRank,
        localBest: localBestScore,
      };
      rankCache.set(cacheKey, { at: Date.now(), result });
      return result;
    } catch (err) {
      const code = Number((err as { errCode?: number } | null)?.errCode) || 0;
      if (code === 1005 || code === 10003) {
        return { ...fallback, reason: 'unauthorized' };
      }
      if (code === 2002 && attempt < delays.length) {
        await new Promise((r) => window.setTimeout(r, delays[attempt]));
        continue;
      }
      return { ...fallback, reason: code === 2002 ? 'not_ready' : 'error' };
    }
  }
  return fallback;
}

/** 离屏绘制《幽林余烬》暗林战报卡片（640×400 PNG Data URI，用于 postNote 发笔记复活，零外链） */
function renderBattleReportDataUrl(stats: {
  day: number;
  defeated: number;
  looted: number;
  score: number;
}): string {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 400;
  const ctx = c.getContext('2d');
  if (!ctx) return '';

  // 暗林深褐渐变羊皮背景
  const bg = ctx.createLinearGradient(0, 0, 640, 400);
  bg.addColorStop(0, '#1e1711');
  bg.addColorStop(0.55, '#130f0b');
  bg.addColorStop(1, '#0b0908');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 640, 400);

  // 顶部余烬红晕
  const glow = ctx.createRadialGradient(320, 90, 12, 320, 110, 260);
  glow.addColorStop(0, 'rgba(186, 86, 46, 0.34)');
  glow.addColorStop(1, 'rgba(186, 86, 46, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 640, 400);

  // 类魂游双层古铜线框
  ctx.strokeStyle = 'rgba(206, 168, 102, 0.72)';
  ctx.lineWidth = 2;
  ctx.strokeRect(18, 18, 604, 364);
  ctx.strokeStyle = 'rgba(154, 120, 72, 0.42)';
  ctx.lineWidth = 1;
  ctx.strokeRect(26, 26, 588, 348);

  // 标题与副标题
  ctx.fillStyle = '#f2e6cf';
  ctx.font = '700 38px serif';
  ctx.textAlign = 'center';
  ctx.fillText('幽 林 余 烬', 320, 92);
  ctx.fillStyle = 'rgba(210, 178, 122, 0.8)';
  ctx.font = '600 14px monospace';
  ctx.fillText('BLACKWOOD EMBER · SURVIVAL RECORD', 320, 122);

  // 分隔线
  ctx.strokeStyle = 'rgba(206, 168, 102, 0.55)';
  ctx.beginPath();
  ctx.moveTo(96, 146);
  ctx.lineTo(544, 146);
  ctx.stroke();

  // 核心战绩 4 格
  const cells = [
    ['存活天数', `第 ${stats.day} 天`],
    ['生存积分', `${stats.score}`],
    ['击退怪物', `${stats.defeated}`],
    ['搜刮物资', `${stats.looted}`],
  ];
  for (let i = 0; i < cells.length; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 68 + col * 262;
    const y = 172 + row * 82;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
    ctx.fillRect(x, y, 242, 66);
    ctx.strokeStyle = 'rgba(186, 152, 98, 0.32)';
    ctx.strokeRect(x, y, 242, 66);
    ctx.fillStyle = '#a89a82';
    ctx.font = '500 13px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(cells[i][0], x + 16, y + 25);
    ctx.fillStyle = '#f3e5c6';
    ctx.font = '700 22px monospace';
    ctx.fillText(cells[i][1], x + 16, y + 53);
  }

  ctx.fillStyle = 'rgba(202, 184, 152, 0.72)';
  ctx.font = '500 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('在黑暗吞噬庇护所前，守住最后一点光。', 320, 362);

  return c.toDataURL('image/png');
}

/**
 * 调用小红书 postNote 发布战报笔记以换取原地复活（遵循在线文档 §3.3 + §3.5）
 * 若在普通 Web 预览环境无 miniTool.postNote，则返回 fallback 供测试体验。
 */
export async function postXhsReviveNote(stats: {
  day: number;
  defeated: number;
  looted: number;
  score: number;
}): Promise<{ ok: boolean; mode: 'xhs' | 'fallback'; message?: string }> {
  const mt = getMiniTool();
  if (!mt || typeof mt.postNote !== 'function') {
    return { ok: true, mode: 'fallback', message: '本地预览模式已触发余烬复活' };
  }
  try {
    const dataUrl = renderBattleReportDataUrl(stats);
    let imgRef = dataUrl;
    if (dataUrl && typeof mt.writeTempFile === 'function') {
      try {
        const tmp = await mt.writeTempFile({ data: dataUrl });
        if (tmp && typeof tmp.filePath === 'string' && tmp.filePath.length > 0) {
          imgRef = tmp.filePath;
        }
      } catch {
        // 回退直传 dataUrl
      }
    }
    await mt.postNote({
      title: `我在幽林余烬撑到了第${stats.day}天`,
      content: `《幽林余烬》东欧暗林生存战报：存活第 ${stats.day} 天，击退 ${stats.defeated} 只怪物，生存积分 ${stats.score}！天黑后的安全屋也不安全，谁敢来挑战？#幽林余烬 #生存恐怖小游戏`,
      pageType: 'photo_publish',
      mediaInfo: {
        image_resources: [{ url: imgRef }],
      },
    });
    return { ok: true, mode: 'xhs' };
  } catch (err) {
    const msg = (err as { errMsg?: string } | null)?.errMsg || '取消发布或当前版本暂不支持';
    return { ok: false, mode: 'xhs', message: msg };
  }
}

/**
 * 调用小红书 share（客户端 9.53+，在线文档 §3.17）分享小工具卡片以换取复活
 * 注：原关注弹窗接口已按平台公告下线，改为合规卡片分享 + 右上角「···」关注作者引导。
 */
export async function shareXhsReviveCard(): Promise<{ ok: boolean; mode: 'xhs' | 'fallback'; message?: string }> {
  const mt = getMiniTool();
  if (!mt || typeof mt.share !== 'function') {
    return { ok: true, mode: 'fallback', message: '本地预览模式已触发分享复活' };
  }
  const ver = await getMiniToolClientVersion();
  if (ver > 0 && ver < 9530) {
    return { ok: false, mode: 'xhs', message: '当前客户端版本低于 9.53，请改用「发笔记复活」' };
  }
  try {
    await mt.share({ type: 'card' });
    return { ok: true, mode: 'xhs' };
  } catch (err) {
    const msg = (err as { errMsg?: string } | null)?.errMsg || '已取消分享';
    return { ok: false, mode: 'xhs', message: msg };
  }
}

/**
 * 设置游玩态屏幕常亮（9.55+），防止黑夜守屋观察动静时自动息屏
 */
export function setXhsKeepScreenOn(keepScreenOn: boolean): void {
  const xhs = getXhs();
  if (!xhs || typeof xhs.setKeepScreenOn !== 'function') return;
  const ver = getXhsBuildVersion();
  if (ver !== null && ver < 9550) return;
  try {
    xhs.setKeepScreenOn({ keepScreenOn, fail() {} });
  } catch {
    // 静默忽略
  }
}
