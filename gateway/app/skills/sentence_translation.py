from __future__ import annotations

import json

from .word_analysis import SKILL_VERSION as WORD_SKILL_VERSION
from ..schemas import LanguageRequest, SentenceTranslation

SKILL_VERSION = "sentence-translation-v1.1"


def get_schema_model():
    return SentenceTranslation


def build_prompt(request: LanguageRequest) -> dict:
    example = {
        "translation": "这些技术越来越多地被用于三维物体的生产。",
        "keyTerm": None,
    }
    system = (
        "你是一名英语辅助翻译助手。只返回 JSON。"
        "targetText is the only TARGET TEXT and the only text to translate. "
        "contextSentence is CONTEXT ONLY. Use contextSentence only for terminology disambiguation, pronoun resolution, "
        "ellipsis recovery, style judgment, and background understanding inside targetText. "
        "The translation field must correspond only to targetText. "
        "Do not translate, restate, summarize, or output any title, numbering, previous sentence, following sentence, "
        "neighboring paragraph, or body text from contextSentence that is outside targetText. "
        "Context may resolve terms, pronouns, and omissions inside targetText, but must not add independent content outside targetText. "
        "Return exactly translation and keyTerm. keyTerm is null unless one technical term in targetText clearly blocks comprehension. "
        "keyTerm.term must come from targetText; keyTerm.meaning may use contextSentence to determine meaning. "
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
