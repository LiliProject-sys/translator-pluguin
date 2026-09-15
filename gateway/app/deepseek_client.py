from __future__ import annotations

import json
import socket
import time
import urllib.error
import urllib.request
from typing import Type

from pydantic import BaseModel, ValidationError

from .config import settings
from .errors import gateway_error

MAX_EMPTY_CONTENT_RETRIES = 1
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
DEEPSEEK_THINKING_TYPE = "enabled"
DEEPSEEK_REASONING_EFFORT = "max"


class DeepSeekClient:
    provider_id = "deepseek"

    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        base_url: str | None = None,
        timeout_seconds: int | None = None,
    ) -> None:
        self.api_key = api_key if api_key is not None else settings.deepseek_api_key
        self.model = model or settings.deepseek_model
        self.base_url = (base_url or settings.deepseek_base_url).rstrip("/")
        self.timeout_seconds = timeout_seconds or settings.deepseek_timeout_seconds

    def generate_json(
        self,
        prompt: dict,
        schema_model: Type[BaseModel],
        request_id: str,
        max_output_tokens: int | None = None,
        telemetry: dict | None = None,
        thinking_type: str | None = None,
        reasoning_effort: str | None = None,
    ) -> dict:
        if not self.api_key:
            raise gateway_error(
                503,
                "UPSTREAM_NOT_CONFIGURED",
                "DeepSeek 上游尚未配置",
                False,
                request_id,
            )

        deadline = time.monotonic() + self.timeout_seconds
        retry_count = 0
        while True:
            response_data = self._request(
                prompt,
                request_id,
                max_output_tokens,
                max(0.001, deadline - time.monotonic()),
                thinking_type or DEEPSEEK_THINKING_TYPE,
                reasoning_effort or DEEPSEEK_REASONING_EFFORT,
            )
            choice = first_choice(response_data, request_id)
            finish_reason = str(choice.get("finish_reason") or "").strip().lower()
            validate_finish_reason(finish_reason, request_id)
            content = str((choice.get("message") or {}).get("content") or "").strip()

            if not content:
                if retry_count < MAX_EMPTY_CONTENT_RETRIES and time.monotonic() < deadline:
                    retry_count += 1
                    continue
                raise gateway_error(
                    502,
                    "UPSTREAM_EMPTY_RESPONSE",
                    "DeepSeek 返回空响应",
                    False,
                    request_id,
                )

            try:
                parsed = json.loads(content)
            except json.JSONDecodeError as exc:
                raise gateway_error(
                    502,
                    "UPSTREAM_INVALID_JSON",
                    "DeepSeek 返回无效 JSON",
                    False,
                    request_id,
                ) from exc

            try:
                result = schema_model.model_validate(parsed).model_dump()
            except ValidationError as exc:
                raise gateway_error(
                    422,
                    "UPSTREAM_SCHEMA_INVALID",
                    "DeepSeek 返回结构不符合要求",
                    False,
                    request_id,
                ) from exc

            if telemetry is not None:
                telemetry.update(
                    extract_usage_telemetry(
                        response_data,
                        self.model,
                        retry_count,
                        thinking_type or DEEPSEEK_THINKING_TYPE,
                        reasoning_effort or DEEPSEEK_REASONING_EFFORT,
                    )
                )
            return result

    def _request(
        self,
        prompt: dict,
        request_id: str,
        max_output_tokens: int | None,
        timeout_seconds: float,
        thinking_type: str,
        reasoning_effort: str,
    ) -> dict:
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": prompt["system"]},
                {"role": "user", "content": json.dumps(prompt["user"], ensure_ascii=False)},
            ],
            "thinking": {"type": thinking_type},
            "response_format": {"type": "json_object"},
            "stream": False,
        }
        if thinking_type == "enabled":
            body["reasoning_effort"] = reasoning_effort
        if max_output_tokens is not None:
            body["max_tokens"] = int(max_output_tokens)

        request = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                raw_body = response.read(MAX_RESPONSE_BYTES + 1)
        except socket.timeout as exc:
            raise gateway_error(504, "UPSTREAM_TIMEOUT", "DeepSeek 请求超时", False, request_id) from exc
        except urllib.error.HTTPError as exc:
            raise map_upstream_http_error(exc.code, request_id) from exc
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, (socket.timeout, TimeoutError)):
                raise gateway_error(504, "UPSTREAM_TIMEOUT", "DeepSeek 请求超时", False, request_id) from exc
            raise gateway_error(503, "UPSTREAM_UNAVAILABLE", "DeepSeek 暂时不可用", False, request_id) from exc
        except OSError as exc:
            raise gateway_error(503, "UPSTREAM_UNAVAILABLE", "DeepSeek 暂时不可用", False, request_id) from exc

        if len(raw_body) > MAX_RESPONSE_BYTES:
            raise gateway_error(502, "UPSTREAM_INVALID_RESPONSE", "DeepSeek 返回无效响应", False, request_id)
        try:
            return json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise gateway_error(502, "UPSTREAM_INVALID_RESPONSE", "DeepSeek 返回无效响应", False, request_id) from exc


