const { pool } = require('../config/db');

/**
 * GET /api/accounts?types=asset,expense
 * Lists chart-of-accounts rows for invoice dropdowns.
 */
async function listAccounts(req, res, next) {
  try {
    const raw = req.query.types || 'asset,expense';
    const types = raw
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    const allowed = new Set(['asset', 'liability', 'equity', 'income', 'expense']);
    const filtered = types.filter((t) => allowed.has(t));
    if (filtered.length === 0) {
      return res.status(400).json({ error: 'Provide at least one valid account type.' });
    }

    const { rows } = await pool.query(
      `SELECT id, name, type, parent_id, created_at
       FROM accounts
       WHERE type = ANY($1::account_type[])
       ORDER BY type, name`,
      [filtered]
    );

    res.json({ accounts: rows });
  } catch (err) {
    next(err);
  }
}

module.exports = { listAccounts };
