#!/usr/bin/env node
/** Dependency compatibility checks using disposable files and the built app modules. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(repo, '.local', 'tmp');
const stateRoot = path.join(repo, '.local', 'state');
const reportPath = path.join(stateRoot, 'compatibility-report.json');
const runDir = path.join(tempRoot, `compatibility-${process.pid}-${randomUUID()}`);
const checks = [];

function confined(target, parent) {
  const relative = path.relative(parent, target);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `Refusing unconfined path: ${target}`);
  return target;
}

async function runWorker(kind, args, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), `--worker=${kind}`, ...args], {
      cwd: repo,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-16_384); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16_384); });
    child.once('error', error => finish(error));
    child.once('close', code => finish(code === 0 ? null : new Error(`${kind} exited ${code}: ${stderr || stdout}`)));
    const timer = setTimeout(() => {
      if (process.platform === 'win32') {
        // Only the spawned worker's process tree is targeted (including its private Chrome).
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill('SIGKILL');
      finish(new Error(`${kind} exceeded ${timeoutMs} ms. Worker output: ${stderr || stdout}`));
    }, timeoutMs);
  });
}

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    checks.push({ name, status: 'passed', durationMs: Date.now() - started, detail });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, status: 'failed', durationMs: Date.now() - started,
      error: error instanceof Error ? error.stack || error.message : String(error) });
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

async function pdfWorker(kind, args) {
  const { parseMarkdownToPdf, parsePdfToMarkdown } = await import('../dist/tools/pdf/index.js');
  if (kind === 'create-pdf') {
    const [output, profile] = args;
    const markdown = '# Chrome compatibility\n\nThe private profile rendered this PDF.\n';
    console.error(`Starting private Chrome PDF generation in ${profile}`);
    const buffer = await parseMarkdownToPdf(markdown, {
      launch_options: { headless: true, userDataDir: profile, args: ['--no-first-run', '--no-default-browser-check'] },
    });
    console.error('Chrome PDF generation returned');
    assert.ok(Buffer.isBuffer(buffer), 'Markdown conversion must return a Node Buffer');
    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
    await fs.writeFile(output, buffer);
  } else if (kind === 'bad-pdf') {
    await assert.rejects(parsePdfToMarkdown(args[0]), /./);
  } else throw new Error(`Unknown worker: ${kind}`);
}

async function main() {
  confined(runDir, tempRoot);
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });
  const startedAt = new Date().toISOString();
  try {
    await check('PDF text, metadata, page selection, and image extraction', async () => {
      const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
      const sharp = (await import('sharp')).default;
      const { fileTypeFromBuffer } = await import('file-type');
      const { parsePdfToMarkdown, extractImagesFromPdf } = await import('../dist/tools/pdf/index.js');
      const { PdfFileHandler } = await import('../dist/utils/files/pdf.js');
      const raw = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
      const img = sharp(raw, { raw: { width: 2, height: 2, channels: 3 } });
      const [png, webp, jpeg] = await Promise.all([img.clone().png().toBuffer(), img.clone().webp().toBuffer(), img.clone().jpeg().toBuffer()]);
      assert.equal((await fileTypeFromBuffer(webp))?.mime, 'image/webp');
      assert.equal((await fileTypeFromBuffer(jpeg))?.mime, 'image/jpeg');
      const wideRaw = Buffer.alloc(1301 * 3, 127);
      const resized = await sharp(wideRaw, { raw: { width: 1301, height: 1, channels: 3 } })
        .resize({ width: 1200 }).webp().toBuffer();
      assert.equal((await sharp(resized).metadata()).width, 1200);
      const doc = await PDFDocument.create();
      doc.setTitle('Compatibility title');
      doc.setAuthor('Desktop Commander test');
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const first = doc.addPage([500, 500]);
      first.drawText('First page compatibility marker', { x: 35, y: 440, font, size: 14, color: rgb(0, 0, 0) });
      const embedded = await doc.embedPng(png);
      first.drawImage(embedded, { x: 35, y: 350, width: 80, height: 80 });
      const second = doc.addPage([500, 500]);
      second.drawText('Second page compatibility marker', { x: 35, y: 440, font, size: 14 });
      const pdfBytes = Buffer.from(await doc.save({ useObjectStreams: false }));
      const pdfFile = confined(path.join(runDir, 'two-pages.pdf'), runDir);
      await fs.writeFile(pdfFile, pdfBytes);
      assert.equal((await fileTypeFromBuffer(pdfBytes))?.mime, 'application/pdf');
      const all = await parsePdfToMarkdown(pdfFile);
      assert.equal(all.metadata.totalPages, 2);
      assert.equal(all.metadata.title, 'Compatibility title');
      assert.equal(all.metadata.author, 'Desktop Commander test');
      assert.match(all.pages[0].text, /First page compatibility marker/);
      assert.match(all.pages[1].text, /Second page compatibility marker/);
      const selected = await parsePdfToMarkdown(pdfFile, { offset: 1, length: 1 });
      assert.deepEqual(selected.pages.map(page => page.pageNumber), [2]);
      assert.match(selected.pages[0].text, /Second page compatibility marker/);
      const webpImages = await extractImagesFromPdf(new Uint8Array(pdfBytes), [1], { format: 'webp' });
      const jpegImages = await extractImagesFromPdf(new Uint8Array(pdfBytes), [1], { format: 'jpeg' });
      for (const [images, mime] of [[webpImages[1], 'image/webp'], [jpegImages[1], 'image/jpeg']]) {
        assert.ok(images.length >= 1, `Missing extracted ${mime}`);
        assert.equal(images[0].mimeType, mime);
        assert.equal((await fileTypeFromBuffer(Buffer.from(images[0].data, 'base64')))?.mime, mime);
      }
      assert.ok(all.pages[0].images.length >= 1, 'Parser should attach extracted page image');
      const handlerRead = await new PdfFileHandler().read(pdfFile, { offset: 1, length: 1 });
      assert.equal(handlerRead.metadata?.totalPages, 2);
      assert.deepEqual(handlerRead.metadata?.pages.map(page => page.pageNumber), [2]);
      return { pages: all.metadata.totalPages, images: webpImages[1].length };
    });

    await check('Chrome Markdown to PDF with a private temporary profile', async () => {
      const output = confined(path.join(runDir, 'from-markdown.pdf'), runDir);
      const profile = confined(path.join(runDir, 'chrome-profile'), runDir);
      await runWorker('create-pdf', [output, profile], 45_000);
      const data = await fs.readFile(output);
      assert.equal(data.subarray(0, 5).toString(), '%PDF-');
      const { parsePdfToMarkdown } = await import('../dist/tools/pdf/index.js');
      const parsed = await parsePdfToMarkdown(output);
      assert.match(parsed.pages.map(page => page.text).join(' '), /private profile rendered this PDF/i);
      return { bytes: data.length, pages: parsed.metadata.totalPages };
    });

    await check('Malformed PDF fails within a deadline', async () => {
      const bad = confined(path.join(runDir, 'malformed.pdf'), runDir);
      await fs.writeFile(bad, Buffer.from('%PDF-1.7\nnot a real PDF\n'));
      await runWorker('bad-pdf', [bad], 8_000);
    });

    await check('ExcelJS values, formulas, styles, conditional formatting, and handler read', async () => {
      const ExcelJS = (await import('exceljs')).default;
      const { ExcelFileHandler } = await import('../dist/utils/files/excel.js');
      const file = confined(path.join(runDir, 'roundtrip.xlsx'), runDir);
      const book = new ExcelJS.Workbook();
      const sheet = book.addWorksheet('Budget');
      sheet.getCell('A1').value = 'Amount';
      sheet.getCell('A2').value = 7;
      sheet.getCell('A2').numFmt = '0.00';
      sheet.getCell('A2').font = { bold: true, color: { argb: 'FF336699' } };
      sheet.getCell('B2').value = { formula: 'A2*2', result: 14 };
      sheet.addConditionalFormatting({ ref: 'A2:A2', rules: [{
        type: 'expression', formulae: ['A2>5'], style: { font: { color: { argb: 'FFFF0000' } } },
      }] });
      sheet.addConditionalFormatting({ ref: 'A2:A2', rules: [{
        type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }],
        color: { argb: 'FF008800' }, gradient: false,
      }] });
      await book.xlsx.writeFile(file);
      const JSZip = (await import('jszip')).default;
      const archive = await JSZip.loadAsync(await fs.readFile(file));
      const xml = await archive.file('xl/worksheets/sheet1.xml').async('string');
      assert.match(xml, /<x14:cfRule[^>]*id="\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}"/,
        'ExcelJS must generate a UUID v4 for extended data-bar formatting');
      const reopened = new ExcelJS.Workbook();
      await reopened.xlsx.readFile(file);
      const readSheet = reopened.getWorksheet('Budget');
      assert.equal(readSheet.getCell('A2').value, 7);
      assert.deepEqual(readSheet.getCell('B2').value, { formula: 'A2*2', result: 14 });
      assert.equal(readSheet.getCell('A2').font.bold, true);
      assert.equal(readSheet.getCell('A2').numFmt, '0.00');
      assert.equal(readSheet.conditionalFormattings.length, 2);
      assert.equal(readSheet.conditionalFormattings[0].rules[0].formulae[0], 'A2>5');
      const handled = await new ExcelFileHandler().read(file);
      assert.match(String(handled.content), /Budget/);
      assert.match(String(handled.content), /Amount/);
      return { rules: readSheet.conditionalFormattings.length };
    });

    await check('Markdown renderer and Tiptap table/link/image round trip', async () => {
      const { JSDOM } = await import('jsdom');
      const dom = new JSDOM('<!doctype html><html><body></body></html>');
      Object.assign(globalThis, { window: dom.window, document: dom.window.document,
        HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
        DOMParser: dom.window.DOMParser, getComputedStyle: dom.window.getComputedStyle });
      try {
        const MarkdownIt = (await import('markdown-it')).default;
        const html = new MarkdownIt().render('# Heading\n\n[Link](https://example.org)\n\n```js\nconst x = 1;\n```');
        assert.match(html, /<h1>Heading<\/h1>/);
        assert.match(html, /href="https:\/\/example.org"/);
        assert.match(html, /<code class="language-js">/);
        const { roundTripMarkdown } = await import('../dist/ui/file-preview/src/markdown/editor.js');
        const input = '# Note\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[Link](https://example.org)\n\n![Pixel](https://example.org/pixel.png)\n';
        const output = roundTripMarkdown(input);
        assert.match(output, /\| A \| B \|/);
        assert.match(output, /\| 1 \| 2 \|/);
        assert.match(output, /\[Link\]\(https:\/\/example.org\)/);
        assert.match(output, /!\[Pixel\]\(https:\/\/example.org\/pixel.png\)/);
        assert.equal(roundTripMarkdown(output), output, 'Second editor pass should not drift');
        return { markdownChars: output.length };
      } finally { dom.window.close(); }
    });
  } finally {
    const resolvedRoot = await fs.realpath(tempRoot);
    const resolvedRun = await fs.realpath(runDir);
    confined(resolvedRun, resolvedRoot);
    await fs.rm(resolvedRun, { recursive: true, force: true });
    const report = { startedAt, completedAt: new Date().toISOString(), node: process.version,
      platform: process.platform, checks, passed: checks.filter(c => c.status === 'passed').length,
      failed: checks.filter(c => c.status === 'failed').length };
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`Report: ${reportPath}`);
  }
  if (checks.some(c => c.status === 'failed')) process.exitCode = 1;
}

const workerArg = process.argv[2];
if (workerArg?.startsWith('--worker=')) {
  pdfWorker(workerArg.slice('--worker='.length), process.argv.slice(3)).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
