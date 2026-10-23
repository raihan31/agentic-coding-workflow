import { z } from 'zod';

export const SubtaskSchema = z.object({
  title: z.string(),
  description: z.string().describe('What to build, precise enough for an engineer who has not seen the failed attempts'),
  acceptanceCriteria: z.array(z.string()).describe('Observable, testable conditions; together the subtasks must cover every original criterion'),
});
export const ManagerDecisionSchema = z.object({
  decision: z.enum(['retry', 'split', 'escalate', 'skip']),
  rationale: z.string().describe('Root cause of the failure and why this decision fixes it'),
  guidance: z.string().optional().describe('retry: concrete instructions for a fresh attempt (approach, root cause, pitfalls)'),
  subtasks: z.array(SubtaskSchema).optional().describe('split: smaller tasks, done in this order'),
  question: z.string().optional().describe('escalate: one specific question a human must answer'),
});
export type Subtask = z.infer<typeof SubtaskSchema>;
export type ManagerDecision = z.infer<typeof ManagerDecisionSchema>;

export class ManagerDecisionError extends Error { constructor(message: string) { super(message); this.name = 'ManagerDecisionError'; } }

/** JSON Schema handed to `claude --json-schema`. */
export function managerJsonSchema(): Record<string, unknown> {
  const { $schema: _ignored, ...json } = z.toJSONSchema(ManagerDecisionSchema) as Record<string, unknown>;
  return json;
}

export interface DecisionLimits { allowSplit: boolean; allowEscalate: boolean; maxSubtasks: number; }

/** Schema + semantic validation: each decision carries what it needs, and only allowed decisions pass. */
export function parseDecision(raw: string, limits: DecisionLimits): ManagerDecision {
  let data: unknown;
  try { data = JSON.parse(raw); } catch (error) { throw new ManagerDecisionError(`Decision is not JSON: ${String(error)}`); }
  const parsed = ManagerDecisionSchema.safeParse(data);
  if (!parsed.success) throw new ManagerDecisionError(`Malformed decision: ${parsed.error.message}`);
  const d = parsed.data;
  if (!d.rationale.trim()) throw new ManagerDecisionError('rationale is empty');
  switch (d.decision) {
    case 'retry':
      if (!d.guidance?.trim()) throw new ManagerDecisionError('retry needs guidance');
      return { decision: 'retry', rationale: d.rationale, guidance: d.guidance.trim() };
    case 'split': {
      if (!limits.allowSplit) throw new ManagerDecisionError('split is not allowed for this task');
      const subtasks = d.subtasks ?? [];
      if (subtasks.length < 2 || subtasks.length > limits.maxSubtasks) throw new ManagerDecisionError(`split needs 2 to ${limits.maxSubtasks} subtasks, got ${subtasks.length}`);
      const empty = subtasks.findIndex(s => !s.title.trim() || !s.description.trim() || !s.acceptanceCriteria.length);
      if (empty >= 0) throw new ManagerDecisionError(`subtask ${empty + 1} needs a title, description and acceptance criteria`);
      return { decision: 'split', rationale: d.rationale, subtasks };
    }
    case 'escalate':
      if (!limits.allowEscalate) throw new ManagerDecisionError('escalate is not allowed');
      if (!d.question?.trim()) throw new ManagerDecisionError('escalate needs a question');
      return { decision: 'escalate', rationale: d.rationale, question: d.question.trim() };
    case 'skip':
      return { decision: 'skip', rationale: d.rationale };
  }
}
