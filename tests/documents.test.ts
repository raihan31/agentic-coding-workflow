import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { documentFormat, loadDocument } from '../src/documents.js';

const dir = await mkdtemp(join(tmpdir(), 'agentic-docs-'));

test('markdown and text are read as-is', async () => {
  await writeFile(join(dir, 'prd.md'), '# PRD\n\nThe system shall work.');
  const doc = await loadDocument(join(dir, 'prd.md'));
  assert.equal(doc.format, 'markdown');
  assert.match(doc.text, /shall work/);
  assert.equal(doc.sha256.length, 64);
});

test('docx is converted to markdown with headings and lists', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Requirements</w:t></w:r></w:p><w:p><w:r><w:t>Users must be able to log in.</w:t></w:r></w:p></w:body></w:document>');
  await writeFile(join(dir, 'brd.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const doc = await loadDocument(join(dir, 'brd.docx'));
  assert.equal(doc.format, 'docx');
  assert.match(doc.text, /^# Requirements/m);
  assert.match(doc.text, /must be able to log in/);
});

test('pdf text is extracted per page', async () => {
  const content = 'BT /F1 12 Tf 72 720 Td (The system shall export CSV.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(join(dir, 'srs.pdf'), pdf, 'latin1');
  const doc = await loadDocument(join(dir, 'srs.pdf'));
  assert.equal(doc.format, 'pdf');
  assert.match(doc.text, /page 1[\s\S]*export CSV/);
  assert.deepEqual(doc.warnings, []);
});

test('rejects unsupported and empty documents', async () => {
  assert.throws(() => documentFormat('spec.pages'), /Unsupported document type/);
  await writeFile(join(dir, 'empty.md'), '   ');
  await assert.rejects(loadDocument(join(dir, 'empty.md')), /is empty/);
});
