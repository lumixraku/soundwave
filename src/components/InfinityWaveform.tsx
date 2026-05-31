import { useRef, useEffect, useCallback } from 'react'
import vertSrc from '../shaders/vert.glsl?raw'
import fragSrc from '../shaders/frag.glsl?raw'

const LOGO_URL = '/infinity.svg'
const LOGO_TEX_W = 1024
const LOGO_TEX_H = Math.round(LOGO_TEX_W * (19 / 35))   // viewBox aspect
const SDF_RANGE_PX = 256   // ±range packed into the R8 SDF texture (must stay in sync with shader)
const SDF_SCALE = 1.5      // SDF texture covers this much of the logo bounding box (padding for the wave to swing into — keep in sync with shader)
const SDF_TEX_W = Math.round(LOGO_TEX_W * SDF_SCALE)
const SDF_TEX_H = Math.round(LOGO_TEX_H * SDF_SCALE)
const SDF_PAD_X = Math.round((SDF_TEX_W - LOGO_TEX_W) / 2)
const SDF_PAD_Y = Math.round((SDF_TEX_H - LOGO_TEX_H) / 2)

interface Props {
  getAudioData: () => Uint8Array
  gainLeft: number
  gainRight: number
}

function resizeCanvas(canvas: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr
    canvas.height = h * dpr
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string) {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`Shader compile error: ${log}`)
  }
  return shader
}

// Chamfer 3x3 (Borgefors) distance transform with parent tracking. For every
// pixel we record (1) its signed distance to the silhouette and (2) the
// silhouette pixel that is closest to it. Packing into RGBA8:
//   R = signed distance (128 == on the edge, ±SDF_RANGE_PX maps to 0/255)
//   G = cos(parentAngle) packed to [0,255]
//   B = sin(parentAngle) packed to [0,255]
// parentAngle is atan2 of the nearest silhouette pixel relative to the canvas
// centre (world-y is flipped). Storing cos/sin lets the GPU's LINEAR filter
// blend across the angle wrap at ±π without discontinuity.
function computeLogoSdfRgba(inside: Uint8Array, w: number, h: number): Uint8Array {
  const D1 = 1.0
  const D2 = Math.SQRT2
  const INF = 1e9
  const dist = new Float32Array(w * h).fill(INF)
  const parent = new Int32Array(w * h).fill(-1)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const here = inside[i]
      const ne = (x > 0 && inside[i - 1] !== here) ||
                 (x < w - 1 && inside[i + 1] !== here) ||
                 (y > 0 && inside[i - w] !== here) ||
                 (y < h - 1 && inside[i + w] !== here)
      if (ne) { dist[i] = 0; parent[i] = i }
    }
  }

  const relax = (i: number, ni: number, inc: number) => {
    const nd = dist[ni] + inc
    if (nd < dist[i]) {
      dist[i] = nd
      parent[i] = parent[ni]
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (y > 0) {
        if (x > 0)     relax(i, i - w - 1, D2)
                       relax(i, i - w,     D1)
        if (x < w - 1) relax(i, i - w + 1, D2)
      }
      if (x > 0)       relax(i, i - 1,     D1)
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      if (x < w - 1)   relax(i, i + 1,     D1)
      if (y < h - 1) {
        if (x > 0)     relax(i, i + w - 1, D2)
                       relax(i, i + w,     D1)
        if (x < w - 1) relax(i, i + w + 1, D2)
      }
    }
  }

  const cx = w / 2, cy = h / 2
  const packed = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const signed = inside[i] ? -dist[i] : dist[i]
    const v = Math.max(-1, Math.min(1, signed / SDF_RANGE_PX))
    packed[i * 4] = Math.round((v * 0.5 + 0.5) * 255)

    const p = parent[i]
    let cosA = 1, sinA = 0
    if (p >= 0) {
      const px = p % w
      const py = (p - px) / w
      // Canvas y is top-down; world y is bottom-up — flip when computing angle.
      const angle = Math.atan2(-(py - cy), px - cx)
      cosA = Math.cos(angle)
      sinA = Math.sin(angle)
    }
    packed[i * 4 + 1] = Math.round((cosA * 0.5 + 0.5) * 255)
    packed[i * 4 + 2] = Math.round((sinA * 0.5 + 0.5) * 255)
    packed[i * 4 + 3] = 255
  }
  return packed
}

function rasterizeSvg(url: string): Promise<{ bmp: HTMLCanvasElement; sdf: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      // Color texture: logo fills the canvas (used for the ribbon body).
      const off = document.createElement('canvas')
      off.width = LOGO_TEX_W
      off.height = LOGO_TEX_H
      const ctx = off.getContext('2d')!
      ctx.clearRect(0, 0, LOGO_TEX_W, LOGO_TEX_H)
      ctx.drawImage(img, 0, 0, LOGO_TEX_W, LOGO_TEX_H)

      // SDF source: logo centred on a larger padded canvas so the SDF carries
      // accurate distance values for the region around the logo (where the
      // voice waveform swings into). Without padding the contour gets clipped
      // at the texture rectangle and shows up as a square halo on screen.
      const sdfCanvas = document.createElement('canvas')
      sdfCanvas.width = SDF_TEX_W
      sdfCanvas.height = SDF_TEX_H
      const sdfCtx = sdfCanvas.getContext('2d')!
      sdfCtx.clearRect(0, 0, SDF_TEX_W, SDF_TEX_H)
      sdfCtx.drawImage(img, SDF_PAD_X, SDF_PAD_Y, LOGO_TEX_W, LOGO_TEX_H)

      const px = sdfCtx.getImageData(0, 0, SDF_TEX_W, SDF_TEX_H).data
      const inside = new Uint8Array(SDF_TEX_W * SDF_TEX_H)
      for (let i = 0; i < inside.length; i++) inside[i] = px[i * 4 + 3] > 128 ? 1 : 0
      const sdf = computeLogoSdfRgba(inside, SDF_TEX_W, SDF_TEX_H)

      resolve({ bmp: off, sdf })
    }
    img.onerror = reject
    img.src = url
  })
}

