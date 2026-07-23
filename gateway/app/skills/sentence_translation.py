from __future__ import annotations

import json

from .word_analysis import SKILL_VERSION as WORD_SKILL_VERSION
from ..schemas import LanguageRequest, SentenceTranslation

SKILL_VERSION = "sentence-translation-v1"


def get_schema_model():
    return SentenceTranslation


def build_prompt(request: LanguageRequest) -> dict:
    example = {
        "translation": "这些技术越来越多地被用于三维物体的生产。",
        "keyTerm": None,
    }
    system = (
        "你是一名英语辅助翻译助手。只返回 JSON。"
        "Return exactly translation and keyTerm. keyTerm is null unless one technical term clearly blocks comprehension. "
        "Do not provide IPA, part of speech, comparison, word analysis, Markdown, or extra explanation."
    )
    return {
        "system": f"{system} JSON example: {json.dumps(example, ensure_ascii=False)}",
        "user": {
            "targetText": request.text,
            "contextSentence": request.context_or_text(),
            "pageTitle": request.pageTitle or "",
            "sourceLanguage": request.sourceLanguage,
            "targetLanguage": request.targetLanguage,
        },
    }
