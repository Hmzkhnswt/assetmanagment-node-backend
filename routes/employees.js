const express = require('express');
const { listEmployees } = require('../controllers/employeeController');

const router = express.Router();

router.get('/', listEmployees);

module.exports = router;
