const multer = require('multer');
const csv = require('csv-parser');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const Transaction = require('../models/Transaction.model');
const Job = require('../models/Job.model');
const { createUploadQueue } = require('../queue/uploadQueue');
const { notifyJobCompleted, notifyJobFailed } = require('../services/email.service');

const AI_ENGINE_URL = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';
const BATCH_SIZE = 1000; // Send to AI in chunks

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}_${file.originalname}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['.csv', '.xlsx', '.xls'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only CSV, XLSX, and XLS files are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
}).single('file');

/**
 * Parse IBM AML CSV/XLSX into transaction objects
 */
function parseIBMAMLRow(row, idx) {
  // IBM AML columns: Timestamp, From Bank, Account, To Bank, Account.1,
  // Amount Received, Receiving Currency, Amount Paid, Payment Currency,
  // Payment Format, Is Laundering
  return {
    transaction_id: row['Transaction ID'] || row['Id'] || `TX-${idx + 1}`,
    timestamp: row['Timestamp'] || row['timestamp'] || new Date().toISOString(),
    from_bank: row['From Bank'] || row['from_bank'] || '',
    account: row['Account'] || row['account'] || '',
    to_bank: row['To Bank'] || row['to_bank'] || '',
    to_account: row['Account.1'] || row['to_account'] || row['ToAccount'] || '',
    amount_paid: parseFloat(row['Amount Paid'] || row['amount_paid'] || 0),
    payment_currency: row['Payment Currency'] || row['payment_currency'] || 'USD',
    amount_received: parseFloat(row['Amount Received'] || row['amount_received'] || 0),
    receiving_currency: row['Receiving Currency'] || row['receiving_currency'] || 'USD',
    payment_format: row['Payment Format'] || row['payment_format'] || 'Wire',
    is_laundering: parseInt(row['Is Laundering'] || row['is_laundering'] || 0)
  };
}

/**
 * Validate that an uploaded file actually looks like IBM-AML-style transaction
 * data before we spend any time processing it. Catches the "wrong dataset
 * entirely" case (e.g. someone uploads a hotel-bookings CSV, a sales CSV, etc.)
 * up front with a clear, specific error — instead of silently defaulting every
 * unrecognized column to 0/empty and producing a job that "completes" with
 * meaningless all-zero transactions.
 */
function validateAMLSchema(rawRows) {
  if (!rawRows || rawRows.length === 0) {
    return { valid: false, error: 'The file is empty — no rows were found to process.' };
  }

  const headers = Object.keys(rawRows[0]);
  const has = (aliases) => aliases.some(a => headers.includes(a));

  const checks = [
    { label: 'a sender account column', aliases: ['Account', 'account'] },
    { label: 'a receiver account column', aliases: ['Account.1', 'to_account', 'ToAccount'] },
    { label: 'an amount column', aliases: ['Amount Paid', 'amount_paid', 'Amount Received', 'amount_received'] },
  ];

  const missing = checks.filter(c => !has(c.aliases));

  if (missing.length > 0) {
    const missingLabels = missing.map(m => m.label).join(', ');
    const foundPreview = headers.slice(0, 8).join(', ') + (headers.length > 8 ? ', …' : '');
    return {
      valid: false,
      error: `This doesn't look like an IBM-AML-style transaction file — missing ${missingLabels}. ` +
        `Expected columns like "Account", "Account.1", "Amount Paid", "Amount Received", "Payment Format". ` +
        `Found instead: ${foundPreview}. Make sure you're uploading the transaction dataset ` +
        `(e.g. HI-Small_Trans.csv), not a different file.`
    };
  }

  return { valid: true, error: null };
}

/**
 * Compute per-account behavioral aggregates (Sender_TX_Count, Sender_Avg_Amount,
 * Sender_Unique_Receivers, Sender_Total_Amount, Sender_Max_Amount, Receiver_TX_Count)
 * from the full uploaded batch, and attach them to each transaction before sending
 * to the AI Engine.
 *
 * WHY: main.py's Transaction model defaults these fields to "first-seen account"
 * values (count=1, avg=amount_paid, etc.) when they aren't supplied, because a
 * single incoming transaction has no history of its own. But a bulk file upload
 * *is* a batch of that account's activity, so we can and should compute real
 * aggregates from it — this was a known gap (every live request silently used
 * defaults) and materially affects how well Isolation Forest / Autoencoder /
 * XGBoost can flag velocity-based and layering patterns (Sender_TX_Count,
 * Sender_Unique_Receivers are two of the model's 21 trained features).
 *
 * Note: this reflects the account's activity *within this uploaded file*, not
 * its full lifetime history (which would require a persistent per-account
 * running aggregate across jobs — out of scope for a single-batch endpoint).
 */
