import { useRef, useEffect, useCallback } from 'react'
import vertSrc from '../shaders/vert.glsl?raw'
import fragSrc from '../shaders/frag.glsl?raw'

const TARGET_HALF      = 0.45  // screen half-extent of the logo's larger axis
const TARGET_TEX_MAX   = 1024  // longer side of the processed logo texture in pixels
const SDF_RANGE_PX     = 256   // ±range packed into the R8 SDF texture (must stay in sync with shader)
const SDF_SCALE        = 1.5   // SDF texture covers this much of the logo bbox

interface Props {
  logoUrl: string
  getAudioData: () => Uint8Array
  gainLeft: number
  gainRight: number
}

interface LogoLayout {
  logoTexW: number
  logoTexH: number
  sdfTexW: number
  sdfTexH: number
  logoHalfW: number  // screen half-extent
  logoHalfH: number
  sdfHalfW: number   // screen half-extent of the padded SDF texture
  sdfHalfH: number
}

function layoutForAspect(aspect: number): LogoLayout {
  let logoTexW: number, logoTexH: number, logoHalfW: number, logoHalfH: number
  if (aspect >= 1) {
    logoTexW  = TARGET_TEX_MAX
    logoTexH  = Math.max(1, Math.round(TARGET_TEX_MAX / aspect))
    logoHalfW = TARGET_HALF
    logoHalfH = TARGET_HALF / aspect
  } else {
    logoTexH  = TARGET_TEX_MAX
    logoTexW  = Math.max(1, Math.round(TARGET_TEX_MAX * aspect))
    logoHalfH = TARGET_HALF
    logoHalfW = TARGET_HALF * aspect
  }
  const sdfTexW = Math.round(logoTexW * SDF_SCALE)
  const sdfTexH = Math.round(logoTexH * SDF_SCALE)
  return {
    logoTexW, logoTexH, sdfTexW, sdfTexH,
    logoHalfW, logoHalfH,
    sdfHalfW: logoHalfW * SDF_SCALE,
    sdfHalfH: logoHalfH * SDF_SCALE,
  }
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

// Build a binary silhouette mask. If the source has real alpha, use it; otherwise
// derive it from luminance against the dominant background colour sampled at the
// four corners. Returns 1 for "inside the logo", 0 for "background".
function extractSilhouette(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const inside = new Uint8Array(w * h)

  let hasAlpha = false
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 250) { hasAlpha = true; break }
  }

  if (hasAlpha) {
    for (let i = 0; i < inside.length; i++) inside[i] = rgba[i * 4 + 3] > 128 ? 1 : 0
    return inside
  }

  // No alpha — figure out whether the background is light or dark by looking
  // at the four corner pixels.
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + (w - 1)) * 4]
  let bgLum = 0
  for (const c of corners) bgLum += rgba[c] * 0.299 + rgba[c + 1] * 0.587 + rgba[c + 2] * 0.114
  bgLum /= corners.length
  const lightBg = bgLum > 128
  for (let i = 0; i < inside.length; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2]
    const lum = r * 0.299 + g * 0.587 + b * 0.114
    inside[i] = lightBg ? (lum < 128 ? 1 : 0) : (lum > 128 ? 1 : 0)
  }
  return inside
}

// Centroid of the silhouette in pixel coords — used as the origin for the
// per-pixel "nearest silhouette point" angle. Falls back to the geometric
// centre if the mask is empty.
function silhouetteCentroid(inside: Uint8Array, w: number, h: number): { cx: number; cy: number } {
  let sx = 0, sy = 0, n = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (inside[y * w + x]) { sx += x; sy += y; n++ }
    }
  }
  if (n === 0) return { cx: w / 2, cy: h / 2 }
  return { cx: sx / n, cy: sy / n }
}

