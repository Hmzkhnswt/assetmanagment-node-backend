const crypto = require('crypto');
const { pool } = require('../config/db');
const { z } = require('../utils/validators');

const RCPT_PREFIX = 'RCPT-';
const RECEIPT_STATUSES = new Set(['draft', 'issued', 'void']);

const idSchema = z.string().uuid();
const optionalDateSchema = z.union([z.string().trim().min(1), z.date()]).optional();
const requiredDateSchema = z.union([z.string().trim().min(1), z.date()]);
const receiptItemSchema = z
  .object({
    fromAccountId: idSchema.optional(),
    assetAccountId: idSchema.optional(),
    reasonAccountId: idSchema.optional(),
    incomeAccountId: idSchema.optional(),
    amount: z.coerce.number().positive(),
    itemDescription: z.string().trim().optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.fromAccountId && !val.assetAccountId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'fromAccountId or assetAccountId is required.',
        path: ['fromAccountId'],
      });
    }
    if (!val.reasonAccountId && !val.incomeAccountId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'reasonAccountId or incomeAccountId is required.',
        path: ['reasonAccountId'],
      });
    }
  });

const createReceiptBodySchema = z.object({
  customerName: z.string().trim().min(1),
  description: z.string().trim().min(1),
  date: optionalDateSchema,
  items: z.array(receiptItemSchema).min(1),
});

const listReceiptsQuerySchema = z.object({
  customerName: z.string().trim().optional(),
  status: z.enum(['draft', 'issued', 'void']).optional(),
  from: optionalDateSchema,
  to: optionalDateSchema,
});

const receiptIdParamSchema = z.object({
  receiptId: idSchema,
});

const updateReceiptBodySchema = z
  .object({
    customerName: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    date: requiredDateSchema.optional(),
    status: z.enum(['draft', 'issued', 'void']).optional(),
    items: z.array(receiptItemSchema).min(1).optional(),
  })
  .refine(
    (val) =>
      val.customerName !== undefined ||
      val.description !== undefined ||
      val.date !== undefined ||
      val.status !== undefined ||
      val.items !== undefined,
    { message: 'Provide at least one field to update.' }
  );

const receiptSummaryQuerySchema = z.object({
  from: optionalDateSchema,
  to: optionalDateSchema,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.expose = true;
  return e;
}

function normalizeDateInput(value, fieldName, { allowNull = true } = {}) {
  if (value === undefined) return undefined;
  if (value === null) {
    if (allowNull) return null;
    throw httpError(400, `${fieldName} cannot be null.`);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()))
      throw httpError(400, `${fieldName} must be a valid date (YYYY-MM-DD).`);
    return value.toISOString().slice(0, 10);
  }
  const trimmed = String(value).trim();
  if (trimmed === '') {
    if (allowNull) return null;
    throw httpError(400, `${fieldName} cannot be blank.`);
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime()))
    throw httpError(400, `${fieldName} must be a valid date (YYYY-MM-DD).`);
  return parsed.toISOString().slice(0, 10);
}

