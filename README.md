# ShaderWave

基于 WebGL2 着色器的实时音频可视化。形状直接复用 [trooly.ai](https://www.trooly.ai/) wordmark 里的 ∞ ribbon —— 从其 SVG path 抠出后栅格化为纹理；shader 负责按左右两个 lobe 各自的频谱做径向 UV 形变 + 外发光。

设计目标是「AI 说话→左侧 lobe 动；人类说话→右侧 lobe 动」，方便接入对话场景。

## 特性

- 真·trooly 无穷曲线：从官网 SVG 抠出 ∞ 部分（剥离 wordmark 字母），中间上下穿插的细节保留
- WebGL2 单 Pass 全屏四边形渲染
- 麦克风实时频谱采样（Web Audio `AnalyserNode`，FFT 256）
- 左右 lobe 各自有 gain（`u_gainLeft / u_gainRight`），用 UV 径向位移让对应一侧"鼓胀"，另一侧保持静止
- 频谱混合：以"到每个 lobe 中心的反距离"加权两侧位移，过渡区平滑
- 外发光 halo + 鼠标靠近的局部增亮
- DPR 自适应分辨率

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6 |
| 渲染 | 原生 WebGL2 |
| 音频 | Web Audio API（`getUserMedia` + `AnalyserNode`） |
| 着色器加载 | Vite `?raw` import |
| 形状资源 | `public/infinity.svg`（运行时栅格化为 1024×… RGBA 纹理） |

## 快速开始

```bash
npm install
npm run dev      # http://localhost:5173
npm run build
npm run preview
```

浏览器需 WebGL2、`getUserMedia` 权限，并允许麦克风访问。

## 目录结构

```
public/
└── infinity.svg               从 trooly.ai 抠出的 ∞ 矢量图（viewBox 21 5 35 19）
src/
├── App.tsx                    入口：麦克风开关 + AI/我 切换
├── App.css
├── main.tsx
├── index.css
├── components/
│   └── InfinityWaveform.tsx   WebGL2 主循环；加载 SVG → 栅格化 → 上传纹理
├── hooks/
│   └── useAudioAnalyser.ts    封装 getUserMedia + AnalyserNode
├── shaders/
│   ├── vert.glsl
│   └── frag.glsl              UV 径向位移 + 纹理采样 + halo 外发光
└── types/glsl.d.ts
```

## 渲染管线

1. **资源加载**：组件 mount 时 `new Image().src = '/infinity.svg'`，加载完成后画到一个 1024×556 的 offscreen canvas，再 `texImage2D` 上传为 `TEXTURE1`。
2. **每帧 CPU**：`getAudioData()` → 128 段指数平滑 → 整体强度平滑 → 镜像 + 3-tap 模糊 → 写入 `TEXTURE0`（R8 1D 频谱纹理）。
3. **片元着色器**：
   - 算左右 lobe 中心 `cL = (-LOBE_D, 0)`、`cR = (+LOBE_D, 0)`；
   - 每个 lobe 给出一个"径向外推"位移向量：根据该 lobe 本地极角采频谱 → 乘 `gain * intensity` → 沿径向方向 × 强度；
   - 用"到 lobe 中心的反距离"对左右位移做加权平均，得到当前像素的总位移；
   - 把 `sampleUV = uv - disp` 映射到 logo 纹理空间，采样 RGBA；
   - 在采样点周围 12 个偏移点采 α 求平均，减去本地 α 得到 halo，叠加 hot teal 发光。

## 左右独立动画

App 顶层维护 `speaker: 'ai' | 'human'`，按钮切换。`gainLeft / gainRight` 推导规则：

```
gainLeft  = active && speaker === 'ai'    ? 1 : 0
gainRight = active && speaker === 'human' ? 1 : 0
```

当前是手动切换，后续要接对话引擎时，把状态机改成「TTS 开始播放 → speaker='ai'；麦克风识别到用户说话 → speaker='human'」即可。

## 已知限制

- 仅 WebGL2 路径，未做 WebGL1 fallback。
- 仍是单麦克风音频驱动两侧 gain，不是真正的「AI TTS 流」+「麦克风流」双路。后续要接对话引擎时，`useAudioAnalyser` 需要拆成 `useDualAudio`。
- 鼠标交互目前只剩"glow 增亮"，没有"推开"形变（旧 SDF 形状版本里的功能）。
- ∞ 形状是栅格纹理，缩放过大时会看到 alpha 边缘的轻微锯齿；可以提高 `LOGO_TEX_W` 缓解。

## License

仅作为个人实验项目，未指定 License。SVG 形状版权属 trooly.ai。
