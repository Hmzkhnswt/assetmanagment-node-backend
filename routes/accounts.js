const express = require('express');
const {
  listAccounts,
  listAssetAccounts,
  listIncomeAccounts,
  listExpenseAccounts,
  listLiabilityAccounts,
  listEquityAccounts,
} = require('../controllers/accountController');

const router = express.Router();

// Dedicated type endpoints — call these directly from the frontend
router.get('/asset',     listAssetAccounts);
router.get('/income',    listIncomeAccounts);
router.get('/expense',   listExpenseAccounts);
router.get('/liability', listLiabilityAccounts);
router.get('/equity',    listEquityAccounts);

// Generic multi-type endpoint (backward compatible)
router.get('/', listAccounts);

module.exports = router;
