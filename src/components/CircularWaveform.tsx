import { useRef, useEffect, useCallback } from 'react'
import vertSrc from '../shaders/vert.glsl?raw'
import fragSrc from '../shaders/frag.glsl?raw'

function clamp01(v: number) { return v < 0 ? 0 : v > 1 ? 1 : v }

interface Props {
  getAudioData: () => Uint8Array
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

export default function CircularWaveform({ getAudioData }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef(0)
  const smoothedAudioRef = useRef<Float32Array | null>(null)
  const smoothedIntensityRef = useRef(0)
  const mouseRef = useRef({ x: -999, y: -999 })

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

    const audioTex = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, audioTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 128, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(128))

    const uTime = gl.getUniformLocation(program, 'u_time')
    const uAudio = gl.getUniformLocation(program, 'u_audioData')
    const uIntensity = gl.getUniformLocation(program, 'u_intensity')
    const uPixelRatio = gl.getUniformLocation(program, 'u_pixelRatio')
    const uResolution = gl.getUniformLocation(program, 'u_resolution')
    const uMouse = gl.getUniformLocation(program, 'u_mouse')

    gl.useProgram(program)
    gl.uniform1i(uAudio, 0)

    const startTime = performance.now()
    const texData = new Uint8Array(128)
    const smoothAudio = new Float32Array(128)
    smoothedAudioRef.current = smoothAudio

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
      const len = rawData.length
      for (let i = 0; i < 128; i++) {
        const idx = Math.floor((i / 128) * len)
        const v = rawData[idx] / 255
        smoothAudio[i] += (v - smoothAudio[i]) * 0.18
      }

      let sum = 0
      for (let i = 0; i < 128; i++) sum += smoothAudio[i]
      const avgIntensity = sum / 128
      smoothedIntensityRef.current += (avgIntensity - smoothedIntensityRef.current) * 0.15

      const N = 128
      const half = N / 2
      const mirrored = new Float32Array(N)
      for (let i = 0; i < N; i++) {
        mirrored[i] = i < half ? smoothAudio[half - 1 - i] : smoothAudio[i - half]
      }
      const blurred = new Float32Array(N)
      for (let i = 0; i < N; i++) {
        const prev = mirrored[(i - 1 + N) % N]
        const curr = mirrored[i]
        const next = mirrored[(i + 1) % N]
        blurred[i] = prev * 0.25 + curr * 0.5 + next * 0.25
      }
      for (let i = 0; i < N; i++) {
        texData[i] = Math.floor(clamp01(blurred[i]) * 255)
      }

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, audioTex)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 1, gl.RED, gl.UNSIGNED_BYTE, texData)

      const elapsed = (performance.now() - startTime) / 1000
      gl.uniform1f(uTime, elapsed)
      gl.uniform1f(uIntensity, 0.3 + smoothedIntensityRef.current * 3.0)
      gl.uniform1f(uPixelRatio, window.devicePixelRatio || 1)
      gl.uniform2f(uResolution, canvas.width, canvas.height)
      gl.uniform2f(uMouse, mouseRef.current.x, mouseRef.current.y)

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
