// Pure-procedural WebGL2 Deferred 2D Normal-Mapped Lighting, Soft Penumbra,
// Volumetric Fog Scattering, Wet Puddle Specular & ACES Post-Process Composer.

export interface GpuLight {
  x: number; // screen-space px
  y: number; // screen-space px
  radius: number;
  intensity: number;
  r: number;
  g: number;
  b: number;
  dirX: number; // normalized cone direction (or 0,0 for omni)
  dirY: number;
  coneCos: number; // -2.0 for 360° omni light, else cos(halfAngle)
  shadowChannel: number; // 0 = flashlight mask (R), 1 = lamp/flare mask (G), 2 = aura (B), 3 = unshadowed
}

export interface WebGLFrameUniforms {
  width: number;
  height: number;
  camX: number;
  camY: number;
  time: number;
  ambientR: number;
  ambientG: number;
  ambientB: number;
  wetness: number;
  rainIntensity: number;
  lightningFlash: number;
  bloodDread: number;
  fogDensity: number;
  penumbraSamples: number;
  enableGrain: boolean;
  puddleReflections: boolean;
  coldPalette: boolean;
  visionFog: boolean;
  // 电影级后期开关（?v-cine=b）：分离调色 + 压迫暗角 + 边缘枝杈剪影框 + 细颗粒/浮尘 + 边缘色差 + 夜晚曝光呼吸
  cine?: boolean;
  // 昼夜混合量：0 = 白昼，1 = 黑夜（黄昏按阶段进度线性过渡），用于暗框强度与曝光呼吸
  nightAmt?: number;
  // 手电树影电影级着色（?v-cine=b 且 ?v-shade=b）：距离相关软半影 + 冷色本影 + 暖色半影边 + 叶隙斑驳 + 体积暗柱
  shadeMode?: boolean;
  // R3 协调曝光（?v-cine=b 且 ?v-tone=b）：Darkwood 锐利 V 锥 + 近身暖光环 + 锥外冷灰记忆柔焦 + 夜间恐惧径向暗影
  tone?: boolean;
  // 危险/理智压迫强度 0..1（驱动夜间径向恐惧拉伸与微暗角脉动）
  danger?: number;
  lights: GpuLight[];
}

