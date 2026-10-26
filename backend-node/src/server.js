/**
 * DeepGuard — Node.js API Gateway
 * Handles file uploads, auth, graph queries, PDF reports, job queue
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server } = require('socket.io');

const connectMongoDB = require('./config/mongodb');
const authRoutes = require('./routes/auth.routes');
const uploadRoutes = require('./routes/upload.routes');
const analysisRoutes = require('./routes/analysis.routes');
const graphRoutes = require('./routes/graph.routes');
const reportRoutes = require('./routes/report.routes');
const adminRoutes = require('./routes/admin.routes');
const dashboardRoutes = require('./routes/dashboard.routes');

const { initUploadQueue } = require('./controllers/upload.controller');
const { createBackupService } = require('./services/backup.service');
const Job = require('./models/Job.model');
const Transaction = require('./models/Transaction.model');

const { errorHandler } = require('./middleware/error.middleware');

const app = express();
const server = http.createServer(app);

// ── Socket.IO for real-time progress ──
const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || 'http://localhost:5173', methods: ['GET', 'POST'] }
});

app.set('io', io);

io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  socket.on('join_job', (jobId) => socket.join(`job_${jobId}`));
  socket.on('disconnect', () => console.log(`🔌 Client disconnected: ${socket.id}`));
});

// ── Security Middleware ──
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));

// ── Rate Limiting ──
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests — please try again later.' }
});
app.use('/api/', limiter);

// ── Body Parsing ──
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan('dev'));

// ── Routes ──
app.use('/api/auth', authRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/analysis', analysisRoutes);
app.use('/api/graph', graphRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/dashboard', dashboardRoutes);

// ── Health Check ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'deepguard-node', timestamp: new Date().toISOString() });
});

// ── Error Handler ──
app.use(errorHandler);

// ── FR-20: Backup service, shared by admin.routes.js and the daily scheduler ──
const backupService = createBackupService({
  models: { jobs: Job, transactions: Transaction },
  dir: process.env.BACKUP_DIR || path.join(__dirname, '../backups'),
  retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10),
});
app.set('backupService', backupService);

// ── Start Server ──
const PORT = process.env.PORT || 4000;

async function startServer() {
  try {
    await connectMongoDB();

    // FR-18: queue must exist before the upload route can accept files
    await initUploadQueue(io);

    // FR-20: daily backups, unless explicitly disabled (e.g. in tests)
    if (process.env.BACKUP_ENABLED !== 'false') {
      backupService.startScheduler();
    }

    server.listen(PORT, () => {
      console.log(`\n🚀 DeepGuard Node.js Backend running on port ${PORT}`);
      console.log(`📡 Socket.IO ready`);
      console.log(`🌍 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
      console.log(`🤖 AI Engine: ${process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000'}\n`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
}

startServer();
