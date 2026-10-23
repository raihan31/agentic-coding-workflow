import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

export type DocumentFormat = 'markdown' | 'text' | 'pdf' | 'docx';
export interface LoadedDocument { format: DocumentFormat; text: string; sha256: string; warnings: string[]; }

const MAX_CHARS = 400_000;
const FORMATS: Record<string, DocumentFormat> = { '.md': 'markdown', '.markdown': 'markdown', '.txt': 'text', '.pdf': 'pdf', '.docx': 'docx' };

export function documentFormat(path: string): DocumentFormat {
  const format = FORMATS[extname(path).toLowerCase()];
  if (!format) throw new Error(`Unsupported document type "${extname(path)}" (supported: ${Object.keys(FORMATS).join(', ')})`);
  return format;
}

/** Extracts text (Markdown where structure is recoverable) from a BRD/PRD/SRS/handoff document. */
export async function loadDocument(path: string): Promise<LoadedDocument> {
  const format = documentFormat(path);
  const bytes = await readFile(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const warnings: string[] = [];
  let text: string;
  if (format === 'pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text: pages } = await extractText(pdf, { mergePages: false });
    text = pages.map((page, i) => `<!-- page ${i + 1} -->\n${page.trim()}`).join('\n\n');
    // The analyst also gets the original PDF (Claude reads PDFs natively), so scanned pages are not fatal.
    if (!pages.some(p => p.trim())) warnings.push('No extractable text in the PDF (scanned?); the analyst will read the original file.');
  } else if (format === 'docx') {
    const [{ default: mammoth }, { default: TurndownService }] = await Promise.all([import('mammoth'), import('turndown')]);
    const { value: html, messages } = await mammoth.convertToHtml({ buffer: bytes });
    warnings.push(...messages.filter(m => m.type === 'error').map(m => m.message));
    text = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' }).turndown(html);
  } else {
    text = bytes.toString('utf8');
  }
  if (format !== 'pdf' && !text.trim()) throw new Error(`Document ${path} is empty`);
  if (text.length > MAX_CHARS) throw new Error(`Document is ${text.length} characters; the limit is ${MAX_CHARS}. Split it into smaller documents.`);
  return { format, text, sha256, warnings };
}
