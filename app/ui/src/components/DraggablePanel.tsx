import { Rnd } from 'react-rnd'
import { useRef, useEffect, useCallback, type ReactNode } from 'react'

type Props = {
  id: string
  pieceId: string
  defaultX: number
  defaultY: number
  defaultWidth: number
  defaultHeight: number
  minWidth?: number
  minHeight?: number
  children: ReactNode
  borderColor?: string
  onClose?: () => void
  /** Watch children height changes and grow/shrink the panel from the top */
  autoGrowBottom?: boolean
}

function saveLayout(pieceId: string, x: number, y: number, width: number, height: number) {
  fetch('/hud/layout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pieceId, x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }),
  }).catch(() => {})
}

export function DraggablePanel({
  id,
  pieceId,
  defaultX,
  defaultY,
  defaultWidth,
  defaultHeight,
  minWidth = 100,
  minHeight = 60,
  children,
  borderColor,
  onClose,
  autoGrowBottom = false,
}: Props) {
  const rndRef = useRef<Rnd>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const lastAutoH = useRef(0)

  const syncHeight = useCallback(() => {
    if (!autoGrowBottom || !rndRef.current || !innerRef.current) return
    const inner = innerRef.current
    const needed = inner.scrollHeight + 2 // 2px for border
    if (needed === lastAutoH.current) return
    lastAutoH.current = needed

    const rnd = rndRef.current
    // Get current position — keep y + height anchored to bottom
    const selfEl = (rnd as any).getSelfElement() as HTMLElement | null
    if (!selfEl) return
    const curY = parseInt(selfEl.style.top || '0') || defaultY
    const curH = selfEl.offsetHeight
    const bottom = curY + curH
    const newH = Math.max(needed, minHeight)
    const newY = bottom - newH

    rnd.updatePosition({ x: parseInt(selfEl.style.left || '0') || defaultX, y: Math.max(0, newY) })
    rnd.updateSize({ width: selfEl.offsetWidth || defaultWidth, height: newH })
  }, [autoGrowBottom, defaultX, defaultY, defaultWidth, minHeight])

  useEffect(() => {
    if (!autoGrowBottom || !innerRef.current) return
    const observer = new ResizeObserver(() => syncHeight())
    observer.observe(innerRef.current)
    return () => observer.disconnect()
  }, [autoGrowBottom, syncHeight])

  // Sync position/size when props change (e.g. from hud_layout tool)
  useEffect(() => {
    if (!rndRef.current) return
    rndRef.current.updatePosition({ x: defaultX, y: defaultY })
    rndRef.current.updateSize({ width: defaultWidth, height: defaultHeight })
  }, [defaultX, defaultY, defaultWidth, defaultHeight])

  return (
    <Rnd
      ref={rndRef}
      default={{
        x: defaultX,
        y: defaultY,
        width: defaultWidth,
        height: defaultHeight,
      }}
      minWidth={minWidth}
      minHeight={minHeight}
      bounds="parent"
      style={borderColor ? { borderColor } : undefined}
      dragHandleClassName="drag-handle"
      enableResizing={{
        top: false,
        right: true,
        bottom: true,
        left: false,
        topRight: false,
        bottomRight: true,
        bottomLeft: false,
        topLeft: false,
      }}
      resizeHandleStyles={{
        bottomRight: {
          width: '10px',
          height: '10px',
          bottom: '2px',
          right: '2px',
          cursor: 'se-resize',
        },
      }}
      onDragStop={(_e, d) => {
        saveLayout(pieceId, d.x, d.y, defaultWidth, defaultHeight)
      }}
      onResizeStop={(_e, _dir, ref, _delta, pos) => {
        saveLayout(pieceId, pos.x, pos.y, parseInt(ref.style.width), parseInt(ref.style.height))
      }}
    >
      <div ref={innerRef} className="draggablePanel" style={{ width: '100%', height: '100%' }}>
        <div className="drag-handle panelHeader"
          style={borderColor ? { borderBottomColor: borderColor } : undefined}>
          <span>{id}</span>
          <span style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <span className="panelHeaderIcon">⠿</span>
            {onClose && (
              <span
                onClick={(e) => { e.stopPropagation(); onClose(); }}
                style={{ cursor: 'pointer', color: 'var(--color-muted)', fontSize: '9px', lineHeight: 1 }}
              >✕</span>
            )}
          </span>
        </div>

        <div className="panelContent">
          {children}
        </div>
      </div>
    </Rnd>
  )
}
