import type { HudComponentState } from '../../types/hud'
import { ReactorCore } from '../ReactorCore'

export function JarvisCoreRenderer({ state }: { state: HudComponentState }) {
  const statusColor = state.data.status === 'online' ? '#4af'
    : state.data.status === 'processing' ? '#fa4'
    : state.data.status === 'loading' ? '#a6f'
    : '#f44'

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
      <ReactorCore reactor={{ status: state.data.status as string, coreLabel: state.data.coreLabel as string, coreSubLabel: state.data.coreSubLabel as string }} size={160} />
      <div className="statusLabel" style={{ fontSize: '11px', color: statusColor, marginTop: '-8px' }}>
        {(state.data.coreLabel as string)?.toUpperCase() ?? 'OFFLINE'}
      </div>
    </div>
  )
}
