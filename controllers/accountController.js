const { pool } = require('../config/db');
const { z, accountTypeSchema } = require('../utils/validators');

const VALID_TYPES = new Set(accountTypeSchema.options);

/**
 * Shared query — returns accounts filtered to the given type(s).
 */
async function fetchAccounts(types) {
  const { rows } = await pool.query(
    `SELECT id, name, type, parent_id, created_at
     FROM accounts
     WHERE type = ANY($1::account_type[])
     ORDER BY name`,
    [types]
  );
  return rows;
}

/**
 * GET /api/accounts?types=asset,expense
 * Generic multi-type fetch (kept for backward compatibility).
 */
async function listAccounts(req, res, next) {
  try {
    const schema = z.object({
      types: z.string().default('asset,expense'),
    });
    const parsed = schema.parse(req.query);

    const filtered = parsed.types
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => VALID_TYPES.has(t));

    if (filtered.length === 0) {
      return res.status(400).json({ error: 'Provide at least one valid account type.' });
    }

    const accounts = await fetchAccounts(filtered);
    res.apiSuccess('Accounts retrieved successfully.', { accounts });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/accounts/asset
 * Asset accounts — used as the Payment Method / "from" dropdown
 * in both receipts and expense payments (Bank, Cash, Accounts Receivable, etc.).
 */
async function listAssetAccounts(req, res, next) {
  try {
    const accounts = await fetchAccounts(['asset']);
    res.apiSuccess('Asset accounts retrieved successfully.', { type: 'asset', accounts });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/accounts/income
 * Income accounts — used as the "reason" dropdown in the receipt form
 * (Service Revenue, Product Sales, Consulting Fee, etc.).
 */
async function listIncomeAccounts(req, res, next) {
  try {
    const accounts = await fetchAccounts(['income']);
    res.apiSuccess('Income accounts retrieved successfully.', { type: 'income', accounts });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/accounts/expense
 * Expense accounts — used as the "reason" dropdown in the expense payment form
 * (Salary Expense, Medical Expense, Rent, Utilities, etc.).
 */
async function listExpenseAccounts(req, res, next) {
  try {
    const accounts = await fetchAccounts(['expense']);
    res.apiSuccess('Expense accounts retrieved successfully.', { type: 'expense', accounts });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/accounts/liability
 * Liability accounts — used for loans received, tax payable, etc.
 */
async function listLiabilityAccounts(req, res, next) {
  try {
    const accounts = await fetchAccounts(['liability']);
    res.apiSuccess('Liability accounts retrieved successfully.', { type: 'liability', accounts });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/accounts/equity
 * Equity accounts — used for owner capital, retained earnings, etc.
 */
async function listEquityAccounts(req, res, next) {
  try {
    const accounts = await fetchAccounts(['equity']);
    res.apiSuccess('Equity accounts retrieved successfully.', { type: 'equity', accounts });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listAccounts,
  listAssetAccounts,
  listIncomeAccounts,
  listExpenseAccounts,
  listLiabilityAccounts,
  listEquityAccounts,
};
