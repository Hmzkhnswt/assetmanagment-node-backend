const express = require('express');
const {
  getUserTransactions,
  getUserAccountBalances,
  getUserSummaryByType,
  getOrgAccountBalances,
  getOrgSummaryByType,
} = require('../controllers/reportController');

const router = express.Router();

router.get('/organization/accounts', getOrgAccountBalances);
router.get('/organization/summary-by-type', getOrgSummaryByType);

router.get('/transactions', getUserTransactions);
router.get('/accounts', getUserAccountBalances);
router.get('/summary-by-type', getUserSummaryByType);

module.exports = router;
