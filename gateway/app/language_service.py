from __future__ import annotations

from .errors import gateway_error
from .schemas import LanguageRequest
from .skills import deepseek_v4_flash_word_detail, sentence_translation, word_analysis
from .translation_profiles import resolve_translation_profile


def process_language_request(payload: LanguageRequest, client, telemetry: dict | None = None) -> dict:
    upstream_provider = getattr(client, "provider_id", "gemini")
    profile = getattr(client, "translation_profile", None) or resolve_translation_profile(payload.mode)
    if (profile.mode != payload.mode or profile.provider != upstream_provider
            or getattr(client, "model", profile.model) != profile.model):
        # Never silently reinterpret a captured request using a reused client.
        raise gateway_error(500, "GATEWAY_PROFILE_MISMATCH", "翻译模式配置不一致", False, payload.requestId)
    if telemetry is not None:
        telemetry.update(profile.diagnostics())
    generation_options = profile.generation_options()

    if payload.requestType == "wordAnalysis":
        detail_v12 = upstream_provider == "deepseek" and payload.analysisMode == "detail"
        skill = deepseek_v4_flash_word_detail if detail_v12 else word_analysis
        prompt = skill.build_prompt(payload)
        schema_model = skill.get_schema_model(payload.analysisMode)
        result = client.generate_json(
            prompt,
            schema_model,
            payload.requestId,
            max_output_tokens=profile.output_limit(payload.requestType, payload.analysisMode),
            telemetry=telemetry,
            **generation_options,
        )
        return {
            "provider": "gateway",
            "upstreamProvider": upstream_provider,
            "resultType": "contextAnalysis",
            "skillVersion": skill.SKILL_VERSION,
            "analysisMode": payload.analysisMode,
            "analysis": result,
        }

    if payload.requestType == "sentenceTranslation" and payload.analysisMode == "quick":
        prompt = sentence_translation.build_prompt(payload)
        result = client.generate_json(
            prompt,
            sentence_translation.get_schema_model(),
            payload.requestId,
            max_output_tokens=profile.output_limit(payload.requestType, payload.analysisMode),
            telemetry=telemetry,
            **generation_options,
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
