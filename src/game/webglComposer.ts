// Pure-procedural WebGL2 Deferred 2D Normal-Mapped Lighting, Soft Penumbra,
// Volumetric Flashlight Beam, Puddle Specular Reflections & ACES Oil-Painting Post-Process.

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
  shadowChannel: number; // 0 = flashlight mask (R), 1 = omni/lamp mask (G), 2 = unshadowed/ambient
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
uniform sampler2D uShadow;    // R=FlashlightVis, G=WorldLightsVis, B=AuraVis

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

uniform int uLightCount;
uniform vec4 uLightPosRad[12];   // xy = screen pos, z = radius, w = intensity
uniform vec4 uLightColChan[12];  // rgb = color, a = shadowChannel (0=R, 1=G, 2=B, 3=unshadowed)
uniform vec4 uLightCone[12];     // xy = dir, z = coneCos (-2 for omni), w = volumetricBoost

// Cheap hash & value noise for volumetric fog beam & painterly canvas grain
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
  vec2 px = 2.6 / uResolution;
  if (uPenumbraSamples <= 3) {
    vec3 s1 = texture(uShadow, uv + vec2(px.x, px.y)).rgb;
    vec3 s2 = texture(uShadow, uv - vec2(px.x, px.y)).rgb;
    return (c * 2.0 + s1 + s2) * 0.25;
  }
  // 5-tap Poisson penumbra feathering
  vec3 sum = c * 0.32;
  sum += texture(uShadow, uv + vec2(px.x * 1.1, px.y * 0.4)).rgb * 0.17;
  sum += texture(uShadow, uv + vec2(-px.x * 0.5, px.y * 1.2)).rgb * 0.17;
  sum += texture(uShadow, uv + vec2(-px.x * 1.1, -px.y * 0.4)).rgb * 0.17;
  sum += texture(uShadow, uv + vec2(px.x * 0.5, -px.y * 1.2)).rgb * 0.17;
  return sum;
}

