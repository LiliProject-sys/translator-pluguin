from __future__ import annotations

import json
from typing import Type

from pydantic import BaseModel

from ..schemas import LanguageRequest, WordDetailAnalysis, WordQuickAnalysis

SKILL_VERSION = "context-analysis-v6"


def get_schema_model(analysis_mode: str) -> Type[BaseModel]:
    return WordDetailAnalysis if analysis_mode == "detail" else WordQuickAnalysis


def build_prompt(request: LanguageRequest) -> dict:
    if request.analysisMode == "detail":
        system = (
            "你是一名英语阅读辅助助手。只返回 JSON。"
            "Mode: detail. Return exactly meaningInSentence and comparison. "
            "comparison must be null unless one obvious synonym distinction exists. "
            "Do not output Markdown, author intention, background expansion, lists, or writing advice."
        )
        user = {
            "word": request.text,
            "sentence": request.context_or_text(),
            "context": request.pageTitle or "",
        }
        example = {"meaningInSentence": "被采用；被使用。", "comparison": None}
    else:
        system = (
            "你是一名英语阅读辅助助手。只返回 JSON。"
            "Mode: quick. Return exactly word, lemma, phonetic, partOfSpeech, and meaning. "
            "partOfSpeech must be exactly one of adj., v., n., adv., prep., or phr. "
            "Do not output Markdown or extra fields."
        )
        user = {
            "targetText": request.text,
            "contextSentence": request.context_or_text(),
            "pageTitle": request.pageTitle or "",
            "sourceLanguage": request.sourceLanguage,
            "targetLanguage": request.targetLanguage,
        }
        example = {
            "word": "employed",
            "lemma": "employ",
            "phonetic": "/ɪmˈplɔɪ/",
            "partOfSpeech": "v.",
            "meaning": "使用；采用",
        }
    return {
        "system": f"{system} JSON example: {json.dumps(example, ensure_ascii=False)}",
        "user": user,
    }
