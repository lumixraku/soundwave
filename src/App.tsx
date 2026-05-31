import { useState, useCallback } from 'react'
import { useAudioAnalyser } from './hooks/useAudioAnalyser'
import InfinityWaveform from './components/InfinityWaveform'
import './App.css'

type Speaker = 'ai' | 'human'

export default function App() {
  const { start, stop, getAudioData } = useAudioAnalyser()
  const [active, setActive] = useState(false)
  const [speaker, setSpeaker] = useState<Speaker>('human')
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

  const gainLeft = active && speaker === 'ai' ? 1 : 0
  const gainRight = active && speaker === 'human' ? 1 : 0

  return (
    <div className="app">
      <InfinityWaveform
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
        </div>
        <button className="mic-btn" onClick={handleToggle}>
          {active ? '停止' : '开启麦克风'}
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  )
}
