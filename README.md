# Bank Statement Extraction Agent

Извлечение структурированных данных (`ExtractResult[]`) из многомесячных банковских выписок PDF.

## Архитектура (feature 002 — OCR-first)

```
PDF + OCR sidecar (.rtf/.txt от Azure Document AI)
    │
    ▼
/api/extract  (Hono, SSE)
    │
    ▼
extractDispatch  ── routing по EXTRACTION_MODE ──┐
    │                                            │
    ▼                                            ▼
extractWithOcrFirst                       extractPdf (legacy LLM-only)
  • parseOcrSidecar                         (без сайдкара — поведение
  • parseSummaryBlock (per period)           идентично feature 001)
  • parseTransactionsForPeriod
  • per-field LLM fallback (ocr-first)
  • reconcile (per period)
    │
    ▼
ExtractResult[]  ── SSE result frame
```

## Команды

```bash
pnpm install
pnpm typecheck          # все пакеты
pnpm test               # 56 unit + 4 integration тестов

# CLI: OCR-first (≤ 5 c на 99-страничной Ixonia)
pnpm -F @app/api extract:cli ./Binder2_Redacted.pdf \
    --ocr "./Bank Statement.rtf" --out ./out/v2.json

# CLI: явный режим
EXTRACTION_MODE=llm-only \
    pnpm -F @app/api extract:cli ./Binder2_Redacted.pdf

# Smoke run (печатает таблицу метрик)
pnpm -F @app/api smoke:ocr-first

# Web UI (Vite dev сервер)
pnpm -F @app/api dev      # терминал 1
pnpm -F @app/web dev      # терминал 2
```

## Self-reported accuracy (Ixonia fixture, OCR-first)

| period            | last4 | model              | tx | declared | recon |
|-------------------|-------|--------------------|----|----------|-------|
| 2025-04-01..04-30 | 1664  | ocr-deterministic  | ≥182 | 192     | drift\* |
| 2024-04..2025-04  | misc  | ocr-deterministic  | varies | varies  | drift\* |

\* Reconciliation drift на Ixonia структурный: `SummarySchema` пока учитывает только `deposits/withdrawals`, тогда как банк репортит ещё `Service Charges`, `Other Credits/Debits` и `Interest`. Это известное ограничение, планируется в feature 003 (расширение схемы); сам OCR-first парсер числа берёт верно — drift отражает реальный разрыв в исходной схеме.

## Known weaknesses

- **Reconciliation drift** на банках с категориями вне `deposits/withdrawals` (Service Charges, Other Credits, Other Debits, Fees, Interest). Известное ограничение `SummarySchema` — будет закрыто feature 003.
- **5% transaction recall ceiling** на строках, которые Document AI разорвал между страницами. Per-row fallback на LLM реализуем в будущей итерации.
- **PDF-sidecar mismatch detection** работает по plain-byte эвристике; на полностью image-only PDF может выдать ложно-положительный warning (`sidecar-pdf-mismatch`). Сама экстракция этим warning не блокируется.

## Конфигурация (env)

| Var                          | Default        | Назначение                             |
|------------------------------|----------------|----------------------------------------|
| `OPENAI_API_KEY`             | —              | обязательный                           |
| `EXTRACTION_MODE`            | `ocr-first`    | `ocr-first \| ocr-only \| llm-only`    |
| `MAX_PDF_BYTES`              | 100 MB         | размер PDF                             |
| `MAX_OCR_BYTES`              | 2 MB           | размер сайдкара                        |
| `OPENAI_CHUNK_BUDGET_BYTES`  | 28 MB          | бюджет per-chunk для OpenAI Files API  |
| `LOG_LEVEL`                  | `info`         | при `debug` пишутся per-period traces  |

## Спека и план

- `specs/001-pdf-statement-extractor/` — базовый LLM-only пайплайн
- `specs/002-ocr-first-extraction/` — текущая фича (OCR-first + per-field fallback)
- `.specify/memory/constitution.md` — инвариантные принципы проекта
