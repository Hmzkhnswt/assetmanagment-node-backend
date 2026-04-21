const express = require('express');
const {
  createReceipt,
  listReceipts,
  getReceipt,
  updateReceipt,
  getReceiptSummary,
} = require('../controllers/receiptController');

const router = express.Router();

router.get('/summary', getReceiptSummary);
router.post('/', createReceipt);
router.get('/', listReceipts);
router.get('/:receiptId', getReceipt);
router.put('/:receiptId', updateReceipt);

module.exports = router;
