import { z } from 'zod';

/** Preserve MCP input contracts when converting the Zod 4 runtime schemas. */
export function zodToJsonSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, {
    target: 'draft-7',
    // Describe the validated value of preprocessors (e.g. write_pdf content).
    io: 'output',
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema instanceof z.ZodObject) {
        // Runtime defaults are outputs, but callers may still omit those inputs.
        const required = Object.entries(zodSchema.shape)
          .filter(([, field]) => !(field as z.ZodType).isOptional())
          .map(([name]) => name);
        if (required.length) jsonSchema.required = required;
        else delete jsonSchema.required;
      }
    },
  });
}
