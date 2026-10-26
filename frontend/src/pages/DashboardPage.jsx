import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSelector } from 'react-redux'
import { dashboardAPI, uploadAPI } from '../utils/api'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts'
import { Shield, AlertTriangle, TrendingUp, Activity, FileUp, ChevronRight, Loader2, Clock } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import toast from 'react-hot-toast'

const RISK_COLORS = { Critical: '#ef4444', High: '#f59e0b', Medium: '#3b82f6', Low: '#22c55e' }

function StatCard({ icon: Icon, label, value, sub, color = 'sky' }) {
  const colorMap = {
    sky:   'text-sky-400 bg-sky-500/10 border-sky-500/20',
    red:   'text-red-400 bg-red-500/10 border-red-500/20',
    amber: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
    green: 'text-green-400 bg-green-500/10 border-green-500/20',
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

function RiskBadge({ level }) {
  return <span className={`badge-${level?.toLowerCase()} capitalize`}>{level}</span>
}

export default function DashboardPage() {
  const { user, role } = useSelector(s => s.auth)
  const navigate = useNavigate()
  const [overview, setOverview] = useState(null)
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    setLoading(true)
    try {
      const [ovRes, jobRes] = await Promise.all([
        dashboardAPI.getOverview(),
        uploadAPI.getJobs()
      ])
      setOverview(ovRes.data)
      setJobs(jobRes.data || [])
    } catch {
      // Demo mode — use mock data
      setOverview(MOCK_OVERVIEW)
      setJobs(MOCK_JOBS)
    } finally {
      setLoading(false)
    }
  }

  const totals = overview?.totals || {}
  const alerts = overview?.recentAlerts || []
  const riskBreakdown = overview?.riskBreakdown || []

  // Build pie data
  const pieData = riskBreakdown.map(r => ({
    name: r._id || 'Unknown',
    value: r.count,
    color: RISK_COLORS[r._id] || '#64748b'
  }))

  // Build trend data from jobs
  const trendData = jobs.slice(0, 7).reverse().map((j, i) => ({
    name: `Job ${i + 1}`,
    flagged: j.flaggedCount || 0,
    total: j.totalTransactions || 0,
    risk: Math.round(j.averageRiskScore || 0)
  }))

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-sky-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">
            Welcome back, {user?.email?.split('@')[0] || 'Auditor'} 👋
          </h1>
          <p className="text-slate-400 text-sm mt-0.5">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
          </p>
        </div>
        <button onClick={() => navigate('/upload')} className="btn-primary flex items-center gap-2">
          <FileUp className="w-4 h-4" />
          Upload Dataset
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Activity}      label="Total Transactions" value={(totals.totalTransactions || 0).toLocaleString()} color="sky" />
        <StatCard icon={AlertTriangle} label="Flagged as Fraud"   value={(totals.totalFlagged || 0).toLocaleString()}      color="red" sub={`${(((totals.totalFlagged||0)/(totals.totalTransactions||1))*100).toFixed(1)}% of total`} />
        <StatCard icon={Shield}        label="Critical Risk"      value={(totals.totalCritical || 0).toLocaleString()}     color="amber" />
        <StatCard icon={TrendingUp}    label="Jobs Processed"     value={jobs.length.toString()}                           color="green" sub="All time" />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Trend Chart */}
        <div className="card lg:col-span-2">
          <h3 className="text-sm font-semibold text-white mb-4">Flagged Transactions — Recent Jobs</h3>
          {trendData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={trendData}>
                <defs>
                  <linearGradient id="gFlagged" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="name" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }} />
                <Area type="monotone" dataKey="flagged" stroke="#ef4444" strokeWidth={2} fill="url(#gFlagged)" name="Flagged" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-48 flex items-center justify-center text-slate-500 text-sm">
              Upload a dataset to see trends
            </div>
          )}
        </div>

        {/* Pie Chart */}
        <div className="card">
          <h3 className="text-sm font-semibold text-white mb-4">Risk Distribution</h3>
          {pieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={pieData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value">
                  {pieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Pie>
                <Legend formatter={(v) => <span style={{ color: '#94a3b8', fontSize: 11 }}>{v}</span>} />
                <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-48 flex items-center justify-center text-slate-500 text-sm">No data yet</div>
          )}
        </div>
      </div>

      {/* Recent Alerts + Jobs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Recent High-Risk Alerts */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-white">Recent High-Risk Alerts</h3>
            <span className="badge-critical">{alerts.filter(a => a.riskLevel === 'Critical').length} Critical</span>
          </div>
          <div className="space-y-2">
            {alerts.length === 0 ? (
              <p className="text-slate-500 text-xs text-center py-6">No alerts yet. Upload a dataset.</p>
            ) : alerts.slice(0, 6).map((alert, i) => (
              <div key={i}
                onClick={() => navigate(`/graph/${alert.transactionId}`)}
                className="flex items-center justify-between p-3 rounded-lg bg-slate-700/40 hover:bg-slate-700/70 cursor-pointer transition-colors group">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-mono text-slate-200 truncate">{alert.transactionId}</p>
                  <p className="text-xs text-slate-400 mt-0.5">{alert.fraudCategory}</p>
                </div>
                <div className="flex items-center gap-2 ml-3">
                  <span className="text-xs font-bold text-red-400">{alert.riskScore?.toFixed(0)}</span>
                  <RiskBadge level={alert.riskLevel} />
                  <ChevronRight className="w-3 h-3 text-slate-600 group-hover:text-slate-300" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent Jobs */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-white">Recent Analysis Jobs</h3>
            <button onClick={() => navigate('/upload')} className="text-xs text-sky-400 hover:text-sky-300">View all</button>
          </div>
          <div className="space-y-2">
            {jobs.length === 0 ? (
              <p className="text-slate-500 text-xs text-center py-6">No jobs yet.</p>
            ) : jobs.slice(0, 6).map((job) => (
              <div key={job.jobId}
                onClick={() => job.status === 'completed' && navigate(`/analysis/${job.jobId}`)}
                className="flex items-center justify-between p-3 rounded-lg bg-slate-700/40 hover:bg-slate-700/70 cursor-pointer transition-colors">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-slate-200 truncate">{job.originalName}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <Clock className="w-3 h-3 text-slate-500" />
                    <p className="text-xs text-slate-500">{formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}</p>
                  </div>
                </div>
                <div className="ml-3 text-right">
                  <div className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                    job.status === 'completed' ? 'text-green-400 bg-green-500/10' :
                    job.status === 'failed'    ? 'text-red-400 bg-red-500/10' :
                    'text-amber-400 bg-amber-500/10'
                  }`}>{job.status}</div>
                  {job.status === 'completed' && (
                    <p className="text-xs text-slate-500 mt-0.5">{job.flaggedCount} flagged</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// Mock data for demo mode
const MOCK_OVERVIEW = {
  totals: { totalTransactions: 125430, totalFlagged: 3842, totalCritical: 289 },
  recentAlerts: [
    { transactionId: 'TX-00142', riskScore: 96.4, riskLevel: 'Critical', fraudCategory: 'High-Risk AML Typology' },
    { transactionId: 'TX-00891', riskScore: 88.2, riskLevel: 'Critical', fraudCategory: 'Circular Transaction' },
    { transactionId: 'TX-02341', riskScore: 82.1, riskLevel: 'High',     fraudCategory: 'Suspicious Layering' },
    { transactionId: 'TX-05621', riskScore: 76.3, riskLevel: 'High',     fraudCategory: 'Unusual Transfer Volume' },
    { transactionId: 'TX-09210', riskScore: 71.8, riskLevel: 'High',     fraudCategory: 'Cryptocurrency Laundering' },
  ],
  riskBreakdown: [
    { _id: 'Critical', count: 289 },
    { _id: 'High',     count: 1204 },
    { _id: 'Medium',   count: 2349 },
    { _id: 'Low',      count: 121588 },
  ]
}

const MOCK_JOBS = [
  { jobId: 'demo-1', originalName: 'HI_Small_Trans.csv', status: 'completed', flaggedCount: 1842, totalTransactions: 52000, averageRiskScore: 18.4, createdAt: new Date(Date.now() - 3600000).toISOString() },
  { jobId: 'demo-2', originalName: 'LI_Small_Trans.csv', status: 'completed', flaggedCount: 2000, totalTransactions: 73430, averageRiskScore: 21.1, createdAt: new Date(Date.now() - 86400000).toISOString() },
]
