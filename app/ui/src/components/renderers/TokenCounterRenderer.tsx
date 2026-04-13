import { useRef, useEffect } from 'react'
import type { HudComponentState } from '../../types/hud'

export function TokenCounterRenderer({ state }: { state: HudComponentState }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const data = state.data as any

  const inputTokens = data?.inputTokens ?? 0
  const outputTokens = data?.outputTokens ?? 0
  const cachePct = data?.cachePct ?? 0
  const contextPct = data?.contextPct ?? 0
  const maxContext = data?.maxContext ?? 200000
  const model = data?.model ?? 'unknown'
  const requestCount = data?.requestCount ?? 0
  const systemTokens = data?.systemTokens ?? 0
  const toolsTokens = data?.toolsTokens ?? 0
  const messagesTokens = data?.messagesTokens ?? 0

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return

    const w = c.width, h = c.height
    const cx = w / 2, cy = h / 2 - 15
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

    // Segments
    let angle = -Math.PI / 2
    if (total > 0) {
      segments.forEach(seg => {
        const sweep = (seg.value / maxContext) * Math.PI * 2
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
    const outputPct = maxContext > 0 ? outputTokens / (maxContext / 10) : 0
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
    ctx.fillText((contextPct * 100).toFixed(0) + '%', cx, cy - 2)
    ctx.fillStyle = '#5a6a7a'
    ctx.font = '500 8px "Orbitron", monospace'
    ctx.fillText('CONTEXT', cx, cy + 10)

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
      ctx.font = '7px "JetBrains Mono", monospace'
      ctx.textAlign = 'left'
      ctx.fillText(item.label, lx - 4, ly + 5)
    })

    // ─── Stats row ───
    const sy = ly + 16
    ctx.fillStyle = '#5a6a7a'
    ctx.font = '8px "JetBrains Mono", monospace'
    ctx.textAlign = 'center'
    ctx.fillText(`IN ${fmt(inputTokens)}  OUT ${fmt(outputTokens)}  REQ ${requestCount}`, cx, sy)

    // ─── Model ───
    ctx.fillStyle = '#4af'
    ctx.font = '7px "Orbitron", monospace'
    ctx.fillText(model, cx, sy + 14)

  }, [inputTokens, outputTokens, cachePct, contextPct, maxContext, model, requestCount, systemTokens, toolsTokens, messagesTokens])

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
      <canvas ref={canvasRef} width={260} height={230} />
    </div>
  )
}
