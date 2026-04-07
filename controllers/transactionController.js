const crypto = require('crypto');
const { pool } = require('../config/db');

const PAY_INV_PREFIX = 'PAY-INV-';
const INVOICE_STATUSES = new Set(['draft', 'sent', 'partial', 'paid', 'void']);

function normalizeDateInput(value, fieldName, { allowNull = true } = {}) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    if (allowNull) return null;
    throw httpError(400, `${fieldName} cannot be null.`);
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw httpError(400, `${fieldName} must be a valid date (YYYY-MM-DD).`);
    }
    return value.toISOString().slice(0, 10);
  }

  const trimmed = typeof value === 'string' ? value.trim() : String(value).trim();
  if (trimmed === '') {
    if (allowNull) return null;
    throw httpError(400, `${fieldName} cannot be blank.`);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw httpError(400, `${fieldName} must be a valid date (YYYY-MM-DD).`);
  }
  return parsed.toISOString().slice(0, 10);
}

function storedDateToString(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value);
}

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.expose = true;
  return e;
}

function isProvided(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  return String(v).trim().length > 0;
}

/**
 * Resolve employee by numeric userId (external_id), full name, or first + last name.
 */
async function resolveEmployee(client, body) {
  const { userId, fullName, employeeName, firstName, lastName } = body;
  const hasUserId = isProvided(userId);
  const full = String(employeeName || fullName || '').trim();
  const hasFull = full.length > 0;
  const fn = typeof firstName === 'string' ? firstName.trim() : '';
  const ln = typeof lastName === 'string' ? lastName.trim() : '';
  const hasPair = fn.length > 0 && ln.length > 0;

  if (!hasUserId && !hasFull && !hasPair) {
    throw httpError(
      400,
      'Provide userId, fullName (or employeeName), or both firstName and lastName.'
    );
  }

  if (hasUserId) {
    const { rows } = await client.query(
      `SELECT id, external_id, full_name FROM employees WHERE external_id = $1`,
      [Number(userId)]
    );
    if (rows.length === 0) {
      throw httpError(404, `No employee found for userId ${userId}.`);
    }
    return rows[0];
  }

  const searchName = hasFull ? full : `${fn} ${ln}`;
  const { rows } = await client.query(
    `SELECT id, external_id, full_name FROM employees
     WHERE lower(trim(full_name)) = lower(trim($1))`,
    [searchName]
  );
  if (rows.length === 0) {
    throw httpError(404, `No employee found matching name "${searchName}".`);
  }
  if (rows.length > 1) {
    throw httpError(
      409,
      `Multiple employees match "${searchName}". Use userId to pick one.`
    );
  }
  return rows[0];
}

/**
 * POST /api/invoices/journal
 * One journal entry per invoice: shared description; each UI row = Dr expense, Cr asset.
 */
