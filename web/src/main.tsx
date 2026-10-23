import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, setToken } from './api';
import { Button, Link } from './components';
import { NewProjectPage } from './pages/NewProject';
import { ProjectPage } from './pages/Project';
import { ProjectsPage } from './pages/Projects';
import { useRoute } from './router';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, retry: (n, e) => !(e instanceof ApiError && [401, 404].includes(e.status)) && n < 2 } },
});

function TokenGate() {
  const [value, setValue] = useState('');
  return (
    <form className="mx-auto mt-24 max-w-sm space-y-3 rounded-lg border border-line bg-surface p-6" onSubmit={e => { e.preventDefault(); setToken(value); location.reload(); }}>
      <h1 className="text-base font-semibold">API token required</h1>
      <p className="text-sm text-ink-2">This server was started with <code>AGENTIC_API_TOKEN</code>. Enter it to continue.</p>
      <input type="password" value={value} onChange={e => setValue(e.target.value)} className="w-full rounded-md border border-line bg-page px-3 py-2 text-sm" autoFocus />
      <Button type="submit" kind="primary">Continue</Button>
    </form>
  );
}

function App() {
  const route = useRoute();
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000 });
  const authFailed = useQuery({ queryKey: ['projects'], queryFn: api.projects, enabled: false }).error;
  if (authFailed instanceof ApiError && authFailed.status === 401) return <TokenGate />;
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3 sm:px-6">
          <Link to={{ name: 'projects' }} className="flex items-center gap-2 text-sm font-semibold text-ink">
            <span aria-hidden className="grid h-6 w-6 place-items-center rounded-md bg-accent text-xs text-accent-ink">AO</span>
            Agent Orchestrator
          </Link>
          <nav className="flex gap-4 text-sm">
            <Link to={{ name: 'projects' }} className={route.name !== 'new' ? 'text-ink' : 'text-ink-2 hover:text-ink'}>Projects</Link>
            <Link to={{ name: 'new' }} className={route.name === 'new' ? 'text-ink' : 'text-ink-2 hover:text-ink'}>New project</Link>
          </nav>
          <div className="ml-auto text-xs text-ink-2">
            {health.data && !health.data.temporal && <span title="Start the stack and restart the API"><span className="text-warn" aria-hidden>◷ </span>Temporal offline: read-only</span>}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {route.name === 'projects' && <ProjectsPage />}
        {route.name === 'new' && <NewProjectPage />}
        {route.name === 'project' && <ProjectPage key={route.id} route={route} />}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={queryClient}><App /></QueryClientProvider></StrictMode>);