def first_choice(response_data: dict, request_id: str) -> dict:
    choices = response_data.get("choices") if isinstance(response_data, dict) else None
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise gateway_error(502, "UPSTREAM_INVALID_RESPONSE", "DeepSeek 返回无效响应", False, request_id)
    return choices[0]


def validate_finish_reason(finish_reason: str, request_id: str) -> None:
    if finish_reason == "stop":
        return
    mappings = {
        "length": ("UPSTREAM_OUTPUT_TRUNCATED", "DeepSeek 输出被截断"),
        "content_filter": ("UPSTREAM_CONTENT_BLOCKED", "DeepSeek 拒绝处理当前内容"),
        "tool_calls": ("UPSTREAM_TOOL_CALL_UNSUPPORTED", "DeepSeek 返回了不支持的工具调用"),
        "insufficient_system_resource": ("UPSTREAM_RESOURCE_UNAVAILABLE", "DeepSeek 服务资源不足"),
    }
    code, message = mappings.get(
        finish_reason,
        ("UPSTREAM_NOT_COMPLETED", "DeepSeek 未正常完成请求"),
    )
    raise gateway_error(502, code, message, False, request_id)


def map_upstream_http_error(status: int, request_id: str):
    if status in (400, 422):
        return gateway_error(502, "UPSTREAM_REQUEST_REJECTED", "DeepSeek 拒绝了请求配置", False, request_id)
    if status in (401, 403):
        return gateway_error(503, "UPSTREAM_AUTH_FAILED", "DeepSeek 认证失败", False, request_id)
    if status == 402:
        return gateway_error(503, "UPSTREAM_QUOTA_EXHAUSTED", "DeepSeek 额度不足", False, request_id)
    if status == 429:
        return gateway_error(429, "UPSTREAM_RATE_LIMITED", "DeepSeek 请求过于频繁，请稍后重试", False, request_id)
    if status >= 500:
        return gateway_error(503, "UPSTREAM_UNAVAILABLE", "DeepSeek 暂时不可用", False, request_id)
    return gateway_error(502, "UPSTREAM_REQUEST_REJECTED", "DeepSeek 请求被拒绝", False, request_id)


def extract_usage_telemetry(
    response_data: dict,
    model: str,
    retry_count: int,
    thinking_type: str = DEEPSEEK_THINKING_TYPE,
    reasoning_effort: str = DEEPSEEK_REASONING_EFFORT,
) -> dict:
    usage = response_data.get("usage") if isinstance(response_data.get("usage"), dict) else {}
    return {
        "model": str(response_data.get("model") or model),
        "thinking": thinking_type,
        "reasoningEffort": reasoning_effort if thinking_type == "enabled" else None,
        "inputTokens": usage.get("prompt_tokens"),
        "outputTokens": usage.get("completion_tokens"),
        "totalTokens": usage.get("total_tokens"),
        "retryCount": retry_count,
    }
