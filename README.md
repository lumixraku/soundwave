# ShaderWave

基于 WebGL2 的实时音频可视化。麦克风采到的语音波形沿任意 logo 的真实轮廓展开 —— 静音时波形精确贴着 logo 边缘，发声时按时域音压沿轮廓法线方向上下起伏。

## 特性

- **任意 logo 支持**：上传 PNG/JPG/SVG/WebP，运行时光栅化 + 提取 silhouette；带 alpha 的图直接用 alpha 通道，纯色背景图用四角亮度自动判背景明暗后做阈值
- **真·形状感**：CPU 端跑 Chamfer 3×3 距离变换 + parent 追踪，得到每个像素到 logo 轮廓的 SDF + 最近轮廓点的角度参数，烘焙成 RGBA8 贴图供 shader 实时采样
- **音波沿法线**：所有像素沿同一条法线共享同一个角度参数 `s`，音频 `audio(s)` 推动 `disp` 偏移 → 波形鼓包**垂直于切线**而非歪斜径向
- **时域波形而非频谱**：用 `getByteTimeDomainData` 拿到带正负的真实声压，避免频谱"中心扩散"感
- **三种 speaker 模式**：左侧（AI）/ 右侧（人）/ 全部，按 uv.x 平滑混合 gain
- **WebGL2 单 Pass**：全屏四边形 + 一个 fragment shader 搞定
- **DPR 自适应**

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6 |
| 渲染 | 原生 WebGL2 |
| 音频 | Web Audio API（`getUserMedia` + `AnalyserNode.getByteTimeDomainData`） |
| 着色器加载 | Vite `?raw` import |

## 快速开始

```bash
npm install
npm run dev      # http://localhost:5173 (或自动找到的下一个空闲端口)
npm run build
npm run preview
```

浏览器需 WebGL2 支持，并允许麦克风访问。

## 目录结构

```
public/
├── languages.svg                 默认 logo（可在 UI 上传任意图片替换）
└── infinity.svg                  备用 logo
src/
├── App.tsx                       入口：麦克风开关 + speaker 模式 + logo 上传
├── App.css
├── main.tsx
├── index.css
├── components/
│   └── InfinityWaveform.tsx      WebGL2 主循环 + SDF 烘焙 + 纹理上传
├── hooks/
│   └── useAudioAnalyser.ts       封装 getUserMedia + AnalyserNode（时域）
├── shaders/
│   ├── vert.glsl
│   └── frag.glsl                 SDF 采样 + 沿法线方向画语音波形
└── types/glsl.d.ts
```

## 渲染管线

1. **资源处理（每次 logo 变化）**
   - `new Image()` 加载图片 → 读 `naturalWidth/Height` 算 aspect → 决定 `logoTexW/H`（长边 1024）和 padded `sdfTexW/H`（1.5×）
   - 颜色贴图：logo 铺满 `logoTexW×logoTexH` canvas → 上传到 `TEXTURE1` (RGBA)
   - SDF 贴图：logo 居中放到更大的 padded canvas → 提取 silhouette 二值 mask → 算质心 → 跑 Chamfer 3×3 距离变换，同步追踪每个像素的 parent（最近轮廓像素）→ 打包成 RGBA8（R = signed distance, G/B = `cos/sin(parentAngleFromCentroid)`）→ 上传到 `TEXTURE2`
2. **每帧 CPU**
   - `getAudioData()` 取 256 字节时域波形（byte 128 = 静音零点）
   - 三抽头平均下采样到 128 字节 → 上传到 `TEXTURE0` (R8 1D)
   - 同时算 RMS，做指数平滑得 `intensity`，shader 用它做 speak-or-silent gate
3. **片元着色器**
   - 从 `TEXTURE2` 采到 `sdf` 和 `(cosA, sinA)` → `atan(sinA, cosA)` 恢复角度 → 得到沿轮廓的 1D 参数 `s ∈ [0,1]`（可带时间偏移做"流动"效果）
   - 从 `TEXTURE0` 在 `s` 处采时域采样值 `wavePoint`
   - `disp = (wavePoint - 0.5) * 2 * AMP` —— 有符号位移（沿轮廓法线方向，因为 `s` 对同一法线上所有像素一致）
   - 像素亮度 = `exp(-|sdf - disp| / ringW) + exp(-|sdf - disp| / glowW) * 0.45`，乘 `speakerGain * speakEnv`
   - 最后用 logo 颜色贴图盖在波形上（`mix(col, hot, wave); mix(col, ribbon, mask)`）

## Speaker 模式

`App.tsx` 维护 `speaker: 'ai' | 'human' | 'both'`，按钮切换：

```
ai    → gainLeft=1, gainRight=0  (只左半边轮廓显示波形)
human → gainLeft=0, gainRight=1  (只右半边)
both  → gainLeft=1, gainRight=1  (整圈)
```

Shader 端 `speakerGain = mix(u_gainLeft, u_gainRight, smoothstep(-0.04, 0.04, uv.x))`，过渡区平滑无硬边。

## 任意 logo 上传

UI 底部"上传 logo"按钮，`accept="image/*"`，文件转 `URL.createObjectURL` 喂给组件 → 触发 SDF 重烘焙 + 纹理重上传，**不重建 WebGL 上下文**。

### 形状 caveat

参数 `s` 用的是"最近轮廓点对质心的角度"，对**类闭合 / 类凸**形状（圆、心、∞、O、D）效果最自然；对**强凹陷 / 多连通**形状（手掌、星、字母 E）从质心射出的射线会穿过 perimeter 多次 → `s` 在轮廓上不再单调 → 波形可能出现"重影"。要根治得换 arclength tracing 的轮廓参数化。

## 已知限制

- 仅 WebGL2 路径，未做 WebGL1 fallback
- SVG 不带 `width`/`height` 属性时 `naturalWidth/Height` 浏览器默认是 300×150，aspect 会错；上传前最好确认 SVG 有显式尺寸或转成栅格
- 纯线条 SVG（fill="none" + stroke）silhouette 是线本身，波形会沿线两侧走；想要"贴整体外形"请用 filled 几何
- 鼠标 uniform 还在但目前未在 shader 里使用

## License

仅作为个人实验项目，未指定 License。
