const router = require("express").Router();
const axios = require("axios");
const { authenticate } = require("../middleware/auth.middleware");
const Job = require("../models/Job.model");
const Transaction = require("../models/Transaction.model");

const AI_ENGINE_URL = process.env.AI_ENGINE_URL || "http://127.0.0.1:8000";

// Dashboard overview for current user
// ── Overview ────────────────────────────────────────────────────────────────
// SHARED_HISTORY (default on): the dashboard shows EVERY analysis done so far, not just the jobs uploaded by the
// account you are logged in with. Jobs are stored with the uploader's Supabase user id, so after creating new
// accounts the old ones used to disappear from the totals / job list. Set SHARED_HISTORY=false to scope to the user.
//
// The three heavy aggregations share ONE collection scan ($facet) and the payload is cached for 30 s because the
// dashboard polls it.
const SHARED_HISTORY = process.env.SHARED_HISTORY !== "false";
const OVERVIEW_TTL_MS = 30 * 1000;
const overviewCache = new Map(); // cacheKey -> { expires, payload }
const SCORE_BOUNDARIES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 101]; // last bucket catches exactly 100
const EMPTY_TOTALS = {
  totalTransactions: 0,
  totalFlagged: 0,
  totalCritical: 0,
  jobCount: 0,
};

router.get("/overview", authenticate, async (req, res) => {
  try {
    const userId = req.userId;
    const cacheKey = SHARED_HISTORY ? "all" : userId;
    const hit = overviewCache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return res.json(hit.payload);

    const jobFilter = SHARED_HISTORY ? {} : { userId };
    const [jobs, totals, jobIdDocs] = await Promise.all([
      Job.find(jobFilter).sort({ createdAt: -1 }).limit(8).lean(),
      Job.aggregate([
        { $match: jobFilter },
        {
          $group: {
            _id: null,
            jobCount: { $sum: 1 },
            totalTransactions: { $sum: "$totalTransactions" },
            totalFlagged: { $sum: "$flaggedCount" },
            totalCritical: { $sum: "$criticalCount" },
          },
        },
      ]),
      SHARED_HISTORY
        ? Promise.resolve(null)
        : Job.find(jobFilter).select("jobId").lean(),
    ]);

    // which transactions to analyse: everything, or only this user's jobs
    const txMatch = SHARED_HISTORY
      ? {}
      : { jobId: { $in: (jobIdDocs || []).map((j) => j.jobId) } };
    const hasData = SHARED_HISTORY
      ? totals[0]?.jobCount > 0
      : txMatch.jobId.$in.length > 0;

    let recentAlerts = [],
      riskBreakdown = [],
      categoryBreakdown = [],
      scoreDistribution = [];
    if (hasData) {
      const [alerts, facets] = await Promise.all([
        Transaction.find({ ...txMatch, isFraud: true })
          .sort({ riskScore: -1 })
          .limit(10)
          .lean(),
        Transaction.aggregate([
          { $match: txMatch },
          {
            $facet: {
              risk: [
                {
                  $group: {
                    _id: "$riskLevel",
                    count: { $sum: 1 },
                    avgRisk: { $avg: "$riskScore" },
                  },
                },
              ],
              categories: [
                { $match: { isFraud: true } },
                {
                  $group: {
                    _id: "$fraudCategory",
                    count: { $sum: 1 },
                    avgRisk: { $avg: "$riskScore" },
                  },
                },
                { $sort: { count: -1 } },
                { $limit: 8 },
              ],
              scores: [
                {
                  $bucket: {
                    groupBy: "$riskScore",
                    boundaries: SCORE_BOUNDARIES,
                    default: "other",
                    output: { count: { $sum: 1 } },
                  },
                },
              ],
            },
          },
        ]).catch((err) => {
          console.warn("⚠️  dashboard facet aggregation failed:", err.message);
          return null;
        }),
      ]);
      recentAlerts = alerts;
      const f = facets && facets[0];
      if (f) {
        riskBreakdown = f.risk;
        categoryBreakdown = f.categories;
        scoreDistribution = f.scores.filter((b) => b._id !== "other");
      }
    }

    const payload = {
      recentJobs: jobs,
      recentAlerts,
      riskBreakdown,
      categoryBreakdown, // flagged transactions per typology (fraudCategory)
      scoreDistribution, // [{ _id: <bucket start 0..100>, count }]
      totals: totals[0] || EMPTY_TOTALS,
      scope: SHARED_HISTORY ? "all" : "user",
    };
    overviewCache.set(cacheKey, {
      expires: Date.now() + OVERVIEW_TTL_MS,
      payload,
    });
    res.json(payload);
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
 *     Engine's saved training outputs (metadata.json, tables/) via GET /models/info, so it's
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
router.get("/performance", authenticate, async (req, res) => {
  try {
    const [modelInfoResult, jobStatsResult, recentJobsResult] =
      await Promise.allSettled([
        axios.get(`${AI_ENGINE_URL}/models/info`, { timeout: 8000 }),
        Job.aggregate([
          { $match: { status: "completed" } },
          {
            $group: {
              _id: null,
              totalJobsRun: { $sum: 1 },
              totalTransactionsProcessed: { $sum: "$totalTransactions" },
              totalFlagged: { $sum: "$flaggedCount" },
              totalCritical: { $sum: "$criticalCount" },
              avgProcessingTimeMs: { $avg: "$processingTimeMs" },
              maxProcessingTimeMs: { $max: "$processingTimeMs" },
              minProcessingTimeMs: { $min: "$processingTimeMs" },
              avgRiskScore: { $avg: "$averageRiskScore" },
            },
          },
        ]),
        Job.find({ status: "completed" })
          .sort({ createdAt: -1 })
          .limit(20)
          .select(
            "jobId originalName totalTransactions processingTimeMs averageRiskScore flaggedCount criticalCount createdAt usedGnn -_id",
          )
          .lean(),
      ]);

    const modelInfo =
      modelInfoResult.status === "fulfilled"
        ? modelInfoResult.value.data
        : null;
    const systemStats =
      jobStatsResult.status === "fulfilled" && jobStatsResult.value[0]
        ? jobStatsResult.value[0]
        : {
            totalJobsRun: 0,
            totalTransactionsProcessed: 0,
            totalFlagged: 0,
            totalCritical: 0,
            avgProcessingTimeMs: 0,
            maxProcessingTimeMs: 0,
            minProcessingTimeMs: 0,
            avgRiskScore: 0,
          };
    const trend =
      recentJobsResult.status === "fulfilled"
        ? recentJobsResult.value.reverse()
        : [];

    res.json({
      modelAvailable: !!modelInfo && !modelInfo.demo_mode,
      demoMode: modelInfo?.demo_mode ?? true,
      modelPerformance: modelInfo?.metadata?.model_performance || null,
      modelLabels: modelInfo?.metadata?.model_labels || null,
      finalModel: modelInfo?.metadata?.final_model || null,
      operatingPoints: modelInfo?.metadata?.operating_points || null,
      trainingInfo: modelInfo?.metadata?.training || null,
      shapFeatureImportance:
        modelInfo?.metadata?.shap_feature_importance || null,
      ensembleWeights: modelInfo?.metadata?.ensemble_weights || null,
      ensembleThreshold: modelInfo?.metadata?.ensemble_threshold ?? null,
      gnnAvailable: modelInfo?.gnn_available || false,
      gnnPerformance: modelInfo?.gnn_metadata?.test_performance || null,
      systemStats,
      recentJobsTrend: trend,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
