import { useEffect, useState } from 'react'
import { dashboardAPI } from '../utils/api'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Legend
} from 'recharts'
import {
  Gauge, Clock, Database, Cpu, Loader2, Info, Network, Target
} from 'lucide-react'

/**
 * FR-12 — View Performance Analytics.
 *
 * Two distinct things live on this page, deliberately kept separate:
 *   1. MODEL performance — how good is the AI? (ROC-AUC, Average Precision,
 *      F1, SHAP feature importance) — sourced from the AI Engine's own
 *      evaluated model_metadata.json via GET /dashboard/performance.
 *   2. SYSTEM performance — how fast is the pipeline? (processing time,
 *      throughput, job history trend) — computed from Job records.
 */

function StatCard({ icon: Icon, label, value, sub, color = 'sky' }) {
  const colorMap = {
    sky:   'text-sky-400 bg-sky-500/10 border-sky-500/20',
    violet:'text-violet-400 bg-violet-500/10 border-violet-500/20',
    green: 'text-green-400 bg-green-500/10 border-green-500/20',
    amber: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  }
  return (
    <div className="card flex items-start gap-4">
      <div className={`w-10 h-10 rounded-lg border flex items-center justify-center flex-shrink-0 ${colorMap[color]}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div>
        <p className="text-xs text-slate-400 mb-0.5">{label}</p>
        <p className="text-2xl font-bold text-white">{value}</p>
        {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

// Display name + sort order for the known model keys. Anything not listed here
// still renders (title-cased from its raw key), just appended after these.
const MODEL_DISPLAY = {
  isolation_forest: { label: 'Isolation Forest', order: 1 },
  autoencoder:       { label: 'Autoencoder',      order: 2 },
  xgboost:           { label: 'XGBoost',          order: 3 },
  ensemble:          { label: 'Ensemble',         order: 4 },
}

/**
 * model_metadata.json stores performance as FLAT scalar keys, e.g.
 *   { isolation_forest_roc_auc: 0.712, isolation_forest_avg_prec: 0.002,
 *     autoencoder_roc_auc: 0.535, ..., xgboost_roc_auc: 0.984, ...,
 *     ensemble_roc_auc: 0.930, ensemble_avg_prec: 0.401, ensemble_f1: 0.4558 }
 * — NOT nested per-model objects. This groups those flat keys back into one
 * row per model so they can be charted and read as a table.
 */
function buildModelRows(perf) {
  const byModel = {}
  for (const [key, value] of Object.entries(perf || {})) {
    if (typeof value !== 'number') continue
    const m = key.match(/^(.+)_(roc_auc|avg_prec|f1)$/)
    if (!m) continue
    const [, modelKey, metric] = m
    const display = MODEL_DISPLAY[modelKey] || {
      label: modelKey.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
      order: 99
    }
    if (!byModel[modelKey]) byModel[modelKey] = { name: display.label, order: display.order }
    if (metric === 'roc_auc') byModel[modelKey].rocAuc = value
    if (metric === 'avg_prec') byModel[modelKey].avgPrecision = value
    if (metric === 'f1') byModel[modelKey].f1 = value
  }
  return Object.values(byModel).sort((a, b) => a.order - b.order)
}

export default function PerformancePage() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => { load() }, [])

  const load = async () => {
    setLoading(true)
    try {
      const res = await dashboardAPI.getPerformance()
      setData(res.data)
    } catch {
      setData(MOCK_PERFORMANCE)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-sky-400 animate-spin" />
      </div>
    )
  }

  const perf = data?.modelPerformance || {}
  const shap = data?.shapFeatureImportance || {}
  const sys = data?.systemStats || {}

  // Model comparison bars (ROC-AUC + Average Precision per model)
  const modelRows = buildModelRows(perf)
  const ensembleF1 = modelRows.find(r => r.name === 'Ensemble')?.f1

  const shapRows = Object.entries(shap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([feature, importance]) => ({ feature, importance: Number(importance.toFixed ? importance.toFixed(4) : importance) }))

  const trend = (data?.recentJobsTrend || []).map((j, i) => ({
    name: `#${i + 1}`,
    seconds: j.processingTimeMs ? +(j.processingTimeMs / 1000).toFixed(1) : 0,
    transactions: j.totalTransactions || 0
  }))

  const avgSeconds = sys.avgProcessingTimeMs ? (sys.avgProcessingTimeMs / 1000).toFixed(1) : '—'

  return (
    <div className="p-6 space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <Gauge className="w-5 h-5 text-sky-400" /> Performance Analytics
        </h1>
        <p className="text-slate-400 text-sm mt-0.5">Model accuracy and system throughput — FR-12</p>
      </div>

      {data?.demoMode && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center gap-2 text-xs text-amber-300">
          <Info className="w-4 h-4 flex-shrink-0" />
          AI Engine is running in demo mode (no trained models loaded) — figures below are illustrative, not real evaluation results.
        </div>
      )}

      {/* System stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Database} label="Jobs Processed" value={(sys.totalJobsRun || 0).toLocaleString()} color="sky" />
        <StatCard icon={Target}   label="Transactions Analyzed" value={(sys.totalTransactionsProcessed || 0).toLocaleString()} color="green" />
        <StatCard icon={Clock}    label="Avg. Processing Time" value={`${avgSeconds}s`} sub={sys.maxProcessingTimeMs ? `max ${(sys.maxProcessingTimeMs/1000).toFixed(1)}s` : undefined} color="amber" />
        <StatCard icon={Cpu}      label="GNN Status" value={data?.gnnAvailable ? 'Available' : 'Not loaded'} sub={data?.gnnAvailable ? 'Optional 4th signal' : 'Core models only'} color="violet" />
      </div>

      {/* Model performance */}
      <div className="card">
        <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
          <h3 className="text-sm font-semibold text-white">Model Performance (ROC-AUC vs Average Precision)</h3>
          {ensembleF1 != null && (
            <span className="text-xs text-slate-400">
              Ensemble F1: <span className="font-semibold text-slate-200">{ensembleF1.toFixed(3)}</span>
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Average Precision is the more meaningful metric here — fraud is ~0.1% of transactions in this dataset, which
          makes F1/accuracy alone misleading even for a genuinely strong model (ROC-AUC 0.93 here vs. F1{' '}
          {ensembleF1 != null ? ensembleF1.toFixed(3) : '0.456'} at that imbalance is expected, not a weak result).
        </p>
        {modelRows.length > 0 ? (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={modelRows} layout="vertical" margin={{ left: 24 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
              <XAxis type="number" domain={[0, 1]} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" tick={{ fill: '#cbd5e1', fontSize: 11 }} axisLine={false} tickLine={false} width={110} />
              <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }} />
              <Legend formatter={(v) => <span style={{ color: '#94a3b8', fontSize: 11 }}>{v}</span>} />
              <Bar dataKey="rocAuc" name="ROC-AUC" fill="#38bdf8" radius={[0, 4, 4, 0]} />
              <Bar dataKey="avgPrecision" name="Avg. Precision" fill="#a78bfa" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-48 flex items-center justify-center text-slate-500 text-sm">No evaluated models yet</div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* SHAP feature importance */}
        <div className="card">
          <h3 className="text-sm font-semibold text-white mb-4">SHAP Feature Importance (Top 8)</h3>
          {shapRows.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={shapRows} layout="vertical" margin={{ left: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                <XAxis type="number" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="feature" tick={{ fill: '#cbd5e1', fontSize: 10 }} axisLine={false} tickLine={false} width={120} />
                <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }} />
                <Bar dataKey="importance" fill="#a78bfa" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-48 flex items-center justify-center text-slate-500 text-sm">No SHAP data yet</div>
          )}
        </div>

        {/* Processing time trend */}
        <div className="card">
          <h3 className="text-sm font-semibold text-white mb-4">Processing Time — Recent Jobs</h3>
          {trend.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={trend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="name" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} unit="s" />
                <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }} />
                <Line type="monotone" dataKey="seconds" stroke="#38bdf8" strokeWidth={2} dot={{ r: 3 }} name="Seconds" />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-48 flex items-center justify-center text-slate-500 text-sm">No completed jobs yet</div>
          )}
        </div>
      </div>

      {data?.gnnAvailable && data?.gnnPerformance && (
        <div className="card">
          <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
            <Network className="w-4 h-4 text-violet-400" /> GNN Model (optional 4th signal)
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
            {Object.entries(data.gnnPerformance).map(([k, v]) => (
              <div key={k} className="p-3 rounded-lg bg-slate-700/40">
                <p className="text-xs text-slate-400 capitalize">{k.replace(/_/g, ' ')}</p>
                <p className="text-lg font-bold text-white mt-1">{typeof v === 'number' ? v.toFixed(3) : String(v)}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// Demo-mode fallback, consistent with the rest of the app's offline-friendly pattern
const MOCK_PERFORMANCE = {
  demoMode: true,
  modelAvailable: false,
  gnnAvailable: false,
  modelPerformance: {
    isolation_forest_roc_auc: 0.712, isolation_forest_avg_prec: 0.002,
    autoencoder_roc_auc: 0.535, autoencoder_avg_prec: 0.001,
    xgboost_roc_auc: 0.984, xgboost_avg_prec: 0.440,
    ensemble_roc_auc: 0.930, ensemble_avg_prec: 0.401, ensemble_f1: 0.4558
  },
  shapFeatureImportance: {
    amount_paid_log: 0.312, sender_total_amount: 0.221, same_currency: 0.158,
    receiver_txn_count: 0.121, payment_format_enc: 0.098, hour: 0.061,
    same_bank: 0.019, day_of_week: 0.010
  },
  systemStats: {
    totalJobsRun: 2, totalTransactionsProcessed: 125430,
    avgProcessingTimeMs: 48200, maxProcessingTimeMs: 61500
  },
  recentJobsTrend: [
    { totalTransactions: 52000, processingTimeMs: 41200 },
    { totalTransactions: 73430, processingTimeMs: 55300 }
  ]
}
