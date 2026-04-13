import type { HudComponentState } from '../../types/hud'

type ActorPoolProps = {
  state: HudComponentState
  onActorClick?: (actorName: string) => void
  onActorKill?: (actorName: string) => void
}

export function ActorPoolRenderer({ state, onActorClick, onActorKill }: ActorPoolProps) {
  const data = state.data as any
  const actors = (data?.actors ?? []) as Array<{ id: string; role: string; status: string; tasks: number }>
  const total = data?.total ?? 0
  const maxActors = data?.maxActors ?? 5

  const statusColor = (s: string) => {
    switch (s) {
      case 'running': return '#fa4'
      case 'waiting_tools': return 'var(--status-auth)'
      case 'idle': return '#4a8'
      case 'stopped': return '#666'
      default: return 'var(--color-muted)'
    }
  }

  const handleKill = (e: React.MouseEvent, name: string) => {
    e.stopPropagation()
    onActorKill?.(name)
  }

  return (
    <div className="panel">
      <div className="row">
        <span className="label">actors</span>
        <span className="value">{total}/{maxActors}</span>
      </div>
      {actors.map((a: any) => (
        <div
          className="row"
          key={a.id}
          onClick={() => onActorClick?.(a.id)}
          style={{ cursor: onActorClick ? 'pointer' : 'default', display: 'flex', alignItems: 'center' }}
        >
          <span className="dot" style={{ color: statusColor(a.status) }}>●</span>
          <span className="label" style={{ flex: 1 }}>{a.id}</span>
          <span className="rightValue" style={{ marginRight: '6px' }}>{a.role} #{a.tasks}</span>
          <span
            onClick={(e) => handleKill(e, a.id)}
            style={{ cursor: 'pointer', color: '#666', fontSize: '9px', lineHeight: 1 }}
            title={`Kill ${a.id}`}
          >✕</span>
        </div>
      ))}
      {actors.length === 0 && (
        <div className="row">
          <span className="muted">no actors</span>
        </div>
      )}
    </div>
  )
}