async function createJournalInvoice(req, res, next) {
  const body = req.body || {};
  const { date, description, entries } = body;

  if (!description || typeof description !== 'string' || !description.trim()) {
    return next(httpError(400, 'description is required.'));
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return next(httpError(400, 'entries must be a non-empty array.'));
  }

  const entryDate = date || new Date().toISOString().slice(0, 10);

  let normalized;
  try {
    normalized = entries.map((e, i) => {
      const fromId = e.fromAccountId ?? e.sourceAccountId;
      const reasonId = e.reasonAccountId ?? e.expenseAccountId;
      const amt = e.amount;
      if (!fromId || !reasonId) {
        throw httpError(400, `entries[${i}]: fromAccountId and reasonAccountId are required.`);
      }
      const amount = Number(amt);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw httpError(400, `entries[${i}]: amount must be a positive number.`);
      }
      return { fromAccountId: fromId, reasonAccountId: reasonId, amount };
    });
  } catch (err) {
    return next(err);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const empRow = await resolveEmployee(client, body);
    const employeeId = empRow.id;

    const accountIds = new Set();
    for (const e of normalized) {
      accountIds.add(e.fromAccountId);
      accountIds.add(e.reasonAccountId);
    }
    const { rows: accRows } = await client.query(
      `SELECT id, type FROM accounts WHERE id = ANY($1::uuid[])`,
      [[...accountIds]]
    );
    const typeById = new Map(accRows.map((a) => [a.id, a.type]));
    for (const e of normalized) {
      if (typeById.get(e.fromAccountId) !== 'asset') {
        throw httpError(400, 'From account must be an asset account (e.g. Bank).');
      }
      if (typeById.get(e.reasonAccountId) !== 'expense') {
        throw httpError(400, 'Reason account must be an expense account (e.g. Salary).');
      }
    }

    const reference = `${PAY_INV_PREFIX}${crypto.randomUUID()}`;
    const { rows: jeRows } = await client.query(
      `INSERT INTO journal_entries (reference, description, entry_date, employee_id)
       VALUES ($1, $2, $3::date, $4)
       RETURNING id, reference, description, entry_date, employee_id, created_at`,
      [reference, description.trim(), entryDate, employeeId]
    );
    const journalEntry = jeRows[0];

    let totalDebit = 0;
    for (const e of normalized) {
      totalDebit += e.amount;
      await client.query(
        `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit)
         VALUES ($1, $2, $3, 0)`,
        [journalEntry.id, e.reasonAccountId, e.amount]
      );
      await client.query(
        `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit)
         VALUES ($1, $2, 0, $3)`,
        [journalEntry.id, e.fromAccountId, e.amount]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      invoice: {
        journalEntryId: journalEntry.id,
        reference: journalEntry.reference,
        description: journalEntry.description,
        entryDate: journalEntry.entry_date,
        userId: empRow.external_id != null ? Number(empRow.external_id) : null,
        employeeName: empRow.full_name,
        totalDebit: totalDebit.toFixed(4),
        totalCredit: totalDebit.toFixed(4),
        lineCount: normalized.length * 2,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

/**
 * GET /api/invoices/journal?userId=
 * Lists payment invoices (journal entries with PAY-INV- reference).
 */
async function listJournalInvoices(req, res, next) {
  try {
    const userId = req.query.userId;
    const pattern = `${PAY_INV_PREFIX}%`;
    const hasUser =
      userId !== undefined && userId !== null && String(userId).trim() !== '';

    const sql = `SELECT
         je.id AS "journalEntryId",
         je.reference,
         je.description,
         je.entry_date AS "entryDate",
         je.created_at AS "createdAt",
         e.external_id AS "userId",
         e.full_name AS "employeeName"
       FROM journal_entries je
       LEFT JOIN employees e ON e.id = je.employee_id
       WHERE je.reference LIKE $1
       ${hasUser ? 'AND e.external_id = $2' : ''}
       ORDER BY je.entry_date DESC, je.created_at DESC`;

    const params = hasUser ? [pattern, Number(userId)] : [pattern];
    const { rows } = await pool.query(sql, params);

    res.json({ invoices: rows });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/invoices/journal/:journalEntryId
 * Single invoice with line detail.
 */
async function getJournalInvoice(req, res, next) {
  try {
    const { journalEntryId } = req.params;
    const { rows: jeRows } = await pool.query(
      `SELECT
         je.id AS "journalEntryId",
         je.reference,
         je.description,
         je.entry_date AS "entryDate",
         je.created_at AS "createdAt",
         e.external_id AS "userId",
         e.full_name AS "employeeName"
       FROM journal_entries je
       LEFT JOIN employees e ON e.id = je.employee_id
       WHERE je.id = $1 AND je.reference LIKE $2`,
      [journalEntryId, `${PAY_INV_PREFIX}%`]
    );
    if (jeRows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }

    const { rows: lines } = await pool.query(
      `SELECT
         jl.id,
         jl.account_id AS "accountId",
         a.name AS "accountName",
         a.type AS "accountType",
         jl.debit,
         jl.credit
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = $1
       ORDER BY jl.debit DESC, jl.credit DESC`,
      [journalEntryId]
    );

    res.json({ invoice: jeRows[0], lines });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/invoices/journal/:journalEntryId
 * Update invoice journal header and line items in one transaction.
 */
async function updateJournalInvoice(req, res, next) {
  const body = req.body || {};
  const { journalEntryId } = req.params;
  const { date, description, entries } = body;

  if (!journalEntryId || typeof journalEntryId !== 'string' || !journalEntryId.trim()) {
    return next(httpError(400, 'journalEntryId is required.'));
  }
  if (!description || typeof description !== 'string' || !description.trim()) {
    return next(httpError(400, 'description is required.'));
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return next(httpError(400, 'entries must be a non-empty array.'));
  }

  const entryDate = normalizeDateInput(
    date === undefined ? new Date() : date,
    'date',
    { allowNull: false }
  );

  let normalized;
  try {
    normalized = entries.map((e, i) => {
      const fromId = e.fromAccountId ?? e.sourceAccountId;
      const reasonId = e.reasonAccountId ?? e.expenseAccountId;
      const amt = e.amount;
      if (!fromId || !reasonId) {
        throw httpError(400, `entries[${i}]: fromAccountId and reasonAccountId are required.`);
      }
      const amount = Number(amt);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw httpError(400, `entries[${i}]: amount must be a positive number.`);
      }
      return { fromAccountId: fromId, reasonAccountId: reasonId, amount };
    });
  } catch (err) {
    return next(err);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existingJe } = await client.query(
      `SELECT id, reference FROM journal_entries
       WHERE id = $1 AND reference LIKE $2`,
      [journalEntryId, `${PAY_INV_PREFIX}%`]
    );
    if (existingJe.length === 0) {
      throw httpError(404, 'Invoice not found.');
    }

    const accountIds = new Set();
    for (const e of normalized) {
      accountIds.add(e.fromAccountId);
      accountIds.add(e.reasonAccountId);
    }
    const { rows: accRows } = await client.query(
      `SELECT id, type FROM accounts WHERE id = ANY($1::uuid[])`,
      [[...accountIds]]
    );
    const typeById = new Map(accRows.map((a) => [a.id, a.type]));
    for (const e of normalized) {
      if (typeById.get(e.fromAccountId) !== 'asset') {
        throw httpError(400, 'From account must be an asset account (e.g. Bank).');
      }
      if (typeById.get(e.reasonAccountId) !== 'expense') {
        throw httpError(400, 'Reason account must be an expense account (e.g. Salary).');
      }
    }

    const { rows: updatedHeaders } = await client.query(
      `UPDATE journal_entries
       SET description = $1, entry_date = $2::date
       WHERE id = $3
       RETURNING id, reference, description, entry_date, employee_id, created_at`,
      [description.trim(), entryDate, journalEntryId]
    );
    const header = updatedHeaders[0];

    await client.query(`DELETE FROM journal_lines WHERE journal_entry_id = $1`, [journalEntryId]);

    let totalDebit = 0;
    for (const e of normalized) {
      totalDebit += e.amount;
      await client.query(
        `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit)
         VALUES ($1, $2, $3, 0)`,
        [journalEntryId, e.reasonAccountId, e.amount]
      );
      await client.query(
        `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit)
         VALUES ($1, $2, 0, $3)`,
        [journalEntryId, e.fromAccountId, e.amount]
      );
    }

    await client.query('COMMIT');

    res.json({
      invoice: {
        journalEntryId: header.id,
        reference: header.reference,
        description: header.description,
        entryDate: header.entry_date,
        totalDebit: totalDebit.toFixed(4),
        totalCredit: totalDebit.toFixed(4),
        lineCount: normalized.length * 2,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

/**
 * PUT /api/invoices/:invoiceId
 * Update invoice header fields such as number, client, dates, or status.
 */
async function updateInvoice(req, res, next) {
  try {
    const invoiceId = req.params.invoiceId;
    if (!invoiceId || typeof invoiceId !== 'string' || invoiceId.trim() === '') {
      throw httpError(400, 'invoiceId is required.');
    }

    const body = req.body || {};
    const { invoiceNumber, clientName, issueDate, dueDate, status } = body;

    const normalizedInvoiceNumber =
      invoiceNumber === undefined
        ? undefined
        : String(invoiceNumber).trim();
    if (normalizedInvoiceNumber !== undefined && normalizedInvoiceNumber === '') {
      throw httpError(400, 'invoiceNumber cannot be blank.');
    }

    const normalizedClientName =
      clientName === undefined ? undefined : String(clientName).trim();
    if (normalizedClientName !== undefined && normalizedClientName === '') {
      throw httpError(400, 'clientName cannot be blank.');
    }

    const parsedIssueDate = normalizeDateInput(issueDate, 'issueDate', {
      allowNull: false,
    });
    const parsedDueDate = normalizeDateInput(dueDate, 'dueDate');

    let normalizedStatus;
    if (status !== undefined) {
      normalizedStatus = String(status).trim().toLowerCase();
      if (normalizedStatus === '' || !INVOICE_STATUSES.has(normalizedStatus)) {
        throw httpError(
          400,
          `status must be one of: ${Array.from(INVOICE_STATUSES).join(', ')}.`
        );
      }
    }

    const { rows: existingRows } = await pool.query(
      'SELECT invoice_number, client_name, issue_date, due_date, status FROM invoices WHERE id = $1',
      [invoiceId]
    );
    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }
    const existing = existingRows[0];

    const finalIssueDate =
      parsedIssueDate !== undefined
        ? parsedIssueDate
        : storedDateToString(existing.issue_date);
    const finalDueDate =
      parsedDueDate !== undefined
        ? parsedDueDate
        : storedDateToString(existing.due_date);

    if (
      finalIssueDate &&
      finalDueDate &&
      finalDueDate < finalIssueDate
    ) {
      throw httpError(400, 'dueDate cannot be before issueDate.');
    }

    const assignments = [];
    const params = [];
    const addAssignment = (column, value) => {
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    };

    if (normalizedInvoiceNumber !== undefined) {
      addAssignment('invoice_number', normalizedInvoiceNumber);
    }
    if (normalizedClientName !== undefined) {
      addAssignment('client_name', normalizedClientName);
    }
    if (parsedIssueDate !== undefined) {
      addAssignment('issue_date', finalIssueDate);
    }
    if (parsedDueDate !== undefined) {
      addAssignment('due_date', finalDueDate);
    }
    if (normalizedStatus !== undefined) {
      addAssignment('status', normalizedStatus);
    }

    if (assignments.length === 0) {
      throw httpError(400, 'Provide at least one field to update.');
    }

    const { rows } = await pool.query(
      `UPDATE invoices
       SET ${assignments.join(', ')}
       WHERE id = $${params.length + 1}
       RETURNING
         id,
         invoice_number AS "invoiceNumber",
         client_name AS "clientName",
         issue_date AS "issueDate",
         due_date AS "dueDate",
         status,
         total_amount AS "totalAmount",
         created_at AS "createdAt"`,
      [...params, invoiceId]
    );

    res.json({ invoice: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return next(httpError(409, 'Another invoice already uses that invoice number.'));
    }
    next(err);
  }
}

module.exports = {
  createJournalInvoice,
  listJournalInvoices,
  getJournalInvoice,
  updateJournalInvoice,
  updateInvoice,
};
