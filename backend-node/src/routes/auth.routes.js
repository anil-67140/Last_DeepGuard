// ── auth.routes.js ──
const router1 = require('express').Router();
const { supabase } = require('../middleware/auth.middleware');

router1.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });
    res.json({ user: data.user, session: data.session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router1.post('/register', async (req, res) => {
  try {
    const { email, password, role = 'auditor' } = req.body;
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { role } }
    });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ user: data.user, message: 'Registration successful' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router1.post('/logout', async (req, res) => {
  try {
    await supabase.auth.signOut();
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router1;
