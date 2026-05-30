#version 300 es
precision highp float;

uniform float u_time;
uniform sampler2D u_audioData;
uniform float u_intensity;
uniform float u_pixelRatio;
uniform vec2 u_resolution;
uniform vec2 u_mouse;

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
  float mouseCursorDist = length(u_mouse);
  float cursorToRingDist = abs(mouseCursorDist - radius);
  float rd = d - radius;

  if (mouseCursorDist > 0.01) {
    vec2 fragToMouse = uv - u_mouse;
    float mouseDist = length(fragToMouse);
    float repelRadius = 0.28;
    float activation = smoothstep(0.25, 0.02, cursorToRingDist);

    if (mouseDist < repelRadius && activation > 0.001) {
      vec2 pushDir = fragToMouse / max(mouseDist, 0.001);
      float pushAmt = pow(1.0 - mouseDist / repelRadius, 2.0) * 0.28 * activation;
      rd = length(uv - pushDir * pushAmt) - radius;
    }
  }

  float mouseProximity = smoothstep(0.35, 0.0, length(uv - u_mouse));
  float glowBoost = mouseProximity * 0.5;

  float ringWidth = 0.005 * u_pixelRatio;
  float glowWidth = 0.035 * u_pixelRatio;

  float core = exp(-abs(rd) / ringWidth);
  float glow = exp(-abs(rd) / glowWidth) * (0.5 + glowBoost);

  float t = clamp(audioEnergy, 0.0, 1.0);

  vec3 col1 = vec3(0.4, 0.753, 0.694);
  vec3 col2 = vec3(0.149, 0.451, 0.38);
  vec3 col3 = vec3(0.847, 0.953, 0.863);

  vec3 color = mix(col1, col2, smoothstep(0.15, 0.5, t));
  color = mix(color, col3, smoothstep(0.5, 0.9, t));

  float alpha = clamp(core + glow, 0.0, 1.0);

  vec3 bg = vec3(0.04, 0.06, 0.055);
  fragColor = vec4(mix(bg, color, alpha), 1.0);
}
