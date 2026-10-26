"""
DeepGuard — AI Engine (FastAPI)
Handles fraud detection using Isolation Forest + Autoencoder + SHAP
"""

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
import numpy as np
import pandas as pd
import joblib
import json
import os
import time
import logging
from datetime import datetime

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s — %(levelname)s — %(message)s')
logger = logging.getLogger("deepguard-ai")

# ─────────────────────────────────────────────
# Optional: Graph Neural Network (GNN) scoring
# ─────────────────────────────────────────────
# torch + torch_geometric are OPTIONAL. If they aren't installed, or the
# saved model fails to load for ANY reason, the GNN is simply reported as
# unavailable (registry.gnn_available = False) everywhere, and the rest of
# the engine (Isolation Forest + Autoencoder + XGBoost) is completely
# unaffected — a GNN problem can never take down the core ensemble.
try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from torch_geometric.nn import GINEConv
    TORCH_AVAILABLE = True
except Exception as e:  # ImportError, or a broken/partial install raising something else
    TORCH_AVAILABLE = False
    # A failed import can leave a half-initialised `torch` in sys.modules, and
    # other libraries (scipy's array-API layer, for one) sniff for it and then
    # crash on the missing attributes — which would take down the CORE
    # ensemble too. Scrub anything torch-related so failure stays contained.
    import sys as _sys
    for _m in [m for m in list(_sys.modules) if m == "torch" or m.startswith("torch.") or m.startswith("torch_geometric")]:
        _sys.modules.pop(_m, None)
    logger.info(f"ℹ️  torch/torch_geometric unavailable ({e}) — GNN scoring disabled, core ensemble unaffected")

if TORCH_AVAILABLE:
    class MultiGNN(nn.Module):
        """
        GINE-based multi-layer GNN with residual connections and an edge
        classifier head. This reconstruction was verified against the ACTUAL
        saved weights (saved_models/deepguard_gnn_saved_model/gnn_model.pt)
        via a strict state_dict load at startup — see ModelRegistry.load_models()
        — not just against the training notebook, which had drifted from what
        actually produced that checkpoint (different feature engineering,
        different n_layers). If this class doesn't match, load_state_dict(strict=True)
        throws immediately with the exact mismatching layer/shape.
        """
        def __init__(self, node_in, edge_in, hidden=64, n_layers=2, dropout=0.2):
            super().__init__()
            self.node_proj = nn.Linear(node_in, hidden)
            self.edge_proj = nn.Linear(edge_in, hidden)
            self.convs = nn.ModuleList()
            self.norms = nn.ModuleList()
            for _ in range(n_layers):
                mlp = nn.Sequential(nn.Linear(hidden, hidden), nn.ReLU(), nn.Linear(hidden, hidden))
                self.convs.append(GINEConv(mlp, edge_dim=hidden))
                self.norms.append(nn.BatchNorm1d(hidden))
            self.dropout = dropout
            self.edge_mlp = nn.Sequential(
                nn.Linear(hidden * 3, hidden), nn.ReLU(), nn.Dropout(dropout),
                nn.Linear(hidden, 1)
            )

        def forward(self, x, edge_index, edge_attr):
            h = F.relu(self.node_proj(x))
            e = F.relu(self.edge_proj(edge_attr))
            for conv, norm in zip(self.convs, self.norms):
                h_new = conv(h, edge_index, e)
                h_new = norm(h_new)
                h = F.relu(h_new) + h
                h = F.dropout(h, p=self.dropout, training=self.training)
            src, dst = edge_index
            edge_logits = self.edge_mlp(torch.cat([h[src], h[dst], e], dim=1))
            return edge_logits.squeeze(-1)

