import { useRef, useEffect } from 'react'
import type { HudComponentState } from '../../types/hud'

export function TokenCounterRenderer({ state }: { state: HudComponentState }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const data = state.data as any

  const sessionInputTokens = data?.sessionInputTokens ?? data?.inputTokens ?? 0
  const sessionOutputTokens = data?.sessionOutputTokens ?? data?.outputTokens ?? 0
  const contextTokens = data?.contextTokens ?? 0
  const cachePct = data?.cachePct ?? 0
  const contextPct = data?.contextPct ?? 0
  const maxContext = data?.maxContext ?? 200000
  const model = data?.model ?? 'unknown'
  const requestCount = data?.requestCount ?? 0
  const systemTokens = data?.systemTokens ?? 0
  const toolsTokens = data?.toolsTokens ?? 0
  const messagesTokens = data?.messagesTokens ?? 0
  const streaming = data?.streaming ?? false
  const streamingVerb = data?.streamingVerb ?? ''
  const streamingElapsedMs = data?.streamingElapsedMs ?? 0
  const streamingOutputChars = data?.streamingOutputChars ?? 0

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return

    const w = c.width, h = c.height
    const cx = w / 2, cy = h / 2 - 25
    ctx.clearRect(0, 0, w, h)

    const outerR = 70
    const midR = 55
    const innerR = 42

    const fmt = (n: number) => n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)

    // ─── Outer ring: context breakdown (system / tools / messages) ───
    const total = systemTokens + toolsTokens + messagesTokens
    const segments = [
      { label: 'SYSTEM', value: systemTokens, color: '#a6f' },
      { label: 'TOOLS', value: toolsTokens, color: '#4a8' },
      { label: 'MESSAGES', value: messagesTokens, color: '#4af' },
    ]

    // Background
    ctx.beginPath()
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(42,58,74,0.2)'
    ctx.lineWidth = 10
    ctx.stroke()

    // Segments — proportional to total context used (contextPct), split by relative weight
    const usedSweep = contextPct * Math.PI * 2
    let angle = -Math.PI / 2
    if (total > 0) {
      segments.forEach(seg => {
        const sweep = (seg.value / total) * usedSweep
        if (sweep > 0.01) {
          ctx.beginPath()
          ctx.arc(cx, cy, outerR, angle, angle + sweep)
          ctx.strokeStyle = seg.color
          ctx.lineWidth = 10
          ctx.lineCap = 'butt'
          ctx.stroke()

          // Glow
          ctx.shadowColor = seg.color
          ctx.shadowBlur = 4
          ctx.beginPath()
          ctx.arc(cx, cy, outerR, angle, angle + sweep)
          ctx.strokeStyle = seg.color
          ctx.lineWidth = 1
          ctx.stroke()
          ctx.shadowBlur = 0
        }
        angle += sweep
      })
    }

    // Ticks
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2 - Math.PI / 2
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * (outerR + 6), cy + Math.sin(a) * (outerR + 6))
      ctx.lineTo(cx + Math.cos(a) * (outerR + 9), cy + Math.sin(a) * (outerR + 9))
      ctx.strokeStyle = 'rgba(68,170,255,0.1)'
      ctx.lineWidth = 1
      ctx.stroke()
    }

    // ─── Middle ring: cache ratio ───
    ctx.beginPath()
    ctx.arc(cx, cy, midR, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(42,58,74,0.15)'
    ctx.lineWidth = 4
    ctx.stroke()
    if (cachePct > 0) {
      ctx.beginPath()
      ctx.arc(cx, cy, midR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(cachePct, 1))
      ctx.strokeStyle = '#4a8'
      ctx.lineWidth = 4
      ctx.lineCap = 'round'
      ctx.stroke()
    }

    // ─── Inner ring: output ───
    const outputPct = maxContext > 0 ? sessionOutputTokens / (maxContext / 10) : 0
    ctx.beginPath()
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(42,58,74,0.15)'
    ctx.lineWidth = 3
    ctx.stroke()
    if (outputPct > 0) {
      ctx.beginPath()
      ctx.arc(cx, cy, innerR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(outputPct, 1))
      ctx.strokeStyle = '#fa4'
      ctx.lineWidth = 3
      ctx.lineCap = 'round'
      ctx.stroke()
    }

    // ─── Center text ───
    const ctxColor = contextPct > 0.8 ? '#f44' : contextPct > 0.5 ? '#fa4' : '#fff'
    ctx.fillStyle = ctxColor
    ctx.font = '500 16px "JetBrains Mono", monospace'
    ctx.textAlign = 'center'
    ctx.fillText(`${fmt(contextTokens)} / ${fmt(maxContext)}`, cx, cy - 4)
    ctx.fillStyle = '#5a6a7a'
    ctx.font = '500 10px "Orbitron", monospace'
    ctx.fillText(`CONTEXT ${(contextPct * 100).toFixed(1)}%`, cx, cy + 10)

    // ─── Legend below ring ───
    const ly = cy + outerR + 16
    const legendItems = [
      ...segments,
      { label: 'CACHE', value: 0, color: '#4a8' },
      { label: 'OUTPUT', value: 0, color: '#fa4' },
    ]
    const spacing = w / legendItems.length
    legendItems.forEach((item, i) => {
      const lx = spacing * i + spacing / 2
      ctx.fillStyle = item.color
      ctx.fillRect(lx - 12, ly, 6, 6)
      ctx.fillStyle = '#7a8a9a'
      ctx.font = '9px "JetBrains Mono", monospace'
      ctx.textAlign = 'left'
      ctx.fillText(item.label, lx - 4, ly + 5)
    })

    // ─── Stats row (session accumulated totals) ───
    const sy = ly + 16
    ctx.fillStyle = '#4a5a6a'
    ctx.font = '9px "Orbitron", monospace'
    ctx.textAlign = 'center'
    ctx.fillText('SESSION', cx, sy)
    ctx.fillStyle = '#5a6a7a'
    ctx.font = '10px "JetBrains Mono", monospace'
    ctx.fillText(`IN ${fmt(sessionInputTokens)}  OUT ${fmt(sessionOutputTokens)}  REQ ${requestCount}`, cx, sy + 12)

    // ─── Streaming status or Model ───
    if (streaming) {
      const elapsedSec = Math.floor(streamingElapsedMs / 1000)
      const estOutputTokens = Math.round(streamingOutputChars / 4) // rough char→token estimate
      const statusText = `${streamingVerb}… ${elapsedSec}s · ↑ ${fmt(estOutputTokens)} tok`
      // Pulsing effect
      const pulseAlpha = 0.6 + 0.4 * Math.sin(Date.now() / 400)
      ctx.globalAlpha = pulseAlpha
      ctx.fillStyle = '#f1fa8c'
      ctx.font = '500 10px "JetBrains Mono", monospace'
      ctx.fillText(statusText, cx, sy + 24)
      ctx.globalAlpha = 1
    } else {
      ctx.fillStyle = '#4af'
      ctx.font = '9px "Orbitron", monospace'
      ctx.fillText(model, cx, sy + 24)
    }

  }, [sessionInputTokens, sessionOutputTokens, contextTokens, cachePct, contextPct, maxContext, model, requestCount, systemTokens, toolsTokens, messagesTokens, streaming, streamingVerb, streamingElapsedMs, streamingOutputChars])

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
      <canvas ref={canvasRef} width={260} height={265} />
    </div>
  )
}
