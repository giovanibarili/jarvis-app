import type { HudReactor } from '../types/hud'

const statusColors: Record<string, { primary: string; secondary: string; accent: string }> = {
  online:       { primary: 'rgba(68,170,255,0.6)',  secondary: 'rgba(0,229,176,0.4)',  accent: 'rgba(170,102,255,0.3)' },
  processing:     { primary: 'rgba(255,170,68,0.6)',  secondary: 'rgba(255,102,68,0.4)', accent: 'rgba(255,204,68,0.3)' },
  waiting_tools:  { primary: 'rgba(170,102,255,0.6)', secondary: 'rgba(136,68,255,0.4)', accent: 'rgba(200,150,255,0.3)' },
  loading:        { primary: 'rgba(170,102,255,0.6)', secondary: 'rgba(68,170,255,0.4)', accent: 'rgba(0,229,176,0.3)' },
  initializing: { primary: 'rgba(170,102,255,0.5)', secondary: 'rgba(68,170,255,0.3)', accent: 'rgba(0,229,176,0.2)' },
  offline:      { primary: 'rgba(255,68,68,0.3)',   secondary: 'rgba(255,68,68,0.15)', accent: 'rgba(255,68,68,0.1)' },
}

export function ReactorCore({ reactor, size = 200 }: { reactor: HudReactor; size?: number }) {
  const colors = statusColors[reactor.status] ?? statusColors.offline
  const isActive = reactor.status !== 'offline'
  const isWorking = reactor.status === 'processing' || reactor.status === 'loading' || reactor.status === 'waiting_tools'

  const blobSize = size * 0.6

  return (
    <div className="orbWrapper" style={{ width: size, height: size }}>
      {/* Ambient glow */}
      <div className="orbGlow" style={{
        width: size * 0.8,
        height: size * 0.8,
        background: `radial-gradient(circle, ${colors.primary}, transparent 70%)`,
        opacity: isActive ? 0.4 : 0.1,
        animation: isActive ? 'pulse-slow 3s ease-in-out infinite' : undefined,
      }} />

      {/* Primary blob */}
      <div className="orbBlob" style={{
        width: blobSize,
        height: blobSize,
        borderRadius: '48% 52% 55% 45% / 42% 58% 42% 58%',
        background: `linear-gradient(135deg, ${colors.primary}, ${colors.secondary})`,
        animation: isActive
          ? `morph1 ${isWorking ? '2s' : '4s'} ease-in-out infinite`
          : undefined,
        opacity: isActive ? 1 : 0.3,
      }} />

      {/* Secondary blob */}
      <div className="orbBlobSecondary" style={{
        width: blobSize * 0.85,
        height: blobSize * 0.85,
        borderRadius: '52% 48% 45% 55% / 55% 45% 55% 45%',
        background: `linear-gradient(225deg, ${colors.secondary}, ${colors.accent})`,
        animation: isActive
          ? `morph2 ${isWorking ? '1.5s' : '3s'} ease-in-out infinite`
          : undefined,
        opacity: isActive ? 0.8 : 0.2,
      }} />

      {/* Core highlight */}
      <div className="orbHighlight" style={{
        width: blobSize * 0.5,
        height: blobSize * 0.5,
        borderRadius: '45% 55% 50% 50% / 50% 50% 55% 45%',
        background: 'radial-gradient(circle, rgba(255,255,255,0.35), transparent)',
        animation: isActive
          ? `morph3 ${isWorking ? '1s' : '5s'} ease-in-out infinite`
          : undefined,
        opacity: isActive ? 1 : 0.2,
      }} />

      {/* Spinning halo ring */}
      {isActive && (
        <div className="orbHalo" style={{
          width: blobSize * 1.3,
          height: blobSize * 1.3,
          background: `conic-gradient(from 0deg, transparent, ${colors.primary}, transparent, ${colors.secondary}, transparent)`,
          opacity: 0.15,
          animation: `spin ${isWorking ? '3s' : '8s'} linear infinite`,
        }} />
      )}

      {/* Ripple rings (when processing) */}
      {isWorking && [0, 1, 2].map(i => (
        <div key={i} className="orbRipple" style={{
          width: blobSize * 0.8,
          height: blobSize * 0.8,
          border: `1px solid ${colors.primary}`,
          animation: `ripple 2s ease-out infinite ${i * 0.6}s`,
        }} />
      ))}

    </div>
  )
}
