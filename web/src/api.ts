import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'needs_attention';
export interface Guidance { from: 'manager' | 'human'; text: string; at: string; }
export interface TaskState { status: TaskStatus; attempts: number; commit?: string; dir?: string; startedAt?: string; finishedAt?: string; error?: string; reviewSummary?: string; interventions?: number; guidance?: Guidance[]; question?: string; }
export interface Invocation { command: string; runId: string; startedAt: string; finishedAt?: string; status?: string; costUsd?: number; costSource?: string; tokens?: { input: number; output: number }; }
export interface ProjectSummary {
  id: string; status: string; repo: string; branch: string; document: string | null; createdAt: string; updatedAt: string;
  tasks: { total: number; done: number; running: number; failed: number; blocked: number; pending: number; attention: number };
  costUsd: number;
}
export interface Requirement { id: string; title: string; description: string; type: string; priority: string; source: string; }
export interface Task { id: string; title: string; description: string; requirementIds: string[]; dependsOn: string[]; acceptanceCriteria: string[]; size: string; risk: string; splitFrom?: string; }
export interface OpenQuestion { id: string; question: string; context: string; blocking: boolean; requirementIds: string[]; answer?: string; }
export interface Backlog { summary: string; requirements: Requirement[]; tasks: Task[]; openQuestions: OpenQuestion[]; outOfScope: string[]; }
export interface Trace { id: string; title: string; priority: string; status: 'implemented' | 'partial' | 'not_implemented' | 'not_planned'; tasks: { id: string; status: TaskStatus; commit?: string }[]; }
export interface WorkflowView { phase: string; status?: string; currentTask?: string; message?: string; question?: { taskId: string; question: string }; }
export interface ProjectDetail extends ProjectSummary {
  state: {
    baseSha: string; worktree: string; error?: string; integration?: { passed: boolean }; tasks: Record<string, TaskState>; invocations: Invocation[]; document: { name: string; format: string };
    delivery?: { pushedAt?: string; remote?: string; prUrl?: string; prNumber?: number; error?: string };
  };
  backlog: Backlog | null; traceability: Trace[]; workflow?: WorkflowView;
}
export interface ProjectEvent { id: number; projectId: string; runId: string | null; taskId: string | null; type: string; data: Record<string, unknown>; at: string; }
export interface FileInfo { name: string; size: number; }

const TOKEN_KEY = 'agentic-api-token';
const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; } };
export const setToken = (token: string) => { try { localStorage.setItem(TOKEN_KEY, token); } catch { /* private mode */ } };

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function request<T>(path: string, init: RequestInit = {}, as: 'json' | 'text' = 'json'): Promise<T> {
  const token = getToken();
  const res = await fetch(path, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers } });
  if (!res.ok) {
    const body = await res.text();
    let message = body;
    try { message = (JSON.parse(body) as { error?: string }).error ?? body; } catch { /* plain text */ }
    throw new ApiError(res.status, message || res.statusText);
  }
  return (as === 'json' ? res.json() : res.text()) as Promise<T>;
}
const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export const api = {
  health: () => request<{ ok: boolean; temporal: boolean; auth: boolean }>('/api/health'),
  projects: () => request<ProjectSummary[]>('/api/projects'),
  project: (id: string) => request<ProjectDetail>(`/api/projects/${id}`),
  events: (id: string, after = 0) => request<ProjectEvent[]>(`/api/projects/${id}/events?after=${after}&limit=2000`),
  projectFile: (id: string, name: string) => request<string>(`/api/projects/${id}/files/${name}`, {}, 'text'),
  taskFiles: (id: string, taskId: string) => request<FileInfo[]>(`/api/projects/${id}/tasks/${taskId}/files`),
  taskFile: (id: string, taskId: string, name: string) => request<string>(`/api/projects/${id}/tasks/${taskId}/files/${name}`, {}, 'text'),
  create: (form: FormData) => request<{ id: string }>('/api/projects', { method: 'POST', body: form }),
  approve: (id: string, answers: Record<string, string>) => post(`/api/projects/${id}/approve`, { answers }),
  action: (id: string, action: 'pause' | 'resume' | 'cancel') => post(`/api/projects/${id}/${action}`),
  rerun: (id: string) => post(`/api/projects/${id}/rerun`),
  guide: (id: string, taskId: string, body: { action: 'retry' | 'skip'; guidance?: string }) => post(`/api/projects/${id}/tasks/${encodeURIComponent(taskId)}/guide`, body),
  deliver: (id: string) => post<{ prUrl?: string }>(`/api/projects/${id}/deliver`),
};

/**
 * Live updates over SSE: new events are appended to the cached event list and the affected
 * queries are refreshed (debounced, so a burst of agent events costs one refetch).
 */
export function useLiveEvents(projectId?: string): boolean {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const token = getToken();
    const params = new URLSearchParams({ ...(projectId ? { project: projectId } : {}), ...(token ? { token } : {}) });
    const source = new EventSource(`/api/stream?${params}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = msg => {
      const event = JSON.parse(msg.data) as ProjectEvent;
      qc.setQueryData<ProjectEvent[]>(['events', event.projectId], old => old && !old.some(e => e.id === event.id) ? [...old, event] : old);

      // Native desktop notifications
      if (typeof window !== 'undefined' && window.desktopAPI?.sendNotification) {
        if (event.type === 'backlog.ready' || event.type === 'backlog.approved') {
          window.desktopAPI.sendNotification('Orchestrator Update', `Project ${event.projectId}: Backlog status updated`);
        } else if (event.type === 'project.completed') {
          window.desktopAPI.sendNotification('Project Completed', `Project ${event.projectId} successfully finished!`);
        } else if (event.type === 'task.failed' || event.type === 'needs_attention') {
          window.desktopAPI.sendNotification('Action Needed', `Task in project ${event.projectId} needs your input`);
        }
      }

      clearTimeout(timer);
      timer = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ['project', event.projectId] });
        void qc.invalidateQueries({ queryKey: ['projects'] });
        if (event.taskId) void qc.invalidateQueries({ queryKey: ['taskFiles', event.projectId, event.taskId] });
      }, 400);
    };
    return () => { clearTimeout(timer); source.close(); setConnected(false); };
  }, [projectId, qc]);
  return connected;
}
