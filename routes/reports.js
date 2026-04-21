const express = require('express');
const {
  getUserTransactions,
  getAccountTransactions,
  getUserAccountBalances,
  getUserSummaryByType,
  getOrgAccountBalances,
  getOrgSummaryByType,
  getTrialBalance,
  getProfitLoss,
  getBalanceSheet,
} = require('../controllers/journalController');

const router = express.Router();

// Financial statement reports (whole organisation, all journal activity)
router.get('/reports/trial-balance', getTrialBalance);
router.get('/reports/profit-loss', getProfitLoss);
router.get('/reports/balance-sheet', getBalanceSheet);

// Organisation-wide account balances
router.get('/organization/accounts', getOrgAccountBalances);
router.get('/organization/summary-by-type', getOrgSummaryByType);

// Per-user (employee) views
router.get('/transactions', getUserTransactions);
router.get('/account-transactions', getAccountTransactions);
router.get('/accounts', getUserAccountBalances);
router.get('/summary-by-type', getUserSummaryByType);

module.exports = router;
