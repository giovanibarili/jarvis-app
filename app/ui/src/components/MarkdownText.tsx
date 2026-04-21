import { useMemo } from 'react'
import { marked } from 'marked'

// Configure marked for inline-friendly rendering
marked.setOptions({
  breaks: true,
  gfm: true,
})

// Custom renderer to keep output compact
const renderer = new marked.Renderer()

// Paragraphs: no wrapping <p> tags — just content with line breaks
renderer.paragraph = ({ tokens }) => {
  // Render child tokens inline (avoid re-entering parser which causes stack overflow)
  const body = tokens.map((t: any) => {
    if (t.type === 'text') return t.text
    if (t.type === 'codespan') return `<code>${t.text}</code>`
    if (t.type === 'strong') return `<strong>${t.text}</strong>`
    if (t.type === 'em') return `<em>${t.text}</em>`
    if (t.type === 'link') return `<a href="${t.href}" target="_blank" rel="noopener" style="color:#4af;text-decoration:underline">${t.text}</a>`
    if (t.type === 'br') return '<br>'
    return t.raw ?? ''
  }).join('')
  return body + '\n'
}

// Links: open in external browser
renderer.link = ({ href, text }) => {
  return `<a href="${href}" target="_blank" rel="noopener" style="color:#4af;text-decoration:underline">${text}</a>`
}

export function MarkdownText({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { renderer, async: false }) as string
    // Trim trailing newlines from block rendering
    return raw.replace(/\n$/, '')
  }, [text])

  return (
    <div
      className={`md-content ${className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