const VERT_SRC = `#version 300 es
precision highp float;
const vec2 POS[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUv;
void main() {
  vec2 p = POS[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uAlbedo;
uniform sampler2D uNormalWet; // R=Nx, G=Ny, B=PuddleMask, A=WetnessBoost
uniform sampler2D uShadow;    // R=FlashlightVis, G=WorldLightsVis, B=PlayerAuraVis

uniform vec2 uResolution;
uniform vec2 uCamPos;
uniform float uTime;
uniform vec3 uAmbient;
uniform float uWetness;
uniform float uRain;
uniform float uLightning;
uniform float uBloodDread;
uniform float uFogDensity;
uniform int uPenumbraSamples;
uniform int uEnableGrain;
uniform int uPuddleReflections;
uniform int uColdPalette;
uniform int uVisionFog;
uniform int uCine;
uniform float uNightAmt;
uniform int uShadeMode;
uniform int uTone;
uniform float uDanger;

uniform int uLightCount;
uniform vec4 uLightPosRad[12];   // xy = screen pos, z = radius, w = intensity
uniform vec4 uLightColChan[12];  // rgb = color, a = shadowChannel (0=R, 1=G, 2=B, 3=unshadowed)
uniform vec4 uLightCone[12];     // xy = dir, z = coneCos (-2 for omni), w = volumetricBoost

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  v += 0.55 * vnoise(p);
  v += 0.30 * vnoise(p * 2.13 + vec2(3.1, 1.7));
  v += 0.15 * vnoise(p * 4.21 + vec2(-2.4, 5.2));
  return v;
}

// Soft Penumbra Shadow Sampling (1 / 3 / 5 taps scaled by Quality tier)
vec3 sampleShadowSoft(vec2 uv) {
  vec3 c = texture(uShadow, uv).rgb;
  if (uPenumbraSamples <= 1) return c;
  vec2 px = 2.4 / uResolution;
  if (uPenumbraSamples <= 3) {
    vec3 s1 = texture(uShadow, uv + vec2(px.x, px.y)).rgb;
    vec3 s2 = texture(uShadow, uv - vec2(px.x, px.y)).rgb;
    return (c * 2.0 + s1 + s2) * 0.25;
  }
  vec3 sum = c * 0.34;
  sum += texture(uShadow, uv + vec2(px.x * 1.1, px.y * 0.4)).rgb * 0.165;
  sum += texture(uShadow, uv + vec2(-px.x * 0.5, px.y * 1.2)).rgb * 0.165;
  sum += texture(uShadow, uv + vec2(-px.x * 1.1, -px.y * 0.4)).rgb * 0.165;
  sum += texture(uShadow, uv + vec2(px.x * 0.5, -px.y * 1.2)).rgb * 0.165;
  return sum;
}

// ===== ?v-cine=b 且 ?v-shade=b：手电筒电影级软阴影（只读 uShadow 现有 R 通道遮挡，不新增任何遮挡/碰撞逻辑）=====
// 1) 宽域探测：中心 + 垂直光线方向两侧最大半影半径处各 1 次采样；三者全亮则直接返回（光锥内大部分像素只花 3 次采样）
// 2) 遮挡搜索（PCSS 式 blocker search）：从阴影中的点沿“像素→光源”方向步进，找到首个受光点 = 遮挡物边界，再二分细化
// 3) 半影宽度 ∝ 阴影已延伸长度 / 光源到遮挡物距离（近锐远糊），在垂直光线方向二分定位边界后解析求软化可见度
// 采样数遵守 uPenumbraSamples 档位：3 -> 4 步搜索 + 2 次二分 + 每侧 3 次边界二分；5 -> 6 步搜索 + 3 次二分 + 每侧 5 次边界二分
// 4) 宽遮挡判定：在遮挡边界后方两侧 ±32px 各采样 1 次，两侧都暗 = 墙体/门板等宽遮挡（宽于任何树干），其后方不做填充光，防止“透墙漏光”
// 返回 vec4：x = 软化后的可见度，y = 该点距遮挡物的阴影长度（px），z = 宽域平均可见度（体积暗柱用），w = 1 表示宽遮挡
vec4 flashShadowSoft(vec2 px, vec2 lightPx, float rawVis) {
  vec2 toL = lightPx - px;
  float dL = length(toL);
  if (dL < 4.0) return vec4(rawVis, 0.0, rawVis, 0.0);
  vec2 dir = toL / dL;
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 invRes = 1.0 / uResolution;
  float rMax = 3.5 + dL * 0.055;

  float wl = texture(uShadow, (px + perp * rMax) * invRes).r;
  float wr = texture(uShadow, (px - perp * rMax) * invRes).r;
  float wide = (wl + wr + rawVis * 2.0) * 0.25;
  if (min(rawVis, min(wl, wr)) > 0.996) return vec4(1.0, 0.0, 1.0, 0.0);

  // 受光像素位于影楔旁：改从处于阴影的一侧起搜，使半影同时向亮侧展开
  vec2 start = px;
  if (rawVis > 0.5) start = (wl < wr) ? (px + perp * rMax) : (px - perp * rMax);

  int nSearch = uPenumbraSamples >= 5 ? 6 : 4;
  int nRefine = uPenumbraSamples >= 5 ? 3 : 2;
  float stepLen = dL / float(nSearch + 1);
  float sLit = dL;
  float sDark = 0.0;
  for (int k = 1; k <= 6; k++) {
    if (k > nSearch) break;
    float s = stepLen * float(k);
    float v = texture(uShadow, (start + dir * s) * invRes).r;
    if (v > 0.5) {
      sLit = s;
      break;
    }
    sDark = s;
  }
  for (int k = 0; k < 3; k++) {
    if (k >= nRefine || sLit >= dL) break;
    float sm = 0.5 * (sLit + sDark);
    float v = texture(uShadow, (start + dir * sm) * invRes).r;
    if (v > 0.5) {
      sLit = sm;
    } else {
      sDark = sm;
    }
  }
  float shadowLen = 0.5 * (sLit + sDark);
  // 宽遮挡判定：取最后一个确认处于阴影中的搜索点（紧贴遮挡物后方），检查两侧 ±32px
  vec2 behind = start + dir * sDark;
  float bl = texture(uShadow, (behind + perp * 32.0) * invRes).r;
  float br = texture(uShadow, (behind - perp * 32.0) * invRes).r;
  // 连续取值（双线性采样值相乘）避免分类突变产生块状边界；整条射线都找不到受光点（遮挡物紧贴光源，如贴墙打光）按宽遮挡处理
  float broad = sLit >= dL ? 1.0 : (1.0 - bl) * (1.0 - br);

  float blockerDist = max(dL - shadowLen, 10.0);
  // 统一平滑半影：避免因离散搜索导致的墙体阴影阶梯/百叶窗条纹
  float pen = clamp(12.0 * shadowLen / blockerDist + shadowLen * 0.025, 0.8, rMax);
  if (sLit >= dL) pen = min(pen, 1.5);

  // 解析半影（无抽样台阶、无噪点）：在垂直光线方向，对“中心与 ±rMax 处状态不同”的一侧二分定位遮挡边界距离 e，
  // 按 [-pen, pen] 盒式窗口内异态长度 (pen - e) 解析求可见度，再做 smoothstep 柔化成 S 形渐变
  bool cLit = rawVis > 0.5;
  int nBis = uPenumbraSamples >= 5 ? 5 : 3;
  float oppL = 0.0;
  float oppR = 0.0;
  if ((wl > 0.5) != cLit) {
    float lo = 0.0;
    float hi = rMax;
    for (int k = 0; k < 5; k++) {
      if (k >= nBis) break;
      float mid = 0.5 * (lo + hi);
      bool mLit = texture(uShadow, (px + perp * mid) * invRes).r > 0.5;
      if (mLit == cLit) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    oppL = clamp((pen - 0.5 * (lo + hi)) / (2.0 * pen), 0.0, 0.5);
  }
  if ((wr > 0.5) != cLit) {
    float lo = 0.0;
    float hi = rMax;
    for (int k = 0; k < 5; k++) {
      if (k >= nBis) break;
      float mid = 0.5 * (lo + hi);
      bool mLit = texture(uShadow, (px - perp * mid) * invRes).r > 0.5;
      if (mLit == cLit) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    oppR = clamp((pen - 0.5 * (lo + hi)) / (2.0 * pen), 0.0, 0.5);
  }
  float opp = oppL + oppR;
  float visA = cLit ? 1.0 - opp : opp;
  visA = visA * visA * (3.0 - 2.0 * visA);
  return vec4(clamp(visA, 0.0, 1.0), shadowLen, wide, broad);
}

// 本影色：偏冷深蓝绿灰（亮度归一，b >= g 避免绿通道主导），按 30% 混入当前环境光/月光色相
vec3 umbraTintColor() {
  float ambLum = max(dot(uAmbient, vec3(0.2126, 0.7152, 0.0722)), 0.0001);
  vec3 ambHue = clamp(uAmbient / ambLum, vec3(0.0), vec3(2.0));
  return mix(vec3(0.77, 1.03, 1.22), ambHue, 0.30);
}

// 叶隙斑驳透射噪声：沿光线方向拉长的世界锚定值噪声（投影光斑随距离被拉长）
float leafDapple(vec2 wpx, vec2 dir) {
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 q = vec2(dot(wpx, dir) * 0.032, dot(wpx, perp) * 0.095);
  float n = vnoise(q) * 0.62 + vnoise(q * 2.3 + vec2(3.1, -1.7)) * 0.38;
  return smoothstep(0.42, 0.78, n);
}

vec3 acesFilm(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// 脊状带：r 为 1-|2n-1| 的脊值，w 为线宽；w 趋零时平滑消失（避免 smoothstep 边界相等的未定义行为）
float ridgeBand(float r, float w) {
  return clamp((r - 1.0 + w) / max(0.35 * w, 0.0015), 0.0, 1.0);
}

// Darkwood 标志性屏幕边缘黑色枝杈/根须剪影框（三层域扭曲脊状噪声 + 不规则实心边缘，随时间极缓慢蠕动）
// 返回 0..1 遮罩，1 = 完全被枝杈遮挡
float rootFrameMask(vec2 uv, float t) {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 q = (uv - 0.5) * vec2(aspect, 1.0);
  float ex = 0.5 * aspect - abs(q.x);
  float ey = 0.5 - abs(q.y);
  float across = min(ex, ey);
  if (across > 0.34) return 0.0;
  // 屏幕四角处枝杈更粗更长
  float corner = 1.0 - smoothstep(0.05, 0.30, max(ex, ey));
  float breathe = 1.0 + 0.04 * sin(t * 0.21);

  // 低频域扭曲：让根须弯折盘绕并极缓慢蠕动
  float wx = vnoise(q * 2.3 + vec2(5.0 + t * 0.010, 1.0)) - 0.5;
  float wy = vnoise(q * 2.3 + vec2(11.0, -3.0 - t * 0.008)) - 0.5;
  vec2 warp = vec2(wx, wy);

  // 第一层：粗壮主枝
  float n1 = vnoise(q * 5.2 + warp * 1.6);
  float r1 = 1.0 - abs(2.0 * n1 - 1.0);
  float f1 = 1.0 - smoothstep(0.0, (0.15 + 0.13 * corner) * breathe, across);
  float b1 = ridgeBand(r1, 0.09 * f1 * f1);

  // 第二层：中等分枝（旋转 0.7rad 打破值噪声网格方向性）
  vec2 p2 = mat2(0.764842, 0.644218, -0.644218, 0.764842) * (q * 12.0 + warp * 3.0);
  float n2 = vnoise(p2 + vec2(3.7, -1.3));
  float r2 = 1.0 - abs(2.0 * n2 - 1.0);
  float f2 = 1.0 - smoothstep(0.0, (0.10 + 0.08 * corner) * breathe, across);
  float b2 = ridgeBand(r2, 0.08 * f2 * f2);

  // 第三层：细碎须根（旋转 1.9rad）
  vec2 p3 = mat2(-0.323290, 0.946300, -0.946300, -0.323290) * (q * 24.0 + warp * 5.0);
  float n3 = vnoise(p3 + vec2(-7.1, 2.9));
  float r3 = 1.0 - abs(2.0 * n3 - 1.0);
  float f3 = 1.0 - smoothstep(0.0, (0.065 + 0.05 * corner) * breathe, across);
  float b3 = ridgeBand(r3, 0.09 * f3 * f3);

  // 不规则实心边缘（四角更厚）
  float rimN = vnoise(q * 7.0 + vec2(2.0, 0.0));
  float rimW = 0.003 + 0.014 * rimN * rimN + 0.04 * corner * corner;
  float rim = 1.0 - smoothstep(rimW * 0.5, rimW, across);

  return clamp(max(max(rim, b1), max(b2 * 0.92, b3 * 0.85)), 0.0, 1.0);
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 screenPx = uv * uResolution;
  vec2 worldPx = screenPx + uCamPos - uResolution * 0.5;

  // R3 协调曝光开关与昼夜混合量（0 = 白昼，1 = 黑夜）
  float nA = clamp(uNightAmt, 0.0, 1.0);
  bool toneOn = (uTone == 1);
  vec2 centered = vUv - 0.5;
  float edgeDist = length(centered);
  vec3 albedo;
  if (uBloodDread > 0.08) {
    // 仅受伤时开启微弱血色色差，常态保持零色差极致锐利清晰
    float ca = uBloodDread * 0.0030 * edgeDist;
    albedo.r = texture(uAlbedo, uv + vec2(ca, 0.0)).r;
    albedo.g = texture(uAlbedo, uv).g;
    albedo.b = texture(uAlbedo, uv - vec2(ca, 0.0)).b;
  } else {
    albedo = texture(uAlbedo, uv).rgb;
  }

  vec4 nw = texture(uNormalWet, uv);
  vec3 N = normalize(vec3(nw.r * 2.0 - 1.0, nw.g * 2.0 - 1.0, 0.72));
  float puddleMask = nw.b;
  float activeWet = clamp(puddleMask * (0.28 + uWetness * 0.95) + uWetness * 0.16, 0.0, 1.0);

  // 雨滴击打积水洼地的双圈同心法线扰动（手电/篝火/吊灯/闪电扫过时呈现湿润反光与细腻波纹高光）
  if (uPuddleReflections == 1 && activeWet > 0.22 && uRain > 0.05) {
    vec2 cell = floor(worldPx * 0.042);
    vec2 f = fract(worldPx * 0.042) - 0.5;
    float h = hash21(cell);
    float phase = fract(uTime * (0.95 + h * 0.65) + h * 7.0);
    float rDist = length(f);
    float ring1 = exp(-abs(rDist - phase * 0.46) * 34.0) * (1.0 - phase);
    float phase2 = clamp(phase - 0.14, 0.0, 1.0);
    float ring2 = exp(-abs(rDist - phase2 * 0.40) * 42.0) * (1.0 - phase2) * 0.55;
    N = normalize(N + vec3(f.x, f.y, 0.0) * (ring1 + ring2) * uRain * 1.75);
  }

  vec3 shadowVis = sampleShadowSoft(uv);

  // 潮湿洼地微压暗并带冷调天光反射
  vec3 surfaceAlbedo = mix(albedo, albedo * vec3(0.56, 0.62, 0.68), activeWet * 0.52);

  // 环境光与闪电照明
  float directVis = 0.0;
  vec3 ambientLight = uAmbient * (0.82 + 0.18 * max(N.z, 0.0));
  vec3 directLight = vec3(0.0);

  if (uLightning > 0.01) {
    vec3 skyDir = normalize(vec3(-0.45, -0.55, 0.7));
    float ndl = max(dot(N, skyDir), 0.18);
    vec3 boltCol = vec3(0.68, 0.78, 0.94) * uLightning * 1.55;
    directLight += boltCol * ndl;
    if (uPuddleReflections == 1 && activeWet > 0.22) {
      directLight += boltCol * activeWet * 1.15;
    }
    directVis = max(directVis, uLightning * 0.9);
  }

  vec3 volumetricScatter = vec3(0.0);
  vec3 glareAccum = vec3(0.0);

  for (int i = 0; i < 12; i++) {
    if (i >= uLightCount) break;
    vec4 pr = uLightPosRad[i];
    vec4 cc = uLightColChan[i];
    vec4 cn = uLightCone[i];

    // Darkwood 真实光影曝光：保留锥内清晰反差与火把/油灯暖琥珀层次，防多光源过曝截断
    float lw = pr.w;
    if (toneOn) {
      if (cc.a < 0.5) {
        // 视野锥/手电主光：白昼克制增亮，黑夜聚焦切开深暗但保持胶片暗调
        lw *= mix(0.54, 0.68, nA);
      } else if (cc.a < 1.5 || cc.a > 2.5) {
        // 吊灯 / 火把 / 照明弹 / 篝火：低彩度暖琥珀光
        lw *= mix(mix(0.52, 0.74, nA), 0.92, smoothstep(3.0, 3.6, pr.w));
      } else {
        // 角色近身 360° 柔和炭笔毛边感知光圈
        lw *= mix(0.76, 0.92, nA);
      }
    }

    vec2 toPx = screenPx - pr.xy;
    float d = length(toPx);
    if (d > pr.z) continue;

    float normD = d / pr.z;
    // 视野锥中远段保持充足辨识度，近身光环叠加上手绘炭笔颗粒毛边（对标原作图 6/10），无阴影小磷光高次柔边衰减
    float attenPow = (cc.a < 0.5) ? 1.04 : (cc.a > 2.5) ? 2.45 : (cc.a > 1.5) ? 1.58 : 1.48;
    float atten = pow(clamp(1.0 - normD, 0.0, 1.0), attenPow);
    if (toneOn && cc.a > 1.5 && cc.a < 2.5) {
      // 原作标志性角色脚下炭笔颗粒蚀刻近身光环边缘
      float haloGrain = vnoise(worldPx * 0.14 + vec2(3.7, -2.1)) * 0.65 + vnoise(worldPx * 0.31) * 0.35;
      float edgeBand = smoothstep(0.42, 0.92, normD) * (1.0 - smoothstep(0.90, 1.0, normD));
      atten = clamp(atten - edgeBand * (0.48 - haloGrain * 0.62), 0.0, 1.0);
    }

    float spot = 1.0;
    if (cn.z > -1.5) {
      vec2 dirToPx = d > 0.001 ? toPx / d : cn.xy;
      float cosAng = dot(dirToPx, cn.xy);
      if (toneOn && cc.a < 0.5) {
        // Darkwood 标志性锐利 V 字视野锥 + 极细微手绘炭笔有机毛边蚀刻（对标原作图 6/10/13）
        float ang = acos(clamp(cosAng, -1.0, 1.0));
        float halfA = acos(clamp(cn.z, -1.0, 1.0));
        float charcoalJit = (vnoise(worldPx * 0.085 + cn.xy * 4.0) - 0.5) * 0.022
                          + (vnoise(worldPx * 0.24 - vec2(uTime * 0.12)) - 0.5) * 0.010;
        float effAng = ang + charcoalJit * smoothstep(28.0, 180.0, d);
        float edgeSharp = mix(0.030, 0.048, nA);
        float core = 1.0 - smoothstep(halfA - edgeSharp * 0.45, halfA + edgeSharp, effAng);
        float halo = (1.0 - smoothstep(halfA - 0.008, halfA + 0.095, effAng)) * mix(0.05, 0.11, nA);
        spot = max(core, halo);
      } else {
        spot = smoothstep(cn.z - 0.045, cn.z + 0.045, cosAng);
      }
      if (spot <= 0.001) continue;
    }

    // 还原原作东欧腐朽油画光色对比：手电视野锥呈浑浊低彩度暖枯草/旧羊皮色，与锥外冷石板灰形成深沉冷暖反差
    vec3 lc = (toneOn && cc.a < 0.5) ? mix(cc.rgb, vec3(0.95, 0.89, 0.74), mix(0.46, 0.34, nA)) : cc.rgb;

    float vis = 1.0;
    // 电影级手电树影：保留贴近树干/墙体的锐利深黑影柱，远端柔和过渡，杜绝墙后漏光
    bool shadeFlash = (uShadeMode == 1 && cc.a < 0.5);
    float shLen = 0.0;
    float visWide = 1.0;
    float broadOcc = 0.0;
    float coneEdgeW = 1.0;
    if (shadeFlash) {
      if (uPenumbraSamples > 1) {
        float rawR = texture(uShadow, uv).r;
        vec4 fs = flashShadowSoft(screenPx, pr.xy, rawR);
        float cA = dot(toPx / max(d, 0.001), cn.xy);
        float sinC = sqrt(max(1.0 - cn.z * cn.z, 0.0));
        // 遮挡多边形外扩 0.05rad -> 边界保护取 0.03rad
        float edgeCos = cn.z * 0.99955 - sinC * 0.029995;
        float wEdge = smoothstep(edgeCos - 0.010, edgeCos + 0.010, cA);
        // 墙体/建筑阴影使用平滑解析半影，杜绝阶梯百叶窗锯齿（树影改由渲染层绘制贴地渐淡地面投影）
        vis = mix(rawR, mix(rawR, fs.x, 0.72), wEdge);
        shLen = fs.y;
        visWide = mix(rawR, fs.z, wEdge);
        broadOcc = fs.w;
        coneEdgeW = wEdge;
      } else {
        vis = shadowVis.r;
        shLen = 120.0;
        visWide = vis;
        broadOcc = 1.0;
      }
    } else if (cc.a < 0.5) vis = shadowVis.r;
    else if (cc.a < 1.5) vis = shadowVis.g;
    else if (cc.a < 2.5) vis = shadowVis.b;

    if (vis <= 0.003 && !shadeFlash) continue;

    vec3 L = normalize(vec3(-toPx.x, -toPx.y, 72.0));
    float ndl = max(dot(N, L), 0.14);

    float spec = 0.0;
    if (uPuddleReflections == 1 && activeWet > 0.16) {
      vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
      float shininess = mix(18.0, 56.0, puddleMask);
      spec = pow(max(dot(N, H), 0.0), shininess) * activeWet * 1.25;
    }

    vec3 contrib = lc * lw * atten * spot * vis;
    directLight += contrib * (ndl * 1.26 + spec);

    if (shadeFlash) {
      float baseI = lw * atten * spot;
      float umbra = 1.0 - vis;
      float fade = smoothstep(24.0, 340.0, shLen);
      vec2 dirToLight = d > 0.001 ? -toPx / d : -cn.xy;
      float dap = leafDapple(worldPx, dirToLight);
      // 墙体后方保持均匀深邃暗影，绝不出现离散条纹或透墙漏光
      float fill = 0.016 * coneEdgeW;
      directLight += umbraTintColor() * baseI * umbra * fill * (0.55 + 0.45 * ndl);
      float fringe = 4.0 * vis * (1.0 - vis);
      directLight += lc * vec3(1.0, 0.84, 0.62) * baseI * fringe * 0.032;
    }

    // 累计真实光照可见度（用于视野锥内外锐利分界：锥内高清有色，锥外冷灰朦胧记忆层）
    float lightReveal = atten * spot * vis * (cc.a < 0.5 ? 2.45 : cc.a < 1.5 ? 1.85 : 1.55);
    directVis = max(directVis, clamp(lightReveal, 0.0, 1.0));

    if (cn.w > 0.01) {
      float mist = fbm(worldPx * 0.011 + vec2(uTime * 0.18, -uTime * 0.11));
      vec3 scatSrc = contrib;
      if (shadeFlash) {
        float sVis = max(mix(vis, visWide, 0.45), smoothstep(40.0, 360.0, shLen) * 0.18 * (1.0 - broadOcc) * coneEdgeW);
        scatSrc = lc * lw * atten * spot * sVis * (1.0 + uRain * 0.18);
      }
      volumetricScatter += scatSrc * cn.w * (0.34 + mist * 0.68) * (0.42 + uFogDensity * 0.48);
    }

    // 强点光源（吊灯、篝火、火盆、照明弹）处叠加克制微眩光
    if (cn.z < -1.5 && cc.a < 1.5 && pr.w >= 1.6) {
      float gx = abs(toPx.x) / max(pr.z * 0.52, 56.0);
      float gy = abs(toPx.y) / 9.0;
      float streak = exp(-gx * 2.5 - gy * 1.65) * vis;
      float coreGlow = exp(-d / 26.0) * vis * 0.48;
      glareAccum += cc.rgb * (streak * 0.12 + coreGlow * 0.15) * clamp(lw * 0.35, 0.4, 1.1);
    }
  }

  // Darkwood 灵魂：锥内温暖枯黄高清色彩，锥外通透冷石板灰记忆层（对标原作图 2~5：暗而清晰可读，绝不死黑一团）
  vec3 effectiveAlbedo = surfaceAlbedo;
  vec3 effectiveAmbient = ambientLight;
  if (uVisionFog == 1) {
    float reveal = smoothstep(0.05, 0.30, directVis);
    float gray = dot(surfaceAlbedo, vec3(0.299, 0.587, 0.114));
    // 锥外通透冷石板灰（白昼与黄昏下清晰呈现树墩、茶田、木板桥与泥土肌理，黑夜自然沉入深暗）
    vec3 memoryCold = vec3(gray) * vec3(0.84, 0.88, 0.92);
    float desatAmt = mix(0.76, 0.92, nA);
    effectiveAlbedo = mix(mix(surfaceAlbedo, memoryCold, desatAmt), surfaceAlbedo, reveal);
    effectiveAmbient *= mix(mix(0.66, 0.26, nA), 1.0, reveal);
  }

  // 多光源柔和胶片肩部压缩（防止室内双吊灯+火盆+手持火把线性叠加烧白过曝，完整保留木地板与地毯暗纹）
  vec3 softDirect = directLight / (vec3(1.0) + directLight * 0.42);
  float dirLum = dot(softDirect, vec3(0.2126, 0.7152, 0.0722));
  softDirect = mix(softDirect, vec3(dirLum) * vec3(1.02, 0.99, 0.93), smoothstep(0.55, 1.65, dirLum) * 0.34);

  // 数值安全红线：在 ACES 之前严格 clamp，杜绝 NaN/Inf 黑块
  vec3 totalLight = clamp(effectiveAmbient + softDirect, vec3(0.0), vec3(4.5));
  volumetricScatter = clamp(volumetricScatter, vec3(0.0), vec3(2.5));
  glareAccum = clamp(glareAccum, vec3(0.0), vec3(0.75));

  // 克制体积散射（0.045），避免泛灰发白，确保画面阴郁通透且细节锐利
  vec3 color = effectiveAlbedo * totalLight + volumetricScatter * 0.045 + glareAccum * 0.46;

  // 东欧油画帆布织纹与胶片颗粒
  if (uEnableGrain == 1 && uCine == 0) {
    float weave = (sin(worldPx.x * 1.6) * sin(worldPx.y * 1.6)) * 0.013;
    float grain = (hash21(screenPx + fract(uTime * 29.0) * 100.0) - 0.5) * 0.038;
    color += vec3(weave + grain) * (0.32 + length(color) * 0.62);
  }

  if (uCine == 1) {
    // 夜晚轻微曝光呼吸（幅度克制）
    float breath = 1.0 + clamp(uNightAmt, 0.0, 1.0) * (0.022 * sin(uTime * 0.63) + 0.010 * sin(uTime * 1.71 + 1.3));
    color *= breath;
  }

  // 数值安全红线：所有累加项在 ACES 之前再次 clamp 至有限区间
  color = clamp(color, vec3(0.0), vec3(10.0));

  // ACES Filmic 色调映射（高对比、深沉暗部、细腻低彩暖高光）
  color = acesFilm(color * 1.01);

  if (uColdPalette == 1) {
    // Darkwood 东欧阴郁油画色彩收敛：胶片低饱和度（保留苔藓暗绿、泥褐、干涸血迹与旧羊皮暖光，杜绝艳丽荧光色）
    float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(lum), color, 0.76);
    float shadowMask = clamp(1.0 - lum * 2.5, 0.0, 0.45);
    color = mix(color, color * vec3(0.89, 0.96, 1.04), shadowMask);
  } else {
    color = mix(color, color * vec3(0.93, 0.98, 1.04), clamp(1.0 - dot(color, vec3(0.3, 0.6, 0.1)) * 2.2, 0.0, 0.45));
  }

  if (uCine == 1) {
    // 胶片分离调色：冷青暗部 + 微微做旧暖高光
    float lumS = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float wShadow = 1.0 - smoothstep(0.02, 0.28, lumS);
    float wHigh = smoothstep(0.32, 0.82, lumS);
    vec3 coldTint = vec3(0.88, 1.00, 1.08) / 0.98026;
    vec3 ochreTint = vec3(1.08, 1.00, 0.84) / 1.0054;
    color *= mix(vec3(1.0), coldTint, wShadow * 0.48);
    color *= mix(vec3(1.0), ochreTint, wHigh * 0.24);

    // 胶片微对比塑形：微压暗部、保持通透中亮调
    if (toneOn) {
      color = pow(clamp(color, vec3(0.0), vec3(1.0)), vec3(mix(0.94, 0.97, nA)));
    }

    // 压迫暗角：白昼柔和包围，黑夜沉重聚焦（对标截图 9, 10, 11, 12）
    float vigStart = mix(0.46, 0.34, nA);
    float vigFloor = mix(0.42, 0.08, nA);
    float vigC = 1.0 - smoothstep(vigStart, 0.78, edgeDist);
    color *= mix(vigFloor, 1.0, vigC);

    // Darkwood 标志性夜间/高危径向恐惧暗影拉丝（对标截图 12）
    float terror = clamp(uDanger * 0.85 + nA * 0.38, 0.0, 1.0);
    if (terror > 0.15 && edgeDist > 0.26) {
      float radAng = atan(centered.y, centered.x);
      float streakN = vnoise(vec2(radAng * 14.0, edgeDist * 2.2 - uTime * 0.28));
      float streakN2 = vnoise(vec2(radAng * 27.0 + 3.1, edgeDist * 1.5 + uTime * 0.19));
      float streak = smoothstep(0.42, 0.88, streakN * 0.65 + streakN2 * 0.35);
      float edgeEnv = smoothstep(0.28, 0.72, edgeDist);
      // 极轻的径向冷白微丝 + 深黑拉丝压迫（截图 12 的噩梦压迫氛围）
      color *= 1.0 - edgeEnv * (0.45 + 0.35 * streak) * terror * 0.65;
      color += vec3(0.10, 0.12, 0.13) * edgeEnv * pow(streak, 3.0) * terror * 0.35;
    }

    // 极克制的屏幕外缘暗枝剪影（主枯枝已在世界空间绘制，此处只保留极弱暗框呼吸）
    float frameK = mix(0.06, 0.32, nA);
    color *= 1.0 - rootFrameMask(vUv, uTime) * frameK;

    // 少量受光浮尘
    vec2 dg = screenPx / 86.0 + vec2(uTime * 0.11, uTime * 0.045);
    vec2 dcell = floor(dg);
    float dh = hash21(dcell + 17.0);
    if (dh > 0.88) {
      vec2 dpos = vec2(fract(dh * 13.71), fract(dh * 7.31)) * 0.7 + 0.15;
      dpos += 0.08 * vec2(sin(uTime * 0.7 + dh * 40.0), cos(uTime * 0.53 + dh * 23.0));
      float dd = length(fract(dg) - dpos);
      float mote = 1.0 - smoothstep(0.0, 0.035, dd);
      float litLum = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color += vec3(0.92, 0.84, 0.70) * mote * 0.065 * smoothstep(0.04, 0.28, litLum);
    }

    // 胶片微颗粒
    if (uEnableGrain == 1) {
      float lumG = dot(color, vec3(0.2126, 0.7152, 0.0722));
      float g1 = hash21(screenPx + fract(uTime * 23.0) * 97.0) - 0.5;
      float g2 = hash21(screenPx * 1.37 + fract(uTime * 17.0) * 61.0) - 0.5;
      float gAmt = 0.034 * smoothstep(0.015, 0.22, lumG) * (1.0 - 0.45 * smoothstep(0.55, 0.95, lumG));
      color += vec3((g1 + g2) * 0.5 * gAmt);
    }
  } else {
    float vig = smoothstep(0.88, 0.26, edgeDist);
    color *= mix(0.20, 1.0, vig);
  }

  // 受伤血色压迫暗角
  if (uBloodDread > 0.01) {
    float pulse = 0.84 + 0.16 * sin(uTime * 6.5);
    float bMask = smoothstep(0.26, 0.78, edgeDist) * uBloodDread * pulse;
    color = mix(color, vec3(0.42, 0.04, 0.04), clamp(bMask * 0.75, 0.0, 0.72));
  }

  fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

export class WebGL2Composer {
  readonly canvas: HTMLCanvasElement;
  readonly available: boolean;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private texAlbedo: WebGLTexture | null = null;
  private texNormal: WebGLTexture | null = null;
  private texShadow: WebGLTexture | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};

  private posRadBuf = new Float32Array(12 * 4);
  private colChanBuf = new Float32Array(12 * 4);
  private coneBuf = new Float32Array(12 * 4);

  constructor(outputCanvas?: HTMLCanvasElement) {
    this.canvas = outputCanvas ?? document.createElement('canvas');
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = this.canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance',
      });
    } catch {
      gl = null;
    }

    if (!gl) {
      this.available = false;
      return;
    }

    const prog = this.createProgram(gl, VERT_SRC, FRAG_SRC);
    if (!prog) {
      this.available = false;
      return;
    }

    this.gl = gl;
    this.program = prog;
    this.vao = gl.createVertexArray();
    this.texAlbedo = this.createTexture(gl);
    this.texNormal = this.createTexture(gl);
    this.texShadow = this.createTexture(gl);

    const names = [
      'uAlbedo',
      'uNormalWet',
      'uShadow',
      'uResolution',
      'uCamPos',
      'uTime',
      'uAmbient',
      'uWetness',
      'uRain',
      'uLightning',
      'uBloodDread',
      'uFogDensity',
      'uPenumbraSamples',
      'uEnableGrain',
      'uPuddleReflections',
      'uColdPalette',
      'uVisionFog',
      'uCine',
      'uNightAmt',
      'uShadeMode',
      'uTone',
      'uDanger',
      'uLightCount',
      'uLightPosRad',
      'uLightColChan',
      'uLightCone',
    ];
    for (const n of names) {
      this.uniforms[n] = gl.getUniformLocation(prog, n);
    }

    this.available = true;
  }

  private compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('WebGL2 shader compile failed:', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  private createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram | null {
    const vs = this.compileShader(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = this.compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    if (!prog) return null;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('WebGL2 program link failed:', gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
  }

  private createTexture(gl: WebGL2RenderingContext): WebGLTexture | null {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  resize(pixelW: number, pixelH: number) {
    if (!this.available || !this.gl) return;
    if (this.canvas.width !== pixelW || this.canvas.height !== pixelH) {
      this.canvas.width = pixelW;
      this.canvas.height = pixelH;
    }
    this.gl.viewport(0, 0, pixelW, pixelH);
  }

  compose(
    albedoCanvas: HTMLCanvasElement,
    normalCanvas: HTMLCanvasElement,
    shadowCanvas: HTMLCanvasElement,
    u: WebGLFrameUniforms
  ): boolean {
    if (!this.available || !this.gl || !this.program) return false;
    const gl = this.gl;

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texAlbedo);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, albedoCanvas);
    gl.uniform1i(this.uniforms.uAlbedo, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texNormal);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, normalCanvas);
    gl.uniform1i(this.uniforms.uNormalWet, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.texShadow);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, shadowCanvas);
    gl.uniform1i(this.uniforms.uShadow, 2);

    gl.uniform2f(this.uniforms.uResolution, u.width, u.height);
    gl.uniform2f(this.uniforms.uCamPos, u.camX, u.camY);
    gl.uniform1f(this.uniforms.uTime, u.time);
    gl.uniform3f(this.uniforms.uAmbient, u.ambientR, u.ambientG, u.ambientB);
    gl.uniform1f(this.uniforms.uWetness, u.wetness);
    gl.uniform1f(this.uniforms.uRain, u.rainIntensity);
    gl.uniform1f(this.uniforms.uLightning, u.lightningFlash);
    gl.uniform1f(this.uniforms.uBloodDread, u.bloodDread);
    gl.uniform1f(this.uniforms.uFogDensity, u.fogDensity);
    gl.uniform1i(this.uniforms.uPenumbraSamples, u.penumbraSamples);
    gl.uniform1i(this.uniforms.uEnableGrain, u.enableGrain ? 1 : 0);
    gl.uniform1i(this.uniforms.uPuddleReflections, u.puddleReflections ? 1 : 0);
    gl.uniform1i(this.uniforms.uColdPalette, u.coldPalette ? 1 : 0);
    gl.uniform1i(this.uniforms.uVisionFog, u.visionFog ? 1 : 0);
    gl.uniform1i(this.uniforms.uCine, u.cine ? 1 : 0);
    gl.uniform1f(this.uniforms.uNightAmt, Number.isFinite(u.nightAmt) ? Math.min(1, Math.max(0, u.nightAmt as number)) : 0);
    gl.uniform1i(this.uniforms.uShadeMode, u.shadeMode && u.cine ? 1 : 0);
    gl.uniform1i(this.uniforms.uTone, u.tone && u.cine ? 1 : 0);
    gl.uniform1f(this.uniforms.uDanger, Number.isFinite(u.danger) ? Math.min(1, Math.max(0, u.danger as number)) : 0);

    const count = Math.min(12, u.lights.length);
    for (let i = 0; i < count; i++) {
      const L = u.lights[i];
      const o = i * 4;
      this.posRadBuf[o] = L.x;
      this.posRadBuf[o + 1] = L.y;
      this.posRadBuf[o + 2] = L.radius;
      this.posRadBuf[o + 3] = L.intensity;

      this.colChanBuf[o] = L.r;
      this.colChanBuf[o + 1] = L.g;
      this.colChanBuf[o + 2] = L.b;
      this.colChanBuf[o + 3] = L.shadowChannel;

      this.coneBuf[o] = L.dirX;
      this.coneBuf[o + 1] = L.dirY;
      this.coneBuf[o + 2] = L.coneCos;
      this.coneBuf[o + 3] = L.coneCos > -1.5 ? 0.55 : L.shadowChannel === 1 ? 0.22 : 0.0;
    }

    gl.uniform1i(this.uniforms.uLightCount, count);
    gl.uniform4fv(this.uniforms.uLightPosRad, this.posRadBuf);
    gl.uniform4fv(this.uniforms.uLightColChan, this.colChanBuf);
    gl.uniform4fv(this.uniforms.uLightCone, this.coneBuf);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  destroy() {
    if (!this.gl) return;
    const gl = this.gl;
    if (this.texAlbedo) gl.deleteTexture(this.texAlbedo);
    if (this.texNormal) gl.deleteTexture(this.texNormal);
    if (this.texShadow) gl.deleteTexture(this.texShadow);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
  }
}
