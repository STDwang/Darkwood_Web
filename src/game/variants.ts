// A/B Variants tuning system: URL (?v-<name>=<id>) > localStorage > default

export interface VariantDef {
  name: string;
  label: string;
  options: [string, string][];
  defaultId: string;
  reloadOnChange?: boolean;
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

  def(name: string, label: string, options: [string, string][], defaultId: string, reloadOnChange = false) {
    if (defs.some((d) => d.name === name)) return;
    defs.push({ name, label, options, defaultId, reloadOnChange });

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
    if (def.reloadOnChange && typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set(`v-${name}`, id);
      window.location.assign(url.toString());
      return;
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
Variants.def('palette', '色彩风格', [['a', '初版偏绿'], ['b', '东欧冷腐油画']], 'b');
Variants.def('vision', '视野恐惧', [['a', '传统可见'], ['b', '锥外记忆雾+盲区隐匿']], 'b');
Variants.def('weather', '天气系统', [['a', '静谧浓雾'], ['b', '雷雨潮湿']], 'b');
Variants.def('roof', '屋顶渐隐', [['a', '常显室内'], ['b', '平滑渐隐']], 'b');
Variants.def('paper', '做旧界面', [['a', '暗色极简'], ['b', '羊皮做旧']], 'b');
Variants.def('light', '照明色调', [['a', '冷白手电'], ['b', '暖黄油灯']], 'b');
Variants.def('fog', '林间浓雾', [['a', '轻薄雾气'], ['b', '压迫浓雾']], 'b');
Variants.def('grain', '胶片噪点', [['a', '纯净画面'], ['b', '油画噪点']], 'b');
Variants.def('cone', '视野角度', [['a', '宽角 78°'], ['b', '压抑 62°']], 'b');
// 电影级美术重制：a = release_v1 旧观感（扇形光芒/砖格屋顶/硬边树冠/旧后期），b = 缝隙体积光 + 破旧屋顶 + 不规则树冠 + 低频地表 + 分离调色/枝杈暗框后期
Variants.def('cine', '电影级美术', [['a', '旧版观感'], ['b', '电影级重制']], 'b');
// 手电树影（仅在 cine=b 下生效）：a = 旧版硬边纯黑影楔，b = 距离相关软半影 + 冷色本影 + 暖色半影边 + 叶隙斑驳冠影 + 雾雨体积暗柱
Variants.def('shade', '手电树影', [['a', '硬边黑影'], ['b', '彩色软半影']], 'b');
// 曝光协调（仅在 cine=b 下生效）：a = R2 高反差（锥外压暗 58%、浓雾灰纱、手电满增益），b = R3 锥外可读 + 抬高夜间环境光下限 + 轻雾 + 锥内降增益 + 白昼弱暗角
Variants.def('tone', '曝光协调', [['a', 'R2 高反差'], ['b', 'R3 协调可读']], 'b');
Variants.def('guidance', '目标+小地图', [['a', '现行提示'], ['b', '弱引导']], 'a');
Variants.def('homes', '建筑入口', [['a', '原尺寸/无提示'], ['b', '扩展室内/明确入口']], 'b', true);
Variants.def('motion', '跑动姿态', [['a', '原始动作'], ['b', '火把惯性/分段手臂']], 'b');
Variants.def('creature', '根生怪物', [['a', '原始轮廓'], ['b', '扭动花冠/开合口器']], 'b');
Variants.def('foley', '拟真音效', [['a', '提示音/统一低吼'], ['b', '材质/生物分层']], 'b');
