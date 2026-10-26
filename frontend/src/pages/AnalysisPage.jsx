import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { analysisAPI, uploadAPI, reportAPI } from '../utils/api'
import toast from 'react-hot-toast'
import {
  Search, Filter, Download, GitBranch, ChevronLeft,
  Loader2, AlertTriangle, CheckCircle, BarChart3, X, FileDown, ShieldCheck
} from 'lucide-react'

const RISK_COLORS = { Critical: '#ef4444', High: '#f59e0b', Medium: '#3b82f6', Low: '#22c55e' }

function RiskGauge({ score }) {
  const r = 40, circ = 2 * Math.PI * r
  const pct = Math.min(score, 100) / 100
  const color = score >= 75 ? '#ef4444' : score >= 55 ? '#f59e0b' : score >= 35 ? '#3b82f6' : '#22c55e'
  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width="96" height="96" viewBox="0 0 96 96">
        <circle cx="48" cy="48" r={r} fill="none" stroke="#1e293b" strokeWidth="8" />
        <circle cx="48" cy="48" r={r} fill="none" stroke={color} strokeWidth="8"
          strokeDasharray={`${circ * pct} ${circ * (1 - pct)}`}
          strokeDashoffset={circ / 4}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 1s ease' }}
        />
      </svg>
      <div className="absolute text-center">
        <span className="text-xl font-bold text-white">{score?.toFixed(0)}</span>
        <span className="text-xs text-slate-400 block -mt-1">/ 100</span>
      </div>
    </div>
  )
}

function SHAPBar({ feature, value, maxValue }) {
  const pct = Math.min((value / maxValue) * 100, 100)
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-slate-400 w-40 truncate flex-shrink-0">{feature}</span>
      <div className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden">
        <div className="h-full bg-sky-400 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-300 w-10 text-right">{(value * 100).toFixed(1)}%</span>
    </div>
  )
}

