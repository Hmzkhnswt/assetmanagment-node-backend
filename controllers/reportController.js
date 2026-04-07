const { pool } = require('../config/db');

/**
 * GET /api/balances/transactions?userId=
 * Line-level activity for journals tied to that user (employee.external_id).
 */
async function getUserTransactions(req, res, next) {
  try {
    const userId = req.query.userId;
    if (userId === undefined || userId === '') {
      return res.status(400).json({ error: 'userId query parameter is required.' });
    }

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
      [Number(userId)]
    );

    res.json({ transactions: rows });
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
    const userId = req.query.userId;
    if (userId === undefined || userId === '') {
      return res.status(400).json({ error: 'userId query parameter is required.' });
    }

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
      [Number(userId)]
    );

    const byType = {};
    for (const r of rows) {
      const t = r.accountType;
      if (!byType[t]) byType[t] = [];
      byType[t].push(r);
    }

    res.json({
      userId: Number(userId),
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
    const userId = req.query.userId;
    if (userId === undefined || userId === '') {
      return res.status(400).json({ error: 'userId query parameter is required.' });
    }

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
      [Number(userId)]
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

    res.json({ userId: Number(userId), totalsByType });
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

    res.json({ accounts: rows, byType });
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

    res.json({ totalsByType });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getUserTransactions,
  getUserAccountBalances,
  getUserSummaryByType,
  getOrgAccountBalances,
  getOrgSummaryByType,
};
