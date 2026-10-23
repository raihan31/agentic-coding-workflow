import { useState, useEffect } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { Columns2, Rows2, Copy, Check, ExternalLink, Folder } from 'lucide-react';

export interface DiffViewerProps {
  original?: string;
  modified?: string;
  patch?: string;
  fileName?: string;
  workspacePath?: string;
  className?: string;
  height?: string;
}

function extractTargetFileFromPatch(patch?: string): string | undefined {
  if (!patch) return undefined;
  const match = patch.match(/\+\+\+\s+[ab]\/(.+)$/m) || patch.match(/diff --git\s+\S+\s+[ab]\/(.+)$/m);
  return match ? match[1].trim() : undefined;
}

/**
 * Parses a standard git unified diff patch into pseudo original and modified texts
 * when separate files are not available.
 */
function parsePatchToOriginalAndModified(patch: string): { original: string; modified: string } {
  const origLines: string[] = [];
  const modLines: string[] = [];
  const lines = patch.split('\n');

  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ')) {
      continue;
    }
    if (line.startsWith('@@')) {
      origLines.push(`// ${line}`);
      modLines.push(`// ${line}`);
      continue;
    }
    if (line.startsWith('-')) {
      origLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      modLines.push(line.slice(1));
    } else {
      const normal = line.startsWith(' ') ? line.slice(1) : line;
      origLines.push(normal);
      modLines.push(normal);
    }
  }

  return { original: origLines.join('\n'), modified: modLines.join('\n') };
}

function detectLanguage(fileName?: string): string {
  if (!fileName) return 'typescript';
  const ext = fileName.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
      return 'javascript';
    case 'json':
      return 'json';
    case 'md':
      return 'markdown';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'py':
      return 'python';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'sh':
    case 'bash':
      return 'shell';
    default:
      return 'plaintext';
  }
}

export function DiffViewer({
  original,
  modified,
  patch,
  fileName,
  workspacePath,
  className = '',
  height = '480px',
}: DiffViewerProps) {
  const [splitView, setSplitView] = useState(true);
  const [copied, setCopied] = useState(false);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    setIsDark(isDarkMode);

    const listener = (e: MediaQueryListEvent) => setIsDark(e.matches);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);

  let orig = original ?? '';
  let mod = modified ?? '';

  if (patch && (!original || !modified)) {
    const parsed = parsePatchToOriginalAndModified(patch);
    orig = parsed.original;
    mod = parsed.modified;
  }

  const targetFile = extractTargetFileFromPatch(patch) || (fileName && !fileName.endsWith('.patch') && !fileName.endsWith('.diff') ? fileName : undefined);
  const displayFile = targetFile || fileName;
  const language = detectLanguage(displayFile);

  const copyPatch = () => {
    navigator.clipboard.writeText(patch || `${orig}\n---\n${mod}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const openTargetInEditor = () => {
    if (!window.desktopAPI) return;
    const target = targetFile && workspacePath
      ? `${workspacePath.replace(/\/+$/, '')}/${targetFile}`
      : (workspacePath || targetFile || fileName);
    if (target) {
      void window.desktopAPI.openInEditor(target);
    }
  };

  const openWorkspaceFolder = () => {
    if (!window.desktopAPI || !workspacePath) return;
    void window.desktopAPI.openPath(workspacePath);
  };

  return (
    <div className={`flex flex-col rounded-md border border-line bg-surface overflow-hidden ${className}`}>
      <div className="flex flex-wrap items-center justify-between border-b border-line bg-raised px-3 py-2 text-xs">
        <div className="flex items-center gap-2 font-mono text-ink">
          {displayFile ? <span className="font-semibold">{displayFile}</span> : <span>Diff</span>}
          {targetFile && fileName && fileName !== targetFile && (
            <span className="text-[0.7rem] text-muted font-normal">({fileName})</span>
          )}
          <span className="rounded bg-page px-1.5 py-0.5 text-[0.7rem] text-muted">{language}</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSplitView(!splitView)}
            className="inline-flex items-center gap-1 rounded border border-line bg-surface px-2 py-1 text-ink-2 hover:bg-raised transition"
            title={splitView ? 'Switch to inline unified view' : 'Switch to side-by-side split view'}
          >
            {splitView ? <Rows2 size={13} /> : <Columns2 size={13} />}
            <span>{splitView ? 'Inline' : 'Split'}</span>
          </button>

          <button
            type="button"
            onClick={copyPatch}
            className="inline-flex items-center gap-1 rounded border border-line bg-surface px-2 py-1 text-ink-2 hover:bg-raised transition"
            title="Copy diff to clipboard"
          >
            {copied ? <Check size={13} className="text-good" /> : <Copy size={13} />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>

          {typeof window !== 'undefined' && Boolean(window.desktopAPI?.isDesktop) && (Boolean(displayFile) || Boolean(workspacePath)) && (
            <button
              type="button"
              onClick={openTargetInEditor}
              className="inline-flex items-center gap-1 rounded border border-line bg-surface px-2 py-1 text-ink-2 hover:bg-raised transition"
              title="Open modified file in VS Code or Cursor"
            >
              <ExternalLink size={13} />
              <span>IDE</span>
            </button>
          )}

          {typeof window !== 'undefined' && Boolean(window.desktopAPI?.isDesktop) && Boolean(workspacePath) && (
            <button
              type="button"
              onClick={openWorkspaceFolder}
              className="inline-flex items-center gap-1 rounded border border-line bg-surface px-2 py-1 text-ink-2 hover:bg-raised transition"
              title="Open repository folder in Finder"
            >
              <Folder size={13} />
              <span>Finder</span>
            </button>
          )}
        </div>
      </div>

      <div style={{ height }}>
        <DiffEditor
          original={orig}
          modified={mod}
          language={language}
          theme={isDark ? 'vs-dark' : 'light'}
          options={{
            renderSideBySide: splitView,
            readOnly: true,
            minimap: { enabled: false },
            fontSize: 12,
            fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}
