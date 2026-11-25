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
