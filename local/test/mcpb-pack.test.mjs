import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import JSZip from 'jszip';

const require = createRequire(import.meta.url);
const { packBundle, validateManifest } = require('../../scripts/mcpb-pack.cjs');
const temporary = fileURLToPath(new URL('../../.local/tmp/', import.meta.url));
const manifest = () => ({ manifest_version: '0.3', name: 'fixture', version: '1.0.0',
  description: 'fixture', author: { name: 'test' }, icon: 'icon.png',
  server: { type: 'node', entry_point: 'dist/index.js', mcp_config: { command: 'node', args: ['${__dirname}/dist/index.js'] } } });
async function fixture() {
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'mcpb-'));
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, 'dist/index.js'), 'console.log("MCPB_OK");\n');
  await fs.writeFile(path.join(root, 'icon.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest()));
  return root;
}

test('unsigned MCPB round trip preserves files and excludes secrets, cache and ignore patterns', async () => {
  const root = await fixture();
  try {
    await fs.mkdir(path.join(root, 'node_modules/.bin'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules/.bin/tool'), 'excluded');
    await fs.writeFile(path.join(root, '.env'), 'excluded secret');
    await fs.writeFile(path.join(root, 'dist/index.js.map'), 'excluded map');
    await fs.writeFile(path.join(root, 'private.txt'), 'excluded custom');
    await fs.writeFile(path.join(root, '.mcpbignore'), 'private.txt\n');
    const output = path.join(root, 'fixture.mcpb');
    await packBundle(root, output);
    const zip = await JSZip.loadAsync(await fs.readFile(output), { checkCRC32: true });
    assert.deepEqual(JSON.parse(await zip.file('manifest.json').async('string')), manifest());
    assert.equal(await zip.file('dist/index.js').async('string'), 'console.log("MCPB_OK");\n');
    for (const omitted of ['.env', '.mcpbignore', 'private.txt', 'dist/index.js.map', 'node_modules/.bin/tool', 'fixture.mcpb']) {
      assert.equal(zip.file(omitted), null, omitted);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('MCPB rejects invalid manifest, missing assets, escaping entry points and invalid icons', async () => {
  const root = await fixture();
  try {
    for (const change of [
      { author: {} }, { manifest_version: '99' }, { name: '../escape' },
      { server: { ...manifest().server, entry_point: '../outside.js' } },
      { server: { ...manifest().server, entry_point: 'C:\\outside.js' } },
      { server: { ...manifest().server, entry_point: 'missing.js' } },
    ]) {
      await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ ...manifest(), ...change }));
      assert.throws(() => validateManifest(root));
    }
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest()));
    await fs.writeFile(path.join(root, 'icon.png'), 'not PNG');
    assert.throws(() => validateManifest(root), /PNG/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('MCPB refuses to pack when ignore patterns remove its entry point', async () => {
  const root = await fixture();
  try {
    await fs.writeFile(path.join(root, '.mcpbignore'), 'dist/\n');
    await assert.rejects(packBundle(root, path.join(root, 'fixture.mcpb')), /Required bundle asset excluded/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
