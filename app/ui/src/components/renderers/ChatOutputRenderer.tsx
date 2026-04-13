import type { HudComponentState } from '../../types/hud'
import { ChatOutput } from '../panels/ChatOutput'

export function ChatOutputRenderer({ state: _state }: { state: HudComponentState }) {
  return <ChatOutput />
}
