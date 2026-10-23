import type { Backlog } from '../src/backlog.js';

export function sampleBacklog(): Backlog {
  const task = (id: string, dependsOn: string[] = [], requirementIds = ['REQ-001']) => ({ id, title: `title ${id}`, description: `do ${id}`, requirementIds, dependsOn, acceptanceCriteria: [`${id} works`], size: 'S' as const, risk: 'low' as const });
  return {
    summary: 'A sample project.',
    requirements: [
      { id: 'REQ-001', title: 'Core', description: 'core feature', type: 'functional', priority: 'must', source: '§1' },
      { id: 'REQ-002', title: 'Nice', description: 'nice to have', type: 'functional', priority: 'could', source: '§2' },
    ],
    tasks: [task('T-001'), task('T-002', ['T-001']), task('T-003', [], ['REQ-002'])],
    openQuestions: [], outOfScope: ['mobile app'],
  };
}