function attachBehavioralAggregates(transactions) {
  const senderStats = new Map(); // account -> { count, total, max, receivers:Set }
  const receiverCounts = new Map(); // to_account -> count

  for (const tx of transactions) {
    if (tx.account) {
      const s = senderStats.get(tx.account) || { count: 0, total: 0, max: 0, receivers: new Set() };
      s.count += 1;
      s.total += tx.amount_paid || 0;
      s.max = Math.max(s.max, tx.amount_paid || 0);
      if (tx.to_account) s.receivers.add(tx.to_account);
      senderStats.set(tx.account, s);
    }
    if (tx.to_account) {
      receiverCounts.set(tx.to_account, (receiverCounts.get(tx.to_account) || 0) + 1);
    }
  }

  return transactions.map(tx => {
    const s = tx.account ? senderStats.get(tx.account) : null;
    return {
      ...tx,
      sender_tx_count: s ? s.count : 1,
      sender_avg_amount: s ? s.total / s.count : (tx.amount_paid || 0),
      sender_unique_receivers: s ? s.receivers.size : 1,
      sender_total_amount: s ? s.total : (tx.amount_paid || 0),
      sender_max_amount: s ? s.max : (tx.amount_paid || 0),
      receiver_tx_count: tx.to_account ? (receiverCounts.get(tx.to_account) || 1) : 1
    };
  });
}

/**
 * Parse CSV file
 */
function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

/**
 * Parse XLSX/XLS file
 */
function parseXLSX(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet);
}

/**
 * Send batch to AI Engine
 * `useGnn` asks the engine to also score with the GNN (silently ignored by
 * the engine if the GNN isn't installed/loaded — see GET /models/gnn/status).
 */
async function sendToAIEngine(transactions, jobId, useGnn = false) {
  const response = await axios.post(`${AI_ENGINE_URL}/analyze/batch`, {
    transactions,
    job_id: jobId,
    use_gnn: !!useGnn
  }, { timeout: 300000 }); // 5 min timeout for large batches
  return response.data;
}

/**
 * Read just the first few rows of a file — enough to validate its schema
 * without parsing the whole thing twice (the queue worker does the full parse).
 */
function peekRows(filePath, ext, maxRows = 5) {
  if (ext !== '.csv') return Promise.resolve(parseXLSX(filePath).slice(0, maxRows));
  return new Promise((resolve, reject) => {
    const rows = [];
    let settled = false;
    const stream = fs.createReadStream(filePath);
    const finish = () => { if (settled) return; settled = true; stream.destroy(); resolve(rows.slice(0, maxRows)); };
    stream.pipe(csv())
      .on('data', (row) => { if (settled) return; rows.push(row); if (rows.length >= maxRows) finish(); })
      .on('end', finish)
      .on('error', (e) => { if (!settled) { settled = true; reject(e); } });
  });
}

// ─────────────────────────────────────────────
// FR-18 — jobs are processed by a bounded-concurrency queue
// (Redis/Bull if REDIS_URL is reachable, otherwise in-process — see
// src/queue/uploadQueue.js). Call initUploadQueue(io) once at startup.
// ─────────────────────────────────────────────
let uploadQueue = null;
let ioRef = null;

async function initUploadQueue(io) {
  ioRef = io;
  uploadQueue = await createUploadQueue({ processor: processUploadJob });
  return uploadQueue;
}

async function getUploadQueue() {
  if (!uploadQueue) uploadQueue = await createUploadQueue({ processor: processUploadJob });
  return uploadQueue;
}

async function getQueueStatus() {
  return (await getUploadQueue()).getStatus();
}

