#!/bin/bash
# DeepGuard AI Engine — Startup Script
# Run this after placing model files in saved_models/

echo "🛡️  DeepGuard AI Engine"
echo "================================"

# Check Python
python3 --version || { echo "❌ Python 3 required"; exit 1; }

# Create virtualenv if not exists
if [ ! -d "venv" ]; then
    echo "📦 Creating virtual environment..."
    python3 -m venv venv
fi

source venv/bin/activate

# Install dependencies
echo "📦 Installing dependencies..."
pip install -r requirements.txt -q

# Check saved_models
if [ ! -f "saved_models/model_metadata.json" ]; then
    echo ""
    echo "⚠️  WARNING: saved_models/ not found or incomplete."
    echo "   The AI engine will run in DEMO MODE with random predictions."
    echo "   To use real models:"
    echo "   1. Run the Colab notebooks (notebooks/)"
    echo "   2. Download deepguard_models.zip from Colab"
    echo "   3. Extract into ai-engine/saved_models/"
    echo ""
    mkdir -p saved_models
fi

# Copy .env if not exists
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "📝 Created .env from .env.example — please edit it"
fi

echo ""
echo "🚀 Starting FastAPI server on http://localhost:8000"
echo "📖 API docs: http://localhost:8000/docs"
echo ""

uvicorn main:app --reload --host 0.0.0.0 --port 8000
