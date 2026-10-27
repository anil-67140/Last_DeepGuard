const router = require('express').Router();
const axios = require('axios');
const { authenticate } = require('../middleware/auth.middleware');
const { uploadFile, getJobStatus, getUserJobs } = require('../controllers/upload.controller');

const AI_ENGINE_URL = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';

// Is the GNN option usable? Open to ANY logged-in user (the upload page needs it).
// The full diagnostic route (/api/admin/gnn/status) is admin-only, which is why auditors
// always saw the checkbox disabled. This returns only a yes/no and a reason.
router.get('/gnn-status', authenticate, async (req, res) => {
  try {
    const { data } = await axios.get(`${AI_ENGINE_URL}/models/gnn/status`, { timeout: 8000 });
    res.json({ available: !!data.available, reason: data.available ? null : 'not_installed' });
  } catch (err) {
    res.json({ available: false, reason: 'engine_offline' });
  }
});

router.post('/', authenticate, uploadFile);
router.get('/jobs', authenticate, getUserJobs);
router.get('/jobs/:jobId', authenticate, getJobStatus);

module.exports = router;
