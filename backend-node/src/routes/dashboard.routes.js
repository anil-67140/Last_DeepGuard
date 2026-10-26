const router = require('express').Router();
const axios = require('axios');
const { authenticate } = require('../middleware/auth.middleware');
const Job = require('../models/Job.model');
const Transaction = require('../models/Transaction.model');

const AI_ENGINE_URL = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';

// Dashboard overview for current user
router.get('/overview', authenticate, async (req, res) => {
  try {
    const userId = req.userId;
    
    const [jobs, recentFrauds, riskBreakdown] = await Promise.all([
      Job.find({ userId }).sort({ createdAt: -1 }).limit(5).lean(),
      Transaction.find({ isFraud: true })
        .sort({ riskScore: -1 })
        .limit(10)
        .lean(),
      Transaction.aggregate([
        { $group: {
          _id: '$riskLevel',
          count: { $sum: 1 },
          avgRisk: { $avg: '$riskScore' }
        }}
      ])
    ]);

    const totals = await Job.aggregate([
      { $match: { userId } },
      { $group: {
        _id: null,
        totalTransactions: { $sum: '$totalTransactions' },
        totalFlagged: { $sum: '$flaggedCount' },
        totalCritical: { $sum: '$criticalCount' }
      }}
    ]);

    res.json({
      recentJobs: jobs,
      recentAlerts: recentFrauds,
      riskBreakdown,
      totals: totals[0] || { totalTransactions: 0, totalFlagged: 0, totalCritical: 0 }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ─────────────────────────────────────────────
 * FR-12 — View Performance Analytics.
 *
 * SRS wording: "The system shall display performance analytics and system
 * health metrics including processing time, number of transactions
 * analyzed, detection accuracy, and model performance statistics."
 *
 * This combines two genuinely different things the old `/overview` route
 * didn't cover:
 *   - MODEL performance (is the AI good?) — proxied straight from the AI
 *     Engine's saved model_metadata.json via GET /models/info, so it's
 *     always the real evaluated numbers, never hand-typed into the frontend.
 *   - SYSTEM performance (is the pipeline fast?) — computed here from Job
 *     history: total jobs run, total transactions processed all-time,
 *     average/max processing time, plus a per-job trend for charting.
 *
 * Available to any authenticated user (not just admin) — the SRS doesn't
 * scope FR-12 to a role, and auditors benefit from seeing model accuracy
 * before trusting its flags as much as admins do.
 * ─────────────────────────────────────────────
 */
router.get('/performance', authenticate, async (req, res) => {
  try {
    const [modelInfoResult, jobStatsResult, recentJobsResult] = await Promise.allSettled([
      axios.get(`${AI_ENGINE_URL}/models/info`, { timeout: 8000 }),
      Job.aggregate([
        { $match: { status: 'completed' } },
        { $group: {
          _id: null,
          totalJobsRun: { $sum: 1 },
          totalTransactionsProcessed: { $sum: '$totalTransactions' },
          totalFlagged: { $sum: '$flaggedCount' },
          totalCritical: { $sum: '$criticalCount' },
          avgProcessingTimeMs: { $avg: '$processingTimeMs' },
          maxProcessingTimeMs: { $max: '$processingTimeMs' },
          minProcessingTimeMs: { $min: '$processingTimeMs' },
          avgRiskScore: { $avg: '$averageRiskScore' }
        }}
      ]),
      Job.find({ status: 'completed' })
        .sort({ createdAt: -1 })
        .limit(20)
        .select('jobId originalName totalTransactions processingTimeMs averageRiskScore flaggedCount criticalCount createdAt usedGnn -_id')
        .lean()
    ]);

    const modelInfo = modelInfoResult.status === 'fulfilled' ? modelInfoResult.value.data : null;
    const systemStats = (jobStatsResult.status === 'fulfilled' && jobStatsResult.value[0])
      ? jobStatsResult.value[0]
      : {
          totalJobsRun: 0, totalTransactionsProcessed: 0, totalFlagged: 0, totalCritical: 0,
          avgProcessingTimeMs: 0, maxProcessingTimeMs: 0, minProcessingTimeMs: 0, avgRiskScore: 0
        };
    const trend = recentJobsResult.status === 'fulfilled' ? recentJobsResult.value.reverse() : [];

    res.json({
      modelAvailable: !!modelInfo && !modelInfo.demo_mode,
      demoMode: modelInfo?.demo_mode ?? true,
      modelPerformance: modelInfo?.metadata?.model_performance || null,
      shapFeatureImportance: modelInfo?.metadata?.shap_feature_importance || null,
      ensembleWeights: modelInfo?.metadata?.ensemble_weights || null,
      ensembleThreshold: modelInfo?.metadata?.ensemble_threshold ?? null,
      gnnAvailable: modelInfo?.gnn_available || false,
      gnnPerformance: modelInfo?.gnn_metadata?.test_performance || null,
      systemStats,
      recentJobsTrend: trend
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
