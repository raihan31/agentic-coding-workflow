/** Dependency-free so workflow code can use it too. Appended to a task brief so planner, developer and reviewer all see it. */
export function guidanceSection(entries: { from: 'manager' | 'human'; text: string }[]): string {
  if (!entries.length) return '';
  return ['', '', 'Guidance from earlier failed attempts (follow it; it does not change the acceptance criteria):',
    ...entries.map(g => `- From the ${g.from === 'human' ? 'product owner' : 'engineering manager'}: ${g.text}`)].join('\n');
}
