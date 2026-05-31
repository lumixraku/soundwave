#version 300 es
precision highp float;

uniform float u_time;
uniform sampler2D u_audioData;
uniform sampler2D u_logo;
uniform float u_intensity;
uniform float u_gainLeft;
uniform float u_gainRight;
uniform float u_pixelRatio;
uniform vec2  u_resolution;
uniform vec2  u_mouse;

in vec2 v_uv;
out vec4 fragColor;

#define TAU 6.28318530718

// Trooly ∞ glyph mapped into uv-space. The SVG viewBox is 35 x 19, so the
// logo's half-extent on screen sets both width and height proportionally.
const float LOGO_HALF_W = 0.45;
const float LOGO_HALF_H = LOGO_HALF_W * (19.0 / 35.0);
// Lobe centers — left lobe of the glyph arcs around viewBox x≈28, right
// around x≈49. Translating to centered uv units: (±10.5/35) * LOGO_HALF_W*2.
const float LOBE_D      = 0.27;
const float DISP_SCALE  = 0.07;   // how far audio pushes the sample inward
const float GLOW_RADIUS = 0.025;

// Outward radial displacement contribution from one lobe.
vec2 lobeDisp(vec2 uv, vec2 center, float gain) {
  vec2 q = uv - center;
  float r = length(q);
  if (r < 1e-4) return vec2(0.0);
  float theta = atan(q.y, q.x);
  float audio = texture(u_audioData, vec2(fract(theta / TAU), 0.5)).r;
  float amount = audio * gain * u_intensity;
  amount += sin(theta * 3.0 + u_time * 1.2) * audio * gain * 0.35;
  amount += sin(theta * 7.0 - u_time * 0.8) * audio * gain * 0.20;
  return (q / r) * amount;
}

// Map screen-uv to logo texture-uv (with optional displacement applied).
vec2 logoSample(vec2 uv) {
  vec2 t;
  t.x = (uv.x / LOGO_HALF_W) * 0.5 + 0.5;
  t.y = (-uv.y / LOGO_HALF_H) * 0.5 + 0.5;   // flip y for image origin
  return t;
}

float sampleAlpha(vec2 uv) {
  vec2 t = logoSample(uv);
  // Out-of-bounds returns 0 so the glow / mask don't wrap.
  if (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) return 0.0;
  return texture(u_logo, t).a;
}

vec3 sampleColor(vec2 uv) {
  vec2 t = logoSample(uv);
  return texture(u_logo, t).rgb;
}

void main() {
  vec2 uv = v_uv * 2.0 - 1.0;
  uv.x *= u_resolution.x / u_resolution.y;

  vec2 cL = vec2(-LOBE_D, 0.0);
  vec2 cR = vec2( LOBE_D, 0.0);

  // Inverse-distance-weighted blend of the two lobes' radial displacements.
  vec2 qL = uv - cL;
  vec2 qR = uv - cR;
  float wL = 1.0 / (length(qL) + 0.05);
  float wR = 1.0 / (length(qR) + 0.05);
  float wSum = wL + wR;
  vec2 disp = (lobeDisp(uv, cL, u_gainLeft) * wL
             + lobeDisp(uv, cR, u_gainRight) * wR) / wSum * DISP_SCALE;

  // Subtract displacement so the ribbon appears to bulge outward with audio.
  vec2 sampleUV = uv - disp;

  float mask = sampleAlpha(sampleUV);
  vec3  ribbon = sampleColor(sampleUV);

  // Halo: average alpha over an offset ring → cheap outer glow.
  float halo = 0.0;
  const int N = 12;
  for (int i = 0; i < N; i++) {
    float a = float(i) / float(N) * TAU;
    vec2 off = vec2(cos(a), sin(a)) * GLOW_RADIUS;
    halo += sampleAlpha(sampleUV + off);
  }
  halo = (halo / float(N) - mask);
  halo = clamp(halo, 0.0, 1.0);

  float mouseProx = smoothstep(0.40, 0.0, length(uv - u_mouse));
  float audioBrightness = u_intensity * (u_gainLeft + u_gainRight) * 0.25;

  vec3 hot = vec3(0.4, 0.870, 0.745);
  vec3 bg  = vec3(0.04, 0.06, 0.055);

  // Compose: bg → halo glow → ribbon body. Boost both with audio + mouse.
  vec3 col = bg;
  col = mix(col, hot * (0.85 + audioBrightness + mouseProx * 0.4), halo * (1.0 + mouseProx * 0.6));
  col = mix(col, ribbon * (1.0 + audioBrightness * 0.8), mask);

  fragColor = vec4(col, 1.0);
}
