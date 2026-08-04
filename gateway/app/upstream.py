from __future__ import annotations

from .config import settings
from .deepseek_client import DeepSeekClient
from .gemini_client import GeminiClient

SUPPORTED_UPSTREAM_PROVIDERS = frozenset({"gemini", "deepseek"})

WORD_QUICK_MAX_TOKENS = 256
WORD_DETAIL_MAX_TOKENS = 512
SENTENCE_TRANSLATION_MAX_TOKENS = 8192


def normalize_upstream_provider(provider_id: str | None) -> str:
    normalized = str(provider_id or "").strip().lower()
    if normalized not in SUPPORTED_UPSTREAM_PROVIDERS:
        raise ValueError(f"Unsupported Gateway upstream provider: {normalized or '<empty>'}")
    return normalized


def get_upstream_client(provider_id: str | None = None):
    selected = normalize_upstream_provider(provider_id or settings.gateway_upstream_provider)
    if selected == "deepseek":
        return DeepSeekClient()
    return GeminiClient()


def get_max_output_tokens(request_type: str, analysis_mode: str) -> int:
    if request_type == "sentenceTranslation":
        return SENTENCE_TRANSLATION_MAX_TOKENS
    if analysis_mode == "detail":
        return WORD_DETAIL_MAX_TOKENS
    return WORD_QUICK_MAX_TOKENS
