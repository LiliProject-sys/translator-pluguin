from __future__ import annotations

from .config import settings
from .deepseek_client import DeepSeekClient
from .gemini_client import GeminiClient
from .translation_profiles import (
    SENTENCE_TRANSLATION_MAX_TOKENS,
    WORD_DETAIL_MAX_TOKENS,
    WORD_QUICK_MAX_TOKENS,
    resolve_translation_profile,
)

SUPPORTED_UPSTREAM_PROVIDERS = frozenset({"gemini", "deepseek"})


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


def get_upstream_client_for_mode(mode: str):
    profile = resolve_translation_profile(mode)
    factories = {"deepseek": DeepSeekClient, "gemini": GeminiClient}
    client = factories[profile.provider](model=profile.model)
    client.translation_profile = profile
    return client
