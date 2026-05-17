import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  ExtractResultArraySchema,
  ExtractResultSchema,
  LlmExtractionInputArraySchema,
  LlmExtractionInputSchema,
} from '../src/schemas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const OUT_DIR = resolve(REPO_ROOT, 'specs', '001-pdf-statement-extractor', 'contracts');

type SchemaEntry = {
  schema: Parameters<typeof zodToJsonSchema>[0];
  name: string;
  filename: string;
  description: string;
};

const ENTRIES: SchemaEntry[] = [
  {
    schema: ExtractResultSchema,
    name: 'ExtractResult',
    filename: 'extract-result.schema.json',
    description:
      'Canonical structured output of one bank-statement extraction (one period). ' +
      'Generated from packages/contracts/src/schemas.ts via zod-to-json-schema; ' +
      'do not edit by hand.',
  },
  {
    schema: ExtractResultArraySchema,
    name: 'ExtractResultArray',
    filename: 'extract-result-array.schema.json',
    description:
      'Top-level result of the multi-period extraction pipeline: ' +
      'an ordered array of ExtractResult, one entry per statement period present in the PDF. ' +
      'Generated from packages/contracts/src/schemas.ts via zod-to-json-schema; do not edit by hand.',
  },
  {
    schema: LlmExtractionInputSchema,
    name: 'LlmExtractionInput',
    filename: 'llm-tool-input.schema.json',
    description:
      'Input shape for the LLM tool / structured-output call (single period). ' +
      'Identical to ExtractResult except that `summary.reconciliation` is omitted: ' +
      'the LLM is responsible for observations (account, summary aggregates, transactions, ' +
      'source spans), while the server-side pipeline computes reconciliation deterministically ' +
      'and assembles the final ExtractResult. Generated from packages/contracts/src/schemas.ts ' +
      'via zod-to-json-schema; do not edit by hand.',
  },
  {
    schema: LlmExtractionInputArraySchema,
    name: 'LlmExtractionInputArray',
    filename: 'llm-tool-input-array.schema.json',
    description:
      'Multi-period LLM input shape: { periods: LlmExtractionInput[] }. ' +
      'Used by the OpenAI Responses API with Structured Outputs. ' +
      'Generated from packages/contracts/src/schemas.ts via zod-to-json-schema; do not edit by hand.',
  },
];

function generate(entry: SchemaEntry): void {
  const jsonSchema = zodToJsonSchema(entry.schema, {
    name: entry.name,
    target: 'jsonSchema2019-09',
    $refStrategy: 'root',
  }) as Record<string, unknown>;

  const {
    $ref: _ref,
    definitions: rawDefinitions,
    ...rest
  } = jsonSchema as Record<string, unknown>;
  void _ref;
  const wrapped: Record<string, unknown> = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://github.com/artem1014/bank-statement-extraction-agent/specs/001-pdf-statement-extractor/contracts/${entry.filename}`,
    title: entry.name,
    description: entry.description,
    ...rest,
  };

  if (rawDefinitions && typeof rawDefinitions === 'object') {
    const definitions = { ...(rawDefinitions as Record<string, unknown>) };
    const root = definitions[entry.name] as Record<string, unknown> | undefined;
    if (root) {
      const { [entry.name]: _self, ...others } = definitions;
      void _self;
      if (Object.keys(others).length > 0) {
        wrapped.$defs = others;
      }
      Object.assign(wrapped, root);
    } else if (Object.keys(definitions).length > 0) {
      wrapped.$defs = definitions;
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = resolve(OUT_DIR, entry.filename);
  const formatted = `${JSON.stringify(wrapped, null, 2)}\n`;
  writeFileSync(outPath, formatted, 'utf8');
  console.log(`wrote ${outPath}`);
}

for (const entry of ENTRIES) {
  generate(entry);
}
