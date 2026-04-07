-- =============================================================================
-- Single-Organization Asset & Financial Management System
-- PostgreSQL — Double-Entry Accounting (production-oriented baseline)
-- =============================================================================
-- Requires: PostgreSQL 14+ (uses gen_random_uuid(), CONSTRAINT TRIGGER patterns)
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- ENUMs
-- -----------------------------------------------------------------------------
CREATE TYPE account_type AS ENUM (
  'asset',
  'liability',
  'equity',
  'income',
  'expense'
);

CREATE TYPE invoice_status AS ENUM (
  'draft',
  'sent',
  'partial',
  'paid',
  'void'
);

-- -----------------------------------------------------------------------------
-- 1. Chart of Accounts
-- -----------------------------------------------------------------------------
CREATE TABLE accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  type        account_type NOT NULL,
  parent_id   UUID REFERENCES accounts (id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT accounts_name_not_blank CHECK (length(trim(name)) > 0),
  CONSTRAINT accounts_no_self_parent CHECK (parent_id IS DISTINCT FROM id)
);

CREATE INDEX idx_accounts_type ON accounts (type);

CREATE OR REPLACE FUNCTION trg_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_updated_at
BEFORE UPDATE ON accounts
FOR EACH ROW EXECUTE PROCEDURE trg_set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Journal entries (header)
-- -----------------------------------------------------------------------------
CREATE TABLE journal_entries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference    TEXT,
  description  TEXT NOT NULL DEFAULT '',
  entry_date   DATE NOT NULL DEFAULT (CURRENT_DATE),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT journal_entries_description_ok CHECK (description IS NOT NULL)
);

CREATE INDEX idx_journal_entries_entry_date ON journal_entries (entry_date);

-- -----------------------------------------------------------------------------
-- 3. Journal lines (double-entry lines)
-- -----------------------------------------------------------------------------
CREATE TABLE journal_lines (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id UUID NOT NULL REFERENCES journal_entries (id) ON DELETE CASCADE,
  account_id       UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  debit            NUMERIC(19, 4) NOT NULL DEFAULT 0,
  credit           NUMERIC(19, 4) NOT NULL DEFAULT 0,
  CONSTRAINT journal_lines_one_side_only
    CHECK (
      (debit = 0 OR credit = 0)
      AND (debit >= 0 AND credit >= 0)
      AND (debit > 0 OR credit > 0)
    )
);

CREATE INDEX idx_journal_lines_account_id ON journal_lines (account_id);
CREATE INDEX idx_journal_lines_journal_entry_id ON journal_lines (journal_entry_id);

-- Deferred balance check: allows multi-line inserts in one transaction before COMMIT
CREATE OR REPLACE FUNCTION validate_journal_entry_balanced(p_entry_id UUID)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_debit NUMERIC(19,4);
  v_credit NUMERIC(19,4);
  v_lines INT;
BEGIN
  SELECT
    COUNT(*),
    COALESCE(SUM(debit), 0),
    COALESCE(SUM(credit), 0)
  INTO v_lines, v_debit, v_credit
  FROM journal_lines
  WHERE journal_entry_id = p_entry_id;

  IF v_lines = 0 THEN
    RETURN;
  END IF;

  IF v_debit <> v_credit THEN
    RAISE EXCEPTION
      'Journal entry % is not balanced: total debit % <> total credit %',
      p_entry_id, v_debit, v_credit
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION trg_journal_lines_must_balance()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_ids UUID[];
  v_entry UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_ids := ARRAY[OLD.journal_entry_id];
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.journal_entry_id IS DISTINCT FROM NEW.journal_entry_id THEN
      v_ids := ARRAY[OLD.journal_entry_id, NEW.journal_entry_id];
    ELSE
      v_ids := ARRAY[NEW.journal_entry_id];
    END IF;
  ELSE
    v_ids := ARRAY[NEW.journal_entry_id];
  END IF;

  FOREACH v_entry IN ARRAY v_ids LOOP
    PERFORM validate_journal_entry_balanced(v_entry);
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_journal_lines_balance_deferred
AFTER INSERT OR UPDATE OR DELETE ON journal_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE PROCEDURE trg_journal_lines_must_balance();

-- Optional: immediate check for single-statement operations (comment out if you rely only on DEFERRED)
-- CREATE TRIGGER trg_journal_lines_balance_immediate
-- AFTER INSERT OR UPDATE OR DELETE ON journal_lines
-- FOR EACH ROW
-- EXECUTE PROCEDURE trg_journal_lines_must_balance();

-- -----------------------------------------------------------------------------
-- 4. Employees
-- -----------------------------------------------------------------------------
CREATE TABLE employees (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name  TEXT NOT NULL,
  salary     NUMERIC(19, 4) NOT NULL DEFAULT 0 CHECK (salary >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employees_full_name_ok CHECK (length(trim(full_name)) > 0)
);

-- -----------------------------------------------------------------------------
-- 5. Physical assets (register); accounting recognition still via journal_entries
-- -----------------------------------------------------------------------------
CREATE TABLE assets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  value             NUMERIC(19, 4) NOT NULL DEFAULT 0 CHECK (value >= 0),
  purchase_date     DATE,
  asset_account_id  UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assets_name_ok CHECK (length(trim(name)) > 0)
);