app = FastAPI(
    title="DeepGuard AI Engine",
    description="AI-powered financial fraud detection using Isolation Forest + Autoencoder + SHAP",
    version="1.0.0"
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────
# Model Loader (singleton pattern)
# ─────────────────────────────────────────────
class ModelRegistry:
    _instance = None
    _models_loaded = False

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def load_models(self):
        if self._models_loaded:
            return

        MODEL_PATH = os.getenv("MODEL_PATH", "./saved_models")
        logger.info(f"Loading models from: {MODEL_PATH}")

        try:
            # Load Isolation Forest
            if_path = os.path.join(MODEL_PATH, "isolation_forest.pkl")
            self.isolation_forest = joblib.load(if_path)
            logger.info("✅ Isolation Forest loaded")

            # Load Autoencoder — prefer the native .keras format, fall back to .h5
            # (the training notebook now saves both, but only .keras is "current")
            import tensorflow as tf
            ae_keras_path = os.path.join(MODEL_PATH, "autoencoder.keras")
            ae_h5_path = os.path.join(MODEL_PATH, "autoencoder.h5")
            ae_path = ae_keras_path if os.path.exists(ae_keras_path) else ae_h5_path
            self.autoencoder = tf.keras.models.load_model(ae_path)
            logger.info(f"✅ Autoencoder loaded from {ae_path}")

            # Load XGBoost (supervised model — this now carries most of the
            # detection performance; IF + AE remain for explainability and as
            # an unsupervised signal for fraud patterns unseen in labeled data)
            self.xgboost_model = None
            xgb_path = os.path.join(MODEL_PATH, "xgboost_model.json")
            if os.path.exists(xgb_path):
                import xgboost as xgb
                self.xgboost_model = xgb.XGBClassifier()
                self.xgboost_model.load_model(xgb_path)
                logger.info("✅ XGBoost loaded")
            else:
                logger.warning("⚠️  xgboost_model.json not found — falling back to IF+AE only")

            # Load Scaler
            scaler_path = os.path.join(MODEL_PATH, "scaler.pkl")
            self.scaler = joblib.load(scaler_path)
            logger.info("✅ Scaler loaded")

            # Load feature columns (defines the exact column order the scaler
            # and every model expect — engineer_features() must match this)
            feature_path = os.path.join(MODEL_PATH, "feature_cols.pkl")
            self.feature_cols = joblib.load(feature_path)
            logger.info(f"✅ Features loaded ({len(self.feature_cols)}): {self.feature_cols}")

            # Load metadata (thresholds, ensemble weights, etc.)
            meta_path = os.path.join(MODEL_PATH, "model_metadata.json")
            with open(meta_path, "r") as f:
                self.metadata = json.load(f)
            self.ae_threshold = self.metadata["ae_threshold"]
            self.ensemble_threshold = self.metadata.get("ensemble_threshold", 0.5)
            self.ensemble_weights = self.metadata.get(
                "ensemble_weights",
                {"xgboost": 0.85, "autoencoder": 0.15, "isolation_forest": 0.0},
            )
            if_range = self.metadata.get("if_decision_function_range", {"min": -0.5, "max": 0.5})
            self.if_score_min = if_range["min"]
            self.if_score_max = if_range["max"]
            logger.info(f"✅ Metadata loaded. Ensemble threshold: {self.ensemble_threshold:.4f}  "
                        f"Weights: {self.ensemble_weights}")

            # ── Optional: GNN (see class MultiGNN above for why strict=True matters) ──
            self.gnn_available = False
            gnn_path = os.path.join(MODEL_PATH, "deepguard_gnn_saved_model")
            if not TORCH_AVAILABLE:
                logger.info("ℹ️  GNN scoring disabled (torch/torch_geometric not installed)")
            elif not os.path.isdir(gnn_path):
                logger.info(f"ℹ️  GNN scoring disabled (no model at {gnn_path})")
            else:
                try:
                    with open(os.path.join(gnn_path, "gnn_metadata.json")) as f:
                        self.gnn_metadata = json.load(f)
                    self.gnn_edge_num_mean = np.load(os.path.join(gnn_path, "gnn_edge_num_mean.npy"))
                    self.gnn_edge_num_std = np.load(os.path.join(gnn_path, "gnn_edge_num_std.npy"))
                    self.gnn_node_feat_mean = np.load(os.path.join(gnn_path, "gnn_node_feat_mean.npy"))
                    self.gnn_node_feat_std = np.load(os.path.join(gnn_path, "gnn_node_feat_std.npy"))

                    node_in = len(self.gnn_node_feat_mean)
                    edge_in = (len(self.gnn_metadata["edge_numeric_cols"])
                               + len(self.gnn_metadata["edge_onehot_cols"]) + 1)  # +1 = is_reverse flag
                    hidden = self.gnn_metadata.get("hidden_dim", 64)
                    n_layers = self.gnn_metadata.get("n_layers", 2)
                    dropout = self.gnn_metadata.get("dropout", 0.2)

                    self.gnn_model = MultiGNN(node_in=node_in, edge_in=edge_in,
                                               hidden=hidden, n_layers=n_layers, dropout=dropout)
                    state_dict = torch.load(os.path.join(gnn_path, "gnn_model.pt"), map_location="cpu")
                    # strict=True IS the verification that this reconstructed
                    # architecture actually matches the trained checkpoint —
                    # a mismatch throws here, immediately, naming the exact
                    # layer/shape at fault, instead of silently producing
                    # wrong predictions later.
                    self.gnn_model.load_state_dict(state_dict, strict=True)
                    self.gnn_model.eval()

                    # Smoke test — tiny synthetic 3-node/2-edge forward pass,
                    # just to confirm it actually RUNS (dtypes/shapes/ops all
                    # line up) before trusting it with real traffic.
                    with torch.no_grad():
                        test_out = self.gnn_model(
                            torch.zeros((3, node_in), dtype=torch.float32),
                            torch.tensor([[0, 1], [1, 2]], dtype=torch.long),
                            torch.zeros((2, edge_in), dtype=torch.float32),
                        )
                        assert test_out.shape == (2,), f"unexpected output shape {tuple(test_out.shape)}"

                    self.gnn_threshold = self.gnn_metadata.get("threshold", 0.5)
                    self.gnn_available = True
                    logger.info(f"✅ GNN loaded and smoke-tested (node_in={node_in}, edge_in={edge_in}, "
                                f"hidden={hidden}, n_layers={n_layers}, threshold={self.gnn_threshold:.4f})")
                except Exception as e:
                    logger.warning(f"⚠️  GNN failed to load — GNN scoring disabled, core ensemble unaffected: {e}")
                    self.gnn_available = False

            self._models_loaded = True

        except FileNotFoundError as e:
            logger.warning(f"⚠️  Model files not found: {e}")
            logger.warning("⚠️  Running in DEMO mode with random predictions")
            self.isolation_forest = None
            self.autoencoder = None
            self.xgboost_model = None
            self.scaler = None
            self.feature_cols = [
                'Amount Paid', 'Amount Received', 'Amount_Ratio', 'Amount_Diff',
                'Log_Amount_Paid', 'Log_Amount_Recv', 'Is_Round_Amount',
                'Hour', 'DayOfWeek', 'Month', 'IsWeekend', 'IsNightTx',
                'Payment Format_enc', 'Payment Currency_enc', 'Receiving Currency_enc',
                'Sender_TX_Count', 'Sender_Avg_Amount', 'Sender_Unique_Receivers',
                'Sender_Total_Amount', 'Sender_Max_Amount', 'Receiver_TX_Count'
            ]
            self.ae_threshold = 0.05
            self.ensemble_threshold = 0.5
            self.ensemble_weights = {"xgboost": 0.85, "autoencoder": 0.15, "isolation_forest": 0.0}
            self.if_score_min, self.if_score_max = -0.5, 0.5
            self.gnn_available = False
            self.metadata = {
                "model_performance": {
                    "isolation_forest_roc_auc": 0.0,
                    "autoencoder_roc_auc": 0.0,
                    "xgboost_roc_auc": 0.0,
                    "ensemble_roc_auc": 0.0
                }
            }
            self._models_loaded = True

    def is_demo_mode(self):
        return self.isolation_forest is None

    def is_gnn_available(self):
        return getattr(self, "gnn_available", False)


registry = ModelRegistry()


@app.on_event("startup")
async def startup_event():
    registry.load_models()
    logger.info("🚀 DeepGuard AI Engine started!")


# ─────────────────────────────────────────────
# Pydantic Models
# ─────────────────────────────────────────────
class Transaction(BaseModel):
    timestamp: Optional[str] = None
    from_bank: Optional[str] = None
    account: Optional[str] = None
    to_bank: Optional[str] = None
    to_account: Optional[str] = None
    amount_paid: float = Field(0.0, ge=0)
    payment_currency: Optional[str] = "USD"
    amount_received: float = Field(0.0, ge=0)
    receiving_currency: Optional[str] = "USD"
    payment_format: Optional[str] = "Wire"
    transaction_id: Optional[str] = None

    # Sender/receiver behavioral aggregates. These were engineered from full
    # transaction history in the training notebook (a single incoming
    # transaction doesn't carry this by itself). The Node backend/DB layer
    # should compute and pass these when available (e.g. from a rolling
    # window of that account's recent activity); sensible "first-seen
    # account" defaults are used otherwise so the API never crashes.
    sender_tx_count: Optional[int] = 1
    sender_avg_amount: Optional[float] = None
    sender_unique_receivers: Optional[int] = 1
    sender_total_amount: Optional[float] = None
    sender_max_amount: Optional[float] = None
    receiver_tx_count: Optional[int] = 1


class BatchAnalysisRequest(BaseModel):
    transactions: List[Transaction]
    job_id: Optional[str] = None
    # If true and the GNN is available (see GET /models/gnn/status), each
    # transaction is also scored by the GNN using this batch's own account
    # graph, and — if the admin has assigned it a nonzero weight via
    # PATCH /models/config — blended into the ensemble score too.
    use_gnn: bool = False


class SingleTransactionRequest(BaseModel):
    transaction: Transaction
    use_gnn: bool = False


class AnalysisResult(BaseModel):
    transaction_id: str
    risk_score: float
    risk_level: str
    is_fraud: bool
    isolation_forest_score: float
    autoencoder_score: float
    xgboost_score: float
    gnn_score: Optional[float] = None
    fraud_category: str
    shap_values: Optional[Dict[str, float]] = None
    processing_time_ms: float


# ─────────────────────────────────────────────
# Feature Engineering (matches notebook)
# ─────────────────────────────────────────────
PAYMENT_FORMAT_MAP = {
    "Cheque": 0, "ACH": 1, "Wire": 2, "Reinvestment": 3,
    "Credit Card": 4, "Bitcoin": 5, "Cash": 6
}
CURRENCY_MAP = {
    "USD": 0, "EUR": 1, "GBP": 2, "JPY": 3, "AUD": 4,
    "CAD": 5, "CHF": 6, "CNY": 7, "BTC": 8, "ETH": 9
}


def engineer_features(transactions: List[Transaction]) -> np.ndarray:
    """
    Convert transaction objects into the feature matrix the models expect.

    IMPORTANT: this must produce the *same* columns, in the *same* order, as
    `feature_cols` from model_metadata.json / feature_cols.pkl — that's what
    the scaler and every model were fit on. We build a name->value dict per
    transaction and then select from it using registry.feature_cols, so the
    function stays correct even if a future retrain changes column order.
    """
    feature_cols = registry.feature_cols
    rows = []
    for tx in transactions:
        try:
            ts = pd.to_datetime(tx.timestamp) if tx.timestamp else pd.Timestamp.now()
        except Exception:
            ts = pd.Timestamp.now()

        amount_paid = float(tx.amount_paid)
        amount_received = float(tx.amount_received)
        amount_ratio = amount_paid / (amount_received + 1e-9)
        amount_diff = amount_paid - amount_received
        log_paid = np.log1p(amount_paid)
        log_received = np.log1p(amount_received)
        is_round = 1 if (amount_paid > 0 and amount_paid % 100 == 0) else 0

        hour = int(ts.hour)
        dow = int(ts.dayofweek)
        month = int(ts.month)
        is_weekend = 1 if dow >= 5 else 0
        is_night = 1 if (hour >= 22 or hour <= 5) else 0

        pf_enc = PAYMENT_FORMAT_MAP.get(tx.payment_format, 2)
        pc_enc = CURRENCY_MAP.get(tx.payment_currency, 0)
        rc_enc = CURRENCY_MAP.get(tx.receiving_currency, 0)

        sender_avg = tx.sender_avg_amount if tx.sender_avg_amount is not None else amount_paid
        sender_total = tx.sender_total_amount if tx.sender_total_amount is not None else amount_paid
        sender_max = tx.sender_max_amount if tx.sender_max_amount is not None else amount_paid

        values = {
            "Amount Paid": amount_paid,
            "Amount Received": amount_received,
            "Amount_Ratio": amount_ratio,
            "Amount_Diff": amount_diff,
            "Log_Amount_Paid": log_paid,
            "Log_Amount_Recv": log_received,
            "Is_Round_Amount": is_round,
            "Hour": hour,
            "DayOfWeek": dow,
            "Month": month,
            "IsWeekend": is_weekend,
            "IsNightTx": is_night,
            "Payment Format_enc": pf_enc,
            "Payment Currency_enc": pc_enc,
            "Receiving Currency_enc": rc_enc,
            "Sender_TX_Count": tx.sender_tx_count or 1,
            "Sender_Avg_Amount": sender_avg,
            "Sender_Unique_Receivers": tx.sender_unique_receivers or 1,
            "Sender_Total_Amount": sender_total,
            "Sender_Max_Amount": sender_max,
            "Receiver_TX_Count": tx.receiver_tx_count or 1,
        }

        row = [values.get(col, 0.0) for col in feature_cols]
        rows.append(row)

    return np.array(rows, dtype=np.float64)


def get_fraud_category(risk_score: float, payment_format: str, amount_diff: float) -> str:
    """Categorize fraud type based on patterns."""
    if risk_score < 0.3:
        return "Clean"
    elif payment_format == "Bitcoin" and risk_score > 0.7:
        return "Cryptocurrency Laundering"
    elif abs(amount_diff) < 1.0 and risk_score > 0.6:
        return "Circular Transaction"
    elif risk_score > 0.85:
        return "High-Risk AML Typology"
    elif risk_score > 0.7:
        return "Suspicious Layering"
    elif risk_score > 0.5:
        return "Unusual Transfer Volume"
    else:
        return "Low-Risk Anomaly"


def compute_shap_for_transaction(X_scaled: np.ndarray, feature_cols: list) -> Dict[str, float]:
    """Compute SHAP feature importance for a single transaction.

    Explains the XGBoost model (the primary/highest-weighted model in the
    ensemble) when available, since that's what's actually driving most of
    the risk score; falls back to the Isolation Forest for explainability
    if XGBoost isn't loaded.
    """
    try:
        import shap
        if not registry.is_demo_mode():
            explain_model = registry.xgboost_model if registry.xgboost_model is not None \
                else registry.isolation_forest
            explainer = shap.TreeExplainer(explain_model)
            shap_vals = explainer.shap_values(X_scaled)
            if isinstance(shap_vals, list):
                shap_vals = shap_vals[0]
            # Take absolute values and normalize
            abs_shap = np.abs(shap_vals).flatten()
            total = abs_shap.sum() + 1e-9
            shap_dict = {
                feat: round(float(abs_shap[i] / total), 4)
                for i, feat in enumerate(feature_cols)
                if i < len(abs_shap)
            }
            return dict(sorted(shap_dict.items(), key=lambda x: x[1], reverse=True)[:8])
    except Exception as e:
        logger.warning(f"SHAP computation failed: {e}")

    # Fallback: return rule-based feature importance
    feature_idx = {f: i for i, f in enumerate(feature_cols)}
    amounts = float(X_scaled[0][0]) if len(X_scaled[0]) > 0 else 0.5
    return {
        "Amount Paid": round(amounts * 0.4, 4),
        "Amount_Ratio": round(0.2, 4),
        "Log_Amount_Paid": round(0.15, 4),
        "Amount_Diff": round(0.1, 4),
        "Payment Format_enc": round(0.08, 4),
        "Hour": round(0.04, 4),
        "DayOfWeek": round(0.02, 4),
        "Receiving Currency_enc": round(0.01, 4)
    }


def gnn_predict(transactions: List[Transaction]) -> Optional[np.ndarray]:
    """
    Build a small transaction graph from THIS batch (accounts as nodes,
    transactions as edges) and return a GNN fraud probability (0-1, from
    sigmoid) for each transaction, in the same order as `transactions`.

    Returns None if the GNN isn't available. Feature engineering here was
    reverse-engineered from the ACTUAL saved scaler files and
    gnn_metadata.json (ground truth), not the training notebook, which had
    drifted from what actually produced the checkpoint — see MultiGNN's
    docstring and ModelRegistry.load_models() for how the architecture
    itself is verified.

    Node features (per account, computed from this batch): [out_count,
    out_sum, out_mean, in_count, in_sum, in_mean] of transaction amounts,
    log1p'd then standardized. Edge features: 8 standardized numeric columns
    + one-hot(payment format) + one-hot(currency) + is_reverse flag — the
    graph includes both forward and reverse copies of every edge, matching
    training. Port numbering (Nth transaction between this exact sender/
    receiver pair) is computed within this batch, chronologically — the
    same "known so far" scoping already used for Sender_TX_Count etc.
    elsewhere in this engine, just applied to the GNN's own feature set.
    """
    if not registry.is_gnn_available() or len(transactions) == 0:
        return None

    reg = registry
    numeric_cols = reg.gnn_metadata["edge_numeric_cols"]
    onehot_cols = reg.gnn_metadata["edge_onehot_cols"]

    def parse_ts(tx):
        try:
            return pd.to_datetime(tx.timestamp) if tx.timestamp else pd.Timestamp.now()
        except Exception:
            return pd.Timestamp.now()

    # ── Account -> node index ──
    acct_to_idx: Dict[str, int] = {}
    def get_idx(acct):
        acct = acct or "UNKNOWN"
        if acct not in acct_to_idx:
            acct_to_idx[acct] = len(acct_to_idx)
        return acct_to_idx[acct]

    for tx in transactions:
        get_idx(tx.account)
        get_idx(tx.to_account)
    n_nodes = len(acct_to_idx)

    # ── Port numbering: prior tx count for this (sender, receiver) pair,
    #    computed in chronological order within this batch ──
    order = sorted(range(len(transactions)), key=lambda i: parse_ts(transactions[i]))
    pair_counts: Dict[tuple, int] = {}
    port_number = [0] * len(transactions)
    for i in order:
        tx = transactions[i]
        key = (tx.account, tx.to_account)
        port_number[i] = pair_counts.get(key, 0)
        pair_counts[key] = port_number[i] + 1

    # ── Node features: out/in degree stats over this batch ──
    out_count = np.zeros(n_nodes); out_sum = np.zeros(n_nodes)
    in_count = np.zeros(n_nodes); in_sum = np.zeros(n_nodes)
    for tx in transactions:
        s, d = get_idx(tx.account), get_idx(tx.to_account)
        out_count[s] += 1; out_sum[s] += tx.amount_paid
        in_count[d] += 1; in_sum[d] += tx.amount_received
    out_mean = np.divide(out_sum, out_count, out=np.zeros_like(out_sum), where=out_count > 0)
    in_mean = np.divide(in_sum, in_count, out=np.zeros_like(in_sum), where=in_count > 0)
    node_feat_raw = np.stack([out_count, out_sum, out_mean, in_count, in_sum, in_mean], axis=1)
    node_feat = (np.log1p(node_feat_raw) - reg.gnn_node_feat_mean) / reg.gnn_node_feat_std

    # ── Edge features (built in original transaction order) ──
    src, dst, numeric_rows, onehot_rows = [], [], [], []
    for i, tx in enumerate(transactions):
        src.append(get_idx(tx.account)); dst.append(get_idx(tx.to_account))

        ts = parse_ts(tx)
        amount_paid, amount_received = float(tx.amount_paid), float(tx.amount_received)
        diff = amount_paid - amount_received
        signed_log_diff = float(np.sign(diff) * np.log1p(abs(diff)))

        feat_map = {
            "Log_Amount_Paid": np.log1p(amount_paid),
            "Log_Amount_Received": np.log1p(amount_received),
            "SignedLog_Amount_Diff": signed_log_diff,
            "Hour": float(ts.hour),
            "DayOfWeek": float(ts.dayofweek),
            "IsWeekend": 1.0 if ts.dayofweek >= 5 else 0.0,
            "IsNightTx": 1.0 if (ts.hour >= 22 or ts.hour <= 5) else 0.0,
            "Log_Port_Number": float(np.log1p(port_number[i])),
        }
        numeric_rows.append([feat_map[c] for c in numeric_cols])

        pf, cur = tx.payment_format or "Wire", tx.payment_currency or "US Dollar"
        onehot_rows.append([
            1.0 if (col == f"Payment Format_{pf}" or col == f"Payment Currency_{cur}") else 0.0
            for col in onehot_cols
        ])

    numeric_arr = (np.array(numeric_rows, dtype=np.float32) - reg.gnn_edge_num_mean) / reg.gnn_edge_num_std
    onehot_arr = np.array(onehot_rows, dtype=np.float32)
    src, dst = np.array(src), np.array(dst)
    n_edges = len(transactions)

    edge_index = np.concatenate([np.stack([src, dst]), np.stack([dst, src])], axis=1)
    edge_feat_fwd = np.concatenate([numeric_arr, onehot_arr, np.zeros((n_edges, 1), dtype=np.float32)], axis=1)
    edge_feat_rev = np.concatenate([numeric_arr, onehot_arr, np.ones((n_edges, 1), dtype=np.float32)], axis=1)
    edge_attr = np.concatenate([edge_feat_fwd, edge_feat_rev], axis=0)

    with torch.no_grad():
        logits = reg.gnn_model(
            torch.tensor(node_feat, dtype=torch.float32),
            torch.tensor(edge_index, dtype=torch.long),
            torch.tensor(edge_attr, dtype=torch.float32),
        )
        probs = torch.sigmoid(logits).cpu().numpy()

    # Edges were appended in original transaction order, so the first n_edges
    # entries (the forward half) already line up 1:1 with `transactions`.
    return probs[:n_edges]


def analyze_transactions(transactions: List[Transaction], use_gnn: bool = False) -> List[AnalysisResult]:
    """Core analysis function — runs IF + AE + XGBoost (+ optional GNN) + SHAP."""
    start = time.time()

    # Feature engineering
    X_raw = engineer_features(transactions)

    # ── Optional GNN pass — built from this batch's own account graph.
    # Never allowed to break the core ensemble: any failure here just means
    # gnn_scores stays None and every transaction gets gnn_score=None. ──
    gnn_scores = None
    if use_gnn and registry.is_gnn_available():
        try:
            gnn_scores = gnn_predict(transactions)
        except Exception as e:
            logger.warning(f"GNN scoring failed for this batch (falling back to core ensemble only): {e}")
            gnn_scores = None

    if not registry.is_demo_mode():
        # Scale (using the *same* fitted scaler + column order used at training time)
        X_scaled = registry.scaler.transform(X_raw)

        # ── Isolation Forest — normalized using the fixed train-set range
        # saved at training time (a single-row batch has no min/max of its
        # own to normalize against, which was the previous bug) ──
        if_raw_scores = registry.isolation_forest.decision_function(X_scaled)
        if_lo, if_hi = registry.if_score_min, registry.if_score_max
        if_normalized = np.clip(1 - (if_raw_scores - if_lo) / (if_hi - if_lo + 1e-9), 0, 1)

        # ── Autoencoder ──
        X_pred = registry.autoencoder.predict(X_scaled, verbose=0)
        ae_mse = np.mean(np.power(X_scaled - X_pred, 2), axis=1)
        ae_normalized = np.clip(ae_mse / (registry.ae_threshold * 3), 0, 1)

        # ── XGBoost (supervised — primary driver of the risk score) ──
        if registry.xgboost_model is not None:
            xgb_normalized = registry.xgboost_model.predict_proba(X_scaled)[:, 1]
        else:
            xgb_normalized = np.zeros(len(transactions))

    else:
        # Demo mode — deterministic pseudo-random scores
        np.random.seed(42)
        if_normalized = np.clip(np.random.beta(2, 5, len(transactions)), 0, 1)
        ae_normalized = np.clip(np.random.beta(2, 5, len(transactions)), 0, 1)
        xgb_normalized = np.clip(np.random.beta(2, 5, len(transactions)), 0, 1)
        X_scaled = X_raw

    # Ensemble — weights come from model_metadata.json (data-driven, tuned on
    # a held-out validation split during training; see saved_models/README).
    # Always renormalize by whichever weights actually contributed: if the
    # admin has configured a nonzero "gnn" weight (as part of a set that
    # sums to 1.0) but this particular request didn't run the GNN (use_gnn
    # =False, or it's unavailable), dividing only by the weights that DID
    # run keeps the score on the same 0-1 scale instead of silently
    # compressing every score toward zero by the missing GNN share.
    w = registry.ensemble_weights
    used_weight = w.get("xgboost", 0.85) + w.get("autoencoder", 0.15) + w.get("isolation_forest", 0.0)
    ensemble_scores = (
        w.get("xgboost", 0.85) * xgb_normalized
        + w.get("autoencoder", 0.15) * ae_normalized
        + w.get("isolation_forest", 0.0) * if_normalized
    )
    if gnn_scores is not None and w.get("gnn", 0.0) > 0:
        ensemble_scores = ensemble_scores + w.get("gnn", 0.0) * gnn_scores
        used_weight += w.get("gnn", 0.0)
    if used_weight > 0:
        ensemble_scores = ensemble_scores / used_weight
    threshold = registry.ensemble_threshold

    results = []
    for i, tx in enumerate(transactions):
        risk = float(ensemble_scores[i])

        # Risk-level bands are spaced relative to the fitted decision
        # threshold rather than fixed absolute numbers, so they stay
        # meaningful if the model/threshold is retrained later.
        if risk >= max(threshold * 1.3, threshold + 0.15):
            risk_level = "Critical"
        elif risk >= threshold:
            risk_level = "High"
        elif risk >= threshold * 0.5:
            risk_level = "Medium"
        else:
            risk_level = "Low"

        is_fraud = risk >= threshold

        amount_diff = tx.amount_paid - tx.amount_received
        category = get_fraud_category(risk, tx.payment_format or "Wire", amount_diff)

        # SHAP (only for medium-risk-and-above or explicitly requested — it's
        # the most expensive step per transaction)
        shap_vals = None
        if risk >= threshold * 0.5:
            shap_vals = compute_shap_for_transaction(X_scaled[i:i+1], registry.feature_cols)

        tx_id = tx.transaction_id or f"TX-{i+1:05d}"

        proc_ms = (time.time() - start) * 1000 / max(len(transactions), 1)

        results.append(AnalysisResult(
            transaction_id=tx_id,
            risk_score=round(risk * 100, 2),       # 0–100
            risk_level=risk_level,
            is_fraud=is_fraud,
            isolation_forest_score=round(float(if_normalized[i]) * 100, 2),
            autoencoder_score=round(float(ae_normalized[i]) * 100, 2),
            xgboost_score=round(float(xgb_normalized[i]) * 100, 2),
            gnn_score=round(float(gnn_scores[i]) * 100, 2) if gnn_scores is not None else None,
            fraud_category=category,
            shap_values=shap_vals,
            processing_time_ms=round(proc_ms, 2)
        ))

    return results


# ─────────────────────────────────────────────
# API Routes
# ─────────────────────────────────────────────

@app.get("/")
async def root():
    return {
        "service": "DeepGuard AI Engine",
        "version": "1.0.0",
        "status": "running",
        "demo_mode": registry.is_demo_mode(),
        "models_loaded": registry._models_loaded,
        "timestamp": datetime.utcnow().isoformat()
    }


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "models": {
            "isolation_forest": not registry.is_demo_mode(),
            "autoencoder": not registry.is_demo_mode(),
            "scaler": not registry.is_demo_mode(),
            "gnn": registry.is_gnn_available()
        },
        "demo_mode": registry.is_demo_mode(),
        "performance": registry.metadata.get("model_performance", {})
    }


