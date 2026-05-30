import { useRef, useCallback, useEffect } from 'react'

const FFT_SIZE = 256

export function useAudioAnalyser() {
  const ctxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const dataRef = useRef<Uint8Array>(new Uint8Array(FFT_SIZE / 2))
  const activeRef = useRef(false)

  const start = useCallback(async () => {
    if (activeRef.current) return

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = FFT_SIZE
    analyser.smoothingTimeConstant = 0.75
    source.connect(analyser)

    ctxRef.current = ctx
    analyserRef.current = analyser
    streamRef.current = stream
    dataRef.current = new Uint8Array(analyser.frequencyBinCount)
    activeRef.current = true
  }, [])

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    ctxRef.current?.close()
    ctxRef.current = null
    analyserRef.current = null
    streamRef.current = null
    dataRef.current = new Uint8Array(FFT_SIZE / 2)
    activeRef.current = false
  }, [])

  const getAudioData = useCallback(() => {
    if (analyserRef.current) {
      analyserRef.current.getByteFrequencyData(dataRef.current)
    }
    return dataRef.current
  }, [])

  useEffect(() => {
    return () => {
      if (activeRef.current) stop()
    }
  }, [stop])

  return { start, stop, getAudioData, activeRef }
}
