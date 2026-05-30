#version 300 es
precision highp float;

uniform float u_time;
uniform sampler2D u_audioData;
uniform float u_intensity;
uniform float u_pixelRatio;
uniform vec2 u_resolution;

in vec2 v_uv;
out vec4 fragColor;

#define TAU 6.28318530718

void main() {
  vec2 uv = v_uv * 2.0 - 1.0;
  uv.x *= u_resolution.x / u_resolution.y;

  float d = length(uv);
  float theta = atan(uv.y, uv.x);
  float nx = fract(theta / TAU);

  float audio = texture(u_audioData, vec2(nx, 0.5)).r;

  float breathe = sin(u_time * 0.8) * 0.5 + 0.5;
  float baseRadius = 0.38 + breathe * 0.005;

  float audioEnergy = audio * u_intensity;

  float distortion = audio * u_intensity;

  distortion += sin(theta * 3.0 + u_time * 1.2) * audio * 0.06 * u_intensity;
  distortion += sin(theta * 7.0 - u_time * 0.8) * audio * 0.03 * u_intensity;

  float radius = baseRadius + distortion * 0.15;
  float rd = d - radius;

  float ringWidth = 0.005 * u_pixelRatio;
  float glowWidth = 0.035 * u_pixelRatio;

  float core = exp(-abs(rd) / ringWidth);
  float glow = exp(-abs(rd) / glowWidth) * 0.5;

  float t = clamp(audioEnergy, 0.0, 1.0);

  vec3 col1 = vec3(0.2, 0.6, 1.0);
  vec3 col2 = vec3(0.7, 0.2, 0.9);
  vec3 col3 = vec3(1.0, 0.35, 0.6);

  vec3 color = mix(col1, col2, smoothstep(0.15, 0.5, t));
  color = mix(color, col3, smoothstep(0.5, 0.9, t));

  float alpha = clamp(core + glow, 0.0, 1.0);

  vec3 bg = vec3(0.02, 0.02, 0.06);
  fragColor = vec4(mix(bg, color, alpha), 1.0);
}
