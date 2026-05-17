<!--
SYNC IMPACT REPORT
==================
Version change: 1.0.0 → 1.0.1
Bump rationale: PATCH — clarification of §IV `TransactionSchema` to permit ambiguous
rows (deposit AND withdrawal both null) when accompanied by an explicit warning. No
core principle is added, removed, or weakened: the spirit of §I "document-grounded
only" is preserved — ambiguous rows are surfaced honestly rather than guessed.

Modified principles (this revision):
  - §IV Data Contract — `TransactionSchema` no longer carries the exclusive-or Zod
    `.refine()` between `deposit` and `withdrawal`. Instead, the schema permits all
    three combinations (deposit-only, withdrawal-only, both-null); the both-null case
    is legal only when `extraction.warnings[]` contains an entry referencing the
    transaction's `source_span` with the `ambiguous-direction:` prefix. This
    business-rule check is enforced in `apps/api/src/pipeline/extract.ts`, not in
    Zod, because Zod has no access to the warnings list at the time the schema
    validates a single transaction.

Added sections: none
Removed sections: none

Templates requiring updates:
  - ✅ .specify/templates/plan-template.md — no edits required.
  - ✅ .specify/templates/spec-template.md — no edits required.
  - ✅ .specify/templates/tasks-template.md — no edits required.
  - ✅ specs/001-pdf-statement-extractor/data-model.md — already reflects the
       relaxed schema (this amendment legitimises that design).
  - ✅ specs/001-pdf-statement-extractor/research.md R-6 — already documents the
       rationale.

Prior revision (1.0.0 → kept for traceability):
  Version change: 0.0.0 (template) → 1.0.0
  Bump rationale: MAJOR — first ratification of the project constitution; replaced
  all placeholder tokens with concrete, binding rules.
  Modified principles:
    - [PRINCIPLE_1_NAME] → I. Document-grounded only (no hallucinations)
    - [PRINCIPLE_2_NAME] → II. Reconciliation is non-negotiable
    - [PRINCIPLE_3_NAME] → III. Generalization via prompts & schema, not code
    - [PRINCIPLE_4_NAME] → IV. Strict typing end-to-end
    - [PRINCIPLE_5_NAME] → V. Deterministic where possible
  Added sections:
    - II. Architecture, III. Technology Stack, IV. Data Contract,
      V. Development Rules, VI. Acceptance Criteria, VII. Out of Scope,
      VIII. Amendment Process (governance)

Deferred items: none.
-->

# Bank Statement Extraction Agent Constitution

**Project**: Агент, который принимает банковскую выписку (PDF + опциональный OCR-текст) и
возвращает структурированный JSON: реквизиты счёта, период, сводные суммы и полный список
транзакций.

**Documents control**: Этот файл — источник правды для архитектуры, технологий и правил
разработки. Любое отклонение от него требует явного обновления документа через PR с
обоснованием (см. §VIII).

## Core Principles

### I. Document-grounded only — никаких галлюцинаций

Все значения в выходном JSON ОБЯЗАНЫ иметь происхождение из исходного документа
(PDF/OCR-текст). LLM НЕ ИМЕЕТ ПРАВА додумывать суммы, даты или счета. Если данные
отсутствуют или неоднозначны — поле возвращается как `null` с записью в
`extraction.warnings[]`.

Каждая транзакция ДОЛЖНА сопровождаться `source_span` (offset в OCR-тексте или page+bbox
в PDF) для аудита и отладки. Это поле обязательно на уровне модели данных.

**Rationale**: проверяемость и воспроизводимость извлечения; без source_span невозможно
отличить корректное извлечение от галлюцинации.

### II. Reconciliation is non-negotiable

Тождество `beginning_balance + Σdeposits − Σwithdrawals = ending_balance` проверяется
ДЕТЕРМИНИРОВАННО после LLM-вызова, не самим LLM. При расхождении > 1 цента (для
устойчивости к копейкам):

- В ответ добавляется `summary.reconciliation = { ok: false, delta, expected_ending }`.
- HTTP-ответ остаётся `200` (это валидный отчёт об ошибке данных), но во фронте
  показывается явный визуальный флаг.

Точные арифметические операции выполняются ТОЛЬКО в decimal-арифметике (`decimal.js` на
бэке); использование `Number` для денежных сумм ЗАПРЕЩЕНО.

**Rationale**: финансовые ошибки недопустимы; LLM не может быть единственным судьёй
собственной арифметики.

### III. Generalization via prompts & schema, not code

Поддержка нового банка = редактирование промпта и/или JSON-схемы, а не кода извлечения.
Парсер НЕ СОДЕРЖИТ банк-специфичных regex, ключевых слов или таблиц соответствий. Все
эвристики живут в `prompts/` как версионируемые markdown-файлы.

