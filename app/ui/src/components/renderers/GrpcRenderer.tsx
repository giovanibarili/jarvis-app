import type { HudComponentState } from '../../types/hud'
import { Panel, Row, Dot, Label, RightValue } from './PanelLayout'

export function GrpcRenderer({ state }: { state: HudComponentState }) {
  const port = state.data.port as number
  const isRunning = state.status === 'running'

  return (
    <Panel>
      <Row>
        <Dot status={isRunning ? 'running' : 'stopped'} />
        <Label>gRPC</Label>
        <RightValue>{isRunning ? `:${port}` : 'OFF'}</RightValue>
      </Row>
    </Panel>
  )
}
