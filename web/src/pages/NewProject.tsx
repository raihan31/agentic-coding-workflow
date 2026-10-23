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
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">New project</h1>
        <p className="text-sm text-ink-2">The analyst reads the document and the repository and proposes a backlog. Nothing is built until you approve it.</p>
      </div>
      <Card>
        <form className="space-y-5" onSubmit={e => { e.preventDefault(); create.mutate(); }}>
          <div>
            <label className="text-sm font-medium" htmlFor="document">Requirements document</label>
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
            <input id="repo" value={repo} onChange={e => setRepo(e.target.value)} placeholder="/absolute/path/to/git/repo" required
              className="mt-1.5 w-full rounded-md border border-line bg-page px-3 py-2 font-mono text-sm" />
            <p className="mt-1 text-xs text-muted">Must be a clean, committed Git repository. Work happens on a new branch in a separate worktree.</p>
          </div>
          <details>
            <summary className="cursor-pointer text-sm font-medium text-ink-2">Advanced: workflow config (JSON)</summary>
            <textarea value={config} onChange={e => setConfig(e.target.value)} rows={8} placeholder='{ "checks": [["npm", "test"]], "maxRepairs": 2 }'
              className="mt-2 w-full rounded-md border border-line bg-page px-3 py-2 font-mono text-xs" />
            <p className="mt-1 text-xs text-muted">Leave empty to use the server's default config.</p>
          </details>
          <ErrorNote error={create.error} />
          <Button type="submit" kind="primary" disabled={!file || !repo.trim() || create.isPending}>{create.isPending ? 'Starting…' : 'Analyze document'}</Button>
        </form>
      </Card>
    </div>
  );
}