// ACES Filmic Tone Mapping (prevents half-float/8-bit harsh blowout per penpen-gamePlus-skill §02)
vec3 acesFilm(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  // Flip Y because Canvas2D origin is top-left while WebGL UV origin is bottom-left
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 screenPx = uv * uResolution;
  vec2 worldPx = screenPx + uCamPos - uResolution * 0.5;

  // Subtle chromatic dread offset at screen edges when wounded
  vec2 centered = vUv - 0.5;
  float edgeDist = length(centered);
  vec3 albedo;
  if (uBloodDread > 0.08) {
    float ca = uBloodDread * 0.0032 * edgeDist;
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

  // Rain ripple perturbation on standing water puddles
  if (uPuddleReflections == 1 && activeWet > 0.25 && uRain > 0.05) {
    vec2 cell = floor(worldPx * 0.038);
    vec2 f = fract(worldPx * 0.038) - 0.5;
    float h = hash21(cell);
    float phase = fract(uTime * (0.85 + h * 0.6) + h * 7.0);
    float ring = exp(-abs(length(f) - phase * 0.45) * 32.0) * (1.0 - phase) * uRain;
    N = normalize(N + vec3(f.x, f.y, 0.0) * ring * 1.45);
  }

  vec3 shadowVis = sampleShadowSoft(uv);

  // Dark wet puddles darken albedo slightly and take on cold sky tint
  vec3 surfaceAlbedo = mix(albedo, albedo * vec3(0.58, 0.66, 0.72), activeWet * 0.52);

  // Base ambient Baltic forest darkness + subtle moonlight relief
  vec3 totalLight = uAmbient * (0.82 + 0.18 * max(N.z, 0.0));

  // Sky lightning storm flash (directional cold blue-white slap across treetops & puddles!)
  if (uLightning > 0.01) {
    vec3 skyDir = normalize(vec3(-0.45, -0.55, 0.7));
    float ndl = max(dot(N, skyDir), 0.18);
    vec3 boltCol = vec3(0.68, 0.80, 0.96) * uLightning * 1.45;
    totalLight += boltCol * ndl;
    if (uPuddleReflections == 1 && activeWet > 0.25) {
      totalLight += boltCol * activeWet * 0.95;
    }
  }

  // Volumetric mist haze accumulator (brightens air inside flashlight beam!)
  vec3 volumetricScatter = vec3(0.0);

  for (int i = 0; i < 12; i++) {
    if (i >= uLightCount) break;
    vec4 pr = uLightPosRad[i];
    vec4 cc = uLightColChan[i];
    vec4 cn = uLightCone[i];

    vec2 toPx = screenPx - pr.xy;
    float d = length(toPx);
    if (d > pr.z) continue;

    float normD = d / pr.z;
    float atten = pow(clamp(1.0 - normD, 0.0, 1.0), 1.65);

    // Directional cone shaping (flashlight beam)
    float spot = 1.0;
    if (cn.z > -1.5) {
      vec2 dirToPx = d > 0.001 ? toPx / d : cn.xy;
      float cosAng = dot(dirToPx, cn.xy);
      spot = smoothstep(cn.z - 0.11, cn.z + 0.14, cosAng);
      if (spot <= 0.001) continue;
    }

    // Shadow visibility channel
    float vis = 1.0;
    if (cc.a < 0.5) vis = shadowVis.r;
    else if (cc.a < 1.5) vis = shadowVis.g;
    else if (cc.a < 2.5) vis = shadowVis.b;

    if (vis <= 0.003) continue;

    // 3D-like normal-mapped diffuse + wet puddle specular highlight
    vec3 L = normalize(vec3(-toPx.x, -toPx.y, 82.0));
    float ndl = max(dot(N, L), 0.16);

    // Specular glint on wet mud, iron & rain puddles
    float spec = 0.0;
    if (uPuddleReflections == 1 && activeWet > 0.18) {
      vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
      float shininess = mix(14.0, 44.0, puddleMask);
      spec = pow(max(dot(N, H), 0.0), shininess) * activeWet * 0.85;
    }

    vec3 contrib = cc.rgb * pr.w * atten * spot * vis;
    totalLight += contrib * (ndl * 1.18 + spec);

    // Volumetric misty beam shaft inside flashlight / flare
    if (cn.w > 0.01) {
      float mist = fbm(worldPx * 0.011 + vec2(uTime * 0.18, -uTime * 0.11));
      volumetricScatter += contrib * cn.w * (0.45 + mist * 0.85) * (0.55 + uFogDensity * 0.65);
    }
  }

  vec3 color = surfaceAlbedo * totalLight + volumetricScatter * 0.24;

  // Painterly Eastern European oil-canvas weave & subtle film grain
  if (uEnableGrain == 1) {
    float weave = (sin(worldPx.x * 1.6) * sin(worldPx.y * 1.6)) * 0.016;
    float grain = (hash21(screenPx + fract(uTime * 29.0) * 100.0) - 0.5) * 0.042;
    color += vec3(weave + grain) * (0.35 + length(color) * 0.65);
  }

  // ACES Filmic Tone Mapping + slight cool shadow grading (Darkwood moody teal-brown contrast)
  color = acesFilm(color * 1.12);
  color = mix(color, color * vec3(0.95, 0.98, 1.03), clamp(1.0 - dot(color, vec3(0.3, 0.6, 0.1)) * 2.2, 0.0, 0.45));

  // Organic dark radial vignette
  float vig = smoothstep(0.88, 0.30, edgeDist);
  color *= mix(0.28, 1.0, vig);

  // Pulsing crimson dread vignette when wounded / hit
  if (uBloodDread > 0.01) {
    float pulse = 0.84 + 0.16 * sin(uTime * 6.5);
    float bMask = smoothstep(0.26, 0.78, edgeDist) * uBloodDread * pulse;
    color = mix(color, vec3(0.42, 0.04, 0.04), clamp(bMask * 0.75, 0.0, 0.72));
  }

  fragColor = vec4(color, 1.0);
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
        preserveDrawingBuffer: true, // supports window.__game.shot()!
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

    // Upload G-buffer textures
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
      // Volumetric mist boost for flashlight & flares
      this.coneBuf[o + 3] = L.coneCos > -1.5 ? 0.58 : L.shadowChannel === 1 ? 0.22 : 0.0;
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
