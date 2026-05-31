# Progress

ShaderWave 的迭代历程。

## 已完成

### v0.7 — 任意 logo 上传

把之前硬编码的 ∞ 形状路径换成"用户可上传任意图片"。

- `Props` 加 `logoUrl: string`；App 端用 `URL.createObjectURL` 把上传文件喂给组件
- `processLogo(url)` 抽象出加载 → 光栅化 → silhouette 提取 → SDF 烘焙的完整流程
- `layoutForAspect(aspect)`：按图片 `naturalWidth/Height` 自动算 `logoTexW/H` 和 padded `sdfTexW/H`，长边固定 1024，screen half-extent 用 `TARGET_HALF=0.45`
- `extractSilhouette()`：先扫一遍所有 alpha，若有透明像素就用 alpha 阈值；否则取四角平均亮度判背景明暗，对反向亮度阈值
- `silhouetteCentroid()`：算 mask 的几何质心，作为 chamfer parent-angle 的参考原点（之前硬编码 `cx=w/2`，对非居中 logo 会有偏差）
- shader 的 `LOGO_HALF_W/H` 和 `SDF_HALF_W/H` 从常量改为 uniform `u_logoHalf` / `u_sdfHalf`，每帧由 JS 推
- WebGL 上下文、program、贴图句柄全部用 `useRef` 持有；logo 切换时只重传两张贴图，不重建 GL pipeline
- 加"全部"speaker 模式：`gainLeft=gainRight=1`，整圈轮廓都显示波形（shader 不动，`mix(1,1,x)=1`）
- 默认 logo 切到 `public/languages.svg`，stroke 加粗 + 上品牌绿做出 filled 视觉效果

### v0.6 — 波形沿法线方向（不再歪斜）

之前 `s = atan2(uv.y, uv.x)` 用的是**当前像素**对原点的角度，导致波形鼓包沿"径向"而非"轮廓法线"，在非圆形 logo 上看起来歪斜。

- 在 Chamfer 距离变换里同步追踪 parent（最近轮廓像素），每次 `relax` 时连带拷贝邻居的 parent
- SDF 贴图从 R8 升级到 RGBA8：R = signed distance，G = `cos(parentAngle)`，B = `sin(parentAngle)`，质心为参考原点
- 用 cos/sin 而不是直接存角度，让 GPU 的 LINEAR filter 在 ±π wrap 处自然过渡，没有脏点
- shader 端 `atan(sinA, cosA)` 恢复 `s`：同一条法线上所有像素 parent 相同 → `s` 相同 → `disp` 相同 → 鼓包就是沿法线方向

### v0.5 — SDF 贴图 padding（消除矩形 halo）

之前 SDF 贴图正好贴合 logo bbox，当波形偏移到外侧时等高线撞到贴图边界 → 看上去像 logo 周围多出一个矩形外框。

- SDF 贴图扩大 1.5×：logo 居中放到 padded canvas，留出 256 px 空白
- Chamfer 在更大 canvas 上跑，离开 logo 边缘 ~0.225 screen units 内的距离都是有效值
- shader 用独立的 `SDF_HALF_W/H`（= `LOGO_HALF_W/H * 1.5`）采样

### v0.4 — 沿真实 logo 轮廓画波形（SDF 路线）

放弃"两个圆心 + 固定半径"那套，改用真正的 logo silhouette SDF。

- JS 端 Chamfer 3×3 (Borgefors) 距离变换：用 SVG 光栅化的 alpha 当 mask，得到每像素到 silhouette 的有符号距离，pack 到 R8 贴图
- shader 端 `sdf == disp` 等高线就是波形描线 —— `disp = 0` 时贴 logo 边缘，音频驱动时朝法线方向起伏
- speaker gain 改为按 `uv.x` 平滑切换（替代之前两个独立 lobe 各自 gate）

### v0.3 — 时域波形替换 FFT 频谱

之前用 `getByteFrequencyData`，结果永远 ≥0 → 波形只能朝外膨胀 → 中心扩散感。

- 切到 `getByteTimeDomainData`：byte 128 = 静音零点，上下波动 = 真实声压
- 删除原本为 FFT 设计的 smoothing + mirror + blur 三段处理
- 直接 256→128 三抽头平均上传 GPU
- intensity 改用 RMS

### v0.2 — 鼠标交互、配色

- 加 `u_mouse`，鼠标靠近圆环时局部"推开"形变 + 增强辉光（当前 shader 已不再使用）
- 主题切到青绿三色梯度 `#66c0b1 / #267361 / #d8f3dc`，背景 `#0a0f0e`

### v0.1 — 首个可用版本

- Vite 6 + React 18 + TS 脚手架；`?raw` 加载 GLSL
- `useAudioAnalyser` 封装麦克风启停
- 单圆环 SDF + 频谱镜像 + 双重指数平滑

## 候选下一步

- **更通用的轮廓参数化**：当前 `s = atan2(parent - centroid)` 对类凸形状好看，对强凹陷或多连通形状会重影。彻底解决要做 arclength tracing：先描边得到有序 perimeter 点列 → 给每个 perimeter 像素分配 arclength 值 → 烘焙到 SDF 贴图的额外通道
- **真双路音频**：把 `useAudioAnalyser` 拆成 `useDualAudio`，一路 `MediaElementSource`（接 TTS 音频）、一路 `getUserMedia`。`u_audioLeft / u_audioRight` 两张时域纹理，shader 端按 speaker gain 各采各的
- **自动 speaker 状态机**：接对话引擎后，把 `speaker` 由人工按钮改成「TTS 播放期间 = ai，VAD 检测到人声 = human」
- **SVG viewBox 兜底**：上传无显式 `width/height` 的 SVG 时浏览器默认 300×150 会把 aspect 搞错。可以 fetch SVG 文本解析 `viewBox` 拿真实 aspect

## 决策记录

- **形状用 SDF 贴图而非过程式**：过程式很难表达任意 logo 的复杂轮廓；CPU Chamfer 一次烘焙 + GPU 实时采样既精确又快
- **G/B 通道存 cos/sin 而非直接角度**：直接存角度后 LINEAR filter 在 ±π wrap 处会出脏点；cos/sin 二维向量天然连续
- **质心为参考原点**：硬编码 canvas 中心对非居中 logo 不准；用 silhouette 几何质心更稳
- **logo 切换不重建 GL**：context、program、buffer 全部存进 ref，logo 变化只触发贴图重传
- **gainLeft / gainRight 用 ref 传**：避免每次 prop 变化重建整个 GL pipeline
- **padding 1.5× 而不是 2×**：波形外摆最多 `WAVE_AMP=0.07`，padding 0.225 screen units 足够余量；2× 会让 Chamfer 多跑一倍像素
