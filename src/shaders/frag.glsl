#version 300 es
precision highp float;

uniform float u_time;
uniform sampler2D u_audioData;
uniform sampler2D u_logo;
uniform sampler2D u_logoSdf;
uniform float u_intensity;
uniform float u_gainLeft;
uniform float u_gainRight;
uniform float u_pixelRatio;
uniform vec2  u_resolution;
uniform vec2  u_mouse;

in vec2 v_uv;
out vec4 fragColor;

#define TAU 6.28318530718
#define PI  3.14159265359

const float LOGO_HALF_W = 0.45;
const float LOGO_HALF_H = LOGO_HALF_W * (19.0 / 35.0);
const float ERODE_R     = 0.014;
const float WAVE_AMP    = 0.07;  // peak signed swing of the voice waveform off the logo edge

// 256 px (SDF_RANGE_PX) × (LOGO_HALF_W * 2 / LOGO_TEX_W) = 256 / 1024 * 0.9 = 0.225
const float SDF_SCREEN_RANGE = 0.225;

vec2 logoSample(vec2 uv) {
  return vec2(
    (uv.x / LOGO_HALF_W) * 0.5 + 0.5,
    (-uv.y / LOGO_HALF_H) * 0.5 + 0.5
  );
}

float sampleAlpha(vec2 uv) {
  vec2 t = logoSample(uv);
  if (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) return 0.0;
  return texture(u_logo, t).a;
}

vec3 sampleColor(vec2 uv) {
  return texture(u_logo, logoSample(uv)).rgb;
}

// Signed distance to the logo silhouette in screen units.
// Negative inside, positive outside, 0 on the boundary.
float logoSdf(vec2 uv) {
  vec2 t = logoSample(uv);
  if (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) return SDF_SCREEN_RANGE;
  float packed = texture(u_logoSdf, t).r;
  return (packed - 0.5) * 2.0 * SDF_SCREEN_RANGE;
}

void main() {
  vec2 uv = v_uv * 2.0 - 1.0;
  uv.x *= u_resolution.x / u_resolution.y;

  // Trooly ribbon body — slightly eroded so the ring sits cleanly around the silhouette.
  float thickness = 0.0;
  const int EN = 8;
  for (int i = 0; i < EN; i++) {
    float a = float(i) / float(EN) * TAU;
    vec2 off = vec2(cos(a), sin(a)) * ERODE_R;
    thickness += sampleAlpha(uv + off);
  }
  thickness /= float(EN);
  float mask = smoothstep(0.55, 0.92, thickness);
  vec3 ribbon = sampleColor(uv);

  // Voice waveform traced perpendicular to the logo silhouette.
  // s walks once around the silhouette via atan2 from origin (monotonic on the ∞ outline).
  float theta = atan(uv.y, uv.x);
  float s = fract((theta + PI) / TAU + u_time * 0.07);
  float wavePoint = texture(u_audioData, vec2(s, 0.5)).r;

  // Signed displacement around the silhouette — silence → wave hugs the edge,
  // loud → wave swings ±WAVE_AMP perpendicular to the actual logo path.
  float disp = (wavePoint - 0.5) * 2.0 * WAVE_AMP;
  float sdf  = logoSdf(uv);
  float waveDist = abs(sdf - disp);

  float speakerGain = mix(u_gainLeft, u_gainRight, smoothstep(-0.04, 0.04, uv.x));
  float speakEnv   = clamp((u_intensity - 0.3) * 3.5, 0.0, 1.0);
  float ringW      = 0.0025 * u_pixelRatio;
  float glowW      = 0.014  * u_pixelRatio;
  float wave = (exp(-waveDist / ringW) + exp(-waveDist / glowW) * 0.45) * speakerGain * speakEnv;
  wave = clamp(wave, 0.0, 1.0);

  vec3 hot = vec3(0.4, 0.870, 0.745);
  vec3 bg  = vec3(0.04, 0.06, 0.055);

  vec3 col = bg;
  col = mix(col, hot, wave);     // wave sits behind the ribbon
  col = mix(col, ribbon, mask);  // ribbon body covers the wave where they overlap

  fragColor = vec4(col, 1.0);
}
