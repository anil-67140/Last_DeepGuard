const router = require('express').Router();
const axios = require('axios');
const { authenticate, requireAdmin, supabase } = require('../middleware/auth.middleware');
const Job = require('../models/Job.model');
const Transaction = require('../models/Transaction.model');

const AI_ENGINE_URL = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';

// All jobs (admin only)
router.get('/jobs', authenticate, requireAdmin, async (req, res) => {
  try {
    const jobs = await Job.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// System stats
router.get('/stats', authenticate, requireAdmin, async (req, res) => {
  try {
    const [totalJobs, totalTx, totalFraud] = await Promise.all([
      Job.countDocuments(),
      Transaction.countDocuments(),
      Transaction.countDocuments({ isFraud: true })
    ]);
    res.json({ totalJobs, totalTransactions: totalTx, totalFraud });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FR-13: Manage Users (Admin) ──
// Uses Supabase's admin API (service role key — already configured in
// middleware/auth.middleware.js) to list/update users. Requires the
// SUPABASE_SERVICE_KEY in .env to actually be a *service_role* key, not
// the anon key, or these calls will 401/403 against Supabase.

// List all users
router.get('/users', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.auth.admin.listUsers();
    if (error) return res.status(500).json({ error: error.message });
    const users = data.users.map(u => ({
      id: u.id,
      email: u.email,
      role: u.user_metadata?.role || 'auditor',
      createdAt: u.created_at,
      lastSignInAt: u.last_sign_in_at,
      confirmed: !!u.email_confirmed_at
    }));
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new user account (uses the Admin API — correctly creates the
// auth.identities row too, unlike a raw SQL INSERT into auth.users).
router.post('/users', authenticate, requireAdmin, async (req, res) => {
  try {
    const { email, password, role = 'auditor' } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'password must be at least 6 characters' });
    }
    if (!['admin', 'auditor', 'analyst'].includes(role)) {
      return res.status(400).json({ error: 'role must be admin, auditor, or analyst' });
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // no confirmation email needed for admin-created accounts
      user_metadata: { role }
    });

    if (error) return res.status(400).json({ error: error.message });

    res.status(201).json({
      id: data.user.id,
      email: data.user.email,
      role,
      createdAt: data.user.created_at
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a user's role (admin | auditor | analyst)
router.patch('/users/:userId/role', authenticate, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;
    if (!['admin', 'auditor', 'analyst'].includes(role)) {
      return res.status(400).json({ error: 'role must be admin, auditor, or analyst' });
    }
    const { data, error } = await supabase.auth.admin.updateUserById(userId, {
      user_metadata: { role }
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ id: data.user.id, email: data.user.email, role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a user account
router.delete('/users/:userId', authenticate, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    if (userId === req.userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'User removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FR-15: View System Logs (Admin) — full audit trail of jobs/uploads ──
router.get('/logs', authenticate, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, status } = req.query;
    const query = {};
    if (status) query.status = status;

    const [logs, total] = await Promise.all([
      Job.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .select('jobId userId originalName status progress totalTransactions flaggedCount errorMessage createdAt completedAt')
        .lean(),
      Job.countDocuments(query)
    ]);

    res.json({ logs, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FR-14: Manage AI Models (Admin) ──
// The AI Engine itself has no auth (matching the rest of that service), so
// requireAdmin here is what actually protects these routes end-to-end.
router.get('/model-config', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data } = await axios.get(`${AI_ENGINE_URL}/models/config`, { timeout: 10000 });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'AI Engine unreachable: ' + err.message });
  }
});

router.patch('/model-config', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data } = await axios.patch(`${AI_ENGINE_URL}/models/config`, req.body, { timeout: 10000 });
    res.json(data);
  } catch (err) {
    const status = err.response?.status || 502;
    res.status(status).json({ error: err.response?.data?.detail || err.message });
  }
});

// ── FR-18: Queue status (Admin) ──
router.get('/queue/status', authenticate, requireAdmin, async (req, res) => {
  try {
    const { getQueueStatus } = require('../controllers/upload.controller');
    res.json(await getQueueStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FR-20: Data Backup & Recovery (Admin) ──
router.get('/backups', authenticate, requireAdmin, (req, res) => {
  try {
    res.json(req.app.get('backupService').listBackups());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/backups/run', authenticate, requireAdmin, async (req, res) => {
  try {
    res.status(201).json(await req.app.get('backupService').runBackup());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/backups/:name/download', authenticate, requireAdmin, (req, res) => {
  try {
    const svc = req.app.get('backupService');
    svc.verifyBackup(req.params.name)
      .then(() => res.download(svc.getBackupPath(req.params.name), req.params.name))
      .catch((err) => res.status(err.status || 500).json({ error: err.message }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/backups/:name/restore', authenticate, requireAdmin, async (req, res) => {
  try {
    res.json(await req.app.get('backupService').restoreBackup(req.params.name));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete('/backups/:name', authenticate, requireAdmin, (req, res) => {
  try {
    req.app.get('backupService').deleteBackup(req.params.name);
    res.json({ message: 'Backup deleted' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── GNN status (Admin) — proxies the AI Engine's own diagnostic endpoint ──
router.get('/gnn/status', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data } = await axios.get(`${AI_ENGINE_URL}/models/gnn/status`, { timeout: 10000 });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'AI Engine unreachable: ' + err.message });
  }
});

module.exports = router;
