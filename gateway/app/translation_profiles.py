"""Request-scoped product routing. No host or presentation concerns belong here."""
from dataclasses import dataclass

from .config import settings

WORD_QUICK_MAX_TOKENS = 256
WORD_DETAIL_MAX_TOKENS = 8192
SENTENCE_TRANSLATION_MAX_TOKENS = 8192

@dataclass(frozen=True)
class TranslationProfile:
    mode: str
    provider: str
    model: str
    thinking: str | None = None
    reasoning: str | None = None

    def generation_options(self) -> dict:
        if self.thinking is None:
            return {}
        options = {"thinking_type": self.thinking}
        if self.reasoning is not None:
            options["reasoning_effort"] = self.reasoning
        return options

    def output_limit(self, request_type: str, analysis_mode: str) -> int | None:
        # Match the Flash Lab: provider default budget, including reasoning.
        # Gemini's existing output limits remain unchanged.
        if self.provider == "deepseek":
            return None
        if request_type == "sentenceTranslation":
            return SENTENCE_TRANSLATION_MAX_TOKENS
        if analysis_mode == "detail":
            return WORD_DETAIL_MAX_TOKENS
        return WORD_QUICK_MAX_TOKENS

    def diagnostics(self) -> dict:
        return {"translationMode": self.mode, "provider": self.provider,
                "resolvedModel": self.model,
                "reasoningMode": self.reasoning or self.thinking or "unchanged"}


# Provider, model setting, thinking toggle, reasoning effort.
PROFILE_CONFIG = {
    "ultra_fast": ("deepseek", "deepseek_model", "disabled", None),
    "fast": ("deepseek", "deepseek_model", "enabled", "max"),
    "precise": ("gemini", "gemini_model", None, None),
}


def resolve_translation_profile(mode: str) -> TranslationProfile:
    try:
        provider, model_setting, thinking, reasoning = PROFILE_CONFIG[mode]
    except KeyError:
        raise ValueError(f"Unsupported product mode: {mode}") from None
    return TranslationProfile(mode, provider, getattr(settings, model_setting), thinking, reasoning)
