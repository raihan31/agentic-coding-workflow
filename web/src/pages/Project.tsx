import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, useLiveEvents, type ProjectDetail, type ProjectEvent, type Task } from '../api';
import { Button, Card, CodeView, Empty, ErrorNote, Rich, SegmentBar, Stat, StatusBadge, Tabs, statusInfo } from '../components';
import { clock, compact, duration, repoName, usd } from '../format';
import { navigate, type Route } from '../router';

type ProjectRoute = Extract<Route, { name: 'project' }>;
const TASK_COLORS = { done: 'var(--good)', running: 'var(--accent)', needs_attention: 'var(--warn)', failed: 'var(--critical)', blocked: 'var(--serious)', pending: 'var(--line)' };
const RERUNNABLE = new Set(['failed', 'partial', 'rate_limited', 'budget_exceeded', 'cancelled', 'needs_attention', 'integration_failed']);
const TASK_TEXT: Record<string, string> = { done: 'text-good', running: 'text-accent animate-pulse', needs_attention: 'text-warn', failed: 'text-critical', blocked: 'text-serious', pending: 'text-muted' };
const taskCount = (p: ProjectDetail, s: keyof typeof TASK_COLORS) => s === 'needs_attention' ? p.tasks.attention ?? 0 : p.tasks[s];

