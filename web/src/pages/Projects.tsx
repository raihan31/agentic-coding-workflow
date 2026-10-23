import { useQuery } from '@tanstack/react-query';
import { api, useLiveEvents } from '../api';
import { Empty, ErrorNote, Link, StatusBadge } from '../components';
import { ago, repoName, usd } from '../format';
import { navigate } from '../router';

export function ProjectsPage() {
  useLiveEvents();
  const { data, error, isLoading } = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Projects</h1>
          <p className="text-sm text-ink-2">Each project turns one requirements document into reviewed, committed code.</p>
        </div>
        <Link to={{ name: 'new' }} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:opacity-90">New project</Link>
      </div>
      <ErrorNote error={error} />
      {isLoading && <div className="text-sm text-ink-2">Loading…</div>}
      {data && !data.length && <Empty title="No projects yet">Upload a BRD, PRD, SRS or handoff document to start one.</Empty>}
      {data && data.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr><th className="px-4 py-2 font-medium">Project</th><th className="px-4 py-2 font-medium">Status</th><th className="px-4 py-2 font-medium">Progress</th><th className="px-4 py-2 text-right font-medium">Cost</th><th className="px-4 py-2 text-right font-medium">Updated</th></tr>
            </thead>
            <tbody>
              {data.map(p => (
                <tr key={p.id} onClick={() => navigate({ name: 'project', id: p.id, tab: 'overview' })} className="cursor-pointer border-b border-line last:border-0 hover:bg-raised">
                  <td className="px-4 py-3">
                    <Link to={{ name: 'project', id: p.id, tab: 'overview' }} className="font-medium text-ink">{p.document ?? p.id}</Link>
                    <div className="text-xs text-ink-2">{p.id} · {repoName(p.repo)}</div>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={p.status} /></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-raised" aria-hidden><div className="h-full rounded-full bg-good" style={{ width: `${(p.tasks.done / Math.max(p.tasks.total, 1)) * 100}%` }} /></div>
                      <span className="tabular-nums text-ink-2">{p.tasks.done}/{p.tasks.total} tasks</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-2">{usd(p.costUsd)}</td>
                  <td className="px-4 py-3 text-right text-ink-2">{ago(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
