import type { ReactNode } from 'react';
import { href, navigate, type Route } from './router';

type Tone = 'good' | 'warn' | 'serious' | 'critical' | 'info' | 'neutral';
const TONE_TEXT: Record<Tone, string> = {
  good: 'text-good', warn: 'text-warn', serious: 'text-serious', critical: 'text-critical', info: 'text-accent', neutral: 'text-muted',
};
const STATUS: Record<string, { tone: Tone; label: string; icon: string }> = {
  // project
  backlog_ready: { tone: 'info', label: 'Backlog ready', icon: '◆' },
  needs_answers: { tone: 'warn', label: 'Needs answers', icon: '?' },
  running: { tone: 'info', label: 'Running', icon: '●' },
  paused: { tone: 'neutral', label: 'Paused', icon: '❚❚' },
  rate_limited: { tone: 'warn', label: 'Rate limited · waiting', icon: '◷' },
  needs_attention: { tone: 'warn', label: 'Needs your input', icon: '?' },
  completed: { tone: 'good', label: 'Completed', icon: '✓' },
  partial: { tone: 'serious', label: 'Partial', icon: '◐' },
  integration_failed: { tone: 'critical', label: 'Integration failed', icon: '✕' },
  budget_exceeded: { tone: 'critical', label: 'Budget exceeded', icon: '$' },
  cancelled: { tone: 'neutral', label: 'Cancelled', icon: '⊘' },
  failed: { tone: 'critical', label: 'Failed', icon: '✕' },
  // task
  pending: { tone: 'neutral', label: 'Pending', icon: '○' },
  done: { tone: 'good', label: 'Done', icon: '✓' },
  blocked: { tone: 'serious', label: 'Blocked', icon: '⊘' },
  // requirement coverage
  implemented: { tone: 'good', label: 'Implemented', icon: '✓' },
  not_implemented: { tone: 'neutral', label: 'Not implemented', icon: '○' },
  not_planned: { tone: 'serious', label: 'Not planned', icon: '!' },
  // workflow phase
  analyzing: { tone: 'info', label: 'Analyzing document', icon: '●' },
  awaiting_approval: { tone: 'warn', label: 'Awaiting your approval', icon: '◆' },
  waiting_rate_limit: { tone: 'warn', label: 'Waiting for rate limit', icon: '◷' },
  finished: { tone: 'neutral', label: 'Finished', icon: '■' },
};
export const statusInfo = (status: string) => STATUS[status] ?? { tone: 'neutral' as Tone, label: status.replace(/_/g, ' '), icon: '•' };

/** Status is never color alone: icon + label, color only on the icon. */
export function StatusBadge({ status, compact = false }: { status: string; compact?: boolean }) {
  const s = statusInfo(status);
  const live = status === 'running' || status === 'analyzing';
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-raised px-2 py-0.5 text-xs font-medium text-ink-2">
      <span aria-hidden className={`${TONE_TEXT[s.tone]} ${live ? 'animate-pulse' : ''} text-[0.7rem] leading-none`}>{s.icon}</span>
      {compact ? <span className="sr-only">{s.label}</span> : s.label}
    </span>
  );
}

/** Renders `backtick` spans from agent-written text as inline code. */
export function Rich({ text }: { text: string }) {
  return <>{text.split(/(`[^`\n]+`)/g).map((part, i) => part.startsWith('`') && part.endsWith('`') && part.length > 2
    ? <code key={i} className="rounded bg-raised px-1 py-px font-mono text-[0.85em] text-ink">{part.slice(1, -1)}</code>
    : part)}</>;
}

export function Link({ to, children, className = '' }: { to: Route; children: ReactNode; className?: string }) {
  return <a href={href(to)} className={className} onClick={e => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); navigate(to); }}>{children}</a>;
}

export function Button({ children, onClick, kind = 'secondary', disabled, type = 'button', title }: {
  children: ReactNode; onClick?: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; type?: 'button' | 'submit'; title?: string;
}) {
  const styles = {
    primary: 'bg-accent text-accent-ink border-transparent hover:opacity-90',
    secondary: 'bg-surface text-ink border-line hover:bg-raised',
    danger: 'bg-surface text-critical border-line hover:bg-raised',
  }[kind];
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick}
      className={`inline-flex items-center justify-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles}`}>
      {children}
    </button>
  );
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-line bg-surface ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 truncate text-2xl font-semibold tabular-nums text-ink">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-ink-2">{hint}</div>}
    </div>
  );
}

/** Segmented bar with a 2px surface gap between segments; each segment has a label in the legend below. */
export function SegmentBar({ segments, total }: { segments: { label: string; value: number; color: string }[]; total: number }) {
  const shown = segments.filter(s => s.value > 0);
  return (
    <div>
      <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full bg-raised" role="img"
        aria-label={shown.map(s => `${s.label}: ${s.value}`).join(', ') || 'none'}>
        {shown.map(s => <div key={s.label} title={`${s.label}: ${s.value}`} style={{ width: `${(s.value / Math.max(total, 1)) * 100}%`, background: s.color }} className="h-full first:rounded-l-full last:rounded-r-full" />)}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
        {segments.map(s => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: s.color }} />{s.label} <span className="tabular-nums text-ink">{s.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: string; badge?: ReactNode }[]; active: string; onChange: (id: string) => void }) {
  return (
    <nav className="-mb-px flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map(t => (
        <button key={t.id} role="tab" aria-selected={active === t.id} onClick={() => onChange(t.id)}
          className={`inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${active === t.id ? 'border-accent text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}>
          {t.label}{t.badge}
        </button>
      ))}
    </nav>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center">
      <div className="text-sm font-semibold text-ink">{title}</div>
      {children && <div className="mt-1 text-sm text-ink-2">{children}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return <div role="alert" className="rounded-md border border-line bg-raised px-3 py-2 text-sm text-ink"><span className="text-critical" aria-hidden>✕ </span>{error instanceof Error ? error.message : String(error)}</div>;
}

/** Artifact viewer: diffs get +/- coloring, JSON is pretty-printed, everything else is plain text. */
export function CodeView({ name, text }: { name: string; text: string }) {
  let body = text;
  if (name.endsWith('.json')) { try { body = JSON.stringify(JSON.parse(text), null, 2); } catch { /* raw */ } }
  const diff = name.endsWith('.patch');
  return (
    <pre className="max-h-[32rem] overflow-auto rounded-md border border-line bg-raised p-3 font-mono text-xs leading-relaxed text-ink">
      {diff ? body.split('\n').map((line, i) => (
        <div key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'text-good' : line.startsWith('-') && !line.startsWith('---') ? 'text-critical' : line.startsWith('@@') ? 'text-accent' : ''}>{line || ' '}</div>
      )) : body}
    </pre>
  );
}