function storedDateToString(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

// ---------------------------------------------------------------------------
// POST /api/receipts
// ---------------------------------------------------------------------------
/**
 * Create a sales receipt.
 *
 * Finance rule (mirror of expense payment):
 *   Dr fromAccountId  (asset  — where money lands, e.g. Cash / Bank / AR)
 *   Cr reasonAccountId (income — what was sold, e.g. Service Revenue)
 *
 * Body:
 *   customerName   string   required
 *   description    string   required   (overall purpose / what was sold)
 *   date           string   optional   YYYY-MM-DD (defaults to today)
 *   items          array    required
 *     items[i].fromAccountId   UUID  asset  account
 *     items[i].reasonAccountId UUID  income account
 *     items[i].amount          number > 0
 *     items[i].itemDescription string optional  (per-line note)
 */
async function createReceipt(req, res, next) {
  const body = createReceiptBodySchema.parse(req.body || {});
  const { customerName, description, date, items } = body;

  const receiptDate = date || new Date().toISOString().slice(0, 10);

  let normalizedItems;
  try {
    normalizedItems = items.map((item, i) => {
      const fromId = item.fromAccountId ?? item.assetAccountId;
      const reasonId = item.reasonAccountId ?? item.incomeAccountId;
      const amount = Number(item.amount);
      if (!fromId || !reasonId)
        throw httpError(400, `items[${i}]: fromAccountId and reasonAccountId are required.`);
      if (!Number.isFinite(amount) || amount <= 0)
        throw httpError(400, `items[${i}]: amount must be a positive number.`);
      const itemDesc =
        item.itemDescription != null ? String(item.itemDescription).trim() : '';
      return { fromAccountId: fromId, reasonAccountId: reasonId, amount, itemDesc };
    });
  } catch (err) {
    return next(err);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Validate account types: from=asset, reason=income
    const accountIds = new Set();
    for (const it of normalizedItems) {
      accountIds.add(it.fromAccountId);
      accountIds.add(it.reasonAccountId);
    }
    const { rows: accRows } = await client.query(
      `SELECT id, type FROM accounts WHERE id = ANY($1::uuid[])`,
      [[...accountIds]]
    );
    const typeById = new Map(accRows.map((a) => [a.id, a.type]));
    for (let i = 0; i < normalizedItems.length; i++) {
      const it = normalizedItems[i];
      if (typeById.get(it.fromAccountId) !== 'asset')
        throw httpError(
          400,
          `items[${i}]: fromAccountId must be an asset account (e.g. Cash, Bank, Accounts Receivable).`
        );
      if (typeById.get(it.reasonAccountId) !== 'income')
        throw httpError(
          400,
          `items[${i}]: reasonAccountId must be an income account (e.g. Service Revenue, Product Sales).`
        );
    }

    // Build journal entry reference
    const journalReference = `${RCPT_PREFIX}${crypto.randomUUID()}`;

    const { rows: jeRows } = await client.query(
      `INSERT INTO journal_entries (reference, description, entry_date)
       VALUES ($1, $2, $3::date)
       RETURNING id, reference, description, entry_date, created_at`,
      [journalReference, description.trim(), receiptDate]
    );
    const journalEntry = jeRows[0];

    let totalAmount = 0;
    for (const it of normalizedItems) {
      totalAmount += it.amount;
      // Dr asset (from) — cash/bank/AR goes up
      await client.query(
        `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit)
         VALUES ($1, $2, $3, 0)`,
        [journalEntry.id, it.fromAccountId, it.amount]
      );
      // Cr income (reason) — revenue recognised
      await client.query(
        `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit)
         VALUES ($1, $2, 0, $3)`,
        [journalEntry.id, it.reasonAccountId, it.amount]
      );
    }

    // Build a human-readable receipt number: RCPT-YYYYMMDD-<8 hex chars>
    const datePart = receiptDate.replace(/-/g, '');
    const receiptNumber = `RCPT-${datePart}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    const { rows: rcptRows } = await client.query(
      `INSERT INTO receipts
         (receipt_number, customer_name, receipt_date, description, journal_entry_id, total_amount, status)
       VALUES ($1, $2, $3::date, $4, $5, $6, 'issued')
       RETURNING id, receipt_number, customer_name, receipt_date, description,
                 journal_entry_id, total_amount, status, created_at`,
      [
        receiptNumber,
        customerName.trim(),
        receiptDate,
        description.trim(),
        journalEntry.id,
        totalAmount.toFixed(4),
      ]
    );
    const receipt = rcptRows[0];

    await client.query('COMMIT');

    res.apiSuccess('Receipt created successfully.', {
      receipt: {
        receiptId: receipt.id,
        receiptNumber: receipt.receipt_number,
        customerName: receipt.customer_name,
        receiptDate: storedDateToString(receipt.receipt_date),
        description: receipt.description,
        totalAmount: receipt.total_amount,
        status: receipt.status,
        journalEntryId: receipt.journal_entry_id,
        journalReference,
        createdAt: receipt.created_at,
        lineCount: normalizedItems.length * 2,
      },
    }, 201);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// GET /api/receipts
// ---------------------------------------------------------------------------
/**
 * List receipts. Optional filters:
 *   ?customerName=  (partial, case-insensitive)
 *   ?status=issued|draft|void
 *   ?from=YYYY-MM-DD
 *   ?to=YYYY-MM-DD
 */
async function listReceipts(req, res, next) {
  try {
    const { customerName, status, from, to } = listReceiptsQuerySchema.parse(req.query);

    const conditions = [];
    const params = [];

    if (customerName && String(customerName).trim()) {
      params.push(`%${String(customerName).trim()}%`);
      conditions.push(`r.customer_name ILIKE $${params.length}`);
    }
    if (status && String(status).trim()) {
      const s = String(status).trim().toLowerCase();
      params.push(s);
      conditions.push(`r.status = $${params.length}`);
    }
    if (from && String(from).trim()) {
      params.push(String(from).trim());
      conditions.push(`r.receipt_date >= $${params.length}::date`);
    }
    if (to && String(to).trim()) {
      params.push(String(to).trim());
      conditions.push(`r.receipt_date <= $${params.length}::date`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT
         r.id AS "receiptId",
         r.receipt_number AS "receiptNumber",
         r.customer_name AS "customerName",
         r.receipt_date AS "receiptDate",
         r.description,
         r.total_amount AS "totalAmount",
         r.status,
         r.journal_entry_id AS "journalEntryId",
         je.reference AS "journalReference",
         r.created_at AS "createdAt"
       FROM receipts r
       JOIN journal_entries je ON je.id = r.journal_entry_id
       ${where}
       ORDER BY r.receipt_date DESC, r.created_at DESC`,
      params
    );

    res.apiSuccess('Receipts retrieved successfully.', { receipts: rows });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/receipts/:receiptId
// ---------------------------------------------------------------------------
/**
 * Single receipt with full journal line detail.
 */
async function getReceipt(req, res, next) {
  try {
    const { receiptId } = receiptIdParamSchema.parse(req.params);

    const { rows: rcptRows } = await pool.query(
      `SELECT
         r.id AS "receiptId",
         r.receipt_number AS "receiptNumber",
         r.customer_name AS "customerName",
         r.receipt_date AS "receiptDate",
         r.description,
         r.total_amount AS "totalAmount",
         r.status,
         r.journal_entry_id AS "journalEntryId",
         je.reference AS "journalReference",
         r.created_at AS "createdAt"
       FROM receipts r
       JOIN journal_entries je ON je.id = r.journal_entry_id
       WHERE r.id = $1`,
      [receiptId]
    );
    if (rcptRows.length === 0)
      return res.status(404).json({ error: 'Receipt not found.' });

    const receipt = rcptRows[0];

    const { rows: lines } = await pool.query(
      `SELECT
         jl.id AS "lineId",
         jl.account_id AS "accountId",
         a.name AS "accountName",
         a.type AS "accountType",
         jl.debit,
         jl.credit
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = $1
       ORDER BY jl.debit DESC, jl.credit DESC, jl.id`,
      [receipt.journalEntryId]
    );

    res.apiSuccess('Receipt retrieved successfully.', { receipt, lines });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// PUT /api/receipts/:receiptId
// ---------------------------------------------------------------------------
/**
 * Update a receipt's header fields (customerName, description, date, status).
 * If items are provided the old journal lines are replaced (full replace).
 * Voided receipts cannot be edited.
 *
 * Body (all optional except at least one must be present):
 *   customerName   string
 *   description    string
 *   date           YYYY-MM-DD
 *   status         draft | issued | void
 *   items          array  (same shape as createReceipt — triggers journal re-write)
 */
async function updateReceipt(req, res, next) {
  const { receiptId } = receiptIdParamSchema.parse(req.params);
  const body = updateReceiptBodySchema.parse(req.body || {});
  const { customerName, description, date, status, items } = body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      `SELECT r.*, je.reference AS journal_reference
       FROM receipts r
       JOIN journal_entries je ON je.id = r.journal_entry_id
       WHERE r.id = $1`,
      [receiptId]
    );
    if (existing.length === 0) throw httpError(404, 'Receipt not found.');

    const current = existing[0];
    if (current.status === 'void')
      throw httpError(400, 'A voided receipt cannot be modified.');

    // Validate new status if provided
    const normalizedStatus =
      status !== undefined ? String(status).trim().toLowerCase() : undefined;

    // Update header fields
    const newCustomerName = customerName !== undefined ? String(customerName).trim() : null;
    const newDescription = description !== undefined ? String(description).trim() : null;

    const newDate = normalizeDateInput(date, 'date', { allowNull: false });

    const assigns = [];
    const params = [];
    const add = (col, val) => { params.push(val); assigns.push(`${col} = $${params.length}`); };

    if (newCustomerName !== null) add('customer_name', newCustomerName);
    if (newDescription !== null) add('description', newDescription);
    if (newDate !== undefined) add('receipt_date', newDate);
    if (normalizedStatus !== undefined) add('status', normalizedStatus);

    // Re-build journal lines if items provided
    let totalAmount = Number(current.total_amount);
    if (Array.isArray(items) && items.length > 0) {
      let normalizedItems;
      try {
        normalizedItems = items.map((item, i) => {
          const fromId = item.fromAccountId ?? item.assetAccountId;
          const reasonId = item.reasonAccountId ?? item.incomeAccountId;
          const amount = Number(item.amount);
          if (!fromId || !reasonId)
            throw httpError(400, `items[${i}]: fromAccountId and reasonAccountId are required.`);
          if (!Number.isFinite(amount) || amount <= 0)
            throw httpError(400, `items[${i}]: amount must be a positive number.`);
          return { fromAccountId: fromId, reasonAccountId: reasonId, amount };
        });
      } catch (err) {
        throw err;
      }

      const accountIds = new Set();
      for (const it of normalizedItems) {
        accountIds.add(it.fromAccountId);
        accountIds.add(it.reasonAccountId);
      }
      const { rows: accRows } = await client.query(
        `SELECT id, type FROM accounts WHERE id = ANY($1::uuid[])`,
        [[...accountIds]]
      );
      const typeById = new Map(accRows.map((a) => [a.id, a.type]));
      for (let i = 0; i < normalizedItems.length; i++) {
        const it = normalizedItems[i];
        if (typeById.get(it.fromAccountId) !== 'asset')
          throw httpError(
            400,
            `items[${i}]: fromAccountId must be an asset account (e.g. Cash, Bank, AR).`
          );
        if (typeById.get(it.reasonAccountId) !== 'income')
          throw httpError(
            400,
            `items[${i}]: reasonAccountId must be an income account (e.g. Service Revenue).`
          );
      }

      // Replace journal lines
      await client.query(
        `DELETE FROM journal_lines WHERE journal_entry_id = $1`,
        [current.journal_entry_id]
      );

      totalAmount = 0;
      for (const it of normalizedItems) {
        totalAmount += it.amount;
        await client.query(
          `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit)
           VALUES ($1, $2, $3, 0)`,
          [current.journal_entry_id, it.fromAccountId, it.amount]
        );
        await client.query(
          `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit)
           VALUES ($1, $2, 0, $3)`,
          [current.journal_entry_id, it.reasonAccountId, it.amount]
        );
      }
      add('total_amount', totalAmount.toFixed(4));

      // Keep journal_entries description in sync
      const descForJe = newDescription || current.description;
      const dateForJe = newDate || storedDateToString(current.receipt_date);
      await client.query(
        `UPDATE journal_entries SET description = $1, entry_date = $2::date WHERE id = $3`,
        [descForJe, dateForJe, current.journal_entry_id]
      );
    }

    params.push(receiptId);
    const { rows: updated } = await client.query(
      `UPDATE receipts SET ${assigns.join(', ')}
       WHERE id = $${params.length}
       RETURNING id, receipt_number, customer_name, receipt_date, description,
                 journal_entry_id, total_amount, status, created_at`,
      params
    );
    const receipt = updated[0];

    await client.query('COMMIT');

    res.apiSuccess('Receipt updated successfully.', {
      receipt: {
        receiptId: receipt.id,
        receiptNumber: receipt.receipt_number,
        customerName: receipt.customer_name,
        receiptDate: storedDateToString(receipt.receipt_date),
        description: receipt.description,
        totalAmount: receipt.total_amount,
        status: receipt.status,
        journalEntryId: receipt.journal_entry_id,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505')
      return next(httpError(409, 'Another receipt already uses that receipt number.'));
    next(err);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// GET /api/receipts/summary
// ---------------------------------------------------------------------------
/**
 * Aggregated receipt totals grouped by income account.
 * Useful as a quick sales report.
 */
async function getReceiptSummary(req, res, next) {
  try {
    const { from, to } = receiptSummaryQuerySchema.parse(req.query);

    const conditions = [`je.reference LIKE '${RCPT_PREFIX}%'`];
    const params = [];

    if (from && String(from).trim()) {
      params.push(String(from).trim());
      conditions.push(`r.receipt_date >= $${params.length}::date`);
    }
    if (to && String(to).trim()) {
      params.push(String(to).trim());
      conditions.push(`r.receipt_date <= $${params.length}::date`);
    }

    const where = conditions.join(' AND ');

    const { rows: byAccount } = await pool.query(
      `SELECT
         a.id AS "accountId",
         a.name AS "accountName",
         a.type AS "accountType",
         COUNT(DISTINCT r.id) AS "receiptCount",
         COALESCE(SUM(jl.credit), 0) AS "totalIncome"
       FROM receipts r
       JOIN journal_entries je ON je.id = r.journal_entry_id
       JOIN journal_lines jl ON jl.journal_entry_id = je.id
       JOIN accounts a ON a.id = jl.account_id
       WHERE ${where}
         AND a.type = 'income'
         AND r.status != 'void'
       GROUP BY a.id, a.name, a.type
       ORDER BY "totalIncome" DESC`,
      params
    );

    const totalsConditions = [`r.status != 'void'`];
    const totalsParams = [];
    if (from && String(from).trim()) {
      totalsParams.push(String(from).trim());
      totalsConditions.push(`r.receipt_date >= $${totalsParams.length}::date`);
    }
    if (to && String(to).trim()) {
      totalsParams.push(String(to).trim());
      totalsConditions.push(`r.receipt_date <= $${totalsParams.length}::date`);
    }

    const { rows: totals } = await pool.query(
      `SELECT
         COUNT(DISTINCT r.id) AS "totalReceipts",
         COALESCE(SUM(r.total_amount), 0) AS "grandTotal"
       FROM receipts r
       WHERE ${totalsConditions.join(' AND ')}`,
      totalsParams
    );

    res.apiSuccess('Receipt summary retrieved successfully.', {
      summary: {
        totalReceipts: Number(totals[0].totalReceipts),
        grandTotal: totals[0].grandTotal,
        byIncomeAccount: byAccount,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createReceipt,
  listReceipts,
  getReceipt,
  updateReceipt,
  getReceiptSummary,
};
