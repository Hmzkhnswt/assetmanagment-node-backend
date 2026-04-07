-- Links payment-style journal entries to an employee/payee and exposes numeric User ID for clients.
-- Run after accounting_system.sql (and optional sample data).

BEGIN;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS external_id INTEGER UNIQUE;

ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES employees (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_journal_entries_employee_id ON journal_entries (employee_id);

COMMENT ON COLUMN employees.external_id IS 'Numeric user id from client apps (e.g. Asset Manager).';
COMMENT ON COLUMN journal_entries.employee_id IS 'Payee/related person for expense payments; scopes balance views by user.';

-- Example payee for local dev (adjust or remove in production)
INSERT INTO employees (full_name, salary, external_id)
VALUES ('Hamza Ali', 0, 1)
ON CONFLICT (external_id) DO NOTHING;

COMMIT;
