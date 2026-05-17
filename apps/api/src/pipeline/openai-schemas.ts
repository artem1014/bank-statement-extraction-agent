export const PERIOD_MARKER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['periods'],
  properties: {
    periods: {
      type: 'array',
      description:
        'Every statement period that appears within the supplied PDF chunk. Emit one entry per distinct (period, account) pair. If a period extends past the last page of the chunk, set chunk_end_page to the last page of the chunk and mark continues_past_chunk=true.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'chunk_start_page',
          'chunk_end_page',
          'continues_before_chunk',
          'continues_past_chunk',
          'start_date',
          'end_date',
          'account_last4',
          'bank',
        ],
        properties: {
          chunk_start_page: {
            type: 'integer',
            description: '1-indexed first page of this period inside the supplied chunk.',
          },
          chunk_end_page: {
            type: 'integer',
            description: '1-indexed last page of this period inside the supplied chunk.',
          },
          continues_before_chunk: {
            type: 'boolean',
            description: 'True iff the period started in an earlier chunk and continues here.',
          },
          continues_past_chunk: {
            type: 'boolean',
            description: 'True iff the period continues past the last page of this chunk.',
          },
          start_date: {
            type: ['string', 'null'],
            description:
              'Period start date as ISO YYYY-MM-DD, or null if not visible in this chunk.',
          },
          end_date: {
            type: ['string', 'null'],
            description: 'Period end date as ISO YYYY-MM-DD, or null if not visible in this chunk.',
          },
          account_last4: {
            type: ['string', 'null'],
            description:
              'Trailing 4 digits of the account number for this period (string of exactly 4 ASCII digits) or null if not visible.',
          },
          bank: {
            type: ['string', 'null'],
            description: 'Bank name as printed (e.g. "Ixonia Bank") or null if not visible.',
          },
        },
      },
    },
  },
} as const;

export const TRANSACTIONS_ONLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['transactions', 'warnings'],
  properties: {
    transactions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['date', 'description', 'deposit', 'withdrawal', 'source_span'],
        properties: {
          date: { type: 'string', description: 'ISO YYYY-MM-DD' },
          description: { type: 'string' },
          deposit: { type: ['number', 'null'] },
          withdrawal: { type: ['number', 'null'] },
          source_span: {
            type: 'object',
            additionalProperties: false,
            required: ['page', 'char_start', 'char_end'],
            properties: {
              page: { type: ['integer', 'null'] },
              char_start: { type: ['integer', 'null'] },
              char_end: { type: ['integer', 'null'] },
            },
          },
        },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const PERIOD_EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['account', 'summary', 'transactions', 'extraction'],
  properties: {
    account: {
      type: 'object',
      additionalProperties: false,
      required: ['bank', 'account_last4', 'period'],
      properties: {
        bank: { type: ['string', 'null'] },
        account_last4: {
          type: ['string', 'null'],
          description: 'Exactly 4 ASCII digits or null.',
        },
        period: {
          type: 'object',
          additionalProperties: false,
          required: ['start', 'end'],
          properties: {
            start: { type: 'string', description: 'ISO YYYY-MM-DD' },
            end: { type: 'string', description: 'ISO YYYY-MM-DD' },
          },
        },
      },
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'beginning_balance',
        'ending_balance',
        'deposits_total',
        'deposits_count',
        'withdrawals_total',
        'withdrawals_count',
      ],
      properties: {
        beginning_balance: { type: 'number' },
        ending_balance: { type: 'number' },
        deposits_total: { type: 'number' },
        deposits_count: { type: 'integer' },
        withdrawals_total: { type: 'number' },
        withdrawals_count: { type: 'integer' },
      },
    },
    transactions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['date', 'description', 'deposit', 'withdrawal', 'source_span'],
        properties: {
          date: { type: 'string', description: 'ISO YYYY-MM-DD' },
          description: { type: 'string' },
          deposit: { type: ['number', 'null'] },
          withdrawal: { type: ['number', 'null'] },
          source_span: {
            type: 'object',
            additionalProperties: false,
            required: ['page', 'char_start', 'char_end'],
            properties: {
              page: { type: ['integer', 'null'] },
              char_start: { type: ['integer', 'null'] },
              char_end: { type: ['integer', 'null'] },
            },
          },
        },
      },
    },
    extraction: {
      type: 'object',
      additionalProperties: false,
      required: ['warnings'],
      properties: {
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
  },
} as const;
