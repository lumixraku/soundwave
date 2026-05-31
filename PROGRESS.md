# Progress

ShaderWave 的迭代历程。

## 已完成

### v0.4 — 改造为 trooly ∞ ribbon（未提交）

目标：把单圆波形换成 trooly.ai 同款的 3D ribbon ∞，左右 lobe 分别由「AI / 人类」的语音驱动。

- **第一次尝试（失败）**：用两个圆环 SDF + smin。结果是两个相交细圆，没有 ribbon 厚度、没有上下穿插，被否决。
- **第二次尝试（失败）**：把圆环换成带厚度的 annulus + 用 `±sin(theta)` 给两个 lobe 错相 z 值做 z-sort、faux 3D shading。形状仍然只是两个独立"甜甜圈"，无法贴近 logo。
- **第三次（成功）**：放弃 procedural 重绘，直接从 trooly 站点抠 SVG 当纹理。
  - 用 Chrome DevTools 在 `svgs[84]`（trooly wordmark, viewBox `0 0 79.175 29.03`）里挑出 ∞ 相关 subpath：
    - `path[2]` 中以 `M 44.487 17.307` 起始的子路径 = ribbon 外轮廓（绕完两个 lobe 的一笔闭合曲线）
    - `path[1]` 全部 = 中心交叉处的两个深色"舌头"，给出上下穿插的视觉
  - 写入 `public/infinity.svg`，自定义 viewBox `21 5 35 19` 紧贴 glyph。
- **shader**：
  - 加载 SVG → drawImage 到 1024×556 offscreen canvas → 上传为 `TEXTURE1` (RGBA)。
  - 维持 `TEXTURE0` R8 1D 频谱纹理不变。
  - 每像素：算到 `cL/cR` 的本地极角、采该角度的频谱、沿径向外推一个位移；左右位移用反距离加权混合；最后 `sampleUV = uv - disp` 去采 logo 纹理。
  - halo：在 sampleUV 周围 12 个偏移点采 α 取均值减去本地 α，得到外发光强度。
- **CPU 侧 / 组件**：
  - 重命名 `CircularWaveform` → `InfinityWaveform`。
  - 新增 `gainLeft / gainRight` props；用 ref 把最新值喂进 rAF loop 不重建 GL。
  - SVG 加载是 promise，挂一个 `cancelled` 标志，StrictMode 双调用卸载时不再触发"bind 已删除纹理"警告。
- **UI**：
  - App 增加 `speaker: 'ai' | 'human'` 状态 + 两枚选择按钮 + 现有的麦克风按钮。
  - `gainLeft/Right` 由 `active && speaker === ...` 推导。

### v0.3 — 鼠标交互（commit `e56153c`）
- 加 `u_mouse`，鼠标靠近圆环时局部"推开"形变 + 增强辉光。

### v0.2 — 主题配色（commit `15a1671`）
- 切换到青绿三色梯度 `#66c0b1 / #267361 / #d8f3dc`，背景 `#0a0f0e`。

### v0.1 — 首个可用版本（commit `1d4d0de`）
- Vite 6 + React 18 + TS 脚手架；`?raw` 加载 GLSL。
- `useAudioAnalyser` 封装麦克风启停。
- 单圆环 SDF + 频谱镜像 + 双重指数平滑。

## 进行中

无。

## 候选下一步

- **真双路音频**：把 `useAudioAnalyser` 拆成 `useDualAudio`，一路 `MediaElementSource`（接 TTS 音频）、一路 `getUserMedia`。`u_audioLeft / u_audioRight` 两张频谱纹理，shader 端按 lobe 各采各的。
- **自动 speaker 状态机**：接对话引擎后，把 `speaker` 由人工按钮改成「TTS 播放期间 = ai，VAD 检测到人声 = human」。
- **rim shading**：现在 ribbon 纯按 SVG 颜色填，没有 audio-driven 调色；可以在 `mask > 0` 区域按 `audio * gain` 把 ribbon 推向更亮的 hot teal，强化"说话方在发光"的反馈。
- **鼠标推开恢复**：旧版本里鼠标靠近会把圆环推开，纹理版当前只剩 glow 增亮；要恢复就在 sampleUV 上叠一层 mouse 方向的 push 量。
- **更高分辨率 / SDF 边缘**：栅格化的 ∞ 在极大尺寸下会看到 alpha 边缘锯齿；可以离线烘焙一张 distance field（SDF）纹理代替直接 α，shader 端做 `smoothstep(0.5, ...)` 得到分辨率无关的尖锐边。

## 决策记录

- **形状用纹理而非过程式**：两次过程式尝试都没法达到 trooly logo 的 ribbon 质感（穿插细节是 SVG path 里两块独立填色形成的，几何上不是简单 SDF 能表达）。SVG 抠图 + 纹理采样 既精确又快。
- **viewBox 紧贴 glyph**：原始 wordmark viewBox 是 `0 0 79.175 29.03`，含文字。重新指定为 `21 5 35 19` 之后纹理空间利用率最高，避免大片空白。
- **位移加权用反距离**：在两个 lobe 中间的过渡区简单的二选一会跳变；反距离加权得到平滑的过渡。
- **gainLeft / gainRight 用 ref 传**：避免每次 prop 变化重建整个 GL pipeline。
