import { useState, useRef, useCallback, useEffect, type KeyboardEvent, type ChangeEvent, type ClipboardEvent } from 'react'
import { SlashMenu } from './SlashMenu'

interface PendingImage {
  label: string
  base64: string
  mediaType: string
  thumbnail: string // data: URL for preview
}

let imageCounter = 0

export function ChatInput() {
  const [input, setInput] = useState('')
  const [images, setImages] = useState<PendingImage[]>([])
  const [slashActive, setSlashActive] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const scrollH = el.scrollHeight
    el.style.height = `${scrollH}px`
    // When exceeds max-height, switch to scrollable
    const maxH = window.innerHeight * 0.4
    el.style.overflowY = scrollH > maxH ? 'auto' : 'hidden'
  }, [])

  useEffect(() => { autoResize() }, [input, autoResize])

  // Track slash state from input value
  useEffect(() => {
    if (input.startsWith('/')) {
      setSlashActive(true)
      setSlashQuery(input.slice(1))
    } else {
      setSlashActive(false)
      setSlashQuery('')
    }
  }, [input])

  const send = (overrideText?: string) => {
    const prompt = (overrideText ?? input).trim()
    if (!prompt && images.length === 0) return

    const text = prompt || (images.length > 0 ? images.map(i => i.label).join(', ') : '')
    const payload: Record<string, unknown> = { prompt: text }
    if (images.length > 0) {
      payload.images = images.map(({ label, base64, mediaType }) => ({ label, base64, mediaType }))
    }
    setInput('')
    setImages([])
    setSlashActive(false)
    fetch('/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {})
    textareaRef.current?.focus()
  }

  const handleSlashSelect = useCallback((name: string) => {
    setSlashActive(false)
    setSlashQuery('')
    setInput('')

    // System commands — bypass AI, call backend directly
    if (name === 'clear_session') {
      fetch('/chat/clear-session', { method: 'POST' }).catch(() => {})
      textareaRef.current?.focus()
      return
    }

    // Regular capabilities — send as "use /capability_name" for JARVIS to interpret
    send(`use /${name}`)
  }, [images])

  const handleSlashClose = useCallback(() => {
    setSlashActive(false)
    setInput('')
  }, [])

  const handleKey = (e: KeyboardEvent) => {
    // When slash menu is active, let SlashMenu handle Enter/Tab/Arrow/Esc
    if (slashActive && ['ArrowUp', 'ArrowDown', 'Tab', 'Escape'].includes(e.key)) {
      return // SlashMenu captures these via window listener
    }
    if (slashActive && e.key === 'Enter' && !e.shiftKey) {
      return // SlashMenu handles Enter for selection
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
    // Shift+Enter → default behavior (newline)
  }

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
  }

  const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    // Check if clipboard has text — if so, let the browser handle it normally
    const hasText = Array.from(items).some(i => i.type === 'text/plain')
    const imageItems = Array.from(items).filter(i => i.type.startsWith('image/'))

    // Only intercept if there are images and NO text (pure image paste, e.g. screenshot)
    if (imageItems.length === 0 || hasText) return

    e.preventDefault()
    for (const item of imageItems) {
      const file = item.getAsFile()
      if (!file) continue
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        // data:image/png;base64,xxxxx
        const [header, base64] = dataUrl.split(',')
        const mediaType = header.split(':')[1].split(';')[0]
        imageCounter++
        const label = `Image #${imageCounter}`
        setImages(prev => [...prev, { label, base64, mediaType, thumbnail: dataUrl }])
      }
      reader.readAsDataURL(file)
    }
  }

  const removeImage = (label: string) => {
    setImages(prev => prev.filter(i => i.label !== label))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', position: 'relative' }} ref={wrapperRef}>
      <SlashMenu
        query={slashQuery}
        onSelect={handleSlashSelect}
        onClose={handleSlashClose}
        visible={slashActive}
      />
      {images.length > 0 && (
        <div className="chatImagePreview">
          {images.map(img => (
            <div key={img.label} className="chatImageThumb">
              <img src={img.thumbnail} alt={img.label} />
              <span className="chatImageLabel">{img.label}</span>
              <button className="chatImageRemove" onClick={() => removeImage(img.label)}>×</button>
            </div>
          ))}
        </div>
      )}
      <div className="chatInputBar" style={{ alignItems: 'flex-end' }}>
        <span className="chatInputLabel" style={{ paddingBottom: '3px' }}>YOU</span>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleChange}
          onKeyDown={handleKey}
          onPaste={handlePaste}
          placeholder="Type a message... (/ for commands)"
          autoFocus
          rows={1}
          className="chatInput chatTextarea"
        />
      </div>
    </div>
  )
}
