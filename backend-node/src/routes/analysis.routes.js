const router = require('express').Router();
const { authenticate } = require('../middleware/auth.middleware');
const Transaction = require('../models/Transaction.model');

// Get transactions for a job
router.get('/job/:jobId', authenticate, async (req, res) => {
  try {
    const { jobId } = req.params;
    const { page = 1, limit = 50, filter, search } = req.query;
    
    const query = { jobId };
    if (filter === 'fraud') query.isFraud = true;
    if (filter === 'critical') query.riskLevel = 'Critical';
    if (filter === 'high') query.riskLevel = 'High';
    if (search) query.$or = [
      { transactionId: { $regex: search, $options: 'i' } },
      { account: { $regex: search, $options: 'i' } },
      { fraudCategory: { $regex: search, $options: 'i' } }
    ];

    const [transactions, total] = await Promise.all([
      Transaction.find(query)
        .sort({ riskScore: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean(),
      Transaction.countDocuments(query)
    ]);

    res.json({ transactions, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single transaction with SHAP details
// jobId is now required as a query param — transactionId is no longer globally
// unique (see Transaction.model.js), only unique within a job, so a lookup by
// transactionId alone would be ambiguous once more than one job exists.
router.get('/transaction/:transactionId', authenticate, async (req, res) => {
  try {
    const { jobId } = req.query;
    if (!jobId) {
      return res.status(400).json({ error: 'jobId query param is required' });
    }
    const tx = await Transaction.findOne({ transactionId: req.params.transactionId, jobId }).lean();
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    res.json(tx);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FR-16: Export anomaly detection results (CSV or JSON) ──
// GET /api/analysis/job/:jobId/export?format=csv|json&filter=fraud|critical|high
router.get('/job/:jobId/export', authenticate, async (req, res) => {
  try {
    const { jobId } = req.params;
    const format = (req.query.format || 'csv').toLowerCase();
    const { filter } = req.query;

    if (!['csv', 'json'].includes(format)) {
      return res.status(400).json({ error: 'format must be "csv" or "json"' });
    }

    const query = { jobId };
    if (filter === 'fraud') query.isFraud = true;
    if (filter === 'critical') query.riskLevel = 'Critical';
    if (filter === 'high') query.riskLevel = 'High';

    const transactions = await Transaction.find(query).sort({ riskScore: -1 }).lean();

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="deepguard_export_${jobId}.json"`);
      return res.json(transactions);
    }

    // CSV
    const columns = [
      'transactionId', 'timestamp', 'fromBank', 'account', 'toBank', 'toAccount',
      'amountPaid', 'paymentCurrency', 'amountReceived', 'receivingCurrency', 'paymentFormat',
      'riskScore', 'riskLevel', 'isFraud', 'isolationForestScore', 'autoencoderScore',
      'fraudCategory'
    ];
    const escape = (val) => {
      if (val === null || val === undefined) return '';
      const s = String(val);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = columns.join(',');
    const rows = transactions.map(t => columns.map(c => escape(t[c])).join(','));
    const csv = [header, ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="deepguard_export_${jobId}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
