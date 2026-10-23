import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { Button, Card, ErrorNote } from '../components';
import { navigate } from '../router';

const ACCEPT = '.md,.markdown,.txt,.pdf,.docx';

export function NewProjectPage() {
  const [file, setFile] = useState<File>();
  const [repo, setRepo] = useState('');
  const [config, setConfig] = useState('');
  const [dragging, setDragging] = useState(false);
  const create = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.set('repo', repo.trim());
      if (config.trim()) form.set('config', config);
      form.set('document', file!);
      return api.create(form);
    },
    onSuccess: ({ id }) => navigate({ name: 'project', id, tab: 'overview' }),
  });
  const isDesktop = typeof window !== 'undefined' && Boolean(window.desktopAPI?.isDesktop);

  const [notGitRepo, setNotGitRepo] = useState(false);
  const [initingGit, setInitingGit] = useState(false);

  const checkRepoGit = async (dir: string) => {
    if (window.desktopAPI && dir.trim()) {
      const isGit = await window.desktopAPI.isGitRepo(dir.trim());
      setNotGitRepo(!isGit);
    } else {
      setNotGitRepo(false);
    }
  };

  const handleBrowseRepo = async () => {
    if (window.desktopAPI) {
      const selected = await window.desktopAPI.selectDirectory(repo || undefined);
      if (selected) {
        setRepo(selected);
        await checkRepoGit(selected);
      }
    }
  };

  const handleInitGit = async () => {
    if (!window.desktopAPI || !repo.trim()) return;
    setInitingGit(true);
    try {
      const res = await window.desktopAPI.initGitRepo(repo.trim());
      if (res.ok) {
        setNotGitRepo(false);
      } else {
        alert(res.error || 'Failed to initialize Git repository');
      }
    } finally {
      setInitingGit(false);
    }
  };

  const handleBrowseDocument = async () => {
    if (window.desktopAPI) {
      const doc = await window.desktopAPI.selectFile();
      if (doc) {
        if (doc.data) {
          const binary = atob(doc.data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          setFile(new File([bytes], doc.name));
        } else {
          try {
            const res = await fetch(`file://${doc.path}`);
            const blob = await res.blob();
            setFile(new File([blob], doc.name));
          } catch {
            setFile(new File([''], doc.name));
          }
        }
      }
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">New project</h1>
        <p className="text-sm text-ink-2">The analyst reads the document and the repository and proposes a backlog. Nothing is built until you approve it.</p>
      </div>
      <Card>
        <form className="space-y-5" onSubmit={e => { e.preventDefault(); create.mutate(); }}>
          <div>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium" htmlFor="document">Requirements document</label>
              {isDesktop && (
                <button type="button" onClick={handleBrowseDocument} className="text-xs text-accent hover:underline">
                  Browse file…
                </button>
              )}
            </div>
            <label htmlFor="document"
              onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
              onDrop={e => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); }}
              className={`mt-1.5 flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-4 py-8 text-center ${dragging ? 'border-accent bg-raised' : 'border-line'}`}>
              {file ? <span className="text-sm font-medium">{file.name} <span className="font-normal text-ink-2">({Math.ceil(file.size / 1024)} KB)</span></span>
                : <span className="text-sm text-ink-2">Drop a BRD, PRD, SRS or handoff here, or click to choose<br /><span className="text-xs text-muted">Markdown, text, PDF or Word (.docx)</span></span>}
              <input id="document" type="file" accept={ACCEPT} className="sr-only" onChange={e => setFile(e.target.files?.[0])} />
            </label>
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="repo">Repository path on the server</label>
            <div className="mt-1.5 flex gap-2">
              <input id="repo" value={repo} onChange={e => { setRepo(e.target.value); void checkRepoGit(e.target.value); }} placeholder="/absolute/path/to/git/repo" required
                className="flex-1 rounded-md border border-line bg-page px-3 py-2 font-mono text-sm" />
              {isDesktop && (
                <Button type="button" onClick={handleBrowseRepo}>Browse…</Button>
              )}
            </div>
            {notGitRepo && (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-warn/40 bg-warn/10 p-2.5 text-xs text-warn">
                <span>⚠️ Selected folder is not an initialized Git repository.</span>
                <Button type="button" onClick={handleInitGit} disabled={initingGit}>
                  {initingGit ? 'Initializing…' : 'Initialize Git Repo'}
                </Button>
              </div>
            )}
            <p className="mt-1 text-xs text-muted">Must be a clean, committed Git repository. Work happens on a new branch in a separate worktree.</p>
          </div>
          <details>
            <summary className="cursor-pointer text-sm font-medium text-ink-2">Advanced: workflow config (JSON)</summary>
            <textarea value={config} onChange={e => setConfig(e.target.value)} rows={8} placeholder='{ "checks": [["npm", "test"]], "maxRepairs": 2 }'
              className="mt-2 w-full rounded-md border border-line bg-page px-3 py-2 font-mono text-xs" />
            <p className="mt-1 text-xs text-muted">Leave empty to use the server's default config.</p>
          </details>
          <ErrorNote error={create.error} />
          {create.error?.message?.includes('not a git repository') && (
            <div className="rounded-md border border-warn/40 bg-raised p-3 text-xs text-warn space-y-1">
              <div className="font-semibold text-sm">Target path is not a Git repository</div>
              <p>The orchestrator creates an isolated git branch and worktree to perform the build. The repository folder must have Git initialized with at least one commit.</p>
              <p className="font-mono text-xs text-ink-1">Run in terminal: <code>git init && git commit --allow-empty -m &quot;initial commit&quot;</code></p>
            </div>
          )}
          <Button type="submit" kind="primary" disabled={!file || !repo.trim() || create.isPending}>{create.isPending ? 'Starting…' : 'Analyze document'}</Button>
        </form>
      </Card>
    </div>
  );
}
