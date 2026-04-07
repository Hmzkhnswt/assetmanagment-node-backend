-- Sample chart of accounts + journal entries illustrating required flows
-- Run after accounting_system.sql

BEGIN;

-- Chart of accounts (typical small business subset)
INSERT INTO accounts (id, name, type, parent_id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'Cash', 'asset', NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'Bank — Operating', 'asset', NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 'Accounts Receivable', 'asset', NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', 'Equipment — GL', 'asset', NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', 'Accounts Payable', 'liability', NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6', 'Owner Capital', 'equity', NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7', 'Service Revenue', 'income', NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8', 'Salaries Expense', 'expense', NULL);

-- 1) Invoice recognized (accrual): Dr AR / Cr Revenue — $1,000.00
INSERT INTO journal_entries (id, reference, description, entry_date) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'INV-001', 'Invoice INV-001 — services rendered', '2026-03-01');

INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 1000.0000, 0),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7', 0, 1000.0000);

-- 2) Payment received: Dr Cash / Cr AR — $1,000.00
INSERT INTO journal_entries (id, reference, description, entry_date) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'RCPT-INV-001', 'Customer payment INV-001', '2026-03-15');

INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 1000.0000, 0),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', 0, 1000.0000);

-- 3) Salary paid: Dr Salaries Expense / Cr Bank — $3,500.00
INSERT INTO journal_entries (id, reference, description, entry_date) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', 'SALARY-MAR', 'March payroll', '2026-03-31');

INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8', 3500.0000, 0),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 0, 3500.0000);

-- 4) Asset purchase (fixed asset capitalized): Dr Equipment GL / Cr Cash — $2,400.00
INSERT INTO journal_entries (id, reference, description, entry_date) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4', 'FA-100', 'Purchase laptop — capitalized', '2026-03-20');

INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', 2400.0000, 0),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 0, 2400.0000);

-- Physical asset register row (informational; GL balance lives in journal)
INSERT INTO assets (name, value, purchase_date, asset_account_id) VALUES
  ('Laptop — IT', 2400.0000, '2026-03-20', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4');

COMMIT;