export default function AnalysisPage() {
  const { jobId } = useParams()
  const navigate = useNavigate()
  const [job, setJob] = useState(null)
  const [transactions, setTransactions] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [selectedTx, setSelectedTx] = useState(null)
  const [generatingReport, setGeneratingReport] = useState(false)

  const LIMIT = 50

  useEffect(() => { loadJob() }, [jobId])
  useEffect(() => { loadTransactions() }, [jobId, page, filter, search])

  const loadJob = async () => {
    try {
      const res = await uploadAPI.getJobStatus(jobId)
      setJob(res.data)
    } catch { setJob(MOCK_JOB) }
  }

  const loadTransactions = async () => {
    setLoading(true)
    try {
      const res = await analysisAPI.getJobTransactions(jobId, {
        page, limit: LIMIT, filter: filter !== 'all' ? filter : undefined, search: search || undefined
      })
      setTransactions(res.data.transactions)
      setTotal(res.data.total)
    } catch {
      setTransactions(MOCK_TRANSACTIONS)
      setTotal(MOCK_TRANSACTIONS.length)
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = useCallback((e) => {
    setSearch(e.target.value)
    setPage(1)
  }, [])

  const handleDownloadReport = async () => {
    setGeneratingReport(true)
    try {
      const res = await reportAPI.generateReport(jobId)
      const blob = new Blob([res.data], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `DeepGuard_Report_${jobId}.pdf`; a.click()
      URL.revokeObjectURL(url)
      toast.success('Report downloaded!')
      await loadJob() // refresh so job.reportHash is populated — enables the Verify button below
    } catch (err) {
      toast.error('Report generation failed: ' + err.message)
    } finally {
      setGeneratingReport(false)
    }
  }

  // FR-11 — Evidence Integrity Hash verification
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState(null)
  const handleVerifyReport = async () => {
    setVerifying(true)
    try {
      const res = await reportAPI.verifyReport(jobId)
      setVerifyResult(res.data)
    } catch (err) {
      toast.error('Verification failed: ' + err.message)
    } finally {
      setVerifying(false)
    }
  }

  const [exporting, setExporting] = useState(false)
  const handleExport = async (format) => {
    setExporting(true)
    try {
      const res = await analysisAPI.exportJob(jobId, format, filter !== 'all' ? filter : undefined)
      const blob = new Blob([res.data], { type: format === 'csv' ? 'text/csv' : 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `deepguard_export_${jobId}.${format}`; a.click()
      URL.revokeObjectURL(url)
      toast.success(`Exported as ${format.toUpperCase()}`)
    } catch (err) {
      toast.error('Export failed: ' + err.message)
    } finally {
      setExporting(false)
    }
  }

  const riskLevelClass = (level) => ({
    Critical: 'badge-critical', High: 'badge-high', Medium: 'badge-medium', Low: 'badge-low'
  })[level] || 'badge-low'

  const j = job || MOCK_JOB
  const shapEntries = selectedTx?.shapValues
    ? Object.entries(selectedTx.shapValues).sort((a, b) => b[1] - a[1]).slice(0, 8)
    : []
  const maxShap = shapEntries.length > 0 ? shapEntries[0][1] : 1

  return (
    <div className="flex h-full">

      {/* ── Main Panel ── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate(-1)} className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div>
              <h1 className="font-bold text-white text-sm">{j.originalName}</h1>
              <p className="text-xs text-slate-400">
                {(j.totalTransactions || 0).toLocaleString()} transactions · {j.flaggedCount} flagged
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Summary chips */}
            <span className="badge-critical">{j.criticalCount} Critical</span>
            <span className="badge-high">{(j.flaggedCount - j.criticalCount)} High+</span>

            <button onClick={() => handleExport('csv')} disabled={exporting}
              className="btn-secondary text-xs flex items-center gap-1.5">
              {exporting ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileDown className="w-3 h-3" />}
              CSV
            </button>
            <button onClick={() => handleExport('json')} disabled={exporting}
              className="btn-secondary text-xs flex items-center gap-1.5">
              {exporting ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileDown className="w-3 h-3" />}
              JSON
            </button>

            <button onClick={handleDownloadReport} disabled={generatingReport}
              className="btn-primary text-xs flex items-center gap-1.5">
              {generatingReport ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              PDF Report
            </button>

            <button onClick={handleVerifyReport} disabled={verifying || !j.reportHash}
              title={!j.reportHash ? 'Generate a PDF report first' : "Verify this job's evidence integrity hash"}
              className="btn-secondary text-xs flex items-center gap-1.5 disabled:opacity-40">
              {verifying ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />}
              Verify
            </button>
          </div>
        </div>

        {/* FR-11 — Evidence integrity verification result */}
        {verifyResult && (
          <div className="mx-5 mt-3 p-3 rounded-lg bg-sky-950/40 border border-sky-800/50 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-sky-300 mb-1 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5" /> Evidence Integrity — SHA-256
              </p>
              <p className="text-[11px] font-mono text-slate-300 break-all">{verifyResult.evidenceHash}</p>
              <p className="text-[11px] text-slate-500 mt-1">
                Generated {new Date(verifyResult.reportGeneratedAt).toLocaleString()} · compare this against the hash
                printed in the footer of your PDF copy — a match confirms the findings haven't been altered.
              </p>
            </div>
            <button onClick={() => setVerifyResult(null)} className="text-slate-500 hover:text-slate-300 flex-shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Filters */}
        <div className="px-5 py-3 border-b border-slate-800 flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              value={search} onChange={handleSearch} placeholder="Search transaction ID, account…"
              className="input w-full pl-8 text-xs h-8"
            />
          </div>
          <div className="flex items-center gap-1">
            {['all', 'fraud', 'critical', 'high'].map(f => (
              <button key={f} onClick={() => { setFilter(f); setPage(1) }}
                className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors capitalize
                  ${filter === f ? 'bg-sky-500 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>
                {f}
              </button>
            ))}
          </div>
          <span className="text-xs text-slate-400 ml-auto">{total.toLocaleString()} results</span>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <Loader2 className="w-6 h-6 text-sky-400 animate-spin" />
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-slate-800/80 sticky top-0">
                <tr>
                  {['Transaction ID', 'Account', 'To Account', 'Amount', 'Format', 'IF Score', 'AE Score', 'Risk Score', 'Level', 'Category', 'Action'].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-slate-400 font-semibold whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => (
                  <tr key={tx.transactionId}
                    onClick={() => setSelectedTx(tx)}
                    className={`border-b border-slate-800/50 cursor-pointer transition-colors
                      ${selectedTx?.transactionId === tx.transactionId ? 'bg-sky-500/10' : 'hover:bg-slate-800/60'}
                      ${tx.riskLevel === 'Critical' ? 'border-l-2 border-l-red-500' : ''}`}>
                    <td className="px-4 py-2.5 font-mono text-slate-200">{tx.transactionId}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-400">{tx.account || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-400">{tx.toAccount || '—'}</td>
                    <td className="px-4 py-2.5 text-white font-medium">${(tx.amountPaid || 0).toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-slate-300">{tx.paymentFormat || '—'}</td>
                    <td className="px-4 py-2.5 text-sky-300">{tx.isolationForestScore?.toFixed(1)}</td>
                    <td className="px-4 py-2.5 text-purple-300">{tx.autoencoderScore?.toFixed(1)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 w-16 bg-slate-700 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{
                            width: `${tx.riskScore}%`,
                            backgroundColor: RISK_COLORS[tx.riskLevel] || '#64748b'
                          }} />
                        </div>
                        <span className="font-bold text-white">{tx.riskScore?.toFixed(1)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={riskLevelClass(tx.riskLevel)}>{tx.riskLevel}</span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-300 max-w-36 truncate">{tx.fraudCategory}</td>
                    <td className="px-4 py-2.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); navigate(`/graph/${tx.transactionId}?jobId=${jobId}`) }}
                        className="p-1.5 rounded-lg hover:bg-slate-600 text-slate-400 hover:text-sky-400 transition-colors">
                        <GitBranch className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        <div className="px-5 py-3 border-t border-slate-800 flex items-center justify-between">
          <span className="text-xs text-slate-400">
            Showing {Math.min((page - 1) * LIMIT + 1, total)}–{Math.min(page * LIMIT, total)} of {total.toLocaleString()}
          </span>
          <div className="flex gap-1">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
              className="btn-secondary text-xs py-1 px-3 disabled:opacity-40">Prev</button>
            <button onClick={() => setPage(p => p + 1)} disabled={page * LIMIT >= total}
              className="btn-secondary text-xs py-1 px-3 disabled:opacity-40">Next</button>
          </div>
        </div>
      </div>

      {/* ── Detail Panel ── */}
      {selectedTx && (
        <div className="w-80 flex-shrink-0 border-l border-slate-800 bg-slate-900 overflow-y-auto">
          <div className="p-4 border-b border-slate-800 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Transaction Detail</h3>
            <button onClick={() => setSelectedTx(null)} className="text-slate-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-4 space-y-5">
            {/* Risk Gauge */}
            <div className="text-center">
              <RiskGauge score={selectedTx.riskScore} />
              <span className={`mt-2 inline-block ${riskLevelClass(selectedTx.riskLevel)}`}>
                {selectedTx.riskLevel} Risk
              </span>
              <p className="text-xs text-slate-400 mt-1">{selectedTx.fraudCategory}</p>
            </div>

            {/* Transaction Fields */}
            <div className="space-y-2">
              {[
                { label: 'Transaction ID', value: selectedTx.transactionId, mono: true },
                { label: 'Sender Account', value: selectedTx.account || '—', mono: true },
                { label: 'Receiver Account', value: selectedTx.toAccount || '—', mono: true },
                { label: 'Amount Paid', value: `$${(selectedTx.amountPaid || 0).toLocaleString()}` },
                { label: 'Payment Format', value: selectedTx.paymentFormat || '—' },
                { label: 'Currency', value: `${selectedTx.paymentCurrency || '?'} → ${selectedTx.receivingCurrency || '?'}` },
              ].map(({ label, value, mono }) => (
                <div key={label} className="flex justify-between gap-2">
                  <span className="text-xs text-slate-400 flex-shrink-0">{label}</span>
                  <span className={`text-xs font-medium text-slate-200 text-right truncate ${mono ? 'font-mono' : ''}`}>{value}</span>
                </div>
              ))}
            </div>

            {/* Model Scores */}
            <div>
              <p className="text-xs text-slate-400 font-semibold uppercase mb-2">Model Scores</p>
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-400">Isolation Forest</span>
                  <span className="text-sky-400 font-bold">{selectedTx.isolationForestScore?.toFixed(1)}/100</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-400">Autoencoder</span>
                  <span className="text-purple-400 font-bold">{selectedTx.autoencoderScore?.toFixed(1)}/100</span>
                </div>
                <div className="flex justify-between text-xs border-t border-slate-700 pt-1.5 mt-1.5">
                  <span className="text-slate-300 font-semibold">Ensemble Score</span>
                  <span className="text-white font-bold">{selectedTx.riskScore?.toFixed(1)}/100</span>
                </div>
              </div>
            </div>

            {/* SHAP Explanations */}
            {shapEntries.length > 0 && (
              <div>
                <p className="text-xs text-slate-400 font-semibold uppercase mb-3">
                  SHAP — Why Flagged?
                </p>
                <div className="space-y-2">
                  {shapEntries.map(([feat, val]) => (
                    <SHAPBar key={feat} feature={feat} value={val} maxValue={maxShap} />
                  ))}
                </div>
                <p className="text-xs text-slate-500 mt-3">
                  Bars show relative contribution of each feature to the anomaly score.
                </p>
              </div>
            )}

            {/* Graph Button */}
            <button
              onClick={() => navigate(`/graph/${selectedTx.transactionId}?jobId=${jobId}`)}
              className="btn-secondary w-full flex items-center justify-center gap-2 text-xs">
              <GitBranch className="w-3.5 h-3.5" />
              Trace Network Graph
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Demo data
const MOCK_JOB = { jobId: 'demo-1', originalName: 'HI_Small_Trans.csv', totalTransactions: 52000, flaggedCount: 1842, criticalCount: 289, averageRiskScore: 18.4 }
const MOCK_TRANSACTIONS = Array.from({ length: 20 }, (_, i) => ({
  transactionId: `TX-${String(i + 1).padStart(5, '0')}`,
  account: `ACC${Math.floor(Math.random() * 9000) + 1000}`,
  toAccount: `ACC${Math.floor(Math.random() * 9000) + 1000}`,
  amountPaid: Math.round(Math.random() * 500000),
  amountReceived: Math.round(Math.random() * 500000),
  paymentFormat: ['Wire', 'ACH', 'Bitcoin', 'Cheque'][Math.floor(Math.random() * 4)],
  paymentCurrency: 'USD',
  receivingCurrency: ['USD', 'EUR', 'BTC'][Math.floor(Math.random() * 3)],
  riskScore: Math.round(Math.random() * 100 * 10) / 10,
  riskLevel: ['Critical', 'High', 'Medium', 'Low'][Math.floor(Math.random() * 4)],
  isFraud: Math.random() > 0.5,
  isolationForestScore: Math.round(Math.random() * 100 * 10) / 10,
  autoencoderScore: Math.round(Math.random() * 100 * 10) / 10,
  fraudCategory: ['High-Risk AML Typology', 'Circular Transaction', 'Suspicious Layering', 'Clean'][Math.floor(Math.random() * 4)],
  shapValues: { 'Amount Paid': 0.38, 'Amount_Ratio': 0.22, 'Log_Amount_Paid': 0.16, 'Payment Format_enc': 0.12, 'Hour': 0.07, 'DayOfWeek': 0.05 }
}))
