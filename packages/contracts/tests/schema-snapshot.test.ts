import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const SCHEMA_FILES = [
  'specs/001-pdf-statement-extractor/contracts/extract-result.schema.json',
  'specs/001-pdf-statement-extractor/contracts/llm-tool-input.schema.json',
] as const;

describe('JSON Schema drift detector', () => {
  it('committed schemas match the freshly generated ones (run `pnpm -F @app/contracts run gen-schema` to refresh)', () => {
    const before = SCHEMA_FILES.map((rel) => readFileSync(resolve(REPO_ROOT, rel), 'utf8'));
    execSync('pnpm -F @app/contracts run gen-schema', { cwd: REPO_ROOT, stdio: 'pipe' });
    const after = SCHEMA_FILES.map((rel) => readFileSync(resolve(REPO_ROOT, rel), 'utf8'));
    expect(after).toEqual(before);
  });
});