/**
 * The actual analysis pipeline for one job: parse -> aggregate -> AI Engine
 * (in batches) -> save -> summarise -> notify. Runs inside a queue worker.
 */
async function processUploadJob({ jobId, filePath, ext, userEmail, useGnn }) {
  const io = ioRef;
  const startTime = Date.now();

  try {
    await Job.findOneAndUpdate({ jobId }, { status: 'parsing', progress: 8 });
    io?.to(`job_${jobId}`).emit('progress', { jobId, status: 'parsing', progress: 10 });

    const rawRows = ext === '.csv' ? await parseCSV(filePath) : parseXLSX(filePath);
    const parsedTransactions = rawRows.map((row, idx) => parseIBMAMLRow(row, idx));
    const transactions = attachBehavioralAggregates(parsedTransactions);

    await Job.findOneAndUpdate({ jobId }, {
      status: 'analyzing',
      progress: 20,
      totalTransactions: transactions.length
    });

    io?.to(`job_${jobId}`).emit('progress', {
      jobId, status: 'analyzing', progress: 20,
      total: transactions.length
    });

    // ── Send to AI Engine in batches ──
    const allResults = [];
    const totalBatches = Math.ceil(transactions.length / BATCH_SIZE);

    for (let i = 0; i < totalBatches; i++) {
      const batch = transactions.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
      const response = await sendToAIEngine(batch, jobId, useGnn);
      allResults.push(...(response.results || []));

      const progress = 20 + Math.round((i + 1) / totalBatches * 50);
      await Job.findOneAndUpdate({ jobId }, {
        progress,
        processedTransactions: allResults.length
      });
      io?.to(`job_${jobId}`).emit('progress', {
        jobId, status: 'analyzing', progress,
        processed: allResults.length, total: transactions.length
      });
    }

    // ── Save results to MongoDB ──
    await Job.findOneAndUpdate({ jobId }, { status: 'saving', progress: 75 });
    io?.to(`job_${jobId}`).emit('progress', { jobId, status: 'saving', progress: 75 });

    const txDocs = allResults.map((result, idx) => {
      const tx = transactions[idx] || {};
      return {
        jobId,
        transactionId: result.transaction_id,
        timestamp: tx.timestamp ? new Date(tx.timestamp) : new Date(),
        fromBank: tx.from_bank,
        account: tx.account,
        toBank: tx.to_bank,
        toAccount: tx.to_account,
        amountPaid: tx.amount_paid,
        paymentCurrency: tx.payment_currency,
        amountReceived: tx.amount_received,
        receivingCurrency: tx.receiving_currency,
        paymentFormat: tx.payment_format,
        isLaundering: tx.is_laundering,
        riskScore: result.risk_score,
        riskLevel: result.risk_level,
        isFraud: result.is_fraud,
        isolationForestScore: result.isolation_forest_score,
        autoencoderScore: result.autoencoder_score,
        gnnScore: result.gnn_score ?? null,
        fraudCategory: result.fraud_category,
        shapValues: result.shap_values || {},
        graphLinks: tx.to_account ? [tx.to_account] : []
      };
    });

    // Bulk insert (ordered:false so one bad doc doesn't block the rest —
    // but we surface what happened instead of swallowing it)
    let insertedCount = 0;
    try {
      const insertResult = await Transaction.insertMany(txDocs, { ordered: false });
      insertedCount = insertResult.length;
      console.log(`✅ Job ${jobId}: inserted ${insertedCount}/${txDocs.length} transactions`);
    } catch (insertErr) {
      insertedCount = insertErr.insertedDocs?.length || insertErr.result?.insertedCount || 0;
      const sampleError = insertErr.writeErrors?.[0]?.errmsg || insertErr.message;
      console.error(
        `⚠️  Job ${jobId}: only ${insertedCount}/${txDocs.length} transactions saved. ` +
        `First error: ${sampleError}`
      );
      await Job.findOneAndUpdate({ jobId }, {
        saveWarning: `Only ${insertedCount}/${txDocs.length} transaction records saved. ` +
          `Analysis/Graph/Report views may be incomplete. Cause: ${sampleError}`
      });
    }

    // ── Compute summary ──
    const flagged = allResults.filter(r => r.is_fraud);
    const critical = allResults.filter(r => r.risk_level === 'Critical');
    const avgRisk = allResults.reduce((s, r) => s + r.risk_score, 0) / Math.max(allResults.length, 1);
    const usedGnn = allResults.some(r => r.gnn_score !== null && r.gnn_score !== undefined);
    const processingTime = Date.now() - startTime;

    const finalJob = await Job.findOneAndUpdate({ jobId }, {
      status: 'completed',
      progress: 100,
      totalTransactions: allResults.length,
      processedTransactions: allResults.length,
      flaggedCount: flagged.length,
      criticalCount: critical.length,
      cleanCount: allResults.length - flagged.length,
      averageRiskScore: Math.round(avgRisk * 10) / 10,
      processingTimeMs: processingTime,
      usedGnn,
      completedAt: new Date()
    }, { new: true }).lean();

    io?.to(`job_${jobId}`).emit('completed', {
      jobId,
      status: 'completed',
      summary: {
        total: allResults.length,
        flagged: flagged.length,
        critical: critical.length,
        clean: allResults.length - flagged.length,
        avgRisk: Math.round(avgRisk * 10) / 10,
        processingTimeMs: processingTime
      }
    });

    // FR-19: email leg of the alert (dashboard leg is the socket event above).
    // notifyJobCompleted never throws and never blocks the job's outcome.
    await notifyJobCompleted(finalJob, userEmail);

  } catch (err) {
    console.error(`❌ Job ${jobId} failed:`, err.message);
    const failedJob = await Job.findOneAndUpdate({ jobId }, {
      status: 'failed',
      errorMessage: err.message
    }, { new: true }).lean();
    io?.to(`job_${jobId}`).emit('error', { jobId, error: err.message });
    await notifyJobFailed(failedJob || { jobId, errorMessage: err.message }, userEmail);
  } finally {
    fs.unlink(filePath, () => {});
  }
}

