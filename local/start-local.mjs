import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installResponseGuard } from './response-guard.mjs';

export function localMcpEnvironment(environment, executable = process.execPath) {
  const env = { ...environment, DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1' };
  // Windows environment names are case insensitive; strip every spelling.
  for (const key of Object.keys(env)) {
    if (['CONTROL_PLANE_API_KEY', 'OPENAI_ADMIN_KEY'].includes(key.toUpperCase())) delete env[key];
  }
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = path.dirname(executable) + path.delimiter + (env[pathKey] ?? '');
  return env;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const env = localMcpEnvironment(process.env);
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(env, key)) delete process.env[key];
  }
  Object.assign(process.env, env);
  process.chdir(root);
  await installResponseGuard();
  await import(pathToFileURL(path.join(root, 'dist', 'index.js')).href);
}