@app.post("/analyze/batch", response_model=Dict[str, Any])
async def analyze_batch(request: BatchAnalysisRequest):
    """
    Analyze a batch of transactions.
    Returns fraud scores, risk levels, and SHAP explanations.
    """
    if len(request.transactions) == 0:
        raise HTTPException(status_code=400, detail="No transactions provided")

    if len(request.transactions) > 100000:
        raise HTTPException(status_code=400, detail="Max 100,000 transactions per batch")

    start = time.time()
    logger.info(f"📥 Batch analysis: {len(request.transactions)} transactions | Job: {request.job_id}")

    try:
        results = analyze_transactions(request.transactions, use_gnn=request.use_gnn)
    except Exception as e:
        logger.error(f"Analysis failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    total_ms = (time.time() - start) * 1000
    flagged = [r for r in results if r.is_fraud]
    critical = [r for r in results if r.risk_level == "Critical"]

    return {
        "job_id": request.job_id,
        "status": "completed",
        "summary": {
            "total_transactions": len(results),
            "flagged_count": len(flagged),
            "critical_count": len(critical),
            "clean_count": len(results) - len(flagged),
            "flagging_rate_pct": round(len(flagged) / max(len(results), 1) * 100, 2),
            "processing_time_ms": round(total_ms, 2),
            "demo_mode": registry.is_demo_mode()
        },
        "results": [r.dict() for r in results],
        "timestamp": datetime.utcnow().isoformat()
    }


@app.post("/analyze/single", response_model=Dict[str, Any])
async def analyze_single(request: SingleTransactionRequest):
    """Analyze a single transaction with full SHAP explanation."""
    try:
        results = analyze_transactions([request.transaction], use_gnn=request.use_gnn)
        result = results[0]
        # Always compute SHAP for single analysis
        X_raw = engineer_features([request.transaction])
        X_scaled = registry.scaler.transform(X_raw) if not registry.is_demo_mode() else X_raw
        result.shap_values = compute_shap_for_transaction(X_scaled, registry.feature_cols)
        return {"result": result.dict(), "timestamp": datetime.utcnow().isoformat()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/models/info")
async def model_info():
    """Return model metadata and performance metrics."""
    info = {
        "demo_mode": registry.is_demo_mode(),
        "features": registry.feature_cols,
        "n_features": len(registry.feature_cols),
        "metadata": registry.metadata,
        "gnn_available": registry.is_gnn_available()
    }
    if registry.is_gnn_available():
        info["gnn_metadata"] = registry.gnn_metadata
    return info


@app.get("/models/gnn/status")
async def gnn_status():
    """
    Dedicated GNN diagnostic endpoint. Use this to check whether the GNN
    actually loaded and passed its startup smoke test, and why not if it
    didn't — check the AI Engine's own console/logs at startup for the
    specific warning (import error, missing files, or a state_dict shape
    mismatch naming the exact layer at fault) if `available` is false here.
    """
    if not registry.is_gnn_available():
        return {
            "available": False,
            "torch_installed": TORCH_AVAILABLE,
            "reason": "See AI Engine startup logs for the specific error."
        }
    return {
        "available": True,
        "architecture": registry.gnn_metadata.get("architecture"),
        "hidden_dim": registry.gnn_metadata.get("hidden_dim"),
        "n_layers": registry.gnn_metadata.get("n_layers"),
        "threshold": registry.gnn_threshold,
        "edge_feature_count": (len(registry.gnn_metadata["edge_numeric_cols"])
                                + len(registry.gnn_metadata["edge_onehot_cols"]) + 1),
        "node_feature_count": len(registry.gnn_node_feat_mean),
        "test_performance": registry.gnn_metadata.get("test_performance"),
        "comparison": registry.gnn_metadata.get("comparison"),
    }


class GnnAnalysisRequest(BaseModel):
    transactions: List[Transaction]
    job_id: Optional[str] = None


@app.post("/analyze/gnn", response_model=Dict[str, Any])
async def analyze_gnn(request: GnnAnalysisRequest):
    """
    Score a batch using ONLY the GNN (built from this batch's own account
    graph), independent of the Isolation Forest/Autoencoder/XGBoost ensemble.
    Useful to inspect the GNN's own opinion directly, e.g. for a side-by-side
    comparison in the report or admin panel, or when the FYP defense
    specifically wants to demonstrate GNN-based detection on its own merits.
    For a blended score, use POST /analyze/batch with "use_gnn": true instead.
    """
    if not registry.is_gnn_available():
        raise HTTPException(status_code=503, detail="GNN is not available — check GET /models/gnn/status")
    if len(request.transactions) == 0:
        raise HTTPException(status_code=400, detail="No transactions provided")
    if len(request.transactions) > 20000:
        raise HTTPException(status_code=400, detail="Max 20,000 transactions per GNN batch "
                                                      "(the whole batch forms one in-memory graph)")

    start = time.time()
    try:
        scores = gnn_predict(request.transactions)
    except Exception as e:
        logger.error(f"GNN analysis failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    threshold = registry.gnn_threshold
    results = []
    for i, tx in enumerate(request.transactions):
        score = float(scores[i])
        is_fraud = score >= threshold
        results.append({
            "transaction_id": tx.transaction_id or f"TX-{i+1:05d}",
            "gnn_score": round(score * 100, 2),
            "is_fraud": is_fraud,
            "risk_level": "Critical" if score >= max(threshold * 1.05, threshold) and is_fraud else
                          ("High" if is_fraud else ("Medium" if score >= threshold * 0.5 else "Low")),
        })

    flagged = [r for r in results if r["is_fraud"]]
    return {
        "job_id": request.job_id,
        "status": "completed",
        "model": "GNN (GINE-based, graph built from this batch)",
        "threshold": threshold,
        "summary": {
            "total_transactions": len(results),
            "flagged_count": len(flagged),
            "flagging_rate_pct": round(len(flagged) / max(len(results), 1) * 100, 2),
            "processing_time_ms": round((time.time() - start) * 1000, 2),
        },
        "results": results,
        "timestamp": datetime.utcnow().isoformat()
    }


# ─────────────────────────────────────────────
# FR-14: Manage AI Models (Admin)
# Lets an admin view/adjust the ensemble threshold and per-model weights
# at runtime, without retraining. Changes are held in memory for the life
# of the process and persisted back to model_metadata.json so they survive
# a restart. This does NOT retrain any model — it only changes how the
# already-trained model scores are combined and thresholded.
# ─────────────────────────────────────────────
class ModelConfigUpdate(BaseModel):
    ensemble_threshold: Optional[float] = Field(None, ge=0.0, le=1.0)
    ensemble_weights: Optional[Dict[str, float]] = None


@app.get("/models/config")
async def get_model_config():
    """Return the currently active, adjustable model configuration."""
    return {
        "ensemble_threshold": registry.ensemble_threshold,
        "ensemble_weights": registry.ensemble_weights,
        "ae_threshold": registry.ae_threshold,
        "gnn_available": registry.is_gnn_available(),
    }


@app.patch("/models/config")
async def update_model_config(update: ModelConfigUpdate):
    """
    Admin-only in practice (the Node.js gateway's requireAdmin middleware
    should sit in front of whatever route proxies to this endpoint — the
    AI engine itself has no auth, matching the rest of this service).
    """
    if registry.is_demo_mode():
        raise HTTPException(status_code=400, detail="Cannot update config in demo mode (no models loaded)")

    if update.ensemble_threshold is not None:
        registry.ensemble_threshold = update.ensemble_threshold
        registry.metadata["ensemble_threshold"] = update.ensemble_threshold

    if update.ensemble_weights is not None:
        total = sum(update.ensemble_weights.values())
        if abs(total - 1.0) > 0.01:
            raise HTTPException(status_code=400, detail=f"ensemble_weights must sum to 1.0 (got {total:.3f})")
        registry.ensemble_weights = update.ensemble_weights
        registry.metadata["ensemble_weights"] = update.ensemble_weights

    # Persist so the new config survives a restart
    try:
        MODEL_PATH = os.getenv("MODEL_PATH", "./saved_models")
        meta_path = os.path.join(MODEL_PATH, "model_metadata.json")
        with open(meta_path, "w") as f:
            json.dump(registry.metadata, f, indent=2)
    except Exception as e:
        logger.warning(f"Config updated in memory but failed to persist to disk: {e}")

    logger.info(f"⚙️  Model config updated: threshold={registry.ensemble_threshold:.4f}, "
                f"weights={registry.ensemble_weights}")

    return {
        "ensemble_threshold": registry.ensemble_threshold,
        "ensemble_weights": registry.ensemble_weights,
        "message": "Configuration updated"
    }
