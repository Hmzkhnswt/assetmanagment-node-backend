const express = require('express');
const {
  createJournalInvoice,
  listJournalInvoices,
  getJournalInvoice,
  updateJournalInvoice,
  updateInvoice,
} = require('../controllers/journalentriesController');

const router = express.Router();

router.post('/journal', createJournalInvoice);
router.get('/journal', listJournalInvoices);
router.get('/journal/:journalEntryId', getJournalInvoice);
router.put('/journal/:journalEntryId', updateJournalInvoice);
router.put('/:invoiceId', updateInvoice);

module.exports = router;
