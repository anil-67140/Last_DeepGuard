const router = require('express').Router();
const { authenticate } = require('../middleware/auth.middleware');
const { generateReport, verifyReport } = require('../controllers/report.controller');

router.get('/generate/:jobId', authenticate, generateReport);
router.get('/verify/:jobId', authenticate, verifyReport); // FR-11 — integrity check

module.exports = router;
