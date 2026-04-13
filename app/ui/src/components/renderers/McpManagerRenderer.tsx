import type { HudComponentState } from '../../types/hud'
import { Panel, Row, Dot, Label, RightValue, STATUS_COLORS } from './PanelLayout'

type ServerInfo = { name: string; type: string; status: string; tools: number; error?: string }

export function McpManagerRenderer({ state }: { state: HudComponentState }) {
  const servers = (state.data.servers as ServerInfo[]) ?? []

  if (servers.length === 0) {
    return <Panel><Label>No MCP servers configured</Label></Panel>
  }

  return (
    <Panel>
      {servers.map(s => (
        <Row key={s.name}>
          <Dot status={s.status} />
          <Label>{s.name}</Label>
          <RightValue color={STATUS_COLORS[s.status]}>
            {s.status === 'connected' ? `${s.tools} tools` : s.status.toUpperCase()}
          </RightValue>
        </Row>
      ))}
    </Panel>
  )
}
