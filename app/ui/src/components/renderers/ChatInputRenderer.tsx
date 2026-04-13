import type { HudComponentState } from '../../types/hud'
import { ChatInput } from '../panels/ChatInput'

export function ChatInputRenderer({ state: _state }: { state: HudComponentState }) {
  return <ChatInput />
}
