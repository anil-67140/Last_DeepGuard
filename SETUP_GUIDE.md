# 🛡️ DeepGuard — Complete Setup Guide

> **Iqra University FYP 2023** |

---

## ✅ Prerequisites

| Tool    | Version    | Download                                       |
| ------- | ---------- | ---------------------------------------------- |
| Node.js | 18+        | https://nodejs.org                             |
| Python  | 3.10+      | https://python.org                             |
| MongoDB | 7+ (local) | https://www.mongodb.com/try/download/community |
| Git     | any        | https://git-scm.com                            |

---

## 🗂️ Project Structure Summary

```
deepguard/
├── 📓 notebooks/          ← Google Colab (train AI models)
├── 🤖 ai-engine/          ← Python FastAPI (AI microservice)
├── ⚙️  backend-node/      ← Node.js Express (API gateway)
└── 🌐 frontend/           ← React.js (dashboard)
```

---

## 📋 STEP-BY-STEP SETUP

### STEP 1 — Supabase (Free Auth + Database)

1. Go to **https://supabase.com** → Create account → New project
2. Go to **Project Settings → API**
3. Copy:
   - `Project URL` → used as `SUPABASE_URL` / `VITE_SUPABASE_URL`
   - `anon public` key → used as `VITE_SUPABASE_ANON_KEY`
   - `service_role` key → used as `SUPABASE_SERVICE_KEY`
4. Create the demo accounts — **do NOT use raw SQL `INSERT INTO auth.users`** (see
   warning below). Instead, after setting up `backend-node/.env` (Step 3 below), run:

```bash
cd backend-node
npm install
node scripts/create-demo-users.js
```

This creates `admin@deepguard.demo` / `auditor@deepguard.demo` (password
`deepguard123` for both) using Supabase's Admin API, which correctly sets up
everything a raw SQL insert misses.

> ⚠️ **Why not raw SQL?** An earlier version of this guide had you run
> `INSERT INTO auth.users (...) VALUES (...)` directly in the SQL Editor. **Don't do
> this.** Supabase's auth server (GoTrue) requires a matching row in
> `auth.identities` to log a user in with email+password — a raw `INSERT` into
> `auth.users` only creates half of what's needed, so `signInWithPassword()` will
> fail with `"Invalid login credentials"` even though the password hash is
> technically correct. Always create users via `supabase.auth.admin.createUser()`
> (the script above), `supabase.auth.signUp()` (your app's own `/api/auth/register`
> route), or the Supabase Dashboard's **Authentication → Users → Add User** button —
> all three correctly create the identity row too. If you already ran the broken SQL
> and users exist but can't log in, delete them (`DELETE FROM auth.users WHERE
> email IN (...)`) and re-run the script above.

---

### STEP 2 — Free AI for Reports (choose ONE)

#### Option A: Groq API (RECOMMENDED — Free, Fast, No credit card)

1. Go to **https://console.groq.com**
2. Sign up → Create API key (completely free)
3. Add to `backend-node/.env`:
   ```
   GROQ_API_KEY=gsk_your_key_here
   ```

#### Option B: Ollama (100% Local — No internet needed)

1. Download from **https://ollama.ai**
2. Install and run:
   ```bash
   ollama serve          # starts Ollama server
   ollama pull llama3    # download model (~4GB)
   ```
3. Add to `backend-node/.env`:
   ```
   OLLAMA_URL=http://localhost:11434
   OLLAMA_MODEL=llama3
   ```

#### Option C: OpenAI (Paid — optional)

```
OPENAI_API_KEY=sk-your-key-here
```

> **Note:** If none are set, DeepGuard generates reports with a built-in rule-based summary. Everything else still works perfectly.

---

### STEP 3 — Train AI Models (Google Colab)

1. Go to **https://colab.research.google.com**
2. Upload the notebooks from `notebooks/` folder to your Google Drive
3. Download the IBM AML dataset from Kaggle:
   - https://www.kaggle.com/datasets/ealtman2019/ibm-transactions-for-anti-money-laundering-aml
   - Use `HI-Small_Trans.csv`
4. Run **Notebook 1** (`01_EDA_and_Preprocessing.ipynb`) completely — upload the CSV when
   prompted, it preprocesses and downloads `preprocessed.zip`
5. Run **Notebook 2** (`02_Model_Training_and_Evaluation.ipynb`) completely — trains
   Isolation Forest, Autoencoder, and an Optuna-tuned XGBoost, then blends them into an
   ensemble. Mounts your Google Drive and checkpoints expensive steps (Autoencoder training,
   the 40-trial hyperparameter search) so a Colab disconnect doesn't cost you a full re-run.
   Takes 20–30 minutes end to end the first time; seconds on a resumed session.
6. At the end, `deepguard_improved_models.zip` downloads automatically
7. _(Optional)_ Run **Notebook 3** (`03_GNN_Model.ipynb`) for a graph-neural-network model
   trained on the same data. This one is **not yet wired into the live AI engine** — see
   "Known Limitations" in the root `README.md`. Treat it as a research/comparison result for
   your report, not something the running app currently uses.
8. Extract `deepguard_improved_models.zip` and copy its contents into `ai-engine/saved_models/`

```
ai-engine/saved_models/
├── isolation_forest.pkl
├── autoencoder.keras   (autoencoder.h5 also included as a fallback)
├── xgboost_model.json
├── scaler.pkl
├── feature_cols.pkl
└── model_metadata.json
```

> **Note:** If you skip this step, the AI engine runs in **DEMO MODE** — it still works but uses random predictions. Perfect for testing the UI! (The repo already ships with trained models in `ai-engine/saved_models/`, so this step is only needed if you want to retrain.)

---

### STEP 4 — Configure Environment Variables

#### `ai-engine/.env`

```env
MODEL_PATH=./saved_models
PORT=8000
```

#### `backend-node/.env`

```env
PORT=4000
NODE_ENV=development
MONGODB_URI=mongodb://localhost:27017/deepguard
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key
AI_ENGINE_URL=http://localhost:8000
FRONTEND_URL=http://localhost:5173
GROQ_API_KEY=gsk_your_key_here        # OR
# OLLAMA_URL=http://localhost:11434    # OR
# OPENAI_API_KEY=sk-...               # optional
```

#### `frontend/.env`

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key_here
VITE_API_URL=http://localhost:4000/api
VITE_SOCKET_URL=http://localhost:4000
```

