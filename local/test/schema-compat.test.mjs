import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import { z } from 'zod';
import { zodToJsonSchema } from '../../dist/utils/json-schema.js';
import { detectUnsupportedParams, getSupportedParams } from '../../dist/utils/unsupportedParams.js';
import { toolArgSchemas, ReadFileArgsSchema, WriteFileArgsSchema, WritePdfArgsSchema,
  EditBlockArgsSchema } from '../../dist/tools/schemas.js';

const ajv = new Ajv({ strict: false });

test('Zod 4 tool schemas retain fields, descriptions and optional input defaults', () => {
  for (const [name, schema] of Object.entries(toolArgSchemas)) {
    const json = zodToJsonSchema(schema);
    assert.equal(json.type, 'object', name);
    assert.deepEqual(Object.keys(json.properties), getSupportedParams(schema), name);
    assert.deepEqual(detectUnsupportedParams({ invented_parameter: true }, schema), ['invented_parameter'], name);
  }
  const read = zodToJsonSchema(ReadFileArgsSchema);
  assert.deepEqual(read.required, ['path']);
  assert.equal(read.properties.offset.default, 0);
  assert.equal(read.additionalProperties, false);
  assert.equal(ajv.compile(read)({ path: 'fixture.txt' }), true);
  assert.equal(ajv.compile(zodToJsonSchema(WriteFileArgsSchema))({ path: 'fixture.txt', content: 'ok' }), true);
  assert.deepEqual(ReadFileArgsSchema.parse({ path: 'fixture.txt' }),
    { path: 'fixture.txt', isUrl: false, offset: 0, length: 1000 });
  assert.equal(WriteFileArgsSchema.parse({ path: 'fixture.txt', content: 'ok' }).mode, 'rewrite');
});

test('PDF preprocessing and edit refinements retain their runtime and JSON contracts', () => {
  const operations = [{ type: 'delete', pageIndexes: [0] }];
  const validPdf = ajv.compile(zodToJsonSchema(WritePdfArgsSchema));
  for (const content of ['# Title', operations, JSON.stringify(operations)]) {
    assert.equal(validPdf({ path: 'fixture.pdf', content }), true);
  }
  assert.equal(validPdf({ path: 'fixture.pdf', content: 123 }), false);
  assert.deepEqual(WritePdfArgsSchema.parse({ path: 'fixture.pdf', content: JSON.stringify(operations) }).content, operations);
  assert.equal(EditBlockArgsSchema.safeParse({ file_path: 'fixture.txt' }).success, false);
  assert.equal(EditBlockArgsSchema.safeParse({ file_path: 'fixture.txt', old_string: 'a', new_string: '' }).success, true);
  assert.equal(EditBlockArgsSchema.safeParse({ file_path: 'fixture.xlsx', range: 'A1', content: [[1]] }).success, true);
});

test('unsupported parameter warnings survive Zod 4 wrappers and refinements', () => {
  const schema = z.object({ known: z.string() }).refine(value => value.known.length > 0);
  for (const wrapped of [schema, schema.optional(), schema.nullable(), schema.default({ known: 'ok' }), schema.brand(), schema.transform(value => value)]) {
    assert.deepEqual(getSupportedParams(wrapped), ['known']);
    assert.deepEqual(detectUnsupportedParams({ known: 'ok', unknown: true }, wrapped), ['unknown']);
  }
  assert.deepEqual(detectUnsupportedParams({ unknown: true }, z.string()), []);
});