/**
 * Main upload handler — validate quickly, create the job, enqueue it, reply.
 */
const uploadFile = async (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();

    // ── Validate BEFORE creating a job or responding ──
    // Reject an obviously-wrong file immediately with a clear error instead
    // of accepting it and producing meaningless all-default transactions.
    let sampleRows;
    try {
      sampleRows = await peekRows(filePath, ext);
    } catch (err) {
      fs.unlink(filePath, () => {});
      return res.status(400).json({ error: `Could not parse file: ${err.message}` });
    }

    const schemaCheck = validateAMLSchema(sampleRows);
    if (!schemaCheck.valid) {
      fs.unlink(filePath, () => {});
      return res.status(400).json({ error: schemaCheck.error });
    }

    const jobId = uuidv4();
    const useGnn = String(req.body?.useGnn ?? '').toLowerCase() === 'true';

    try {
      await Job.create({
        jobId,
        userId: req.userId,
        fileName: req.file.filename,
        originalName: req.file.originalname,
        fileSize: req.file.size,
        status: 'queued',
        progress: 2
      });

      const queue = await getUploadQueue();
      const { position } = await queue.add({
        jobId, filePath, ext, userEmail: req.user?.email, useGnn
      });

      res.status(202).json({
        jobId,
        message: position > 1
          ? `File received — queued (${position - 1} ahead of it)`
          : 'File received, processing started',
        status: 'queued',
        queue: queue.mode,
        position
      });
    } catch (e) {
      console.error(`❌ Could not enqueue job ${jobId}:`, e.message);
      await Job.findOneAndUpdate({ jobId }, { status: 'failed', errorMessage: `Could not queue job: ${e.message}` });
      fs.unlink(filePath, () => {});
      if (!res.headersSent) res.status(500).json({ error: `Could not queue job: ${e.message}` });
    }
  });
};

/**
 * Get job status
 */
const getJobStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await Job.findOne({ jobId, userId: req.userId });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Get all jobs for user
 */
const getUserJobs = async (req, res) => {
  try {
    const jobs = await Job.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(20)
      .select('-__v');
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  uploadFile, getJobStatus, getUserJobs, initUploadQueue, getQueueStatus,
  _internals: { processUploadJob, peekRows, validateAMLSchema, parseIBMAMLRow }
};
