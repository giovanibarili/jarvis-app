import type { HudComponentState } from '../../types/hud'
import { Panel, Row, Dot, Label, RightValue } from './PanelLayout'

export function CapabilityExecutorRenderer({ state }: { state: HudComponentState }) {
  const d = state.data
  const tools = d.tools as string[] | undefined
  const calls = d.callsPerTool as Record<string, number> | undefined

  return (
    <Panel>
      {tools && tools.length > 0 && tools.map(name => (
        <Row key={name}>
          <Dot status="connected" />
          <Label>{name}</Label>
          <RightValue>{calls?.[name] ?? 0}</RightValue>
        </Row>
      ))}
      <Row>
        <Label>total</Label>
        <RightValue>{Number(d.totalCalls ?? 0)} calls · {Number(d.avgTimeMs ?? 0)}ms avg</RightValue>
      </Row>
    </Panel>
  )
}
