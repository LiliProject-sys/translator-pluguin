from __future__ import annotations

from .errors import gateway_error
from .schemas import LanguageRequest
from .skills import sentence_translation, word_analysis
from .upstream import get_max_output_tokens


def process_language_request(payload: LanguageRequest, client, telemetry: dict | None = None) -> dict:
    upstream_provider = getattr(client, "provider_id", "gemini")

    if payload.requestType == "wordAnalysis":
        prompt = word_analysis.build_prompt(payload)
        schema_model = word_analysis.get_schema_model(payload.analysisMode)
        result = client.generate_json(
            prompt,
            schema_model,
            payload.requestId,
            max_output_tokens=get_max_output_tokens(payload.requestType, payload.analysisMode),
            telemetry=telemetry,
        )
        return {
            "provider": "gateway",
            "upstreamProvider": upstream_provider,
            "resultType": "contextAnalysis",
            "skillVersion": word_analysis.SKILL_VERSION,
            "analysisMode": payload.analysisMode,
            "analysis": result,
        }

    if payload.requestType == "sentenceTranslation" and payload.analysisMode == "quick":
        prompt = sentence_translation.build_prompt(payload)
        result = client.generate_json(
            prompt,
            sentence_translation.get_schema_model(),
            payload.requestId,
            max_output_tokens=get_max_output_tokens(payload.requestType, payload.analysisMode),
            telemetry=telemetry,
        )
        return {
            "provider": "gateway",
            "upstreamProvider": upstream_provider,
            "resultType": "sentenceTranslation",
            "skillVersion": sentence_translation.SKILL_VERSION,
            "translation": result["translation"],
            "keyTerm": result["keyTerm"],
        }

    raise gateway_error(400, "INVALID_REQUEST", "请求字段不合法", False, payload.requestId)