-- -----------------------------------------------------------------------------
-- 6. Invoices
-- -----------------------------------------------------------------------------
CREATE TABLE invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number  TEXT NOT NULL,
  client_name     TEXT NOT NULL,
  issue_date      DATE NOT NULL DEFAULT (CURRENT_DATE),
  due_date        DATE,
  status          invoice_status NOT NULL DEFAULT 'draft',
  total_amount    NUMERIC(19, 4) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invoices_invoice_number_unique UNIQUE (invoice_number),
  CONSTRAINT invoices_client_ok CHECK (length(trim(client_name)) > 0)
);

CREATE INDEX idx_invoices_invoice_number ON invoices (invoice_number);

-- -----------------------------------------------------------------------------
-- 7. Invoice line items
-- -----------------------------------------------------------------------------
CREATE TABLE invoice_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  UUID NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',
  quantity    NUMERIC(19, 4) NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  unit_price  NUMERIC(19, 4) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  line_total  NUMERIC(19, 4) GENERATED ALWAYS AS (ROUND(quantity * unit_price, 4)) STORED
);

CREATE INDEX idx_invoice_items_invoice_id ON invoice_items (invoice_id);

CREATE OR REPLACE FUNCTION trg_recalc_invoice_total()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_invoice UUID;
BEGIN
  v_invoice := COALESCE(NEW.invoice_id, OLD.invoice_id);

  UPDATE invoices i
  SET total_amount = COALESCE((
    SELECT ROUND(SUM(ii.line_total), 4)
    FROM invoice_items ii
    WHERE ii.invoice_id = v_invoice
  ), 0)
  WHERE i.id = v_invoice;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER invoice_items_recalc_total_aiud
AFTER INSERT OR UPDATE OR DELETE ON invoice_items
FOR EACH ROW
EXECUTE PROCEDURE trg_recalc_invoice_total();

-- -----------------------------------------------------------------------------
-- 8. Payments (links cash receipt to AR clearance via journal_entries)
-- -----------------------------------------------------------------------------
CREATE TABLE payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        UUID NOT NULL REFERENCES invoices (id) ON DELETE RESTRICT,
  journal_entry_id  UUID NOT NULL REFERENCES journal_entries (id) ON DELETE RESTRICT,
  payment_date      DATE NOT NULL DEFAULT (CURRENT_DATE),
  amount            NUMERIC(19, 4) NOT NULL CHECK (amount > 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_invoice_id ON payments (invoice_id);
CREATE INDEX idx_payments_journal_entry_id ON payments (journal_entry_id);

-- -----------------------------------------------------------------------------
-- VIEWS — Financial statements from posted journal activity
-- Normal balances: Assets & Expenses → debit; Liability, Equity, Income → credit
-- -----------------------------------------------------------------------------

-- Trial balance: raw posting totals per account
CREATE OR REPLACE VIEW trial_balance AS
SELECT
  a.id AS account_id,
  a.name AS account_name,
  a.type AS account_type,
  COALESCE(SUM(jl.debit), 0) AS total_debit,
  COALESCE(SUM(jl.credit), 0) AS total_credit,
  CASE a.type
    WHEN 'asset' THEN COALESCE(SUM(jl.debit - jl.credit), 0)
    WHEN 'expense' THEN COALESCE(SUM(jl.debit - jl.credit), 0)
    WHEN 'liability' THEN COALESCE(SUM(jl.credit - jl.debit), 0)
    WHEN 'equity' THEN COALESCE(SUM(jl.credit - jl.debit), 0)
    WHEN 'income' THEN COALESCE(SUM(jl.credit - jl.debit), 0)
  END AS balance
FROM accounts a
LEFT JOIN journal_lines jl ON jl.account_id = a.id
GROUP BY a.id, a.name, a.type;

-- Profit & Loss: net = income (credit-normal) minus expenses (debit-normal)
CREATE OR REPLACE VIEW profit_loss AS
SELECT
  COALESCE(SUM(CASE WHEN a.type = 'income' THEN jl.credit - jl.debit ELSE 0 END), 0) AS total_income,
  COALESCE(SUM(CASE WHEN a.type = 'expense' THEN jl.debit - jl.credit ELSE 0 END), 0) AS total_expense,
  COALESCE(SUM(CASE WHEN a.type = 'income' THEN jl.credit - jl.debit ELSE 0 END), 0)
    - COALESCE(SUM(CASE WHEN a.type = 'expense' THEN jl.debit - jl.credit ELSE 0 END), 0) AS net_income
FROM journal_lines jl
JOIN accounts a ON a.id = jl.account_id
WHERE a.type IN ('income', 'expense');

-- Balance sheet: section totals (accounting equation: assets = liabilities + equity)
CREATE OR REPLACE VIEW balance_sheet AS
SELECT
  COALESCE(SUM(CASE WHEN a.type = 'asset' THEN jl.debit - jl.credit ELSE 0 END), 0) AS total_assets,
  COALESCE(SUM(CASE WHEN a.type = 'liability' THEN jl.credit - jl.debit ELSE 0 END), 0) AS total_liabilities,
  COALESCE(SUM(CASE WHEN a.type = 'equity' THEN jl.credit - jl.debit ELSE 0 END), 0) AS total_equity,
  COALESCE(SUM(CASE WHEN a.type = 'asset' THEN jl.debit - jl.credit ELSE 0 END), 0)
    - (
      COALESCE(SUM(CASE WHEN a.type = 'liability' THEN jl.credit - jl.debit ELSE 0 END), 0)
      + COALESCE(SUM(CASE WHEN a.type = 'equity' THEN jl.credit - jl.debit ELSE 0 END), 0)
    ) AS balancing_difference
FROM journal_lines jl
JOIN accounts a ON a.id = jl.account_id
WHERE a.type IN ('asset', 'liability', 'equity');

COMMIT;
