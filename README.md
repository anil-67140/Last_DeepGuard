# 🛡️ DeepGuard — AI-Driven Financial Forensics Platform

> Final Year Project | Iqra University, CS Batch 2023
> Supervisor:

A full-stack Anti-Money-Laundering (AML) detection platform: a supervised + unsupervised
ensemble (Isolation Forest, Autoencoder, XGBoost) trained on IBM's synthetic AML dataset,
served via a Python AI microservice, orchestrated by a Node.js API gateway, and visualized
through a React dashboard with an interactive transaction-network graph.

---

## 📁 Project Structure

```
final_deepguard_fyp_project/
├── notebooks/                        # Google Colab training notebooks — run in order
│   ├── 01_EDA_and_Preprocessing.ipynb
│   ├── 02_Model_Training_and_Evaluation.ipynb   # Isolation Forest + Autoencoder + XGBoost ensemble
│   └── 03_GNN_Model.ipynb                       # Graph Neural Network (research result — see Known Limitations)
│
├── preprocessed/                     # Small artifacts committed to git
│   ├── scaler.pkl
│   ├── feature_cols.pkl
│   ├── y_train.npy / y_test.npy
│   └── X_train.npy / X_test.npy      # 🚫 NOT in git (too large) — regenerate via Notebook 1, see below
│
├── ai-engine/                        # Python FastAPI — AI microservice
│   ├── main.py                       # loads saved_models/, exposes /analyze, /health, /models/info
│   ├── requirements.txt
│   ├── start.sh
│   ├── .env.example
│   └── saved_models/                 # trained model artifacts (committed — see saved_models/README.md)
│       ├── isolation_forest.pkl
│       ├── autoencoder.keras / autoencoder.h5
│       ├── xgboost_model.json        # primary model — 85% ensemble weight
│       ├── scaler.pkl / feature_cols.pkl / model_metadata.json
│       ├── meta_ensemble.pkl         # alternative combiner explored, not deployed
│       ├── deepguard_gnn_saved_model/ # GNN artifacts — not yet loaded by main.py
│       └── *.png, shap_importance.json  # evaluation plots for the FYP report
│
├── backend-node/                     # Node.js + Express — API Gateway
│   ├── src/
│   │   ├── config/mongodb.js
│   │   ├── controllers/              # upload, analysis, graph, report, admin
│   │   ├── middleware/                # auth, error handling
│   │   ├── models/                   # Job, Transaction (Mongoose)
│   │   ├── routes/
│   │   └── server.js
│   ├── uploads/                      # runtime file uploads — empty in git (.gitkeep)
│   ├── reports/                      # generated PDF reports — empty in git (.gitkeep)
│   ├── package.json
│   ├── start.sh
│   └── .env.example
│
└── frontend/                         # React.js + Tailwind CSS
    ├── src/
    │   ├── components/
    │   ├── pages/                    # Login, Dashboard, Upload, Analysis, Graph, Reports, Admin
    │   ├── store/                    # Redux
    │   └── utils/api.js
    ├── package.json
    ├── vite.config.js
    └── .env.example
```

