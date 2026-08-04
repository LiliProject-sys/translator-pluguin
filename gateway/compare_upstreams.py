from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from fastapi import HTTPException

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from gateway.app.language_service import process_language_request
from gateway.app.schemas import LanguageRequest
from gateway.app.upstream import get_upstream_client


SAMPLES = [
    ("ordinary-word", "wordAnalysis", "quick", "employed", "These technologies are increasingly employed in production."),
    ("polysemy", "wordAnalysis", "detail", "address", "This study addresses the limitations of existing methods."),
    ("technical-term", "wordAnalysis", "quick", "electrochemical", "Electrochemical impedance spectroscopy was used."),
    ("hyphenated-word", "wordAnalysis", "quick", "state-of-the-art", "A state-of-the-art model was evaluated."),
    ("short-title", "sentenceTranslation", "quick", "Definition of LLM Agent", "2.1 Definition of LLM Agent"),
    ("complex-sentence", "sentenceTranslation", "quick", "Although the approach improves accuracy, its computational cost remains challenging for deployment.", "Research summary"),
    ("academic-paragraph", "sentenceTranslation", "quick", "The proposed framework integrates multimodal observations and adaptive planning to improve decision quality under uncertainty.", "Abstract"),
    ("target-smaller-than-context", "sentenceTranslation", "quick", "These agents exhibit remarkable capabilities.", "An LLM agent uses a large language model. These agents exhibit remarkable capabilities."),
    ("context-boundary", "sentenceTranslation", "quick", "Security and Privacy", "4. Security and Privacy\nThe following section discusses deployment risks."),
    ("special-symbols", "sentenceTranslation", "quick", "Performance improved by 95.5% (p < 0.01).", "Experimental results"),
    ("long-paragraph", "sentenceTranslation", "quick", " ".join(["Long-context evaluation remains important for reliable academic reading."] * 45), "Long-form evaluation"),
]


def parse_args():
    parser = argparse.ArgumentParser(description="Compare Orange Gateway Gemini and DeepSeek adapters.")
    parser.add_argument("--providers", nargs="+", choices=["gemini", "deepseek"], default=["gemini", "deepseek"])
    return parser.parse_args()


def optional_price(provider: str, kind: str) -> float | None:
    raw_value = os.getenv(f"{provider.upper()}_{kind.upper()}_PRICE_PER_MILLION", "").strip()
    if not raw_value:
        return None
    try:
        return float(raw_value)
    except ValueError:
        return None


def estimate_cost(provider: str, telemetry: dict) -> float | None:
    input_tokens = telemetry.get("inputTokens")
    output_tokens = telemetry.get("outputTokens")
    input_price = optional_price(provider, "input")
    output_price = optional_price(provider, "output")
    if None in (input_tokens, output_tokens, input_price, output_price):
        return None
    return round((input_tokens * input_price + output_tokens * output_price) / 1_000_000, 8)


def run_sample(provider: str, sample: tuple) -> dict:
    sample_id, request_type, analysis_mode, text, context = sample
    request = LanguageRequest.model_validate({
        "requestId": f"compare-{provider}-{sample_id}",
        "requestType": request_type,
        "analysisMode": analysis_mode,
        "sourceLanguage": "en",
        "targetLanguage": "zh-CN",
        "text": text,
        "contextSentence": context,
        "pageTitle": "Orange Gateway fixed comparison sample",
    })
    client = get_upstream_client(provider)
    telemetry = {}
    started = time.perf_counter()
    try:
        result = process_language_request(request, client, telemetry)
        elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
        return {
            "sample": sample_id,
            "provider": provider,
            "modelAlias": telemetry.get("model") or getattr(client, "model", ""),
            "thinking": telemetry.get("thinking") if provider == "deepseek" else None,
            "reasoningEffort": telemetry.get("reasoningEffort") if provider == "deepseek" else None,
            "requestType": request_type,
            "analysisMode": analysis_mode,
            "success": True,
            "schemaValid": True,
            "elapsedMs": elapsed_ms,
            "tokenUsage": {
                "input": telemetry.get("inputTokens"),
                "output": telemetry.get("outputTokens"),
                "total": telemetry.get("totalTokens"),
            },
            "estimatedCostUsd": estimate_cost(provider, telemetry),
            "retryCount": telemetry.get("retryCount", 0),
            "result": result,
        }
    except HTTPException as error:
        elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
        detail = error.detail if isinstance(error.detail, dict) else {}
        return {
            "sample": sample_id,
            "provider": provider,
            "modelAlias": getattr(client, "model", ""),
            "thinking": "enabled" if provider == "deepseek" else None,
            "reasoningEffort": "max" if provider == "deepseek" else None,
            "requestType": request_type,
            "analysisMode": analysis_mode,
            "success": False,
            "schemaValid": False,
            "elapsedMs": elapsed_ms,
            "tokenUsage": None,
            "estimatedCostUsd": None,
            "retryCount": telemetry.get("retryCount", 0),
            "errorCode": detail.get("errorCode", "GATEWAY_ERROR"),
        }


def main() -> int:
    args = parse_args()
    results = [run_sample(provider, sample) for sample in SAMPLES for provider in args.providers]
    print(json.dumps({"results": results}, ensure_ascii=False, indent=2))
    return 0 if all(item["success"] for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
