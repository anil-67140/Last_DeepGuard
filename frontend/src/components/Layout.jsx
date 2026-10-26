import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useSelector, useDispatch } from 'react-redux'
import { supabase } from '../utils/api'
import { clearUser } from '../store'
import toast from 'react-hot-toast'
import {
  LayoutDashboard, Upload, BarChart3, GitBranch, Gauge,
  FileText, Settings, LogOut, Shield, ChevronRight
} from 'lucide-react'

const NAV_ITEMS = [
  { to: '/dashboard',    icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/upload',       icon: Upload,           label: 'Upload File' },
  { to: '/reports',      icon: FileText,         label: 'Reports' },
  { to: '/performance',  icon: Gauge,            label: 'Performance' }, // FR-12
]

const ADMIN_ITEMS = [
  { to: '/admin', icon: Settings, label: 'Admin Panel' },
]

export default function Layout() {
  const { user, role } = useSelector(s => s.auth)
  const dispatch = useDispatch()
  const navigate = useNavigate()

  const handleLogout = async () => {
    await supabase.auth.signOut()
    dispatch(clearUser())
    navigate('/login')
    toast.success('Logged out')
  }

  return (
    <div className="flex h-screen bg-slate-900 overflow-hidden">

      {/* ── Sidebar ── */}
      <aside className="w-60 flex-shrink-0 flex flex-col bg-slate-900 border-r border-slate-800">

        {/* Logo */}
        <div className="p-5 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-sky-500/20 border border-sky-500/30 flex items-center justify-center">
              <Shield className="w-5 h-5 text-sky-400" />
            </div>
            <div>
              <h1 className="font-bold text-white text-sm leading-none">DeepGuard</h1>
              <p className="text-xs text-slate-500 mt-0.5">Financial Forensics</p>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          <p className="text-xs text-slate-600 font-semibold uppercase tracking-wider px-3 mb-2">Navigation</p>
          {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `sidebar-link ${isActive ? 'active' : ''}`
              }
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              <span>{label}</span>
            </NavLink>
          ))}

          {role === 'admin' && (
            <>
              <p className="text-xs text-slate-600 font-semibold uppercase tracking-wider px-3 mb-2 mt-5">Admin</p>
              {ADMIN_ITEMS.map(({ to, icon: Icon, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  <span>{label}</span>
                </NavLink>
              ))}
            </>
          )}
        </nav>

        {/* User */}
        <div className="p-3 border-t border-slate-800">
          <div className="flex items-center gap-3 px-3 py-2 mb-1">
            <div className="w-8 h-8 rounded-full bg-sky-500/20 border border-sky-500/30 flex items-center justify-center text-xs font-bold text-sky-400 uppercase">
              {user?.email?.[0] || 'U'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-slate-200 truncate">{user?.email}</p>
              <p className="text-xs text-slate-500 capitalize">{role}</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="sidebar-link w-full hover:text-red-400 hover:bg-red-500/10"
          >
            <LogOut className="w-4 h-4" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  )
}