export default function InfinityWaveform({ getAudioData, gainLeft, gainRight }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef(0)
  const smoothedIntensityRef = useRef(0)
  const mouseRef = useRef({ x: -999, y: -999 })
  const gainRef = useRef({ left: gainLeft, right: gainRight })

  gainRef.current.left = gainLeft
  gainRef.current.right = gainRight

  const render = useCallback(() => {
    const canvas = canvasRef.current!
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false })!

    resizeCanvas(canvas)

    const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc)
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc)
    const program = gl.createProgram()!
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`)
    }

    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])
    const vbo = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)
    const aPosition = gl.getAttribLocation(program, 'a_pos')
    gl.enableVertexAttribArray(aPosition)
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0)

    // Texture 0: live audio spectrum (R8, 128x1)
    const audioTex = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, audioTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 128, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(128))

    // Texture 1: trooly ∞ logo rasterized from SVG (RGBA)
    const logoTex = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, logoTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))

    // Texture 2: RGBA8 — R: signed distance to the silhouette; G,B: cos/sin of the
    // angle of the NEAREST silhouette point (relative to canvas centre). All pixels
    // sharing a silhouette parent share the same angle, so the wave bumps come out
    // perpendicular to the local tangent instead of radial from the origin.
    const sdfTex = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, sdfTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 128, 128, 255]))

    let cancelled = false
    rasterizeSvg(LOGO_URL).then(({ bmp, sdf }) => {
      if (cancelled) return
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, logoTex)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp)

      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, sdfTex)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SDF_TEX_W, SDF_TEX_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, sdf)
    }).catch(err => {
      if (!cancelled) console.error('Failed to load logo SVG:', err)
    })

    const uTime       = gl.getUniformLocation(program, 'u_time')
    const uAudio      = gl.getUniformLocation(program, 'u_audioData')
    const uLogo       = gl.getUniformLocation(program, 'u_logo')
    const uLogoSdf    = gl.getUniformLocation(program, 'u_logoSdf')
    const uIntensity  = gl.getUniformLocation(program, 'u_intensity')
    const uGainLeft   = gl.getUniformLocation(program, 'u_gainLeft')
    const uGainRight  = gl.getUniformLocation(program, 'u_gainRight')
    const uPixelRatio = gl.getUniformLocation(program, 'u_pixelRatio')
    const uResolution = gl.getUniformLocation(program, 'u_resolution')
    const uMouse      = gl.getUniformLocation(program, 'u_mouse')

    gl.useProgram(program)
    gl.uniform1i(uAudio, 0)
    gl.uniform1i(uLogo, 1)
    gl.uniform1i(uLogoSdf, 2)

    const startTime = performance.now()
    const texData = new Uint8Array(128)

    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const aspect = rect.width / rect.height
      mouseRef.current = {
        x: ((e.clientX - rect.left) / rect.width * 2 - 1) * aspect,
        y: -((e.clientY - rect.top) / rect.height * 2 - 1)
      }
    }
    const onMouseLeave = () => { mouseRef.current = { x: -999, y: -999 } }
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mouseleave', onMouseLeave)

    function frame() {
      resizeCanvas(canvas)
      gl.viewport(0, 0, canvas.width, canvas.height)

      // Time-domain waveform: byte 128 == silence, 0/255 == max negative/positive swing.
      // Downsample 256 → 128 with a 3-tap smoothing so we don't alias single samples.
      const rawData = getAudioData()
      const step = rawData.length / 128
      let sumSq = 0
      for (let i = 0; i < 128; i++) {
        const j = Math.floor(i * step)
        const prev = rawData[Math.max(0, j - 1)]
        const curr = rawData[j]
        const next = rawData[Math.min(rawData.length - 1, j + 1)]
        texData[i] = Math.round((prev + curr * 2 + next) / 4)
        const centered = (curr - 128) / 128
        sumSq += centered * centered
      }
      const rms = Math.sqrt(sumSq / 128)
      smoothedIntensityRef.current += (rms - smoothedIntensityRef.current) * 0.2

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, audioTex)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 1, gl.RED, gl.UNSIGNED_BYTE, texData)

      const elapsed = (performance.now() - startTime) / 1000
      gl.uniform1f(uTime, elapsed)
      gl.uniform1f(uIntensity, 0.3 + smoothedIntensityRef.current * 6.0)
      gl.uniform1f(uGainLeft, gainRef.current.left)
      gl.uniform1f(uGainRight, gainRef.current.right)
      gl.uniform1f(uPixelRatio, window.devicePixelRatio || 1)
      gl.uniform2f(uResolution, canvas.width, canvas.height)
      gl.uniform2f(uMouse, mouseRef.current.x, mouseRef.current.y)

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      rafRef.current = requestAnimationFrame(frame)
    }

    frame()

    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mouseleave', onMouseLeave)
      gl.deleteProgram(program)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      gl.deleteBuffer(vbo)
      gl.deleteTexture(audioTex)
      gl.deleteTexture(logoTex)
      gl.deleteTexture(sdfTex)
    }
  }, [getAudioData])

  useEffect(() => {
    const cleanup = render()
    return () => {
      cleanup?.()
    }
  }, [render])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  )
}
