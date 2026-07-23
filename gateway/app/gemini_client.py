from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from typing import Type

from pydantic import BaseModel, ValidationError

from .config import settings
from .errors import gateway_error

GEMINI_INTERACTIONS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions"


class GeminiClient:
    def __init__(self, api_key: str | None = None, model: str | None = None, timeout_seconds: int | None = None) -> None:
        self.api_key = api_key if api_key is not None else settings.gemini_api_key
        self.model = model or settings.gemini_model
        self.timeout_seconds = timeout_seconds or settings.gemini_timeout_seconds

    def generate_json(self, prompt: dict, schema_model: Type[BaseModel], request_id: str) -> dict:
        if not self.api_key:
            raise gateway_error(503, "UPSTREAM_CONFIGURATION_MISSING", "Gateway 暂时不可用", False, request_id)

        body = {
            "model": self.model,
            "system_instruction": prompt["system"],
            "input": json.dumps(prompt["user"], ensure_ascii=False),
            "response_format": {
                "type": "text",
                "mime_type": "application/json",
                "schema": schema_model.model_json_schema(),
            },
            "store": False,
        }
        request = urllib.request.Request(
            GEMINI_INTERACTIONS_ENDPOINT,
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": self.api_key,
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                response_data = json.loads(response.read().decode("utf-8"))
        except socket.timeout as exc:
            raise gateway_error(504, "UPSTREAM_TIMEOUT", "Gemini 请求超时", False, request_id) from exc
        except urllib.error.HTTPError as exc:
            raise map_upstream_http_error(exc, request_id) from exc
        except (urllib.error.URLError, OSError) as exc:
            raise gateway_error(503, "UPSTREAM_UNAVAILABLE", "Gemini 暂时不可用", False, request_id) from exc

        text = extract_interaction_text(response_data, request_id)
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise gateway_error(502, "UPSTREAM_INVALID_JSON", "Gemini 返回无效响应", False, request_id) from exc

        try:
            return schema_model.model_validate(parsed).model_dump()
        except ValidationError as exc:
            raise gateway_error(422, "UPSTREAM_SCHEMA_INVALID", "Gemini 返回结构不符合要求", False, request_id) from exc


def extract_interaction_text(response_data: dict, request_id: str) -> str:
    status = str(response_data.get("status", "")).lower()
    if status != "completed":
        raise gateway_error(502, "UPSTREAM_NOT_COMPLETED", "Gemini 返回无效响应", False, request_id)
    text_parts = []
    for step in response_data.get("steps", []) or []:
        if step.get("type") != "model_output":
            continue
        for item in step.get("content", []) or []:
            if item.get("type") == "text" and str(item.get("text", "")).strip():
                text_parts.append(str(item["text"]).strip())
    if not text_parts:
        raise gateway_error(502, "UPSTREAM_EMPTY_RESPONSE", "Gemini 返回空响应", False, request_id)
    return "".join(text_parts)


def map_upstream_http_error(error: urllib.error.HTTPError, request_id: str):
    status = error.code
    if status in (401, 403):
        return gateway_error(503, "UPSTREAM_AUTH_FAILED", "Gemini 暂时不可用", False, request_id)
    if status == 429:
        return gateway_error(429, "UPSTREAM_RATE_LIMITED", "Gemini 请求过于频繁，请稍后重试", False, request_id)
    if status >= 500:
        return gateway_error(503, "UPSTREAM_UNAVAILABLE", "Gemini 暂时不可用", False, request_id)
    return gateway_error(502, "UPSTREAM_INVALID_RESPONSE", "Gemini 返回无效响应", False, request_id)
