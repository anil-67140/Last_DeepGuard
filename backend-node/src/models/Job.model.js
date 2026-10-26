const mongoose = require('mongoose');

const JobSchema = new mongoose.Schema({
  jobId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  fileName: { type: String },
  originalName: { type: String },
  fileSize: { type: Number },
  status: {
    type: String,
    enum: ['queued', 'parsing', 'analyzing', 'saving', 'completed', 'failed'],
    default: 'queued',
    index: true
  },
  progress: { type: Number, default: 0 },          // 0-100
  totalTransactions: { type: Number, default: 0 },
  processedTransactions: { type: Number, default: 0 },
  flaggedCount: { type: Number, default: 0 },
  criticalCount: { type: Number, default: 0 },
  cleanCount: { type: Number, default: 0 },
  averageRiskScore: { type: Number, default: 0 },
  processingTimeMs: { type: Number, default: 0 },
  errorMessage: { type: String },
  saveWarning: { type: String }, // set if Transaction.insertMany partially/fully failed after a successful AI analysis — see upload.controller.js
  usedGnn: { type: Boolean, default: false },      // true if the GNN also scored this job
  reportUrl: { type: String },
  reportHash: { type: String },          // SHA-256 evidence fingerprint — FR-11
  reportGeneratedAt: { type: Date },      // FR-11
  createdAt: { type: Date, default: Date.now },
  completedAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('Job', JobSchema);
