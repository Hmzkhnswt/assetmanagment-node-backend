const express = require('express');
const { listAccounts } = require('../controllers/accountController');

const router = express.Router();

router.get('/', listAccounts);

module.exports = router;