export function ProjectPage({ route }: { route: ProjectRoute }) {
  const live = useLiveEvents(route.id);
  const qc = useQueryClient();
  const project = useQuery({ queryKey: ['project', route.id], queryFn: () => api.project(route.id), refetchInterval: 15_000 });
  const events = useQuery({ queryKey: ['events', route.id], queryFn: () => api.events(route.id), staleTime: Infinity });
  const action = useMutation({
    mutationFn: (a: 'pause' | 'resume' | 'cancel') => api.action(route.id, a),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', route.id] }),
  });
  const rerun = useMutation({ mutationFn: () => api.rerun(route.id), onSettled: () => qc.invalidateQueries({ queryKey: ['project', route.id] }) });
  const deliver = useMutation({ mutationFn: () => api.deliver(route.id), onSettled: () => qc.invalidateQueries({ queryKey: ['project', route.id] }) });
  const setTab = (tab: string, task?: string) => navigate({ ...route, tab, task }, true);

  if (project.error) return <ErrorNote error={project.error} />;
  if (!project.data) return <div className="text-sm text-ink-2">Loading…</div>;
  const p = project.data;
  const phase = p.workflow?.phase;
  const openQuestions = p.backlog?.openQuestions.filter(q => q.blocking && !q.answer).length ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold">{p.document ?? p.id}</h1>
            <StatusBadge status={p.status} />
            {/* The phase only adds information while it is not already implied by the status. */}
            {phase && ['analyzing', 'awaiting_approval', 'paused'].includes(phase) && phase !== p.status && <StatusBadge status={phase} />}
          </div>
          <div className="mt-1 text-sm text-ink-2">
            {p.id} · <span title={p.repo}>{repoName(p.repo)}</span> · branch <code className="font-mono text-xs">{p.branch}</code>
            <span className="ml-2 text-xs" title={live ? 'Receiving live updates' : 'Live updates disconnected; polling'}>{live ? <><span className="text-good" aria-hidden>●</span> live</> : <><span className="text-muted" aria-hidden>○</span> polling</>}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {p.state.delivery?.prUrl && <a href={p.state.delivery.prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium hover:bg-raised">Pull request #{p.state.delivery.prNumber} <span aria-hidden>↗</span></a>}
          {p.status === 'completed' && !p.state.delivery?.prUrl && <Button kind="primary" onClick={() => deliver.mutate()} disabled={deliver.isPending} title="Push the project branch and open a draft pull request">{deliver.isPending ? 'Delivering…' : 'Push & open PR'}</Button>}
          {RERUNNABLE.has(p.status) && (!phase || phase === 'finished') && <Button kind="primary" onClick={() => rerun.mutate()} disabled={rerun.isPending} title="Start a new run: done tasks are kept, the rest are retried">{rerun.isPending ? 'Starting…' : 'Run again'}</Button>}
          {phase === 'awaiting_approval' && <Button kind="primary" onClick={() => setTab('backlog')}>Review &amp; approve backlog</Button>}
          {phase === 'running' && <Button onClick={() => action.mutate('pause')} disabled={action.isPending} title="Stops before the next task">Pause</Button>}
          {phase === 'paused' && <Button kind="primary" onClick={() => action.mutate('resume')} disabled={action.isPending}>Resume</Button>}
          {phase && phase !== 'finished' && <Button kind="danger" disabled={action.isPending} onClick={() => { if (confirm('Cancel this project? The running task is stopped and its partial work discarded; committed tasks stay on the branch.')) action.mutate('cancel'); }}>Cancel</Button>}
        </div>
      </div>
      <ErrorNote error={action.error ?? deliver.error ?? rerun.error} />
      {p.state.delivery?.error && !deliver.error && <div className="rounded-md border border-line bg-raised px-3 py-2 text-sm"><span className="text-critical" aria-hidden>✕ </span>Delivery failed: {p.state.delivery.error.slice(0, 300)}</div>}
      {p.state.delivery?.pushedAt && !p.state.delivery.prUrl && <div className="text-sm text-ink-2"><span className="text-good" aria-hidden>✓ </span>Branch pushed to <code className="font-mono text-xs">{p.state.delivery.remote}</code>.</div>}
      {p.workflow?.message && <div className="rounded-md border border-line bg-raised px-3 py-2 text-sm"><span className="text-warn" aria-hidden>◆ </span>{p.workflow.message}</div>}
      <Escalation p={p} onTask={id => setTab('tasks', id)} />
      {p.state.error && p.status !== 'running' && p.status !== 'needs_attention' && <div className="rounded-md border border-line bg-raised px-3 py-2 text-sm"><span className={p.status === 'rate_limited' ? 'text-warn' : 'text-critical'} aria-hidden>{p.status === 'rate_limited' ? '◷ ' : '✕ '}</span>{p.state.error.split('\n')[0].slice(0, 400)}</div>}

      <Tabs active={route.tab} onChange={tab => setTab(tab)} tabs={[
        { id: 'overview', label: 'Overview' },
        { id: 'backlog', label: 'Backlog', badge: openQuestions ? <span className="rounded-full bg-raised px-1.5 text-xs text-warn">{openQuestions}</span> : undefined },
        { id: 'tasks', label: 'Tasks', badge: <span className="text-xs tabular-nums text-muted">{p.tasks.done}/{p.tasks.total}</span> },
        { id: 'activity', label: 'Activity' },
        { id: 'report', label: 'Report' },
      ]} />

      {route.tab === 'overview' && <Overview p={p} onTask={id => setTab('tasks', id)} />}
      {route.tab === 'backlog' && <BacklogView p={p} />}
      {route.tab === 'tasks' && <TasksView p={p} events={events.data ?? []} selected={route.task} onSelect={id => setTab('tasks', id)} />}
      {route.tab === 'activity' && <ActivityView events={events.data ?? []} onTask={id => setTab('tasks', id)} />}
      {route.tab === 'report' && <ReportView id={p.id} />}
    </div>
  );
}

function Overview({ p, onTask }: { p: ProjectDetail; onTask: (id: string) => void }) {
  const tokens = p.state.invocations.reduce((s, i) => s + (i.tokens?.input ?? 0) + (i.tokens?.output ?? 0), 0);
  const trace = p.traceability;
  const cov = (s: string) => trace.filter(t => t.status === s).length;
  const current = p.workflow?.currentTask ?? Object.entries(p.state.tasks).find(([, t]) => t.status === 'running')?.[0];
  const currentTask = p.backlog?.tasks.find(t => t.id === current);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 rounded-lg border border-line bg-surface p-4 md:grid-cols-4">
        <Stat label="Tasks done" value={`${p.tasks.done} / ${p.tasks.total}`} hint={p.tasks.failed ? `${p.tasks.failed} failed` : undefined} />
        <Stat label="Requirements implemented" value={`${cov('implemented')} / ${trace.length}`} hint={cov('partial') ? `${cov('partial')} partial` : undefined} />
        <Stat label="Spend" value={usd(p.costUsd)} hint={p.state.invocations.at(-1)?.costSource === 'gateway' ? 'measured by gateway' : 'agent-reported'} />
        <Stat label="Tokens" value={compact(tokens)} />
      </div>
      {currentTask && (
        <Card title="Working on">
          <button className="text-left" onClick={() => onTask(currentTask.id)}>
            <div className="font-medium">{currentTask.id}: {currentTask.title}</div>
            <div className="mt-1 line-clamp-2 text-sm text-ink-2"><Rich text={currentTask.description} /></div>
          </button>
        </Card>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Tasks">
          <SegmentBar total={p.tasks.total} segments={(['done', 'running', 'needs_attention', 'failed', 'blocked', 'pending'] as const).map(s => ({ label: statusInfo(s).label, value: taskCount(p, s), color: TASK_COLORS[s] }))} />
        </Card>
        <Card title="Requirement coverage">
          <SegmentBar total={trace.length} segments={[
            { label: 'Implemented', value: cov('implemented'), color: 'var(--good)' },
            { label: 'Partial', value: cov('partial'), color: 'var(--accent)' },
            { label: 'Not implemented', value: cov('not_implemented'), color: 'var(--line)' },
            { label: 'Not planned', value: cov('not_planned'), color: 'var(--serious)' },
          ]} />
        </Card>
      </div>
      {p.backlog && <Card title="Summary"><p className="text-sm leading-relaxed text-ink-2"><Rich text={p.backlog.summary} /></p></Card>}
      {p.state.integration && (
        <Card title="Integration checks">
          <StatusBadge status={p.state.integration.passed ? 'completed' : 'integration_failed'} />
          <span className="ml-2 text-sm text-ink-2">{p.state.integration.passed ? 'All checks pass on the project branch.' : 'Checks fail on the combined branch; see report.'}</span>
        </Card>
      )}
    </div>
  );
}

/** A task the manager escalated: the question, and (while the workflow waits) a way to answer it. */
function Escalation({ p, onTask }: { p: ProjectDetail; onTask: (id: string) => void }) {
  const qc = useQueryClient();
  const [guidance, setGuidance] = useState('');
  const waiting = p.workflow?.phase === 'needs_attention' ? p.workflow.question : undefined;
  const local = Object.entries(p.state.tasks).find(([, t]) => t.status === 'needs_attention' && t.question);
  const q = waiting ?? (local && { taskId: local[0], question: local[1].question! });
  const guide = useMutation({
    mutationFn: (action: 'retry' | 'skip') => api.guide(p.id, q!.taskId, { action, ...(guidance.trim() ? { guidance: guidance.trim() } : {}) }),
    onSuccess: () => { setGuidance(''); void qc.invalidateQueries({ queryKey: ['project', p.id] }); },
  });
  if (!q) return null;
  const task = p.backlog?.tasks.find(t => t.id === q.taskId);
  return (
    <section className="rounded-lg border border-line bg-surface p-4" aria-label="Task needs your input">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status="needs_attention" />
        <button onClick={() => onTask(q.taskId)} className="font-mono text-xs text-accent hover:underline">{q.taskId}</button>
        {task && <span className="font-medium"><Rich text={task.title} /></span>}
      </div>
      <p className="mt-2 text-sm"><span className="text-muted">The manager asks: </span><Rich text={q.question} /></p>
      {waiting ? (
        <>
          <textarea rows={3} value={guidance} onChange={e => setGuidance(e.target.value)} aria-label="Your answer"
            placeholder="Your answer or instructions. They are added to the task brief, and the task is planned and built again."
            className="mt-3 w-full rounded-md border border-line bg-page px-3 py-2 text-sm" />
          <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
            <ErrorNote error={guide.error} />
            <Button onClick={() => guide.mutate('skip')} disabled={guide.isPending} title="Mark the task failed and continue; tasks that depend on it are blocked">Skip task</Button>
            <Button kind="primary" onClick={() => guide.mutate('retry')} disabled={guide.isPending || !guidance.trim()}>{guide.isPending ? 'Sending…' : 'Retry with this answer'}</Button>
          </div>
        </>
      ) : (
        <p className="mt-2 text-xs text-ink-2">Answer with <code className="font-mono">npm start -- project guide --project &lt;dir&gt; --task {q.taskId} --guidance "…"</code>, then run the project again.</p>
      )}
    </section>
  );
}

function BacklogView({ p }: { p: ProjectDetail }) {
  const qc = useQueryClient();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const approve = useMutation({
    mutationFn: () => api.approve(p.id, answers),
    onSuccess: () => { setAnswers({}); void qc.invalidateQueries({ queryKey: ['project', p.id] }); },
  });
  if (!p.backlog) return <Empty title="No backlog yet">The analyst is reading the document; the backlog appears here when it's ready.</Empty>;
  const b = p.backlog;
  const awaiting = p.workflow?.phase === 'awaiting_approval';
  const missing = b.openQuestions.filter(q => q.blocking && !q.answer && !answers[q.id]?.trim());
  return (
    <div className="space-y-4">
      {b.openQuestions.length > 0 && (
        <Card title={`Open questions (${b.openQuestions.length})`}>
          <ul className="space-y-4">
            {b.openQuestions.map(q => (
              <li key={q.id}>
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 font-mono text-xs text-muted">{q.id}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium"><Rich text={q.question} /> {q.blocking && <span className="ml-1 whitespace-nowrap text-xs font-normal text-warn">◆ blocking</span>}</div>
                    <div className="mt-1 text-xs text-ink-2"><Rich text={q.context} /></div>
                    {q.answer ? <div className="mt-2 text-sm"><span className="text-good" aria-hidden>✓ </span><Rich text={q.answer} /></div>
                      : awaiting && <textarea rows={2} value={answers[q.id] ?? ''} onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })}
                        placeholder={q.blocking ? 'Required before the build can start' : 'Optional: otherwise the analyst\'s assumption is used'}
                        className="mt-2 w-full rounded-md border border-line bg-page px-3 py-2 text-sm" />}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {awaiting && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface p-3 shadow-sm">
          <div className="text-sm text-ink-2">{missing.length ? `${missing.length} blocking question${missing.length > 1 ? 's' : ''} still need an answer.` : `Approving starts the build: ${b.tasks.length} tasks on branch ${p.branch}.`}</div>
          <div className="flex items-center gap-2">
            <ErrorNote error={approve.error} />
            <Button kind="primary" disabled={missing.length > 0 || approve.isPending} onClick={() => approve.mutate()}>{approve.isPending ? 'Approving…' : 'Approve & start build'}</Button>
          </div>
        </div>
      )}
      <Card title={`Tasks (${b.tasks.length})`}>
        <ol className="divide-y divide-line">
          {b.tasks.map(t => <TaskItem key={t.id} task={t} status={p.state.tasks[t.id]?.status ?? 'pending'} />)}
        </ol>
      </Card>
      <Card title={`Requirements (${b.requirements.length})`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted"><tr><th className="py-1.5 pr-3 font-medium">ID</th><th className="py-1.5 pr-3 font-medium">Requirement</th><th className="py-1.5 pr-3 font-medium">Priority</th><th className="py-1.5 font-medium">Coverage</th></tr></thead>
            <tbody>
              {b.requirements.map(r => {
                const t = p.traceability.find(x => x.id === r.id);
                return (
                  <tr key={r.id} className="border-t border-line align-top">
                    <td className="py-2 pr-3 font-mono text-xs text-muted">{r.id}</td>
                    <td className="py-2 pr-3"><div className="font-medium"><Rich text={r.title} /></div><div className="text-xs text-ink-2"><Rich text={r.description} /></div><div className="mt-0.5 text-xs text-muted">Source: {r.source}</div></td>
                    <td className="py-2 pr-3 text-xs uppercase text-ink-2">{r.priority}</td>
                    <td className="py-2">{t && <StatusBadge status={t.status} />}<div className="mt-1 font-mono text-xs text-muted">{t?.tasks.map(x => x.id).join(', ')}</div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {b.outOfScope.length > 0 && <Card title="Out of scope"><ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">{b.outOfScope.map((o, i) => <li key={i}><Rich text={o} /></li>)}</ul></Card>}
    </div>
  );
}

function TaskItem({ task, status }: { task: Task; status: string }) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted">{task.id}</span>
        <span className="font-medium"><Rich text={task.title} /></span>
        <StatusBadge status={status} />
        <span className="text-xs text-muted">size {task.size} · risk {task.risk}{task.dependsOn.length ? ` · after ${task.dependsOn.join(', ')}` : ''}{task.splitFrom ? ` · split from ${task.splitFrom}` : ''}</span>
      </div>
      <p className="mt-1 text-sm text-ink-2"><Rich text={task.description} /></p>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-ink-2">{task.acceptanceCriteria.map((a, i) => <li key={i}><Rich text={a} /></li>)}</ul>
    </li>
  );
}

function describe(e: ProjectEvent): { icon: string; tone: string; text: string } {
  const d = e.data as Record<string, never>;
  switch (e.type) {
    case 'project.created': return { icon: '◆', tone: 'text-accent', text: `Project created on branch ${d.branch}` };
    case 'project.status': return { icon: statusInfo(d.status).icon, tone: 'text-ink-2', text: `Project ${statusInfo(d.status).label.toLowerCase()}${d.error ? `: ${String(d.error).split('\n')[0].slice(0, 160)}` : ''}` };
    case 'backlog.ready': return { icon: '◆', tone: 'text-accent', text: `Backlog ready: ${d.requirements} requirements, ${d.tasks} tasks, ${d.openQuestions} open questions` };
    case 'backlog.answered': return { icon: '✎', tone: 'text-ink-2', text: `Answered ${(d.questions as string[]).join(', ')}` };
    case 'backlog.approved': return { icon: '✓', tone: 'text-good', text: 'Backlog approved, build started' };
    case 'task.status': return { icon: statusInfo(d.status).icon, tone: d.status === 'done' ? 'text-good' : d.status === 'failed' ? 'text-critical' : 'text-ink-2', text: `${e.taskId} ${statusInfo(d.status).label.toLowerCase()}${d.commit ? ` · commit ${String(d.commit).slice(0, 8)}` : ''}${d.status === 'done' || d.status === 'failed' ? ` · ${d.attempts} attempt${d.attempts === 1 ? '' : 's'}` : ''}` };
    case 'agent.started': return { icon: '▸', tone: 'text-muted', text: `${d.role} started (${d.phase})` };
    case 'agent.finished': {
      const tok = d.tokens as { input: number; output: number } | undefined;
      return { icon: d.outcome === 'ok' ? '▪' : '✕', tone: d.outcome === 'ok' ? 'text-muted' : 'text-critical', text: `${d.role} ${d.outcome === 'ok' ? 'finished' : 'failed'} in ${duration(d.durationMs)}${tok ? ` · ${compact(tok.input + tok.output)} tokens` : ''}${d.costUsd ? ` · ${usd(d.costUsd)}` : ''}` };
    }
    case 'checks.finished': {
      const results = d.results as { command: string; code: number }[];
      const failed = results.filter(r => r.code !== 0);
      return { icon: failed.length ? '✕' : '✓', tone: failed.length ? 'text-critical' : 'text-good', text: failed.length ? `Checks failed: ${failed.map(f => f.command).join(', ')}` : `Checks passed (${results.length})` };
    }
    case 'security.finished': return { icon: d.blocking ? '✕' : '✓', tone: d.blocking ? 'text-critical' : 'text-good', text: d.blocking ? `Security scan blocked: ${d.blocking} finding${d.blocking === 1 ? '' : 's'} at or above the threshold` : `Security scan passed (${d.scanned} files${d.findings ? `, ${d.findings} minor findings for the reviewer` : ''})` };
    case 'review.finished': return { icon: d.decision === 'pass' ? '✓' : '↺', tone: d.decision === 'pass' ? 'text-good' : 'text-warn', text: `Review ${d.decision === 'pass' ? 'passed' : 'requested changes'}${d.findings ? ` (${d.findings} findings)` : ''}: ${String(d.summary).slice(0, 200)}` };
    case 'attempt.finished': return { icon: d.gate === 'passed' ? '✓' : '↺', tone: d.gate === 'passed' ? 'text-good' : 'text-warn', text: `Attempt ${d.attempt} ${d.gate === 'passed' ? 'passed every gate' : `rejected at ${String(d.gate).replace(/_/g, ' ')}`}` };
    case 'integration.finished': return { icon: d.passed ? '✓' : '✕', tone: d.passed ? 'text-good' : 'text-critical', text: `Integration checks ${d.passed ? 'passed' : 'failed'} on the project branch` };
    case 'manager.decision': {
      const what = { retry: 'retry with new guidance', split: `split it into ${(d.subtasks as string[] | undefined)?.length ?? 'smaller'} tasks`, escalate: 'ask you', skip: 'stop trying' }[d.decision as string] ?? d.decision;
      return { icon: '◇', tone: d.decision === 'skip' ? 'text-critical' : 'text-accent', text: `Manager decided to ${what}: ${String(d.rationale).slice(0, 220)}` };
    }
    case 'task.split': return { icon: '⑂', tone: 'text-accent', text: `Split into ${(d.into as { id: string }[]).map(t => t.id).join(', ')}` };
    case 'task.escalated': return { icon: '?', tone: 'text-warn', text: `Waiting for your input: ${String(d.question).slice(0, 220)}` };
    case 'task.guided': return { icon: '✎', tone: 'text-ink-2', text: d.action === 'skip' ? 'You skipped the task' : `You answered: ${String(d.guidance ?? '').slice(0, 220)}` };
    case 'run.finished': return { icon: '■', tone: 'text-ink-2', text: `Run finished: ${statusInfo(d.status).label.toLowerCase()} · ${usd(Number(d.costUsd ?? 0))}` };
    default: return { icon: '•', tone: 'text-muted', text: e.type };
  }
}

function Timeline({ events, onTask }: { events: ProjectEvent[]; onTask?: (id: string) => void }) {
  if (!events.length) return <Empty title="No activity yet" />;
  return (
    <ol className="space-y-1.5">
      {events.map(e => {
        const d = describe(e);
        return (
          <li key={e.id} className="flex gap-3 text-sm">
            <span className="w-16 shrink-0 font-mono text-xs leading-5 text-muted tabular-nums">{clock(e.at)}</span>
            <span aria-hidden className={`w-4 shrink-0 text-center leading-5 ${d.tone}`}>{d.icon}</span>
            <span className="min-w-0 leading-5 text-ink">
              {onTask && e.taskId && <button onClick={() => onTask(e.taskId!)} className="mr-1.5 font-mono text-xs text-accent hover:underline">{e.taskId}</button>}
              {d.text}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function TasksView({ p, events, selected, onSelect }: { p: ProjectDetail; events: ProjectEvent[]; selected?: string; onSelect: (id: string) => void }) {
  const tasks = p.backlog?.tasks ?? [];
  const running = Object.entries(p.state.tasks).find(([, t]) => t.status === 'running')?.[0];
  const active = selected ?? running ?? tasks[0]?.id;
  useEffect(() => { if (!selected && active) onSelect(active); }, [selected, active, onSelect]);
  if (!tasks.length) return <Empty title="No tasks yet" />;
  const task = tasks.find(t => t.id === active) ?? tasks[0];
  const state = p.state.tasks[task.id];
  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <ol className="space-y-1 self-start rounded-lg border border-line bg-surface p-2">
        {tasks.map(t => (
          <li key={t.id}>
            <button onClick={() => onSelect(t.id)} className={`flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm ${t.id === task.id ? 'bg-raised' : 'hover:bg-raised'}`}>
              <span aria-hidden className={`mt-0.5 w-4 text-center text-xs ${TASK_TEXT[p.state.tasks[t.id]?.status ?? 'pending']}`}>{statusInfo(p.state.tasks[t.id]?.status ?? 'pending').icon}</span>
              <span className="min-w-0"><span className="font-mono text-xs text-muted">{t.id}</span> <span className="text-ink"><Rich text={t.title} /></span></span>
            </button>
          </li>
        ))}
      </ol>
      <div className="min-w-0 space-y-4">
        <Card title={<span>{task.id}: {task.title}</span>} actions={<StatusBadge status={state?.status ?? 'pending'} />}>
          <p className="text-sm text-ink-2"><Rich text={task.description} /></p>
          <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
            <div><span className="text-muted">Attempts </span><span className="tabular-nums">{state?.attempts ?? 0}</span></div>
            <div><span className="text-muted">Commit </span>{state?.commit ? <code className="font-mono text-xs">{state.commit.slice(0, 10)}</code> : '-'}</div>
            <div><span className="text-muted">Implements </span><span className="font-mono text-xs">{task.requirementIds.join(', ')}</span></div>
          </div>
          {task.splitFrom && <div className="mt-2 text-xs text-ink-2">The manager split this out of {task.splitFrom}.</div>}
          {state?.guidance?.length ? (
            <div className="mt-3 space-y-1.5">
              {state.guidance.map((g, i) => (
                <div key={i} className="rounded-md bg-raised px-3 py-2 text-sm"><span className="font-medium">{g.from === 'human' ? 'You' : 'Manager'}: </span><span className="text-ink-2"><Rich text={g.text} /></span></div>
              ))}
            </div>
          ) : null}
          {state?.reviewSummary && <div className="mt-3 rounded-md bg-raised px-3 py-2 text-sm"><span className="font-medium">Reviewer: </span><span className="text-ink-2"><Rich text={state.reviewSummary} /></span></div>}
          {state?.error && state.status !== 'done' && <div className="mt-3 rounded-md bg-raised px-3 py-2 text-sm text-ink-2">{state.error.split('\n')[0].slice(0, 300)}</div>}
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium text-ink-2">Acceptance criteria ({task.acceptanceCriteria.length})</summary>
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-ink-2">{task.acceptanceCriteria.map((a, i) => <li key={i}><Rich text={a} /></li>)}</ul>
          </details>
        </Card>
        <Card title="Timeline"><Timeline events={events.filter(e => e.taskId === task.id)} /></Card>
        <Artifacts projectId={p.id} taskId={task.id} />
      </div>
    </div>
  );
}

const ARTIFACT_ORDER = (name: string) => [/^requirement/, /^plan/, /^diff-/, /^checks-/, /^security-\d+\.json/, /^review-parsed/, /^feedback/, /^manager-\d+\.json/, /^status-/, /^developer-.*\.md/, /\.log$/].findIndex(r => r.test(name)) >>> 0;

function Artifacts({ projectId, taskId }: { projectId: string; taskId: string }) {
  const files = useQuery({ queryKey: ['taskFiles', projectId, taskId], queryFn: () => api.taskFiles(projectId, taskId) });
  const list = useMemo(() => (files.data ?? []).filter(f => !f.name.endsWith('.schema.json')).sort((a, b) => ARTIFACT_ORDER(a.name) - ARTIFACT_ORDER(b.name) || a.name.localeCompare(b.name, undefined, { numeric: true })), [files.data]);
  const [open, setOpen] = useState<string>();
  const current = open && list.some(f => f.name === open) ? open : list.find(f => f.name === 'plan.md')?.name;
  const content = useQuery({ queryKey: ['taskFile', projectId, taskId, current], queryFn: () => api.taskFile(projectId, taskId, current!), enabled: Boolean(current) });
  if (!list.length) return null;
  return (
    <Card title="Artifacts">
      <div className="mb-3 flex flex-wrap gap-1.5">
        {list.map(f => (
          <button key={f.name} onClick={() => setOpen(f.name)} className={`rounded-md border px-2 py-1 font-mono text-xs ${f.name === current ? 'border-accent text-ink' : 'border-line text-ink-2 hover:text-ink'}`}>{f.name}</button>
        ))}
      </div>
      <ErrorNote error={content.error} />
      {current && content.data !== undefined && <CodeView name={current} text={content.data} />}
    </Card>
  );
}

function ActivityView({ events, onTask }: { events: ProjectEvent[]; onTask: (id: string) => void }) {
  const [verbose, setVerbose] = useState(false);
  const shown = (verbose ? events : events.filter(e => e.type !== 'agent.started')).slice().reverse();
  return (
    <Card title={`Activity (${events.length} events)`} actions={<label className="flex items-center gap-1.5 text-xs text-ink-2"><input type="checkbox" checked={verbose} onChange={e => setVerbose(e.target.checked)} /> show agent starts</label>}>
      <Timeline events={shown} onTask={onTask} />
    </Card>
  );
}

function ReportView({ id }: { id: string }) {
  const report = useQuery({ queryKey: ['report', id], queryFn: () => api.projectFile(id, 'report.md'), retry: false });
  if (report.error) return <Empty title="No report yet">The report is written when a build run finishes.</Empty>;
  return <Card title="report.md">{report.data !== undefined ? <CodeView name="report.md" text={report.data} /> : 'Loading…'}</Card>;
}
