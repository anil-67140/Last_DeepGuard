const router = require('express').Router();
const { authenticate } = require('../middleware/auth.middleware');
const { uploadFile, getJobStatus, getUserJobs } = require('../controllers/upload.controller');

router.post('/', authenticate, uploadFile);
router.get('/jobs', authenticate, getUserJobs);
router.get('/jobs/:jobId', authenticate, getJobStatus);

module.exports = router;
