// Zero-invasion bilingual dictionary (zh default literal keys -> en overrides)

export type Lang = 'zh' | 'en';

const EN_DICT: Record<string, string> = {
  '幽林余烬': 'Blackwood Ember',
  // 标题页极小号副标题：中文模式显示英文名，英文模式反向显示中文名作为题签
  'BLACKWOOD EMBER': '幽林余烬',
  '在黑暗吞噬庇护所前，搜集一切能活下去的东西。':
    'Scavenge everything you need before the woods swallow your shelter.',
  '开始求生': 'Start Survival',
  '继续求生': 'Resume',
  '操作说明': 'Controls',
  '设置': 'Settings',
  '日志': 'Journal',
  '羊皮生存日志': 'Field Journal',
  '手绘林区方位草图': 'Hand-Drawn Sector Sketch',
  '生存纪事': 'Survival Log',
  '尚未踏足': 'Uncharted',
  '已探明': 'Explored',
  '返回': 'Back',
  '重新开始': 'Restart',
  '回到标题': 'Title Screen',
  '暂停': 'Pause',
  '制作': 'Craft',
  '白昼': 'Day',
  '黄昏': 'Dusk',
  '黑夜': 'Night',
  '浓雾': 'Mist',
  '细雨': 'Drizzle',
  '雷暴': 'Storm',
  '第 {n} 天': 'Day {n}',
  '生命': 'Health',
  '体力': 'Stamina',
  '电量': 'Battery',
  '发电机燃油': 'Generator Fuel',
  '燃料告急': 'Fuel Low',
  '发电机熄火': 'Generator Out',
  '发电机运行中': 'Generator Running',
  '庇护所': 'Hideout',
  '迷雾深林': 'Deep Woods',
  '坠毁货车': 'Crashed Truck',
  '废弃锯木厂': 'Old Sawmill',
  '枯林祭坛': 'Withered Shrine',
  '猎人营地': 'Hunter Camp',
  '木材': 'Wood',
  '废铁': 'Scrap',
  '燃油': 'Fuel',
  '布草': 'Herbs & Rags',
  '电池': 'Battery',
  '幽光菇': 'Odd Essence',
  '钉刺木板': 'Spiked Board',
  '锈蚀伐木斧': 'Rusted Axe',
  '手电筒': 'Flashlight',
  '照明弹': 'Flare',
  '草药绷带': 'Bandage',
  '捕兽夹': 'Bear Trap',
  '工作台制作': 'Workbench Crafting',
  '消耗资源合成求生道具，随时可在暗处应急。':
    'Combine scavenged supplies into tools to survive the night.',
  '制作完成': 'Crafted',
  '资源不足': 'Insufficient resources',
  '已装备': 'Equipped',
  '合成': 'Craft',
  '画质档位': 'Graphics Quality',
  '高': 'High',
  '均衡': 'Balanced',
  '流畅': 'Smooth',
  '语言': 'Language',
  '声音': 'Audio',
  '开启': 'On',
  '静音': 'Muted',
  '黑暗吞噬了你': 'Consumed by the Dark',
  '黎明破晓': 'Dawn Breaks',
  '存活天数': 'Days Survived',
  '搜刮容器': 'Containers Looted',
  '击退怪物': 'Horrors Repelled',
  '幽光菇收集': 'Essence Collected',
  '再次踏入森林': 'Enter the Woods Again',
  '长按 E 搜刮': 'Hold E to Search',
  '按 E 加固门窗 (木材×2)': 'Press E to Barricade (2 Wood)',
  '按 E 注入燃油 (燃油×1)': 'Press E to Refuel (1 Fuel)',
  '按 E 打开工作台': 'Press E for Workbench',
  '按 E 采摘幽光菇': 'Press E to Harvest Essence',
  '按 E 充电 (电池×1)': 'Press E to Recharge',
  '已加固': 'Barricaded',
  '空空如也': 'Empty',
  '搜刮中...': 'Searching...',
  '你点燃了发电机，暖光驱散了屋内的寒意。':
    'The generator roars to life, pushing back the cabin chill.',
  '门窗已用木板钉死。': 'Planks nailed securely across the opening.',
  '黄昏将至，雾气变浓了。尽快返回庇护所！':
    'Dusk settles and the fog thickens. Return to the Hideout!',
  '黑夜降临！有什么东西正在墙外徘徊……':
    'Night falls. Something is stalking outside the walls...',
  '天亮了。你熬过了又一个漫长的黑夜。':
    'Dawn breaks. You survived another long night.',
  '乌云压境，林间下起了冰冷的暴雨……':
    'Dark clouds gather as freezing rain lashes the pines...',
  '手电电量耗尽！寻找电池或在工作台制作备用电池。':
    'Flashlight dead! Scavenge batteries or craft a cell.',
  '捕兽夹触发！困住了入侵者！': 'Bear trap snapped! Intruder immobilized!',
  '投掷了照明弹！': 'Flare ignited and tossed!',
  '绷带止住了伤口，恢复了生命。': 'Bandage applied. Health restored.',
  '武器已升级为锈蚀伐木斧！': 'Weapon upgraded to Rusted Axe!',
  '获得了': 'Found',
  '移动与冲刺': 'Move & Sprint',
  'WASD / 方向键移动，按住 Shift 消耗体力冲刺':
    'WASD / Arrows to move, hold Shift to sprint using stamina',
  '照明与视线': 'Flashlight & Vision',
  '鼠标控制视线锥光方向，按 F 开关手电节省电量':
    'Aim cone of light with mouse; press F to toggle flashlight',
  '搜集与加固': 'Scavenge & Barricade',
  '靠近物资箱长按 E 搜刮；靠近庇护所门窗或发电机按 E 加固/加油':
    'Hold E near crates to loot; press E at doorways or generator',
  '近战与道具': 'Combat & Tools',
  '左键蓄力挥击，右键投掷照明弹，1-4 快捷道具，C 制作，J 翻阅羊皮日志':
    'LMB swing, RMB flare, 1-4 quick items, C craft, J field journal',
  '开发者 Variants 面板': 'Developer Variants',
  '时间跳转': 'Jump Time',
  '天气跳转': 'Jump Weather',
  '法线光影': 'Normal Shader',
  '平面光影': 'Flat 2D',
  'WebGL2法线': 'WebGL2 Normal',
  '天气系统': 'Weather',
  '静谧浓雾': 'Quiet Mist',
  '雷雨潮湿': 'Rain & Storm',
  '屋顶渐隐': 'Roof Cutaway',
  '常显室内': 'Always Open',
  '平滑渐隐': 'Smooth Fade',
  '做旧界面': 'UI Style',
  '暗色极简': 'Minimal Dark',
  '羊皮做旧': 'Aged Parchment',
  '照明色调': 'Light Tone',
  '冷白手电': 'Cold Beam',
  '暖黄油灯': 'Warm Lantern',
  '林间浓雾': 'Forest Fog',
  '轻薄雾气': 'Light Mist',
  '压迫浓雾': 'Dense Dread',
  '胶片噪点': 'Canvas Grain',
  '纯净画面': 'Clean',
  '油画噪点': 'Oil Grain',
  '视野角度': 'Cone Angle',
  '宽角 78°': 'Wide 78°',
  '压抑 62°': 'Tight 62°',
  '状态正常': 'Stable',
  '受伤': 'Wounded',
  '濒危': 'Critical',
  '恢复 45 生命值': 'Restores 45 Health',
  '照亮黑暗区域 22 秒，驱散阴影': 'Illuminates dark zone for 22s',
  '部署在门口，困住并重创入侵怪物': 'Place at doorways to snare monsters',
  '补充手电 65% 电量': 'Recharges 65% flashlight battery',
  '大幅提升近战伤害与击退距离': 'Greatly increases melee damage & knockback',
  '备用电池': 'Spare Cell',
  '升级伐木斧': 'Upgrade Axe',
  '已拥有最高级武器': 'Max weapon owned',
  '无木材加固！': 'Need 2 Wood to barricade!',
  '没有燃油了！': 'Out of Fuel!',
  '发电机燃料已满': 'Generator fuel full',
  '木板完好无损': 'Barricade intact',
  '攻击': 'Swing',
  '手电': 'Light',
  '搜刮': 'Use',
  '当前无照明弹': 'No Flares left',
  '当前无绷带': 'No Bandages left',
  '当前无捕兽夹': 'No Bear Traps left',
  '生命值已满': 'Health is already full',
  '放置了捕兽夹': 'Bear trap armed on the ground',
  '关闭': 'Close',
  '门窗木板被撕碎了！': 'Barricade planks torn apart!',
  '手电电量已补充': 'Flashlight battery recharged',
  '天黑前搜集木材、燃油与废铁，返回庇护所加固门窗。':
    'Scavenge wood, fuel & scrap before nightfall, then fortify the Hideout.',
  '破雾撤离': 'Escaped the Fog',
  '信号中继电台穿透了黑林浓雾，你在灰白黎明中找到了逃出生天的路。':
    'The radio relay pierced the Blackwood fog. At gray dawn, you found the way out.',
  '继续无尽求生': 'Continue Endless Survival',
  '中继零件': 'Relay Parts',
  '闪避': 'Dodge',
  '松开': 'Drop',
  '按 E 拖拽家具': 'Press E to Drag Furniture',
  '按 E 松开家具': 'Press E to Drop Furniture',
  '按 E 拾取信号中继零件': 'Press E to Take Relay Part',
  '挡路的家具被怪物撞碎了！': 'Barricading furniture smashed apart!',
  '中继就绪 (3/3) · 守至破晓撤离': 'Relay Ready (3/3) · Survive Until Dawn',
  '收集信号零件 0/3 · 探索地标': 'Find Relay Parts 0/3 · Explore Landmarks',
  '收集信号零件 1/3 · 探索地标': 'Find Relay Parts 1/3 · Explore Landmarks',
  '收集信号零件 2/3 · 探索地标': 'Find Relay Parts 2/3 · Explore Landmarks',
  // 第二轮 HUD：小地图地标缩写与无障碍分组名
  '货车': 'Truck',
  '锯木厂': 'Mill',
  '营地': 'Camp',
  '祭坛': 'Shrine',
  '资源': 'Supplies',
  '快捷栏': 'Quickbar',
  // R3 内心独白浮字（key 即中文原句；见 thoughts.ts THOUGHT_TEXT）
  '树在低语，听起来如此平静……': 'The trees whisper so calmly...',
  '这里的空气不对劲。': 'The air here is wrong.',
  '车上的人……都去哪儿了？': 'The people from the truck... where did they go?',
  '锯子还在等着谁回来。': 'The saws are still waiting for someone to come back.',
  '田地荒了很久，可脚印是新的。': 'These fields died long ago. The footprints are fresh.',
  '每扇窗都朝着林子，像在等谁。': 'Every window faces the woods, as if waiting for someone.',
  '钟不再响了。可我还是听见了什么。': 'The bell has stopped ringing. Yet I still hear something.',
  '医生……他也没能救自己。': "The doctor... he couldn't save himself either.",
  '水面下有东西在看着我。': 'Something beneath the water is watching me.',
  '有人在那里跳舞……不，不可能。': "Someone is dancing out there... no. It can't be.",
  '她又在雨里跳舞了。': "She's dancing in the rain again.",
  '是谁在敲那张桌子？': 'Who keeps knocking on that table?',
  '那把椅子……刚才是朝着桌子的。': 'That chair... it was facing the table.',
  '灯灭了。黑暗在靠近。': 'The light is gone. The dark is closing in.',
  '天黑了。我不该还在外面。': "It's dark. I shouldn't still be out here.",
  '天黑了。守住这点光。': 'Night. Keep this little light burning.',
  '我的腿快撑不住了。': 'My legs are about to give out.',
  '血止不住……我得找东西包扎。': "The bleeding won't stop... I need to bind it.",
  // R3 装备：火把 ⇄ 手枪
  '火把': 'Torch',
  '手枪': 'Pistol',
  '射击': 'Fire',
  '换弹': 'Reload',
  '切换武器': 'Swap Weapon',
  '手枪子弹': 'Pistol Rounds',
  '按 E 捡起火把': 'Press E to Pick Up Torch',
  '火把丢在了身侧——靠近按 E 捡回': 'Torch dropped beside you — press E nearby to pick it up',
  '火把在地上——靠近按 E 捡回': 'Your torch is on the ground — walk over and press E',
  '弹匣已空——按 R 换弹': 'Magazine empty — press R to reload',
  '没有子弹了': 'Out of ammo',
  '没有备用子弹': 'No spare rounds',
  '火把熄灭了——按 R 用木材+燃油重新点燃': 'Torch burned out — press R to rewrap it (Wood + Fuel)',
  '重新点燃火把需要 木材×1 + 燃油×1': 'Relighting the torch needs 1 Wood + 1 Fuel',
  '火把重新燃起来了': 'The torch flares back to life',
  '火把还很旺': 'The torch is still burning strong',
  '蓄力重击与道具': 'Charged Strikes & Tools',
  '左键挥动火把轻点快劈、长按蓄力爆发重击，右键投掷照明弹，1-4 快捷道具，C 制作，J 翻阅日志':
    'LMB swings the torch (tap = quick strike, hold = charged heavy), RMB throws a flare, 1-4 quick items, C craft, J journal',
  '火把与手枪': 'Torch & Pistol',
  'Q 切换火把/手枪（切枪时火把丢在身侧继续燃烧，靠近按 E 捡回）；手枪左键射击、R 换弹；火把燃尽后按 R 用木材+燃油重新点燃':
    'Q swaps torch/pistol (the torch is dropped beside you and keeps burning — press E to pick it up); pistol: LMB fire, R reload; a burnt-out torch is relit with R (Wood + Fuel)',
};

const STORAGE_KEY = 'blackwood_lang_v1';

function detectInitialLang(): Lang {
  try {
    const params = new URLSearchParams(window.location.search);
    const forced = params.get('lang');
    if (forced === 'en' || forced === 'zh') return forced;
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh') return saved;
  } catch {
    // ignore storage errors
  }
  const nav =
    typeof navigator !== 'undefined' ? navigator.languages?.[0] || navigator.language || 'zh' : 'zh';
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let currentLang: Lang = detectInitialLang();
const listeners = new Set<() => void>();

export const I18n = {
  get lang(): Lang {
    return currentLang;
  },
  setLang(next: Lang) {
    if (next === currentLang) return;
    currentLang = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
    listeners.forEach((fn) => fn());
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  t(key: string, vars?: Record<string, string | number>): string {
    let text = currentLang === 'en' ? EN_DICT[key] ?? key : key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replace(`{${k}}`, String(v));
      }
    }
    return text;
  },
};
