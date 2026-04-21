require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { ZodError } = require('zod');
const { installApiResponseMiddleware } = require('./utils/apiResponse');

const accountsRouter = require('./routes/accounts');
const employeesRouter = require('./routes/employees');
const transactionsRouter = require('./routes/transactions');
const reportsRouter = require('./routes/reports');
const receiptsRouter = require('./routes/receipts');

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());
app.use(installApiResponseMiddleware);

app.use('/api/accounts', accountsRouter);
app.use('/api/employees', employeesRouter);
app.use('/api/invoices', transactionsRouter);
app.use('/api/balances', reportsRouter);
app.use('/api/receipts', receiptsRouter);

app.get('/api/health', (_req, res) => {
  res.apiSuccess('API health retrieved successfully.', { ok: true });
});

app.use((err, _req, res, _next) => {
  if (err instanceof ZodError) {
    // Expected client-side validation issue; avoid noisy stack logs.
    return res.status(400).json({
      error: 'Validation failed.',
      errors: err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const status = err.statusCode || 500;
  const message = err.expose ? err.message : 'Internal server error.';
  if (status >= 500) {
    console.error(err);
  }
  return res.status(status).json({ error: message });
});

app.listen(port, () => {
  console.log(`Asset Manager API listening on http://localhost:${port}`);
});
