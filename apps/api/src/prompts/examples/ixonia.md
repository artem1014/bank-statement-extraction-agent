---
prompt_version: v1.0.0
purpose: example
bank: ixonia
last_changed: 2026-05-17
---

# Few-shot example — Ixonia Bank (single-period, April 2025)

## Source text fragment

```
Ixonia Bank — Statement of Account
Account Number: XXXXXXXX4664
Statement Period: April 1, 2025 — April 30, 2025

Account Activity Summary
  Beginning Balance ........ 597,068.70
  Deposits and Credits ...... 1,214,254.05  (81 items)
  Withdrawals and Debits .... 1,302,201.16  (111 items)
  Ending Balance ........... 509,121.59

Transaction Details
  04-01  AIRLINEHYD 2759/VENDOR PMT          1,809.28
  04-01  ACME PAYROLL DEP                   12,450.00
  04-02  OFFICE LEASE                                     3,200.00
  ...
```

## Expected `submit_extraction` arguments (excerpt)

```json
{
  "account": {
    "bank": "Ixonia Bank",
    "account_last4": "4664",
    "period": { "start": "2025-04-01", "end": "2025-04-30" }
  },
  "summary": {
    "beginning_balance": 597068.70,
    "ending_balance": 509121.59,
    "deposits_total": 1214254.05,
    "deposits_count": 81,
    "withdrawals_total": 1302201.16,
    "withdrawals_count": 111
  },
  "transactions": [
    {
      "date": "2025-04-01",
      "description": "AIRLINEHYD 2759/VENDOR PMT",
      "deposit": 1809.28,
      "withdrawal": null,
      "source_span": { "page": null, "char_start": 0, "char_end": 0 }
    },
    {
      "date": "2025-04-01",
      "description": "ACME PAYROLL DEP",
      "deposit": 12450.00,
      "withdrawal": null,
      "source_span": { "page": null, "char_start": 0, "char_end": 0 }
    },
    {
      "date": "2025-04-02",
      "description": "OFFICE LEASE",
      "deposit": null,
      "withdrawal": 3200.00,
      "source_span": { "page": null, "char_start": 0, "char_end": 0 }
    }
  ],
  "extraction": { "warnings": [] }
}
```

Notes:

- `summary` does **not** contain a `reconciliation` field — the server fills
  it after your call.
- The full Ixonia statement has 192 transactions; this fragment shows just
  three rows to illustrate the shape.
- Real `source_span` offsets must point to the actual character ranges in the
  source text; the zeros above are placeholders.
