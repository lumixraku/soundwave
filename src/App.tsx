import { useState, useCallback, useEffect, useRef } from 'react'
import { useAudioAnalyser } from './hooks/useAudioAnalyser'
import InfinityWaveform from './components/InfinityWaveform'
import './App.css'

type Speaker = 'ai' | 'human' | 'both'

const DEFAULT_LOGO = '/languages.svg'

export default function App() {
  const { start, stop, getAudioData } = useAudioAnalyser()
  const [active, setActive] = useState(false)
  const [speaker, setSpeaker] = useState<Speaker>('both')
  const [error, setError] = useState<string | null>(null)
  const [logoUrl, setLogoUrl] = useState<string>(DEFAULT_LOGO)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Release the previous object URL when the logo changes so we don't leak blobs.
  const lastObjectUrl = useRef<string | null>(null)
  useEffect(() => () => {
    if (lastObjectUrl.current) URL.revokeObjectURL(lastObjectUrl.current)
  }, [])

  const handleToggle = useCallback(async () => {
    if (active) {
      stop()
      setActive(false)
    } else {
      try {
        await start()
        setActive(true)
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : '无法访问麦克风')
      }
    }
  }, [active, start, stop])

  const handleLogoChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (lastObjectUrl.current) URL.revokeObjectURL(lastObjectUrl.current)
    const url = URL.createObjectURL(file)
    lastObjectUrl.current = url
    setLogoUrl(url)
  }, [])

  const handleResetLogo = useCallback(() => {
    if (lastObjectUrl.current) {
      URL.revokeObjectURL(lastObjectUrl.current)
      lastObjectUrl.current = null
    }
    setLogoUrl(DEFAULT_LOGO)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [])

  const gainLeft  = active && (speaker === 'ai'    || speaker === 'both') ? 1 : 0
  const gainRight = active && (speaker === 'human' || speaker === 'both') ? 1 : 0

  return (
    <div className="app">
      <InfinityWaveform
        logoUrl={logoUrl}
        getAudioData={getAudioData}
        gainLeft={gainLeft}
        gainRight={gainRight}
      />
      <div className="overlay">
        <div className="speaker-toggle">
          <button
            className={`speaker-btn ${speaker === 'ai' ? 'active' : ''}`}
            onClick={() => setSpeaker('ai')}
          >
            AI 说话（左）
          </button>
          <button
            className={`speaker-btn ${speaker === 'human' ? 'active' : ''}`}
            onClick={() => setSpeaker('human')}
          >
            我说话（右）
          </button>
          <button
            className={`speaker-btn ${speaker === 'both' ? 'active' : ''}`}
            onClick={() => setSpeaker('both')}
          >
            全部
          </button>
        </div>
        <button className="mic-btn" onClick={handleToggle}>
          {active ? '停止' : '开启麦克风'}
        </button>
        <div className="logo-tools">
          <label className="logo-btn">
            上传 logo
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleLogoChange}
              style={{ display: 'none' }}
            />
          </label>
          {logoUrl !== DEFAULT_LOGO && (
            <button className="logo-btn" onClick={handleResetLogo}>
              恢复默认
            </button>
          )}
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  )
}
