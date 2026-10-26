import { configureStore, createSlice } from '@reduxjs/toolkit'

// ── Auth Slice ──
const authSlice = createSlice({
  name: 'auth',
  initialState: { user: null, session: null, role: 'auditor', loading: false },
  reducers: {
    setUser:    (state, { payload }) => { state.user = payload.user; state.session = payload.session; state.role = payload.user?.user_metadata?.role || 'auditor'; },
    clearUser:  (state) => { state.user = null; state.session = null; state.role = 'auditor'; },
    setLoading: (state, { payload }) => { state.loading = payload; },
  }
})

// ── Jobs Slice ──
const jobsSlice = createSlice({
  name: 'jobs',
  initialState: { list: [], activeJob: null, jobProgress: {} },
  reducers: {
    setJobs:        (state, { payload }) => { state.list = payload; },
    setActiveJob:   (state, { payload }) => { state.activeJob = payload; },
    updateProgress: (state, { payload }) => { state.jobProgress[payload.jobId] = payload; },
    addJob:         (state, { payload }) => { state.list.unshift(payload); },
    updateJob:      (state, { payload }) => {
      const idx = state.list.findIndex(j => j.jobId === payload.jobId);
      if (idx !== -1) state.list[idx] = { ...state.list[idx], ...payload };
      if (state.activeJob?.jobId === payload.jobId) state.activeJob = { ...state.activeJob, ...payload };
    }
  }
})

// ── Transactions Slice ──
const txSlice = createSlice({
  name: 'transactions',
  initialState: { list: [], total: 0, page: 1, filter: 'all', search: '', loading: false },
  reducers: {
    setTransactions: (state, { payload }) => { state.list = payload.transactions; state.total = payload.total; },
    setPage:         (state, { payload }) => { state.page = payload; },
    setFilter:       (state, { payload }) => { state.filter = payload; state.page = 1; },
    setSearch:       (state, { payload }) => { state.search = payload; state.page = 1; },
    setLoading:      (state, { payload }) => { state.loading = payload; },
  }
})

// ── Dashboard Slice ──
const dashboardSlice = createSlice({
  name: 'dashboard',
  initialState: { overview: null, loading: false },
  reducers: {
    setOverview: (state, { payload }) => { state.overview = payload; },
    setLoading:  (state, { payload }) => { state.loading = payload; },
  }
})

export const { setUser, clearUser, setLoading: setAuthLoading } = authSlice.actions
export const { setJobs, setActiveJob, updateProgress, addJob, updateJob } = jobsSlice.actions
export const { setTransactions, setPage, setFilter, setSearch, setLoading: setTxLoading } = txSlice.actions
export const { setOverview, setLoading: setDashLoading } = dashboardSlice.actions

export const store = configureStore({
  reducer: {
    auth:         authSlice.reducer,
    jobs:         jobsSlice.reducer,
    transactions: txSlice.reducer,
    dashboard:    dashboardSlice.reducer,
  }
})