Если возникает соблазн «захардкодить случай Ixonia» — это сигнал переписать промпт или
схему.

**Rationale**: масштабирование на новые форматы без релиза кода; чёткое разделение
данных, логики и контракта.

### IV. Strict typing end-to-end

Контракт между фронтом и бэком — Zod-схема, из которой выводятся TS-типы для обеих
сторон через общий пакет `@app/contracts`. Никакого ручного дублирования типов.

LLM-ответ парсится через ту же Zod-схему. Если LLM возвращает невалидный JSON —
отдельная ошибка `SchemaValidationError`, а не молчаливое исправление.

**Rationale**: single source of truth для контракта; runtime-проверки совпадают со
статической типизацией.

### V. Deterministic where possible

LLM-вызовы идут с `temperature: 0` и фиксированным `seed` (если модель поддерживает).
Один и тот же вход → один и тот же выход. Тесты МОГУТ полагаться на это в
snapshot-тестах детерминированных частей пайплайна.

**Rationale**: воспроизводимость багов и тестов; стабильность демо.

## II. Architecture

### High-level data flow

```text
[PDF + opt. OCR.txt]
        │
        ▼
   ┌─────────────┐
   │  Frontend   │  React + TS, drag-and-drop, file upload
   └──────┬──────┘
          │ multipart/form-data
          ▼
   ┌─────────────┐
   │  API Layer  │  Hono (Node.js + TS)
   │   /extract  │  валидация, rate-limiting, idempotency-key
   └──────┬──────┘
          │
          ▼
   ┌──────────────────────────────────────┐
   │      Extraction Pipeline             │
   │  1. preprocess (PDF → text если нет) │
   │  2. chunk (если > 1 страницы)        │
   │  3. LLM call (structured output)     │
   │  4. schema validation (Zod)          │
   │  5. reconciliation check             │
   │  6. enrich with warnings/metadata    │
   └──────────────┬───────────────────────┘
                  │
                  ▼
            structured JSON
```

### Backend structure (Hono + TS)

```text
apps/api/
├── src/
│   ├── index.ts                       # Hono app entry
│   ├── routes/
│   │   └── extract.ts                 # POST /extract
│   ├── pipeline/
│   │   ├── preprocess.ts              # PDF → text (если нет OCR)
│   │   ├── chunk.ts                   # разбиение длинных выписок
│   │   ├── llm-client.ts              # абстракция над Anthropic SDK
│   │   ├── extract.ts                 # главная функция extract()
│   │   └── reconcile.ts               # детерминированная сверка сумм
│   ├── prompts/
│   │   ├── system.md                  # роль и общие правила
│   │   ├── extraction.md              # инструкции по извлечению
│   │   └── examples/                  # few-shot примеры (Ixonia + 1-2 других)
│   ├── domain/
│   │   ├── types.ts                   # импорт из @app/contracts
│   │   └── errors.ts                  # типизированные ошибки
│   └── utils/
│       ├── money.ts                   # decimal-арифметика
│       └── logger.ts                  # structured logging (pino)
├── tests/
│   ├── reconcile.test.ts              # unit, чистая логика
│   ├── extract.integration.test.ts    # с реальным/моковым LLM
│   └── fixtures/                      # PDF + ожидаемый JSON
└── package.json
```

### Frontend structure (React + TS)

```text
apps/web/
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── features/
│   │   └── extraction/
│   │       ├── api/
│   │       │   └── useExtract.ts          # TanStack Query mutation
│   │       ├── components/
│   │       │   ├── FileDropzone.tsx
│   │       │   ├── ExtractionResult.tsx
│   │       │   ├── SummaryCard.tsx
│   │       │   ├── ReconciliationBadge.tsx
│   │       │   └── TransactionsTable.tsx  # TanStack Table
│   │       └── hooks/
│   │           └── useFileUpload.ts
│   ├── shared/
│   │   ├── ui/                            # shadcn/ui компоненты
│   │   ├── lib/
│   │   │   └── format.ts                  # форматирование сумм/дат
│   │   └── api/
│   │       └── client.ts                  # fetch wrapper
│   └── types/                             # импорт из @app/contracts
├── tests/
└── package.json
```

### Shared contracts package

```text
packages/contracts/
├── src/
│   ├── schemas.ts          # Zod-схемы (Account, Summary, Transaction, ExtractResult)
│   ├── types.ts            # z.infer<> экспорты
│   └── index.ts
└── package.json
```

### Monorepo layout

`pnpm` workspaces + Turborepo для оркестрации сборок и кэширования.

