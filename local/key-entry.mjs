import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const headers = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin'
};
const page = content => '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Desktop Commander — ключ туннеля</title>' +
  '<style>body{font:18px system-ui;max-width:680px;margin:70px auto;padding:24px;background:#171b22;color:#eee}input{display:block;width:95%;font:20px system-ui;margin:20px 0;padding:12px}button{font:18px system-ui;padding:12px}p{line-height:1.6}a{color:#95e1be}</style>' + content + '</html>';

// Dependency injection keeps tests independent of real keys, DPAPI and disk.
export async function startKeyEntry({ encrypt, save, port = 0, lifetimeMs = 15 * 60 * 1000 }) {
  const csrf = randomBytes(32).toString('hex');
  let origin;
  let saving = false;
  let saved = false;
  const server = http.createServer(async (req, res) => {
    const reply = (status, content) => { res.writeHead(status, headers); res.end(page(content)); };
    if (req.headers.host !== new URL(origin).host) { reply(403, '<h1>Недопустимый адрес</h1>'); return; }
    if (req.method === 'GET' && req.url === '/save') {
      res.writeHead(303, { ...headers, Location: '/' }); res.end(); return;
    }
    if (req.method === 'GET' && req.url === '/') {
      reply(200, '<h1>Desktop Commander Local</h1><h2>Runtime API key</h2>' +
        '<p>Ключ остаётся на этом ПК и сохраняется с шифрованием Windows DPAPI. Не отправляйте его в чат.</p>' +
        '<form method="post" action="/save" autocomplete="off"><input type="hidden" name="csrf" value="' + csrf + '">' +
        '<label for="key">Вставьте ключ OpenAI Platform</label><input autofocus id="key" name="key" type="password" autocomplete="off" required maxlength="2000">' +
        '<button type="submit">Сохранить зашифрованный ключ</button></form>'); return;
    }
    if (req.method !== 'POST' || req.url !== '/save' || req.headers.origin !== origin ||
        !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
      reply(403, '<h1>Обновите страницу ввода</h1><p>Проверка источника формы не пройдена. Откройте <a href="/">форму заново</a>.</p>'); return;
    }
    if (saving || saved) { reply(409, '<h1>Сохранение уже выполняется</h1>'); return; }
    try {
      let body = '';
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 4096) throw new Error('Form too large');
        body += chunk.toString('utf8');
      }
      const form = new URLSearchParams(body);
      const supplied = Buffer.from(form.get('csrf') ?? '');
      if (supplied.length !== csrf.length || !timingSafeEqual(supplied, Buffer.from(csrf))) throw new Error('Expired form');
      let key = form.get('key')?.trim();
      body = ''; form.delete('key');
      if (!key || !/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) throw new Error('Invalid key');
      // A second request may have started reading its body before the first save.
      if (saving || saved) { reply(409, '<h1>Сохранение уже выполняется</h1>'); return; }
      saving = true;
      const encrypted = await encrypt(key);
      key = '';
      await save(encrypted);
      saved = true;
      reply(200, '<h1>Ключ сохранён</h1><p>Ключ зашифрован. Закройте вкладку и вернитесь в терминал.</p>');
      server.close();
      server.closeIdleConnections();
    } catch {
      saving = false;
      reply(400, '<h1>Ключ не сохранён</h1><p>Проверьте ключ и права локальной папки. <a href="/">Повторить ввод</a></p>');
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = 'http://127.0.0.1:' + server.address().port;
  const expiry = setTimeout(() => { server.closeAllConnections(); server.close(); }, lifetimeMs);
  expiry.unref();
  server.once('close', () => clearTimeout(expiry));
  return { server, origin };
}

export function encryptWithDpapi(key, powerShellPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(powerShellPath, ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop"; $s=ConvertTo-SecureString ([Console]::In.ReadToEnd()) -AsPlainText -Force; try { $s | ConvertFrom-SecureString } finally { $s.Dispose() }'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.resume();
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', code => {
      const encrypted = output.trim();
      if (code === 0 && /^[0-9a-f]+$/i.test(encrypted)) resolve(encrypted);
      else reject(new Error('DPAPI encryption failed'));
    });
    child.stdin.end(key);
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.platform !== 'win32') throw new Error('DPAPI key entry requires Windows.');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = JSON.parse(await fs.readFile(path.join(root, '.local', 'config.json'), 'utf8'));
  const state = path.join(root, '.local', 'state');
  await fs.mkdir(state, { recursive: true });
  const { server, origin } = await startKeyEntry({
    encrypt: key => encryptWithDpapi(key, config.powerShellPath),
    save: async encrypted => {
      const destination = path.join(state, 'runtime-key.dpapi');
      const temporary = destination + '.tmp';
      await fs.writeFile(temporary, encrypted + '\n', { mode: 0o600 });
      await fs.rename(temporary, destination);
    }
  });
  await fs.writeFile(path.join(state, 'key-entry-url.txt'), origin + '\n');
  console.log('Open this local URL in your normal browser: ' + origin);
  console.log('The form closes after saving or after 15 minutes. Ctrl+C cancels.');
  server.once('close', () => console.log('Local key form closed.'));
}
