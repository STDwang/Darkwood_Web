// A/B Variants tuning system: URL (?v-<name>=<id>) > localStorage > default

export interface VariantDef {
  name: string;
  label: string;
  options: [string, string][];
  defaultId: string;
}

const STORAGE_PREFIX = 'blackwood_var_v2_';
const defs: VariantDef[] = [];
const values: Record<string, string> = {};
const listeners = new Set<() => void>();

export const Variants = {
  defs,
  val: values,

  isDevMode(): boolean {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.has('dev') || window.location.pathname.endsWith('/dev');
  },

  def(name: string, label: string, options: [string, string][], defaultId: string) {
    if (defs.some((d) => d.name === name)) return;
    defs.push({ name, label, options, defaultId });

    let chosen = defaultId;
    const validIds = new Set(options.map(([id]) => id));

    try {
      const saved = window.localStorage.getItem(STORAGE_PREFIX + name);
      if (saved && validIds.has(saved)) chosen = saved;
    } catch {
      // ignore
    }

    try {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get(`v-${name}`);
      if (fromUrl && validIds.has(fromUrl)) chosen = fromUrl;
    } catch {
      // ignore
    }

    values[name] = chosen;
  },

  set(name: string, id: string) {
    const def = defs.find((d) => d.name === name);
    if (!def || !def.options.some(([optId]) => optId === id)) return;
    if (values[name] === id) return;
    values[name] = id;
    try {
      window.localStorage.setItem(STORAGE_PREFIX + name, id);
    } catch {
      // ignore
    }
    listeners.forEach((fn) => fn());
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

// Steam-grade visual A/B Variants
Variants.def('shader', '法线光影', [['a', '平面光影'], ['b', 'WebGL2法线']], 'b');
Variants.def('weather', '天气系统', [['a', '静谧浓雾'], ['b', '雷雨潮湿']], 'b');
Variants.def('roof', '屋顶渐隐', [['a', '常显室内'], ['b', '平滑渐隐']], 'b');
Variants.def('paper', '做旧界面', [['a', '暗色极简'], ['b', '羊皮做旧']], 'b');
Variants.def('light', '照明色调', [['a', '冷白手电'], ['b', '暖黄油灯']], 'b');
Variants.def('fog', '林间浓雾', [['a', '轻薄雾气'], ['b', '压迫浓雾']], 'b');
Variants.def('grain', '胶片噪点', [['a', '纯净画面'], ['b', '油画噪点']], 'b');
Variants.def('cone', '视野角度', [['a', '宽角 78°'], ['b', '压抑 62°']], 'b');