```text
/
├── apps/
│   ├── api/
│   └── web/
├── packages/
│   └── contracts/
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

## III. Technology Stack

### Backend

| Назначение         | Технология              | Обоснование                                              |
|--------------------|-------------------------|----------------------------------------------------------|
| Runtime            | Node.js 20+ LTS         | стабильность, fetch встроен                              |
| Framework          | Hono                    | лёгкий, типизированный, edge-ready, лучше Express для TS |
| Language           | TypeScript 5.4+         | `strict: true`, без `any` без явного объяснения          |
| LLM SDK            | `@anthropic-ai/sdk`     | structured output через tool use или JSON mode           |
| PDF parsing        | `pdf-parse` или `unpdf` | только для извлечения текста, если OCR не передан        |
| Validation         | Zod                     | runtime + статические типы из одного источника           |
| Money              | `decimal.js`            | избегаем float-ошибок                                    |
| Logging            | `pino`                  | structured JSON-логи                                     |
| Testing            | `vitest`                | быстрый, ESM-friendly                                    |
| Linter/Formatter   | Biome или ESLint+Prettier | единый стиль                                           |

### Frontend

| Назначение     | Технология                                         | Обоснование                                  |
|----------------|----------------------------------------------------|----------------------------------------------|
| Build          | Vite                                               | быстрый dev-сервер, минимум конфига          |
| Framework      | React 18 + TypeScript                              | требование                                   |
| Routing        | `react-router` (если нужен)                        | минимально, одна страница может обойтись без |
| Data fetching  | TanStack Query                                     | кэш, состояния loading/error из коробки      |
| Forms / Upload | `react-dropzone`                                   | drag-and-drop файлов                         |
| Tables         | TanStack Table                                     | красивая таблица транзакций                  |
| UI primitives  | shadcn/ui + Tailwind                               | копируемые компоненты, контроль над стилями  |
| State          | локальный + TanStack Query                         | без Redux/Zustand, пока не нужен             |
| Testing        | `vitest` + `@testing-library/react` + Playwright   | пирамида тестирования                        |

### Infrastructure / DevX

- **Git + Conventional Commits** — для автоматических changelog'ов и понятной истории.
- **Husky + lint-staged** — pre-commit хуки: lint, format, typecheck.
- **GitHub Actions** — CI: `lint → typecheck → test → build`.
- **Docker** — `Dockerfile` для `api`, чтобы было воспроизводимо. Frontend деплоится
  статикой.
- **.env + zod-валидация конфига** — никаких `process.env.X` напрямую, только через
  типизированный `config` модуль.

## IV. Data Contract (источник правды)

Канонический формат вывода. Любое изменение требует обновления Zod-схемы в
`@app/contracts`.

```ts
// packages/contracts/src/schemas.ts
import { z } from 'zod';

export const AccountSchema = z.object({
  bank: z.string().nullable(),
  account_last4: z.string().regex(/^\d{4}$/).nullable(),
  period: z.object({
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
});

export const SummarySchema = z.object({
  beginning_balance: z.number(),
  ending_balance:    z.number(),
  deposits_total:    z.number(),
  deposits_count:    z.number().int().nonnegative(),
  withdrawals_total: z.number(),
  withdrawals_count: z.number().int().nonnegative(),
  reconciliation: z.object({
    ok: z.boolean(),
    delta: z.number(),
    expected_ending: z.number(),
  }),
});

export const TransactionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string(),
  deposit:    z.number().nullable(),
  withdrawal: z.number().nullable(),
  source_span: z.object({
    page: z.number().int().positive().nullable(),
    char_start: z.number().int().nonnegative().nullable(),
    char_end:   z.number().int().nonnegative().nullable(),
  }),
});
// Direction rule (enforced in pipeline/extract.ts, not in Zod):
//   At least one of { deposit, withdrawal } MUST be non-null UNLESS the row is
//   flagged ambiguous. An ambiguous row has both fields null AND there MUST exist
//   an entry in `extraction.warnings[]` of the form
//   `ambiguous-direction: <date> '<description>' @ <source_span>` referencing it.
//   See `specs/001-pdf-statement-extractor/research.md` R-6 for rationale.

export const ExtractResultSchema = z.object({
  account: AccountSchema,
  summary: SummarySchema,
  transactions: z.array(TransactionSchema),
  extraction: z.object({
    model: z.string(),
    prompt_version: z.string(),
    duration_ms: z.number().int(),
    warnings: z.array(z.string()),
  }),
});

export type ExtractResult = z.infer<typeof ExtractResultSchema>;
```

## V. Development Rules

### Code quality

- TypeScript strict mode включён везде: `noImplicitAny`, `strictNullChecks`,
  `noUncheckedIndexedAccess`.
- Никаких `any` без комментария `// reason: ...`. PR с unjustified `any` отклоняется.
- Функции до 50 строк. Длиннее — декомпозируй.
- Pure functions where possible. Бизнес-логика (`reconcile`, money math) — без побочных
  эффектов и легко тестируется.

### Testing strategy

