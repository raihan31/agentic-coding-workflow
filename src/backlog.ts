import { z } from 'zod';

export const RequirementSchema = z.object({
  id: z.string().describe('Stable ID such as REQ-001'),
  title: z.string(),
  description: z.string(),
  type: z.enum(['functional', 'non_functional', 'constraint']),
  priority: z.enum(['must', 'should', 'could', 'wont']),
  source: z.string().describe('Where in the document this comes from: section heading or short quote'),
});
export const TaskSchema = z.object({
  id: z.string().describe('Stable ID such as T-001'),
  title: z.string(),
  description: z.string().describe('What to build, precise enough for an engineer who has not read the document'),
  requirementIds: z.array(z.string()),
  dependsOn: z.array(z.string()).describe('IDs of tasks that must be completed first'),
  acceptanceCriteria: z.array(z.string()).describe('Observable, testable conditions'),
  size: z.enum(['S', 'M', 'L']),
  risk: z.enum(['low', 'medium', 'high']),
  /** Set when the manager agent split a failed task into smaller ones. */
  splitFrom: z.string().optional(),
});
export const OpenQuestionSchema = z.object({
  id: z.string().describe('Stable ID such as Q-001'),
  question: z.string(),
  context: z.string().describe('Why it matters and what the analyst assumed meanwhile'),
  blocking: z.boolean().describe('True if implementation would differ materially depending on the answer'),
  requirementIds: z.array(z.string()),
  /** Filled in by a human before the backlog is approved. */
  answer: z.string().optional(),
});
export const BacklogSchema = z.object({
  summary: z.string().describe('What the project is, in two or three sentences'),
  requirements: z.array(RequirementSchema),
  tasks: z.array(TaskSchema),
  openQuestions: z.array(OpenQuestionSchema),
  outOfScope: z.array(z.string()),
});
export type Requirement = z.infer<typeof RequirementSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;
export type Backlog = z.infer<typeof BacklogSchema>;

/** JSON Schema handed to `claude --json-schema` (the human-only `answer` field is left out). */
export function backlogJsonSchema(): Record<string, unknown> {
  const schema = BacklogSchema.extend({ tasks: z.array(TaskSchema.omit({ splitFrom: true })), openQuestions: z.array(OpenQuestionSchema.omit({ answer: true })) });
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return json;
}

export class BacklogError extends Error {
  constructor(readonly problems: string[]) { super(`Invalid backlog:\n${problems.map(p => `- ${p}`).join('\n')}`); this.name = 'BacklogError'; }
}

/** Dependency order that otherwise follows the analyst's backlog order (always the earliest ready task next). Throws on cycles. */
export function taskOrder(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const position = new Map(tasks.map((t, i) => [t.id, i]));
  const indegree = new Map(tasks.map(t => [t.id, t.dependsOn.filter(d => byId.has(d)).length]));
  const ordered: Task[] = [];
  const ready = tasks.filter(t => indegree.get(t.id) === 0);
  while (ready.length) {
    ready.sort((a, b) => position.get(a.id)! - position.get(b.id)!);
    const task = ready.shift()!;
    ordered.push(task);
    for (const t of tasks) {
      if (!t.dependsOn.includes(task.id)) continue;
      indegree.set(t.id, indegree.get(t.id)! - 1);
      if (indegree.get(t.id) === 0) ready.push(t);
    }
  }
  if (ordered.length !== tasks.length) {
    const stuck = tasks.filter(t => !ordered.includes(t)).map(t => t.id);
    throw new BacklogError([`dependency cycle among tasks: ${stuck.join(', ')}`]);
  }
  return ordered;
}

export function parseBacklog(data: unknown, opts: { maxTasks: number }): Backlog {
  const parsed = BacklogSchema.safeParse(data);
  if (!parsed.success) throw new BacklogError(parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`));
  const backlog = parsed.data;
  const problems: string[] = [];
  const dupes = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);
  const reqIds = new Set(backlog.requirements.map(r => r.id));
  const taskIds = new Set(backlog.tasks.map(t => t.id));
  for (const [kind, ids] of [['requirement', backlog.requirements.map(r => r.id)], ['task', backlog.tasks.map(t => t.id)], ['question', backlog.openQuestions.map(q => q.id)]] as const) {
    for (const id of new Set(dupes(ids))) problems.push(`duplicate ${kind} id ${id}`);
  }
  // A backlog without requirements usually means the analyst could not read the document.
  if (!backlog.requirements.length) problems.push('no requirements extracted from the document');
  if (!backlog.tasks.length) problems.push('no tasks');
  if (backlog.tasks.length > opts.maxTasks) problems.push(`${backlog.tasks.length} tasks exceeds the limit of ${opts.maxTasks}; merge tasks or split the document`);
  for (const t of backlog.tasks) {
    if (!t.acceptanceCriteria.length) problems.push(`${t.id} has no acceptance criteria`);
    if (!t.requirementIds.length) problems.push(`${t.id} implements no requirement (link foundation tasks to the requirements they enable)`);
    for (const r of t.requirementIds) if (!reqIds.has(r)) problems.push(`${t.id} references unknown requirement ${r}`);
    for (const d of t.dependsOn) if (!taskIds.has(d)) problems.push(`${t.id} depends on unknown task ${d}`);
    if (t.dependsOn.includes(t.id)) problems.push(`${t.id} depends on itself`);
  }
  for (const q of backlog.openQuestions) for (const r of q.requirementIds) if (!reqIds.has(r)) problems.push(`${q.id} references unknown requirement ${r}`);
  const covered = new Set(backlog.tasks.flatMap(t => t.requirementIds));
  for (const r of backlog.requirements) if (r.priority === 'must' && !covered.has(r.id)) problems.push(`must-have requirement ${r.id} is not covered by any task`);
  if (problems.length) throw new BacklogError(problems);
  taskOrder(backlog.tasks); // cycles
  return backlog;
}

export function unansweredBlockingQuestions(backlog: Backlog): OpenQuestion[] {
  return backlog.openQuestions.filter(q => q.blocking && !q.answer?.trim());
}

export function renderBacklogMarkdown(backlog: Backlog): string {
  const lines = [`# Backlog`, '', backlog.summary, '', `## Requirements (${backlog.requirements.length})`, ''];
  for (const r of backlog.requirements) lines.push(`- **${r.id}** [${r.priority}, ${r.type}] ${r.title}: ${r.description} _(source: ${r.source})_`);
  lines.push('', `## Tasks (${backlog.tasks.length}, in execution order)`, '');
  for (const t of taskOrder(backlog.tasks)) {
    lines.push(`### ${t.id}: ${t.title}`, '', `Size ${t.size} · risk ${t.risk} · implements ${t.requirementIds.join(', ') || '-'} · after ${t.dependsOn.join(', ') || '-'}`, '', t.description, '', 'Acceptance criteria:', ...t.acceptanceCriteria.map(a => `- ${a}`), '');
  }
  if (backlog.openQuestions.length) {
    lines.push(`## Open questions (${backlog.openQuestions.length})`, '', 'Answer blocking questions by filling `answer` in backlog.json before running.', '');
    for (const q of backlog.openQuestions) lines.push(`- **${q.id}**${q.blocking ? ' **(blocking)**' : ''}: ${q.question}`, `  - Context: ${q.context}`, ...(q.answer ? [`  - Answer: ${q.answer}`] : []));
  }
  if (backlog.outOfScope.length) lines.push('', '## Out of scope', '', ...backlog.outOfScope.map(o => `- ${o}`));
  return `${lines.join('\n')}\n`;
}
