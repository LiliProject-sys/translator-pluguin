import io
import json
import socket
import unittest
import urllib.error
from unittest.mock import patch

from fastapi import HTTPException

from gateway.app.config import settings
from gateway.app.deepseek_client import DeepSeekClient
from gateway.app.language_service import process_language_request
from gateway.app.schemas import LanguageRequest, SentenceTranslation, WordDetailAnalysis, WordQuickAnalysis
from gateway.app.upstream import (
    SENTENCE_TRANSLATION_MAX_TOKENS,
    WORD_DETAIL_MAX_TOKENS,
    WORD_QUICK_MAX_TOKENS,
    get_upstream_client,
    normalize_upstream_provider,
)


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self, size=-1):
        return json.dumps(self.payload, ensure_ascii=False).encode("utf-8")[:size]


def completion(content, finish_reason="stop", usage=None):
    return {
        "model": "deepseek-v4-flash",
        "choices": [{
            "finish_reason": finish_reason,
            "message": {
                "content": content,
                "reasoning_content": "must never become the business result",
            },
        }],
        "usage": usage or {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30},
    }


def quick_json():
    return json.dumps({
        "word": "employed",
        "lemma": "employ",
        "phonetic": "/ɪmˈplɔɪ/",
        "partOfSpeech": "v.",
        "meaning": "使用；采用",
    }, ensure_ascii=False)


def error_code(callable_value):
    with unittest.TestCase().assertRaises(HTTPException) as captured:
        callable_value()
    return captured.exception.detail["errorCode"], captured.exception.detail


class RecordingClient:
    provider_id = "deepseek"

    def __init__(self):
        self.calls = []

    def generate_json(
        self, prompt, schema_model, request_id, max_output_tokens=None, telemetry=None,
        thinking_type=None, reasoning_effort=None,
    ):
        self.calls.append((schema_model.__name__, max_output_tokens, thinking_type, reasoning_effort))
        if schema_model.__name__ == "WordQuickAnalysis":
            return json.loads(quick_json())
        if schema_model.__name__ == "WordDetailAnalysis":
            return {"meaningInSentence": "使用；采用。", "comparison": None}
        return {"translation": "完整译文。", "keyTerm": None}


