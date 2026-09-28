import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createBundlePackageJson } = require('../../scripts/mcpb-package-json.cjs');

test('MCPB production manifest keeps Node requirement and scoped overrides', () => {
  const bundle = createBundlePackageJson(
    { name: 'fixture', version: '1.0.0', description: 'fixture', author: 'test', license: 'MIT', repository: {} },
    {
      engines: { node: '>=22.12.0' },
      dependencies: { exceljs: '^4.4.0' },
      devDependencies: { nexe: '0.0.0' },
      overrides: { exceljs: { uuid: '11.1.1' } },
    }
  );
  assert.deepEqual(bundle.engines, { node: '>=22.12.0' });
  assert.deepEqual(bundle.overrides, { exceljs: { uuid: '11.1.1' } });
  assert.deepEqual(bundle.dependencies, { exceljs: '^4.4.0' });
  assert.equal(bundle.devDependencies, undefined);
});