- Unit-тесты ОБЯЗАТЕЛЬНЫ для: `reconcile.ts`, `money.ts`, всех чистых утилит.
- Integration-тесты для пайплайна с моками LLM (фиксированный ответ модели) + минимум
  2 fixture (Ixonia + 1 другой банк).
- E2E (Playwright) — один smoke-тест: загрузить PDF → дождаться результата → проверить,
  что таблица отрендерилась.
- Snapshot-тесты РАЗРЕШЕНЫ только для детерминированных частей (форматирование, не для
  LLM-ответа целиком).

### Prompt management

- Промпты — версионируемые `.md` файлы в `prompts/`. У каждого есть `prompt_version` в
  frontmatter; этот тег попадает в ответ.
- Изменение промпта = bump `prompt_version` + комментарий в PR с обоснованием.
- Few-shot примеры хранятся отдельно от системного промпта в `prompts/examples/` для
  удобства редактирования.

### Error handling

Бэк НИКОГДА не возвращает stack trace в продакшене. Только типизированные коды ошибок:

- `BAD_FILE` — невалидный/повреждённый PDF
- `EXTRACTION_FAILED` — LLM вернул невалидный JSON после N ретраев
- `RECONCILIATION_FAILED` — это не ошибка HTTP, это поле в ответе
- `LLM_UNAVAILABLE` — провайдер недоступен / rate limit

Фронт показывает понятное сообщение пользователю + кнопку «повторить» для retriable
ошибок.

### Security

- Размер загружаемого PDF — лимит 10MB (конфигурируемо).
- MIME-type validation на бэке, не только по расширению.
- Файлы НЕ сохраняются на диск между запросами (in-memory обработка). Если в будущем
  понадобится — отдельное обсуждение privacy.
- Все API-ключи — через `.env`, никогда не в коде, `.env.example` в репозитории.
- CORS настроен явно: только origin фронтенда.

### Performance budgets

- `p95` latency `/extract` для выписки до 10 страниц: ≤ 20 секунд (с учётом LLM).
- Frontend bundle размер: ≤ 250KB gzipped initial.
- Time to interactive на десктопе: ≤ 2s.

## VI. Acceptance Criteria

Проект считается готовым к сдаче, когда:

- ✅ `extract(pdf_path, txt_path?)` работает как CLI и как HTTP endpoint.
- ✅ На образце Ixonia все summary-поля совпадают точно с эталоном (grading #1).
- ✅ Сумма `Σdeposits` и `Σwithdrawals` из массива `transactions` совпадает с
  `summary.*_total` (grading #2).
- ✅ На 2 дополнительных банковских выписках другого формата извлечение работает без
  правок кода (grading #3).
- ✅ `README` содержит:
  - Архитектурную диаграмму (или текстовое описание потока)
  - Команды для запуска (`dev`, `build`, `test`)
  - Self-reported accuracy на тестовых fixture
  - Known weaknesses (раздел с честным разбором кейсов, где модель ошибается)
- ✅ CI зелёный: lint, typecheck, unit + integration tests.
- ✅ Подготовлена 30-минутная демо-сессия: live-run на Ixonia + на ранее невиданной
  выписке.

## VII. Out of Scope (явные NO)

Чтобы не расползалось:

- ❌ Авторизация / multi-user. Это single-user tool для демо.
- ❌ Хранение истории извлечений (БД). Не нужно для скоупа.
- ❌ Поддержка не-PDF форматов (CSV, OFX, HTML-выписки). Не сейчас.
- ❌ Категоризация транзакций / ML-классификация. Только извлечение.
- ❌ Многоязычные выписки кроме английского. Можно добавить позже через промпт.
- ❌ Кастомные обученные модели. Только vendor LLM API.

## VIII. Governance — Amendment Process

Изменение constitution возможно только через PR со следующей структурой:

1. **Что меняется и почему** (1–2 абзаца).
2. **Какие принципы из Core Principles затронуты** (если затронуты — нужно сильное
   обоснование).
3. **Миграционный план** для существующего кода, если применимо.
4. **Минимум 1 review** + явный approve от owner проекта.

Изменения в Core Principles (§I) требуют отдельного обсуждения и НЕ ДЕЛАЮТСЯ в спешке.

**Versioning policy** (semantic versioning):

- **MAJOR** — backward-incompatible изменения принципов, удаление принципа или
  переопределение governance.
- **MINOR** — новый принцип/секция или существенное расширение guidance.
- **PATCH** — уточнения, исправления формулировок, опечатки, не семантические правки.

**Compliance review**: каждый PR должен подтверждать соответствие constitution; planning
(`/speckit-plan`) запускает Constitution Check как gate перед Phase 0 и повторно после
Phase 1.

**Version**: 1.0.1 | **Ratified**: 2026-05-17 | **Last Amended**: 2026-05-17
