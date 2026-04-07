require('dotenv').config();

const express = require('express');
const cors = require('cors');

const accountsRouter = require('./routes/accounts');
const employeesRouter = require('./routes/employees');
const transactionsRouter = require('./routes/transactions');
const reportsRouter = require('./routes/reports');

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());

app.use('/api/accounts', accountsRouter);
app.use('/api/employees', employeesRouter);
app.use('/api/invoices', transactionsRouter);
app.use('/api/balances', reportsRouter);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.statusCode || 500;
  const message = err.expose ? err.message : 'Internal server error';
  res.status(status).json({ error: message });
});

app.listen(port, () => {
  console.log(`Asset Manager API listening on http://localhost:${port}`);
});
