import { useEffect } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { useDispatch, useSelector } from 'react-redux'
import { supabase } from './utils/api'
import { setUser, clearUser } from './store'

import LoginPage      from './pages/LoginPage'
import DashboardPage  from './pages/DashboardPage'
import UploadPage     from './pages/UploadPage'
import AnalysisPage   from './pages/AnalysisPage'
import GraphPage      from './pages/GraphPage'
import ReportsPage    from './pages/ReportsPage'
import PerformancePage from './pages/PerformancePage'
import AdminPage      from './pages/AdminPage'
import Layout         from './components/Layout'

function ProtectedRoute({ children, adminOnly = false }) {
  const { user, role } = useSelector(s => s.auth)
  if (!user) return <Navigate to="/login" replace />
  if (adminOnly && role !== 'admin') return <Navigate to="/dashboard" replace />
  return children
}

export default function App() {
  const dispatch = useDispatch()
  const navigate = useNavigate()

  useEffect(() => {
    // Restore session on mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) dispatch(setUser({ user: session.user, session }))
    })

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) {
        dispatch(setUser({ user: session.user, session }))
      } else if (event === 'SIGNED_OUT') {
        dispatch(clearUser())
        navigate('/login')
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route path="/" element={
        <ProtectedRoute><Layout /></ProtectedRoute>
      }>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="upload"    element={<UploadPage />} />
        <Route path="analysis/:jobId" element={<AnalysisPage />} />
        <Route path="graph/:transactionId" element={<GraphPage />} />
        <Route path="reports"   element={<ReportsPage />} />
        <Route path="performance" element={<PerformancePage />} />
        <Route path="admin"     element={
          <ProtectedRoute adminOnly><AdminPage /></ProtectedRoute>
        } />
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  )
}