// Chamfer 3x3 (Borgefors) distance transform with parent tracking. Packs SDF
// into R and the parent's angle (relative to the silhouette centroid) into
// G,B as cos/sin so LINEAR filtering wraps cleanly at ±π.
function computeLogoSdfRgba(inside: Uint8Array, w: number, h: number, cx: number, cy: number): Uint8Array {
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

interface ProcessedLogo {
  bmp: HTMLCanvasElement
  sdf: Uint8Array
  layout: LogoLayout
}

function processLogo(url: string): Promise<ProcessedLogo> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const aspect = (img.naturalWidth || 1) / (img.naturalHeight || 1)
      const layout = layoutForAspect(aspect)

      // Color texture: logo fills its own canvas, used to render the ribbon body.
      const off = document.createElement('canvas')
      off.width = layout.logoTexW
      off.height = layout.logoTexH
      const ctx = off.getContext('2d')!
      ctx.clearRect(0, 0, layout.logoTexW, layout.logoTexH)
      ctx.drawImage(img, 0, 0, layout.logoTexW, layout.logoTexH)

      // SDF source: logo centred on a larger padded canvas so wave swings don't
      // clip on the texture rectangle.
      const padX = Math.round((layout.sdfTexW - layout.logoTexW) / 2)
      const padY = Math.round((layout.sdfTexH - layout.logoTexH) / 2)
      const sdfCanvas = document.createElement('canvas')
      sdfCanvas.width = layout.sdfTexW
      sdfCanvas.height = layout.sdfTexH
      const sdfCtx = sdfCanvas.getContext('2d')!
      sdfCtx.clearRect(0, 0, layout.sdfTexW, layout.sdfTexH)
      sdfCtx.drawImage(img, padX, padY, layout.logoTexW, layout.logoTexH)

      const px = sdfCtx.getImageData(0, 0, layout.sdfTexW, layout.sdfTexH).data
      const inside = extractSilhouette(px, layout.sdfTexW, layout.sdfTexH)
      const { cx, cy } = silhouetteCentroid(inside, layout.sdfTexW, layout.sdfTexH)
      const sdf = computeLogoSdfRgba(inside, layout.sdfTexW, layout.sdfTexH, cx, cy)

      resolve({ bmp: off, sdf, layout })
    }
    img.onerror = reject
    img.src = url
  })
}

export default function InfinityWaveform({ logoUrl, getAudioData, gainLeft, gainRight }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef(0)
  const smoothedIntensityRef = useRef(0)
  const mouseRef = useRef({ x: -999, y: -999 })
  const gainRef = useRef({ left: gainLeft, right: gainRight })

  gainRef.current.left = gainLeft
  gainRef.current.right = gainRight

  // Refs that survive across logo swaps so we can re-upload textures without
  // tearing down the GL context.
  const glRef          = useRef<WebGL2RenderingContext | null>(null)
  const logoTexRef     = useRef<WebGLTexture | null>(null)
  const sdfTexRef      = useRef<WebGLTexture | null>(null)
  const layoutRef      = useRef<LogoLayout>(layoutForAspect(35 / 19))
  const uLogoHalfRef   = useRef<WebGLUniformLocation | null>(null)
  const uSdfHalfRef    = useRef<WebGLUniformLocation | null>(null)

  const render = useCallback(() => {
    const canvas = canvasRef.current!
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false })!
    glRef.current = gl

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

    const audioTex = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, audioTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 128, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(128).fill(128))

    const logoTex = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, logoTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]))
    logoTexRef.current = logoTex

    const sdfTex = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, sdfTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 128, 128, 255]))
    sdfTexRef.current = sdfTex

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
    uLogoHalfRef.current = gl.getUniformLocation(program, 'u_logoHalf')
    uSdfHalfRef.current  = gl.getUniformLocation(program, 'u_sdfHalf')

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
      const layout = layoutRef.current
      gl.uniform2f(uLogoHalfRef.current, layout.logoHalfW, layout.logoHalfH)
      gl.uniform2f(uSdfHalfRef.current,  layout.sdfHalfW,  layout.sdfHalfH)

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      rafRef.current = requestAnimationFrame(frame)
    }

    frame()

    return () => {
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
      glRef.current = null
      logoTexRef.current = null
      sdfTexRef.current = null
    }
  }, [getAudioData])

  useEffect(() => {
    const cleanup = render()
    return () => { cleanup?.() }
  }, [render])

  // Reload + reupload the logo's color and SDF textures whenever the URL changes.
  useEffect(() => {
    let cancelled = false
    processLogo(logoUrl).then(({ bmp, sdf, layout }) => {
      if (cancelled) return
      const gl = glRef.current
      const logoTex = logoTexRef.current
      const sdfTex = sdfTexRef.current
      if (!gl || !logoTex || !sdfTex) return

      layoutRef.current = layout

      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, logoTex)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp)

      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, sdfTex)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, layout.sdfTexW, layout.sdfTexH, 0, gl.RGBA, gl.UNSIGNED_BYTE, sdf)
    }).catch(err => {
      if (!cancelled) console.error('Failed to process logo:', err)
    })
    return () => { cancelled = true }
  }, [logoUrl])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  )
}
