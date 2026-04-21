const { pool } = require('../config/db');
const { userIdQuerySchema, accountIdQuerySchema } = require('../utils/validators');

function parseUserId(query) {
  const parsed = userIdQuerySchema.parse(query);
  return parsed.userId;
}

function parseAccountId(query) {
  const parsed = accountIdQuerySchema.parse(query);
  return parsed.accountId;
}

/**
 * GET /api/balances/transactions?userId=
 * Line-level activity for journals tied to that user (employee.external_id).
 */
async function getUserTransactions(req, res, next) {
  try {
    const userId = parseUserId(req.query);

    const { rows } = await pool.query(
      `SELECT
         jl.id AS "lineId",
         je.id AS "journalEntryId",
         je.reference,
         je.description AS "journalDescription",
         je.entry_date AS "entryDate",
         je.created_at AS "journalCreatedAt",
         jl.account_id AS "accountId",
         a.name AS "accountName",
         a.type AS "accountType",
         jl.debit,
         jl.credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journal_entry_id
       JOIN employees emp ON emp.id = je.employee_id
       JOIN accounts a ON a.id = jl.account_id
       WHERE emp.external_id = $1
       ORDER BY je.entry_date DESC, je.created_at DESC, jl.id`,
      [userId]
    );

    res.apiSuccess('User transactions retrieved successfully.', { transactions: rows });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/balances/account-transactions?accountId=
 * Line-level activity for a selected account (e.g. HBL bank account).
 */
async function getAccountTransactions(req, res, next) {
  try {
    const accountId = parseAccountId(req.query);

    const { rows } = await pool.query(
      `SELECT
         jl.id AS "lineId",
         je.id AS "journalEntryId",
         je.reference,
         je.description AS "journalDescription",
         je.entry_date AS "entryDate",
         je.created_at AS "journalCreatedAt",
         jl.account_id AS "accountId",
         a.name AS "accountName",
         a.type AS "accountType",
         jl.debit,
         jl.credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journal_entry_id
       JOIN accounts a ON a.id = jl.account_id
       WHERE jl.account_id = $1
       ORDER BY je.entry_date DESC, je.created_at DESC, jl.id`,
      [accountId]
    );

    res.apiSuccess('Account transactions retrieved successfully.', {
      accountId,
      transactions: rows,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/balances/accounts?userId=
 * Per-account balances from that user's journal activity only.
 */
async function getUserAccountBalances(req, res, next) {
  try {
    const userId = parseUserId(req.query);

    const { rows } = await pool.query(
      `SELECT
         a.id AS "accountId",
         a.name AS "accountName",
         a.type AS "accountType",
         COALESCE(SUM(jl.debit), 0) AS "totalDebit",
         COALESCE(SUM(jl.credit), 0) AS "totalCredit",
         CASE a.type
           WHEN 'asset' THEN COALESCE(SUM(jl.debit - jl.credit), 0)
           WHEN 'expense' THEN COALESCE(SUM(jl.debit - jl.credit), 0)
           WHEN 'liability' THEN COALESCE(SUM(jl.credit - jl.debit), 0)
           WHEN 'equity' THEN COALESCE(SUM(jl.credit - jl.debit), 0)
           WHEN 'income' THEN COALESCE(SUM(jl.credit - jl.debit), 0)
         END AS balance
       FROM accounts a
       JOIN journal_lines jl ON jl.account_id = a.id
       JOIN journal_entries je ON je.id = jl.journal_entry_id
       JOIN employees emp ON emp.id = je.employee_id
       WHERE emp.external_id = $1
       GROUP BY a.id, a.name, a.type
       HAVING COALESCE(SUM(jl.debit), 0) <> 0 OR COALESCE(SUM(jl.credit), 0) <> 0
       ORDER BY a.type, a.name`,
      [userId]
    );

    const byType = {};
    for (const r of rows) {
      const t = r.accountType;
      if (!byType[t]) byType[t] = [];
      byType[t].push(r);
    }

    res.apiSuccess('User account balances retrieved successfully.', {
      userId,
      accounts: rows,
      byType,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/balances/summary-by-type?userId=
 * Rolled-up totals per account_type for the Assets Balances dashboard.
 */
async function getUserSummaryByType(req, res, next) {
  try {
    const userId = parseUserId(req.query);

    const { rows } = await pool.query(
      `SELECT
         a.type AS "accountType",
         CASE a.type
           WHEN 'asset' THEN COALESCE(SUM(jl.debit - jl.credit), 0)
           WHEN 'expense' THEN COALESCE(SUM(jl.debit - jl.credit), 0)
           WHEN 'liability' THEN COALESCE(SUM(jl.credit - jl.debit), 0)
           WHEN 'equity' THEN COALESCE(SUM(jl.credit - jl.debit), 0)
           WHEN 'income' THEN COALESCE(SUM(jl.credit - jl.debit), 0)
         END AS balance
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       JOIN journal_entries je ON je.id = jl.journal_entry_id
       JOIN employees emp ON emp.id = je.employee_id
       WHERE emp.external_id = $1
       GROUP BY a.type
       ORDER BY a.type`,
      [userId]
    );

    const totalsByType = {
      asset: '0.0000',
      liability: '0.0000',
      equity: '0.0000',
      income: '0.0000',
      expense: '0.0000',
    };
    for (const r of rows) {
      totalsByType[r.accountType] = Number(r.balance).toFixed(4);
    }

    res.apiSuccess('User summary by account type retrieved successfully.', {
      userId,
      totalsByType,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/balances/organization/accounts
 * Per-account balances from all posted journals (whole organization).
 */
async function getOrgAccountBalances(_req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT
         a.id AS "accountId",
         a.name AS "accountName",
         a.type AS "accountType",
         COALESCE(SUM(jl.debit), 0) AS "totalDebit",
         COALESCE(SUM(jl.credit), 0) AS "totalCredit",
         CASE a.type
           WHEN 'asset' THEN COALESCE(SUM(jl.debit - jl.credit), 0)
           WHEN 'expense' THEN COALESCE(SUM(jl.debit - jl.credit), 0)
           WHEN 'liability' THEN COALESCE(SUM(jl.credit - jl.debit), 0)
           WHEN 'equity' THEN COALESCE(SUM(jl.credit - jl.debit), 0)
           WHEN 'income' THEN COALESCE(SUM(jl.credit - jl.debit), 0)
         END AS balance
       FROM accounts a
       JOIN journal_lines jl ON jl.account_id = a.id
       GROUP BY a.id, a.name, a.type
       HAVING COALESCE(SUM(jl.debit), 0) <> 0 OR COALESCE(SUM(jl.credit), 0) <> 0
       ORDER BY a.type, a.name`
    );

    const byType = {};
    for (const r of rows) {
      const t = r.accountType;
      if (!byType[t]) byType[t] = [];
      byType[t].push(r);
    }

    res.apiSuccess('Organization account balances retrieved successfully.', {
      accounts: rows,
      byType,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/balances/organization/summary-by-type
 * Rolled-up totals per account_type for the whole organization.
 */
async function getOrgSummaryByType(_req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT
         a.type AS "accountType",
         CASE a.type
           WHEN 'asset' THEN COALESCE(SUM(jl.debit - jl.credit), 0)
           WHEN 'expense' THEN COALESCE(SUM(jl.debit - jl.credit), 0)
           WHEN 'liability' THEN COALESCE(SUM(jl.credit - jl.debit), 0)
           WHEN 'equity' THEN COALESCE(SUM(jl.credit - jl.debit), 0)
           WHEN 'income' THEN COALESCE(SUM(jl.credit - jl.debit), 0)
         END AS balance
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       GROUP BY a.type
       ORDER BY a.type`
    );

    const totalsByType = {
      asset: '0.0000',
      liability: '0.0000',
      equity: '0.0000',
      income: '0.0000',
      expense: '0.0000',
    };
    for (const r of rows) {
      totalsByType[r.accountType] = Number(r.balance).toFixed(4);
    }

    res.apiSuccess('Organization summary by account type retrieved successfully.', {
      totalsByType,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/balances/reports/trial-balance
 * Every account with its total debits, total credits, and running balance.
 * Covers ALL journal activity (expenses, receipts, adjustments).
 */
async function getTrialBalance(_req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT
         account_id   AS "accountId",
         account_name AS "accountName",
         account_type AS "accountType",
         total_debit  AS "totalDebit",
         total_credit AS "totalCredit",
         balance
       FROM trial_balance
       WHERE total_debit <> 0 OR total_credit <> 0
       ORDER BY account_type, account_name`
    );

    const byType = {};
    for (const r of rows) {
      if (!byType[r.accountType]) byType[r.accountType] = [];
      byType[r.accountType].push(r);
    }

    res.apiSuccess('Trial balance report retrieved successfully.', {
      trialBalance: rows,
      byType,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/balances/reports/profit-loss
 * Income Statement: total income, total expenses, net income (profit/loss).
 */
async function getProfitLoss(_req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT total_income AS "totalIncome",
              total_expense AS "totalExpense",
              net_income AS "netIncome"
       FROM profit_loss`
    );

    // Also return a breakdown by account for detail
    const { rows: detail } = await pool.query(
      `SELECT
         a.id   AS "accountId",
         a.name AS "accountName",
         a.type AS "accountType",
         CASE a.type
           WHEN 'income'  THEN COALESCE(SUM(jl.credit - jl.debit), 0)
           WHEN 'expense' THEN COALESCE(SUM(jl.debit - jl.credit), 0)
         END AS balance
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       WHERE a.type IN ('income', 'expense')
       GROUP BY a.id, a.name, a.type
       ORDER BY a.type, a.name`
    );

    const income  = detail.filter((r) => r.accountType === 'income');
    const expense = detail.filter((r) => r.accountType === 'expense');

    res.apiSuccess('Profit and loss report retrieved successfully.', {
      summary: rows[0] || { totalIncome: '0', totalExpense: '0', netIncome: '0' },
      income,
      expense,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/balances/reports/balance-sheet
 * Balance Sheet: Assets = Liabilities + Equity.
 * balancingDifference should be 0 for a correctly maintained set of books.
 */
async function getBalanceSheet(_req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT total_assets       AS "totalAssets",
              total_liabilities  AS "totalLiabilities",
              total_equity       AS "totalEquity",
              balancing_difference AS "balancingDifference"
       FROM balance_sheet`
    );

    // Per-account detail for each section
    const { rows: detail } = await pool.query(
      `SELECT
         a.id   AS "accountId",
         a.name AS "accountName",
         a.type AS "accountType",
         CASE a.type
           WHEN 'asset'     THEN COALESCE(SUM(jl.debit - jl.credit), 0)
           WHEN 'liability' THEN COALESCE(SUM(jl.credit - jl.debit), 0)
           WHEN 'equity'    THEN COALESCE(SUM(jl.credit - jl.debit), 0)
         END AS balance
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       WHERE a.type IN ('asset', 'liability', 'equity')
       GROUP BY a.id, a.name, a.type
       ORDER BY a.type, a.name`
    );

    const assets      = detail.filter((r) => r.accountType === 'asset');
    const liabilities = detail.filter((r) => r.accountType === 'liability');
    const equity      = detail.filter((r) => r.accountType === 'equity');

    res.apiSuccess('Balance sheet report retrieved successfully.', {
      summary: rows[0] || {
        totalAssets: '0',
        totalLiabilities: '0',
        totalEquity: '0',
        balancingDifference: '0',
      },
      assets,
      liabilities,
      equity,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getUserTransactions,
  getAccountTransactions,
  getUserAccountBalances,
  getUserSummaryByType,
  getOrgAccountBalances,
  getOrgSummaryByType,
  getTrialBalance,
  getProfitLoss,
  getBalanceSheet,
};
