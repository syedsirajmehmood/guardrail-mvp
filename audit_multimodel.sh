#!/bin/bash
# Run audit across all 5 Ollama models sequentially
# Each model's results saved to /tmp/audit_<model>.json

MODELS=("llama3.2" "mistral" "phi3" "gemma2:2b" "qwen2.5:3b")
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "═══════════════════════════════════════════════════════════"
echo "  MULTI-MODEL COMPARATIVE AUDIT"
echo "  Models: ${MODELS[*]}"
echo "═══════════════════════════════════════════════════════════"

for model in "${MODELS[@]}"; do
    echo ""
    echo "━━━ Starting: $model ━━━"
    node "$DIR/audit_real.js" --llm=ollama --ollama-model="$model" 2>&1 | tee "/tmp/audit_${model//[:.]/_}.log"
    # Copy results
    cp /tmp/audit_real_results.json "/tmp/audit_${model//[:.]/_}_results.json" 2>/dev/null
    echo "━━━ Done: $model ━━━"
done

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ALL MODELS COMPLETE"
echo "═══════════════════════════════════════════════════════════"
