import type { ReactNode } from 'react'

// ─── Design Tokens ────────────────────────────────────────────
// Backward-compatible token object pointing to CSS custom properties.
// Prefer className-based components below for new code.

export const panelView = {
  border: 'var(--panel-border)',
  bg: 'var(--panel-bg)',
  radius: 'var(--panel-radius)',
  headerPadding: 'var(--header-padding)',
  headerFont: 'var(--font-display)',
  headerSize: 'var(--header-size)',
  headerColor: 'var(--header-color)',
  headerLetterSpacing: 'var(--header-letter-spacing)',
  headerDragIcon: 'var(--header-drag-icon)',
  contentPadding: 'var(--content-padding)',
  contentFont: 'var(--font-mono)',
  contentSize: 'var(--content-size)',
  rowGap: 'var(--row-gap)',
  rowSpacing: 'var(--row-spacing)',
  label: 'var(--color-label)',
  value: 'var(--color-value)',
  muted: 'var(--color-muted)',
  rightValue: 'var(--color-muted)',
  rightValueSize: '9px',
} as const

// ─── Status ───────────────────────────────────────────────────

export const STATUS_COLORS: Record<string, string> = {
  running: 'var(--status-running)',
  connected: 'var(--status-running)',
  starting: 'var(--status-starting)',
  connecting: 'var(--status-starting)',
  stopped: 'var(--status-stopped)',
  disconnected: 'var(--status-stopped)',
  auth_required: 'var(--status-auth)',
  error: 'var(--status-error)',
  offline: 'var(--status-error)',
}

// ─── Components ───────────────────────────────────────────────

export function Panel({ children }: { children: ReactNode }) {
  return <div className="panel">{children}</div>
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="row">{children}</div>
}

export function Dot({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? 'var(--status-stopped)'
  const icon = status === 'error' || status === 'offline' ? '✕'
    : status === 'auth_required' ? '🔐'
    : status === 'connecting' || status === 'starting' ? '◌'
    : status === 'running' || status === 'connected' ? '●'
    : '○'
  return <span className="dot" style={{ color }}>{icon}</span>
}

export function Label({ children }: { children: ReactNode }) {
  return <span className="label">{children}</span>
}

export function Value({ children, color }: { children: ReactNode; color?: string }) {
  return <span className="value" style={color ? { color } : undefined}>{children}</span>
}

export function RightValue({ children, color }: { children: ReactNode; color?: string }) {
  return <span className="rightValue" style={color ? { color } : undefined}>{children}</span>
}

export function Muted({ children }: { children: ReactNode }) {
  return <span className="muted">{children}</span>
}
