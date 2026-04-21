-- Receipts: sales receipts that record income via double-entry journal.
-- Finance rule: Dr Asset (from — where money lands) / Cr Income (reason — what was sold).
-- Run after accounting_system.sql and 002_journal_employee_support.sql.

BEGIN;

CREATE TABLE receipts (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number   TEXT        NOT NULL,
  customer_name    TEXT        NOT NULL,
  receipt_date     DATE        NOT NULL DEFAULT (CURRENT_DATE),
  description      TEXT        NOT NULL DEFAULT '',
  journal_entry_id UUID        NOT NULL REFERENCES journal_entries (id) ON DELETE RESTRICT,
  total_amount     NUMERIC(19, 4) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  status           TEXT        NOT NULL DEFAULT 'issued'
                               CHECK (status IN ('draft', 'issued', 'void')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT receipts_number_unique  UNIQUE (receipt_number),
  CONSTRAINT receipts_customer_ok    CHECK (length(trim(customer_name)) > 0),
  CONSTRAINT receipts_description_ok CHECK (length(trim(description)) > 0)
);

CREATE INDEX idx_receipts_receipt_number   ON receipts (receipt_number);
CREATE INDEX idx_receipts_journal_entry_id ON receipts (journal_entry_id);
CREATE INDEX idx_receipts_receipt_date     ON receipts (receipt_date);
CREATE INDEX idx_receipts_status           ON receipts (status);

COMMENT ON TABLE receipts IS
  'Sales receipts issued by the organisation. Each receipt is backed by a balanced '
  'journal entry (Dr asset / Cr income) recorded in journal_entries + journal_lines.';

COMMENT ON COLUMN receipts.receipt_number   IS 'Human-readable receipt identifier, e.g. RCPT-2026-0001.';
COMMENT ON COLUMN receipts.customer_name    IS 'Name of the buyer / paying party.';
COMMENT ON COLUMN receipts.journal_entry_id IS 'Corresponding balanced journal entry (reference starts with RCPT-).';
COMMENT ON COLUMN receipts.total_amount     IS 'Sum of all sale line amounts; computed at insert time.';
COMMENT ON COLUMN receipts.status           IS 'draft | issued | void';

COMMIT;
