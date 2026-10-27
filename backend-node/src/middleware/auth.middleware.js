const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

// ADMIN client (service_role). Used for the Admin API and for reading/writing the
// `profiles` table. IMPORTANT: never call signInWithPassword()/signUp() on this
// client — doing so replaces its service-role token with that user's token, and
// every later table query would then run as that user (blocked by RLS).
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, clientOptions);

// Throwaway client for sign-in / sign-up calls (one per request, never shared).
const createAuthClient = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, clientOptions);

const VALID_ROLES = ['admin', 'auditor', 'analyst'];

// ── profiles table helpers ──────────────────────────────────────────────────
// public.profiles is the single source of truth for roles (see
// supabase/001_profiles.sql). user_metadata is NOT trusted for permissions
// because users can edit it themselves from the browser.

const ROLE_TTL_MS = 30 * 1000; // avoid one DB hit per request (the dashboard polls a lot)
const roleCache = new Map();   // userId -> { role, expires }
const invalidateRoleCache = (userId) => roleCache.delete(userId);

let warnedMissingTable = false;
const warnMissingTable = (error) => {
  if (warnedMissingTable) return;
  warnedMissingTable = true;
  console.error(
    `❌ Could not use the Supabase "profiles" table: ${error.message}\n` +
    '   → Run supabase/001_profiles.sql in Supabase Dashboard → SQL Editor. ' +
    'Until then every user is treated as "auditor".'
  );
};

/**
 * Create/update a user's row in public.profiles.
 * `role` is optional: when omitted, an existing row keeps its role and a new row gets 'auditor'.
 */
async function upsertProfile({ id, email, role, full_name }) {
  const row = { id, email, updated_at: new Date().toISOString() };
  if (role) row.role = role;
  if (full_name) row.full_name = full_name;
  const { data, error } = await supabase
    .from('profiles')
    .upsert(row, { onConflict: 'id' })
    .select('id, email, role')
    .single();
  if (error) throw error;
  invalidateRoleCache(id);
  return data;
}

/** Read the role from public.profiles (creates an 'auditor' row if the user has none yet). */
async function getRole(user) {
  const cached = roleCache.get(user.id);
  if (cached && cached.expires > Date.now()) return cached.role;

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    if (error) throw error;

    let role = data?.role;
    if (!role) {
      const created = await upsertProfile({ id: user.id, email: user.email }); // self-heal
      role = created.role;
    }
    roleCache.set(user.id, { role, expires: Date.now() + ROLE_TTL_MS });
    return role;
  } catch (err) {
    warnMissingTable(err);
    return 'auditor'; // fail closed: never fall back to user-editable metadata
  }
}

/**
 * Verify Supabase JWT token — protect routes
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = user;
    req.userId = user.id;
    req.userRole = await getRole(user); // from the profiles table

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Authentication failed' });
  }
};

/**
 * Require admin role
 */
const requireAdmin = (req, res, next) => {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

/**
 * Require auditor or admin role
 */
const requireAuditor = (req, res, next) => {
  if (!['admin', 'auditor'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Auditor access required' });
  }
  next();
};

module.exports = {
  authenticate, requireAdmin, requireAuditor,
  supabase, createAuthClient,
  upsertProfile, getRole, invalidateRoleCache, VALID_ROLES,
};
