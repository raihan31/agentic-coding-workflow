export const usd = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;
export const compact = (n: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
export const duration = (ms: number) => ms < 1_000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1_000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1_000)} s`;
export function ago(iso: string | Date): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1_000);
  if (s < 45) return 'just now';
  if (s < 3_600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3_600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
export const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export const repoName = (path: string) => path.split('/').filter(Boolean).pop() ?? path;