class DeepSeekClientTests(unittest.TestCase):
    @patch("gateway.app.deepseek_client.urllib.request.urlopen")
    def test_business_profiles_reach_wire_and_keep_schemas(self, urlopen):
        self.client.model = settings.deepseek_model
        sentence = "The researchers proposed an innovative framework for the problem."
        cases = [
            ("wordAnalysis", "quick", "innovative", json.loads(quick_json()), "enabled", "max", "context-analysis-v6"),
            ("sentenceTranslation", "quick", sentence, {"translation": "测试译文", "keyTerm": None}, "enabled", "max", "sentence-translation-v1.1"),
            ("wordAnalysis", "detail", "innovative", {"meaningInSentence": "测试释义", "comparison": None}, "enabled", "max", "deepseek-v4-flash-context-v12"),
        ]
        for request_type, mode, text, result, thinking, effort, skill in cases:
            with self.subTest(request_type=request_type, mode=mode):
                urlopen.return_value = FakeResponse(completion(json.dumps(result)))
                payload = LanguageRequest(
                    requestId="profile-test", requestType=request_type, analysisMode=mode,
                    text=text, contextSentence=sentence, mode="fast",
                )
                telemetry = {}
                output = process_language_request(payload, self.client, telemetry)
                body = json.loads(urlopen.call_args.args[0].data)
                self.assertEqual(body["thinking"], {"type": thinking})
                if effort is None:
                    self.assertNotIn("reasoning_effort", body)
                else:
                    self.assertEqual(body["reasoning_effort"], effort)
                self.assertEqual(telemetry["reasoningEffort"], effort)
                self.assertEqual(output["skillVersion"], skill)
                self.assertEqual(body["response_format"], {"type": "json_object"})
                self.assertFalse(body["stream"])
                if mode == "detail":
                    self.assertNotIn("max_tokens", body)
                self.assertNotIn("reasoning_content", json.dumps(output))

    def setUp(self):
        self.client = DeepSeekClient(
            api_key="fake-deepseek-key-for-tests",
            model="deepseek-v4-flash",
            base_url="https://api.deepseek.com",
            timeout_seconds=5,
        )

    @patch("gateway.app.deepseek_client.urllib.request.urlopen")
    def test_request_contract_and_success(self, urlopen):
        urlopen.return_value = FakeResponse(completion(quick_json()))
        telemetry = {}
        result = self.client.generate_json(
            {"system": "Return JSON only. JSON example: {}", "user": {"targetText": "employed"}},
            WordQuickAnalysis,
            "request-quick",
            max_output_tokens=WORD_QUICK_MAX_TOKENS,
            telemetry=telemetry,
        )

        request = urlopen.call_args.args[0]
        body = json.loads(request.data.decode("utf-8"))
        self.assertEqual(request.full_url, "https://api.deepseek.com/chat/completions")
        self.assertEqual(request.get_header("Authorization"), "Bearer fake-deepseek-key-for-tests")
        self.assertEqual(body["model"], "deepseek-v4-flash")
        self.assertEqual(body["thinking"], {"type": "enabled"})
        self.assertEqual(body["reasoning_effort"], "max")
        self.assertNotEqual(body["thinking"]["type"], "disabled")
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertEqual(body["max_tokens"], 256)
        self.assertFalse(body["stream"])
        self.assertNotIn("temperature", body)
        self.assertEqual(body["reasoning_effort"], "max")
        self.assertEqual(result["lemma"], "employ")
        self.assertNotIn("reasoning_content", result)
        self.assertEqual(telemetry["totalTokens"], 30)
        self.assertEqual(telemetry["thinking"], "enabled")
        self.assertEqual(telemetry["reasoningEffort"], "max")
        self.assertEqual(telemetry["retryCount"], 0)

    @patch("gateway.app.deepseek_client.urllib.request.urlopen")
    def test_empty_content_retries_once(self, urlopen):
        urlopen.side_effect = [
            FakeResponse(completion("")),
            FakeResponse(completion(quick_json())),
        ]
        telemetry = {}
        result = self.client.generate_json(
            {"system": "JSON only", "user": {}},
            WordQuickAnalysis,
            "request-retry",
            telemetry=telemetry,
        )
        self.assertEqual(result["word"], "employed")
        self.assertEqual(urlopen.call_count, 2)
        self.assertEqual(telemetry["retryCount"], 1)

    @patch("gateway.app.deepseek_client.urllib.request.urlopen")
    def test_second_empty_content_fails(self, urlopen):
        urlopen.side_effect = [FakeResponse(completion("")), FakeResponse(completion(""))]
        code, _ = error_code(lambda: self.client.generate_json(
            {"system": "JSON only", "user": {}}, WordQuickAnalysis, "request-empty"
        ))
        self.assertEqual(code, "UPSTREAM_EMPTY_RESPONSE")
        self.assertEqual(urlopen.call_count, 2)

    def test_missing_key_is_explicit(self):
        client = DeepSeekClient(api_key="", model="deepseek-v4-flash")
        code, detail = error_code(lambda: client.generate_json(
            {"system": "JSON only", "user": {}}, WordQuickAnalysis, "request-no-key"
        ))
        self.assertEqual(code, "UPSTREAM_NOT_CONFIGURED")
        self.assertNotIn("API Key", detail["message"])

    @patch("gateway.app.deepseek_client.urllib.request.urlopen")
    def test_invalid_json_code_fence_and_schema_errors_are_distinct(self, urlopen):
        for content, expected in [
            ("not-json", "UPSTREAM_INVALID_JSON"),
            ("```json\n{}\n```", "UPSTREAM_INVALID_JSON"),
            (json.dumps({"word": "employed"}), "UPSTREAM_SCHEMA_INVALID"),
            (json.dumps({
                "word": "employed", "lemma": "employ", "phonetic": "/x/",
                "partOfSpeech": "v.", "meaning": "使用", "extra": "not allowed",
            }), "UPSTREAM_SCHEMA_INVALID"),
        ]:
            urlopen.return_value = FakeResponse(completion(content))
            code, _ = error_code(lambda: self.client.generate_json(
                {"system": "JSON only", "user": {}}, WordQuickAnalysis, f"request-{expected}"
            ))
            self.assertEqual(code, expected)

    @patch("gateway.app.deepseek_client.urllib.request.urlopen")
    def test_finish_reasons(self, urlopen):
        expected_codes = {
            "length": "UPSTREAM_OUTPUT_TRUNCATED",
            "content_filter": "UPSTREAM_CONTENT_BLOCKED",
            "tool_calls": "UPSTREAM_TOOL_CALL_UNSUPPORTED",
            "insufficient_system_resource": "UPSTREAM_RESOURCE_UNAVAILABLE",
            "": "UPSTREAM_NOT_COMPLETED",
            "future_reason": "UPSTREAM_NOT_COMPLETED",
        }
        for reason, expected in expected_codes.items():
            urlopen.return_value = FakeResponse(completion(quick_json(), reason))
            code, _ = error_code(lambda: self.client.generate_json(
                {"system": "JSON only", "user": {}}, WordQuickAnalysis, f"request-{expected}"
            ))
            self.assertEqual(code, expected)

    @patch("gateway.app.deepseek_client.urllib.request.urlopen")
    def test_http_error_mapping_does_not_expose_upstream_body(self, urlopen):
        mappings = {
            400: "UPSTREAM_REQUEST_REJECTED",
            401: "UPSTREAM_AUTH_FAILED",
            402: "UPSTREAM_QUOTA_EXHAUSTED",
            403: "UPSTREAM_AUTH_FAILED",
            422: "UPSTREAM_REQUEST_REJECTED",
            429: "UPSTREAM_RATE_LIMITED",
            500: "UPSTREAM_UNAVAILABLE",
            503: "UPSTREAM_UNAVAILABLE",
        }
        secret_text = "fake-deepseek-key-for-tests private prompt text"
        for status, expected in mappings.items():
            urlopen.side_effect = urllib.error.HTTPError(
                "https://api.deepseek.com/chat/completions",
                status,
                "error",
                {},
                io.BytesIO(json.dumps({"error": {"message": secret_text}}).encode("utf-8")),
            )
            code, detail = error_code(lambda: self.client.generate_json(
                {"system": "JSON only", "user": {"text": "private prompt text"}},
                WordQuickAnalysis,
                f"request-http-{status}",
            ))
            self.assertEqual(code, expected)
            self.assertNotIn(secret_text, json.dumps(detail, ensure_ascii=False))

    @patch("gateway.app.deepseek_client.urllib.request.urlopen")
    def test_timeout_and_network_errors(self, urlopen):
        urlopen.side_effect = socket.timeout()
        code, _ = error_code(lambda: self.client.generate_json(
            {"system": "JSON only", "user": {}}, WordQuickAnalysis, "request-timeout"
        ))
        self.assertEqual(code, "UPSTREAM_TIMEOUT")

        urlopen.side_effect = urllib.error.URLError("dns unavailable")
        code, _ = error_code(lambda: self.client.generate_json(
            {"system": "JSON only", "user": {}}, WordQuickAnalysis, "request-network"
        ))
        self.assertEqual(code, "UPSTREAM_UNAVAILABLE")

    def test_factory_and_provider_validation(self):
        self.assertEqual(get_upstream_client("gemini").provider_id, "gemini")
        self.assertEqual(get_upstream_client("deepseek").provider_id, "deepseek")
        with self.assertRaises(ValueError):
            normalize_upstream_provider("unsupported")

        original_provider = settings.gateway_upstream_provider
        try:
            settings.gateway_upstream_provider = "deepseek"
            self.assertEqual(get_upstream_client().provider_id, "deepseek")
        finally:
            settings.gateway_upstream_provider = original_provider

    def test_provider_keys_are_isolated(self):
        original_gemini_key = settings.gemini_api_key
        original_deepseek_key = settings.deepseek_api_key
        try:
            settings.gemini_api_key = ""
            settings.deepseek_api_key = "fake-deepseek-key-for-tests"
            self.assertEqual(get_upstream_client("deepseek").api_key, "fake-deepseek-key-for-tests")

            settings.gemini_api_key = "fake-gemini-key-for-tests"
            settings.deepseek_api_key = ""
            self.assertEqual(get_upstream_client("gemini").api_key, "fake-gemini-key-for-tests")
        finally:
            settings.gemini_api_key = original_gemini_key
            settings.deepseek_api_key = original_deepseek_key

    def test_business_service_uses_three_output_limits_and_existing_skills(self):
        client = RecordingClient()
        requests = [
            LanguageRequest.model_validate({
                "requestId": "quick", "mode": "fast", "requestType": "wordAnalysis", "analysisMode": "quick", "text": "employed"
            }),
            LanguageRequest.model_validate({
                "requestId": "detail", "mode": "fast", "requestType": "wordAnalysis", "analysisMode": "detail", "text": "employed"
            }),
            LanguageRequest.model_validate({
                "requestId": "sentence", "mode": "fast", "requestType": "sentenceTranslation", "analysisMode": "quick", "text": "A sentence."
            }),
        ]
        results = [process_language_request(request, client) for request in requests]
        self.assertEqual(client.calls, [
            ("WordQuickAnalysis", None, "enabled", "max"),
            ("WordDetailAnalysis", None, "enabled", "max"),
            ("SentenceTranslation", None, "enabled", "max"),
        ])
        self.assertEqual(results[0]["skillVersion"], "context-analysis-v6")
        self.assertEqual(results[1]["skillVersion"], "deepseek-v4-flash-context-v12")
        self.assertEqual(results[2]["skillVersion"], "sentence-translation-v1.1")
        self.assertTrue(all(result["upstreamProvider"] == "deepseek" for result in results))

    @patch("gateway.app.deepseek_client.urllib.request.urlopen")
    def test_sentence_schema_uses_same_adapter(self, urlopen):
        payload = json.dumps({"translation": "句子译文。", "keyTerm": None}, ensure_ascii=False)
        urlopen.return_value = FakeResponse(completion(payload))
        result = self.client.generate_json(
            {"system": "Return JSON only", "user": {"targetText": "A sentence."}},
            SentenceTranslation,
            "request-sentence",
            max_output_tokens=SENTENCE_TRANSLATION_MAX_TOKENS,
        )
        self.assertEqual(result["translation"], "句子译文。")
        body = json.loads(urlopen.call_args.args[0].data.decode("utf-8"))
        self.assertEqual(body["max_tokens"], 8192)

    @patch("gateway.app.deepseek_client.urllib.request.urlopen")
    def test_v12_detail_profile_uses_low_reasoning_without_max_tokens(self, urlopen):
        payload = json.dumps(
            {"meaningInSentence": "采用。", "comparison": None}, ensure_ascii=False
        )
        urlopen.return_value = FakeResponse(completion(payload))
        self.client.generate_json(
            {"system": "detail", "user": {"targetText": "employed"}},
            WordDetailAnalysis,
            "request-detail-v12",
            max_output_tokens=None,
            thinking_type="enabled",
            reasoning_effort="low",
        )
        body = json.loads(urlopen.call_args.args[0].data.decode("utf-8"))
        self.assertEqual(body["thinking"], {"type": "enabled"})
        self.assertEqual(body["reasoning_effort"], "low")
        self.assertNotIn("max_tokens", body)


if __name__ == "__main__":
    unittest.main()