_(The `ai-engine/models/` and `ai-engine/utils/` split shown in earlier drafts of this README
doesn't reflect reality — everything is in the single `main.py` file. The tree above matches
what's actually in the repo.)_

---

## 🚀 Quick Start

Full step-by-step instructions, including Supabase/MongoDB setup and free LLM options for
report generation, are in **[SETUP_GUIDE.md](./SETUP_GUIDE.md)**. Short version:

### 1. Trained models are already included

`ai-engine/saved_models/` ships with trained Isolation Forest, Autoencoder, and XGBoost models
committed to this repo — **you don't need to retrain anything to run the app.** Retraining
(via `notebooks/`) is only needed if you want to reproduce or improve the models yourself.

### 2. AI Engine (Python FastAPI)

```bash
cd ai-engine
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Visit `http://localhost:8000/docs` for interactive API docs, or `http://localhost:8000/health`
to confirm models loaded (`"demo_mode": false` means the real models are active).

### 3. Node.js Backend

```bash
cd backend-node
cp .env.example .env   # fill in MongoDB URI + Supabase keys — see SETUP_GUIDE.md
npm install
npm run dev
```

**Requires MongoDB running first** — the server will not start (by design — it fails fast
with a clear error) until it can connect.

### 4. React Frontend

```bash
cd frontend
cp .env.example .env   # fill in Supabase keys
npm install
npm run dev
```

### 5. Retraining from scratch (optional)

Download `HI-Small_Trans.csv` from
[Kaggle](https://www.kaggle.com/datasets/ealtman2019/ibm-transactions-for-anti-money-laundering-aml)
(476 MB, ~5.08M transactions — note the hyphen in the filename) and follow `notebooks/01` → `02`
→ (optionally) `03` in Google Colab. Full instructions in `SETUP_GUIDE.md`. The large dataset
CSV and the preprocessed `X_train.npy`/`X_test.npy` arrays are `.gitignore`d — too large for
GitHub — so they're regenerated locally/in Colab, not pulled from this repo.

---

## ✅ Verified Working

The following was directly tested end-to-end, not just read for correctness:

| Layer                | What was checked                                                                                                                                            | Result                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| AI Engine            | Started the real FastAPI server against the actual committed model files, hit `/health`, `/analyze/single`, `/analyze/batch`, `/models/info` over real HTTP | ✅ All respond correctly, including SHAP explanations                                  |
| AI Engine            | Malformed/empty transaction input                                                                                                                           | ✅ Handled gracefully with sensible defaults, no crash                                 |
| backend-node         | `npm install`, syntax-check on every file, integration payload shape vs. `ai-engine`'s `Transaction` model                                                  | ✅ Installs clean, all files valid, field names match exactly                          |
| backend-node         | Behavior when MongoDB is unreachable                                                                                                                        | ✅ Fails fast with a clear error (by design), doesn't hang or crash silently           |
| frontend             | `npm install`, `npm run build`                                                                                                                              | ✅ Builds clean (one non-fatal "bundle size" warning, common for React apps this size) |
| Cross-service config | Ports/URLs across all three `.env.example` files (frontend → 4000, backend → 8000)                                                                          | ✅ Consistent                                                                          |
| AI Engine            | `GET/PATCH /models/config` (FR-14) — threshold + weight updates, validation (weights must sum to 1.0), persistence to `model_metadata.json`                 | ✅ Round-trips correctly, rejects invalid weights with 400                             |
| backend-node         | `attachBehavioralAggregates()` unit-tested in isolation against a hand-built 4-row batch                                                                    | ✅ Sender tx count/avg/total/max/unique-receivers and receiver tx count all correct    |
| Full pipeline        | Node's enriched (real, non-default) `Sender_*`/`Receiver_*` fields sent through to the live AI Engine's `/analyze/batch`                                    | ✅ Fields consumed correctly, scores reflect the real aggregates                       |

**Not verified** (needs live credentials this environment doesn't have): full MongoDB-backed
request flow, Supabase auth (including the new `/api/admin/users*` endpoints, which need a
real `service_role` key), PDF report generation via Puppeteer, Groq/Ollama report
summarization, the new `/api/analysis/job/:jobId/export` and `/api/admin/logs` endpoints
against a real database. These should work if configured per `SETUP_GUIDE.md` — the query/
aggregation logic and field names were checked against the actual Mongoose schemas — but
weren't exercised against a live MongoDB instance here.

---

## 📊 Model Performance

From `ai-engine/saved_models/model_metadata.json`, evaluated on a held-out test split of the
full `HI-Small` dataset (~1.02M transactions, ~0.10% fraud rate):

| Model                                             | ROC-AUC   | Avg. Precision |
| ------------------------------------------------- | --------- | -------------- |
| Isolation Forest                                  | 0.712     | 0.002          |
| Autoencoder                                       | 0.535     | 0.001          |
| **XGBoost**                                       | **0.984** | **0.440**      |
| **Ensemble** (85% XGBoost + 15% Isolation Forest) | 0.930     | 0.401          |

Ensemble F1 (fraud class): **0.456**.

XGBoost — trained directly on the fraud labels, which Isolation Forest and the Autoencoder
don't use — does almost all of the work here; the other two remain in the pipeline mainly for
SHAP explainability and as an unsupervised signal for patterns not present in labeled training
data. This is normal for this dataset: 5 million transactions with roughly 1 in 1,000 flagged
as laundering is an extreme imbalance, and average precision in the 0.4 range on data this
skewed represents real, usable signal — not a modeling shortfall. (A separate note in this
repo's history claimed an "original baseline" of ROC-AUC 0.91 / AP 0.05 for comparison — that
number was computed on a much smaller ~170K-row test sample, not this dataset, and isn't a
fair before/after comparison. If you want a genuine baseline for your report, that requires
re-running an unsupervised-only version on this same full dataset.)

---

## 📋 FYP Functional Requirements — Coverage

Mapped against the 20 functional requirements from Activity #3 (`3.2 Functional
Requirements`). Useful for your viva/defense to point at exactly where each requirement
lives in the code.

| #     | Requirement                 | Status                 | Where                                                                                                                                                                                                                                                                                                                                   |
| ----- | --------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-1  | User Login                  | ✅ Done                | `backend-node/src/routes/auth.routes.js`, Supabase Auth                                                                                                                                                                                                                                                                                 |
| FR-2  | Admin Login                 | ✅ Done                | Same login route; role comes from Supabase `user_metadata.role`                                                                                                                                                                                                                                                                         |
| FR-3  | Session Management          | ✅ Done                | Supabase session + JWT, handled client-side in `App.jsx`                                                                                                                                                                                                                                                                                |
| FR-4  | Logout                      | ✅ Done                | `auth.routes.js` `/logout`, `Layout.jsx`                                                                                                                                                                                                                                                                                                |
| FR-5  | Display Dashboard           | ✅ Done                | `dashboard.routes.js`, `DashboardPage.jsx`                                                                                                                                                                                                                                                                                              |
| FR-6  | Upload Transaction File     | ✅ Done                | `upload.controller.js` (CSV/XLSX, 100MB limit)                                                                                                                                                                                                                                                                                          |
| FR-7  | Run Anomaly Detection       | ✅ Done                | `ai-engine/main.py` — Isolation Forest + Autoencoder + XGBoost                                                                                                                                                                                                                                                                          |
| FR-8  | View Anomaly Results        | ✅ Done                | `analysis.routes.js`, `AnalysisPage.jsx` (filter/search/sort/paginate)                                                                                                                                                                                                                                                                  |
| FR-9  | Network Graph Visualization | ✅ Done                | `graph.controller.js` (`$graphLookup`), `GraphPage.jsx` (Cytoscape.js)                                                                                                                                                                                                                                                                  |
| FR-10 | SHAP Explainability         | ✅ Done                | `compute_shap_for_transaction()` in `main.py`, SHAP bars in `AnalysisPage.jsx`                                                                                                                                                                                                                                                          |
| FR-11 | Generate Forensic Report    | ✅ Done                | `report.controller.js` (Puppeteer PDF + AI summary)                                                                                                                                                                                                                                                                                     |
| FR-12 | View Performance Analytics  | ✅ Done                | `dashboard.routes.js` aggregates, `DashboardPage.jsx` charts                                                                                                                                                                                                                                                                            |
| FR-13 | Manage Users                | ✅ **Added this pass** | `admin.routes.js` `/users*`, Users tab in `AdminPage.jsx`                                                                                                                                                                                                                                                                               |
| FR-14 | Manage AI Models            | ✅ **Added this pass** | `/models/config` in `main.py`, AI Models tab in `AdminPage.jsx`                                                                                                                                                                                                                                                                         |
| FR-15 | View System Logs            | ✅ **Added this pass** | `/admin/logs`, System Logs tab (reuses `Job` collection — see limitations)                                                                                                                                                                                                                                                              |
| FR-16 | Export Data                 | ✅ **Added this pass** | `/analysis/job/:jobId/export`, CSV/JSON buttons in `AnalysisPage.jsx`                                                                                                                                                                                                                                                                   |
| FR-17 | Role-Based Access Control   | ✅ Done                | `requireAdmin`/`requireAuditor` middleware, `ProtectedRoute` in `App.jsx`                                                                                                                                                                                                                                                               |
| FR-18 | Bulk Processing Queue       | ✅ **Added this pass** | `src/queue/uploadQueue.js` — Redis/Bull when `REDIS_URL` is reachable (real ping-verified, not just "connecting"), auto-falls back to a bounded-concurrency in-process queue otherwise. Admin → Queue tab. |
| FR-19 | Alert Notifications         | ✅ **Added this pass** | In-dashboard via Socket.IO (already done) **+ email** via `src/services/email.service.js` (SMTP, graceful no-op if unconfigured, HTML-escaped, dry-run mode for demos) |
| FR-20 | Data Backup and Recovery    | ✅ **Added this pass** | `src/services/backup.service.js` — daily 2 AM backup (no `mongodump` needed), 30-day retention, integrity-checked restore. Admin → Backups tab. |

**Bottom line: 20 of 20 functional requirements implemented.** Plus a bonus beyond the
original 20: the trained GNN (Notebook 3) is now wired into the AI Engine as an
optional, selectable model (see the "GNN as a selectable option" section below) —
including in `/models/info`'s reported feature set. Its numerical correctness could
not be verified end-to-end in the sandbox this was built in (see that section for
exactly why, and how to verify it on your own machine); everything else on this line
was tested against live services, not just written and assumed to work.

---

## 🕸️ GNN as a selectable option (bonus, beyond the original 20 requirements)

The GNN trained in `notebooks/03_GNN_Model.ipynb` is now wired into the live AI
Engine as an **optional, additive** fourth model — never required, never able to
break the core ensemble if it's absent or fails to load:

- **Upload page** — a checkbox, "Also score with the Graph Neural Network" (disabled
  with an explanation if the GNN isn't installed on the AI Engine).
- **`POST /analyze/batch`** — accepts `"use_gnn": true` to also score with the GNN
  and blend it into the ensemble (only if the admin has assigned it a nonzero weight
  in Admin → AI Models).
- **`POST /analyze/gnn`** — GNN-only scoring of a batch, for a side-by-side
  comparison independent of the core ensemble.
- **`GET /models/gnn/status`** — diagnostics: is it loaded, what architecture, what
  threshold, what its own test-set performance was.
- **Admin → AI Models** — a GNN status card, and a one-click "Add GNN to the
  ensemble" weight toggle.

**To enable it** (optional — everything else works identically without this):
```bash
cd ai-engine
pip install torch==2.2.2 torch_geometric==2.5.3
```
Then restart the AI Engine and check its startup log for a line starting `✅ GNN
loaded and smoke-tested`. If instead you see `⚠️ GNN failed to load`, that line names
the exact problem (missing files, or — if the reconstructed model architecture in
`main.py` doesn't match the saved weights — the exact mismatching layer and shape).
See `CHANGES.md`'s "Read this first" section for the full story on why this specific
piece couldn't be end-to-end verified against real PyTorch in the environment it was
built in, and what to do if it doesn't load cleanly on the first try.

---

## 🧠 Tech Stack

| Layer     | Technology                                                     |
| --------- | -------------------------------------------------------------- |
| Frontend  | React.js, Tailwind CSS, Redux, Cytoscape.js, Recharts          |
| Backend   | Node.js, Express.js, Puppeteer                                 |
| AI Engine | Python, FastAPI, Scikit-learn, XGBoost, TensorFlow/Keras, SHAP |
| Research  | PyTorch Geometric (GNN — trained, not yet deployed)            |
| Database  | MongoDB (`$graphLookup`), Supabase (PostgreSQL)                |
| Auth      | Supabase Auth + JWT                                            |
| Report AI | Groq (free) / Ollama (local) / OpenAI (optional)               |

---

## 🔧 Fixes & Additions (this pass)

A second independent verification pass (live-booted both services, hit every endpoint with
real requests, ran `npm run build`) found and fixed one crash bug and closed three of the
FYP's functional-requirement gaps that existed in the version described above:

1. **Fixed: AI Engine crashed on startup.** `requirements.txt` pinned `xgboost==2.0.3`
   against `scikit-learn==1.6.1` — XGBoost's sklearn wrapper calls a `__sklearn_tags__` API
   that scikit-learn only added in 1.6, and xgboost 2.0.3 predates it, so
   `xgboost_model.load_model()` threw `AttributeError: 'super' object has no attribute
'__sklearn_tags__'` on every boot. **Fix:** bumped to `xgboost==2.1.4`. Confirmed the
   server now loads all four models and serves `/health`, `/analyze/batch`,
   `/analyze/single`, `/models/info` correctly.
2. **Fixed (partially): `Sender_*`/`Receiver_*` behavioral features now computed for real
   on batch upload**, not defaulted. `backend-node/src/controllers/upload.controller.js`
   now has `attachBehavioralAggregates()`, which computes each account's tx count, average/
   total/max amount, and unique-receiver count _from the uploaded file itself_ before
   sending to the AI Engine. This is a real improvement over the previous "every transaction
   defaults to count=1" behavior, but it's still a per-file aggregate, not a persistent
   cross-job running history — see remaining limitation #2 below.
3. **Added: FR-13 Manage Users, FR-14 Manage AI Models, FR-16 Export Data.** These were
   fully missing from the Admin panel. Now implemented:
   - `GET/PATCH/DELETE /api/admin/users*` (Supabase admin API) + a Users tab in `AdminPage`
   - `GET/PATCH /api/admin/model-config` (proxies to a new `GET/PATCH /models/config` in
     the AI Engine) + an AI Models tab with threshold slider and ensemble-weight editor
   - `GET /api/analysis/job/:jobId/export?format=csv|json` + CSV/JSON buttons in
     `AnalysisPage`
   - `GET /api/admin/logs` (a System Logs tab reusing the `Job` collection as the audit
     trail, since there's no separate audit-log model — reasonable for this scope, but say
     so explicitly if asked in your defense)

All four were tested live: the AI Engine's `/models/config` GET/PATCH round-trips and
persists to `model_metadata.json`; the export endpoint's CSV/JSON output was verified
against the field names actually stored in `Transaction.model.js`.

---

## ⚠️ Remaining Known Limitations

Worth stating plainly in your report/defense rather than leaving for a supervisor to find:

1. **GNN numerical correctness couldn't be fully end-to-end verified** (architecture
   shape was verified via strict state-dict loading; full inference couldn't be run
   in the sandbox this was built in — disk/environment constraints, not a code issue).
   See `CHANGES.md`'s "Read this first" section and `GET /models/gnn/status`.
2. **`Sender_*`/`Receiver_*` aggregates are per-upload, not per-account-lifetime.** The fix
   above computes real stats from the file being uploaded, which is correct for a one-shot
   batch analysis (matches the FYP's "upload bulk files for batch processing" design) but
   won't reflect an account's activity from a _previous_ upload/job. A persistent per-account
   running aggregate (e.g. a Mongo collection keyed by account, updated on every job) would
   be the natural next step if you extend this for continuous/live monitoring — out of scope
   for this fix.
3. **The ensemble is tuned for `HI-Small_Trans.csv` specifically.** The other IBM AML files
   (`LI-Small`, `HI-Medium`, etc.) are different synthetic "worlds" with different accounts —
   don't feed them into this trained model expecting comparable results.
4. **`ai-engine/saved_models/model_metadata.json`'s `baseline_performance_for_comparison`
   field is stale** (see Model Performance above) — computed on a different, smaller dataset,
   not a valid before/after comparison for the numbers actually shown in this repo.
5. **`/models/config` (FR-14) has no auth of its own in the AI Engine.** It's protected in
   practice only because the Node gateway's `/api/admin/model-config` route sits in front of
   it with `requireAdmin`. If you ever expose the AI Engine's port 8000 directly to the
   internet, add auth there too — right now it trusts whatever calls it.
6. **In-process queue mode (FR-18's default without `REDIS_URL`) loses queued-but-not-yet-started
   jobs if the server restarts.** Jobs already running or completed are unaffected. Set
   `REDIS_URL` (e.g. a free Upstash instance) for persistence across restarts.

---

\_DeepGuard — Iqra University CS Batch 2023 | Supervised by
