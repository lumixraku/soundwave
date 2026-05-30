import { useState, useCallback } from 'react'
import { useAudioAnalyser } from './hooks/useAudioAnalyser'
import CircularWaveform from './components/CircularWaveform'
import './App.css'

export default function App() {
  const { start, stop, getAudioData } = useAudioAnalyser()
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <div className="app">
      <CircularWaveform getAudioData={getAudioData} />
      <div className="overlay">
        <button className="mic-btn" onClick={handleToggle}>
          {active ? '停止' : '开启麦克风'}
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  )
}
