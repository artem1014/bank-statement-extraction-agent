#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

pnpm -F @app/contracts run gen-schema

if ! git diff --quiet -- \
  "specs/001-pdf-statement-extractor/contracts/extract-result.schema.json" \
  "specs/001-pdf-statement-extractor/contracts/llm-tool-input.schema.json"; then
  echo "::error::JSON schemas drifted from packages/contracts/src/schemas.ts." >&2
  echo "Run: pnpm -F @app/contracts run gen-schema && git add specs/.../contracts/*.schema.json" >&2
  git --no-pager diff -- \
    "specs/001-pdf-statement-extractor/contracts/extract-result.schema.json" \
    "specs/001-pdf-statement-extractor/contracts/llm-tool-input.schema.json" >&2
  exit 1
fi

echo "Schemas are in sync."
