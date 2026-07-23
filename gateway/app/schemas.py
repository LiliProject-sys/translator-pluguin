from typing import Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class LanguageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    requestId: str = Field(min_length=1, max_length=160)
    requestType: Literal["wordAnalysis", "sentenceTranslation"]
    analysisMode: Literal["quick", "detail"]
    sourceLanguage: str = Field(default="en", max_length=16)
    targetLanguage: str = Field(default="zh-CN", max_length=16)
    text: str = Field(min_length=1, max_length=5000)
    contextSentence: Optional[str] = Field(default=None, max_length=5000)
    pageTitle: Optional[str] = Field(default=None, max_length=300)

    @field_validator("requestId", "sourceLanguage", "targetLanguage", "text", "contextSentence", "pageTitle", mode="before")
    @classmethod
    def strip_text(cls, value):
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def validate_combination(self):
        if self.requestType == "sentenceTranslation" and self.analysisMode != "quick":
            raise ValueError("sentenceTranslation only supports quick analysisMode")
        return self

    def context_or_text(self) -> str:
        return self.contextSentence or self.text


class WordQuickAnalysis(BaseModel):
    model_config = ConfigDict(extra="forbid")

    word: str = Field(min_length=1)
    lemma: str = Field(min_length=1)
    phonetic: str = Field(min_length=1)
    partOfSpeech: Literal["adj.", "v.", "n.", "adv.", "prep.", "phr."]
    meaning: str = Field(min_length=1)

    @field_validator("*", mode="before")
    @classmethod
    def strip_text(cls, value):
        return value.strip() if isinstance(value, str) else value


class WordComparison(BaseModel):
    model_config = ConfigDict(extra="forbid")

    word: str = Field(min_length=1)
    difference: str = Field(min_length=1)

    @field_validator("*", mode="before")
    @classmethod
    def strip_text(cls, value):
        return value.strip() if isinstance(value, str) else value


class WordDetailAnalysis(BaseModel):
    model_config = ConfigDict(extra="forbid")

    meaningInSentence: str = Field(min_length=1)
    comparison: Optional[WordComparison]

    @field_validator("meaningInSentence", mode="before")
    @classmethod
    def strip_text(cls, value):
        return value.strip() if isinstance(value, str) else value


class SentenceKeyTerm(BaseModel):
    model_config = ConfigDict(extra="forbid")

    term: str = Field(min_length=1)
    meaning: str = Field(min_length=1)

    @field_validator("*", mode="before")
    @classmethod
    def strip_text(cls, value):
        return value.strip() if isinstance(value, str) else value


class SentenceTranslation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    translation: str = Field(min_length=1)
    keyTerm: Optional[SentenceKeyTerm]

    @field_validator("translation", mode="before")
    @classmethod
    def strip_translation(cls, value):
        return value.strip() if isinstance(value, str) else value


ProviderResult = Union[WordQuickAnalysis, WordDetailAnalysis, SentenceTranslation]
