const { pool } = require('../config/db');


async function listEmployees(_req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name AS "fullName", salary, external_id AS "userId", created_at
       FROM employees
       ORDER BY external_id NULLS LAST, full_name`
    );
    res.json({ employees: rows });
  } catch (err) {
    next(err);
  }
}

module.exports = { listEmployees };