---

### STEP 5 — Start MongoDB

```bash
# Windows
net start MongoDB

# macOS
brew services start mongodb-community

# Linux
sudo systemctl start mongod
```

---

### STEP 6 — Start All Services

#### Option A: One command (recommended)

```bash
cd deepguard
bash start-all.sh
```

#### Option B: Manual (3 separate terminals)

**Terminal 1 — AI Engine**

```bash
cd deepguard/ai-engine
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

**Terminal 2 — Node.js Backend**

```bash
cd deepguard/backend-node
npm install
npm run dev
```

**Terminal 3 — React Frontend**

```bash
cd deepguard/frontend
npm install
npm run dev
```

---

### STEP 7 — Access the App

| Service               | URL                        |
| --------------------- | -------------------------- |
| 🌐 Frontend Dashboard | http://localhost:5173      |
| ⚙️ Backend API        | http://localhost:4000/api  |
| 🤖 AI Engine          | http://localhost:8000      |
| 📖 AI API Docs        | http://localhost:8000/docs |

**Login credentials (demo):**

- Admin: `admin@deepguard.demo` / `deepguard123`
- Auditor: `auditor@deepguard.demo` / `deepguard123`

---

## 🧪 Testing Without Real Data

1. Login with demo credentials
2. Click **"Demo Auditor"** or **"Demo Admin"** on login page
3. Dashboard shows mock data immediately
4. Upload any CSV file — AI engine processes it (demo mode = random scores)
5. Network graph shows demo circular transaction pattern
6. PDF report generates with rule-based summary

---

## 🐛 Common Issues

| Issue                    | Fix                                                                     |
| ------------------------ | ----------------------------------------------------------------------- |
| MongoDB connection error | Make sure MongoDB is running: `mongod --dbpath /data/db`                |
| Supabase auth error      | Check SUPABASE_URL and keys in `.env` files                             |
| AI Engine 503            | Start `uvicorn main:app --reload` in `ai-engine/`                       |
| CORS error               | Make sure FRONTEND_URL in backend `.env` matches port 5173              |
| Port in use              | Change PORT in `.env` files                                             |
| Puppeteer error on PDF   | `npm install puppeteer` or use `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false` |

---

## 🏗️ Architecture Summary

```
React Frontend (5173)
    ↕ REST + Socket.IO
Node.js Backend (4000)
    ↕ REST API          ↕ MongoDB ($graphLookup)
Python FastAPI (8000)
    ↕ joblib/keras
Trained Models (pkl/keras files)
```

---

## 📊 IBM AML Dataset Info

| File                                          | Size                                      | Transactions                          |
| --------------------------------------------- | ----------------------------------------- | ------------------------------------- |
| **HI-Small_Trans.csv** (used by this project) | 476 MB                                    | ~5.08M (~0.10% flagged as laundering) |
| LI-Small_Trans.csv                            | check the Kaggle page — not verified here | —                                     |
| HI-Medium_Trans.csv                           | check the Kaggle page — not verified here | —                                     |

Use **HI-Small_Trans.csv** (note the hyphen — Kaggle's actual filename, not an underscore).
This is the only file this project's notebooks, `.gitignore`, and the numbers quoted throughout
this repo assume; the other variants are a different synthetic "world" with different account
IDs, not just a bigger sample of the same one, so don't mix them with the trained models here.

---

_DeepGuard — Iqra University CS Batch 2023 | Supervised by Dr. Dure e Jabeen_
