import asyncio
import json
import sys
import unittest
from unittest.mock import patch
from pathlib import Path

from fastapi import HTTPException
from pydantic import ValidationError

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

from gateway.app.auth import extract_bearer_token, verify_token_value
from gateway.app.config import MAX_REQUEST_BODY_BYTES, settings
from gateway.app.main import create_app
from gateway.app.schemas import LanguageRequest
from gateway.app.skills import sentence_translation


FIXTURE_DIR = PROJECT_ROOT / "gateway" / "contracts" / "fixtures"


class FakeGeminiClient:
    provider_id = "gemini"

    def __init__(self):
        self.calls = []

    def generate_json(
        self, prompt, schema_model, request_id, max_output_tokens=None, telemetry=None,
        thinking_type=None, reasoning_effort=None,
    ):
        self.calls.append({
            "prompt": prompt,
            "schema_model": schema_model,
            "request_id": request_id,
            "max_output_tokens": max_output_tokens,
            "thinking_type": thinking_type,
            "reasoning_effort": reasoning_effort,
        })
        if schema_model.__name__ == "WordQuickAnalysis":
            return {
                "word": "employed",
                "lemma": "employ",
                "phonetic": "/ɪmˈplɔɪ/",
                "partOfSpeech": "v.",
                "meaning": "使用；采用",
            }
        if schema_model.__name__ == "WordDetailAnalysis":
            return {
                "meaningInSentence": "被采用；被使用。",
                "comparison": None,
            }
        return {
            "translation": "这些技术越来越多地被用于三维物体的生产。",
            "keyTerm": None,
        }


class FakeDeepSeekClient(FakeGeminiClient):
    provider_id = "deepseek"


def route_endpoint(app, path, method):
    for route in app.routes:
        if getattr(route, "path", "") == path and method in getattr(route, "methods", set()):
            return route.endpoint
    raise AssertionError(f"Missing route {method} {path}")


class GatewayContractTests(unittest.TestCase):
    def setUp(self):
        self.original_token = settings.beta_access_token
        settings.beta_access_token = "valid-token"
        self.fake_gemini = FakeGeminiClient()
        self.app = create_app(self.fake_gemini)

    def tearDown(self):
        settings.beta_access_token = self.original_token

    def test_health_has_independent_contract(self):
        endpoint = route_endpoint(self.app, "/health", "GET")
        response = asyncio.run(endpoint())
        self.assertEqual(response, {"status": "ok", "service": "translator-gateway"})
        self.assertEqual(self.fake_gemini.calls, [])

    def test_verify_contract_and_token_errors(self):
        verify_endpoint = route_endpoint(self.app, "/v1/auth/verify", "POST")
        response = asyncio.run(verify_endpoint())
        self.assertEqual(response, {"status": "ok", "access": "granted"})
        self.assertEqual(self.fake_gemini.calls, [])

        self.assertEqual(extract_bearer_token("Bearer valid-token"), "valid-token")
        with self.assertRaises(HTTPException) as missing:
            extract_bearer_token("")
        self.assertEqual(missing.exception.status_code, 401)

        with self.assertRaises(HTTPException) as invalid:
            verify_token_value("wrong-token")
        self.assertEqual(invalid.exception.status_code, 401)
        self.assertEqual(invalid.exception.detail["errorCode"], "INVALID_ACCESS_TOKEN")

    def test_language_success(self):
        language_endpoint = route_endpoint(self.app, "/v1/language", "POST")
        payload = LanguageRequest.model_validate({
            "requestId": "selection-example-001",
            "requestType": "wordAnalysis",
            "analysisMode": "quick",
            "sourceLanguage": "en",
            "targetLanguage": "zh-CN",
            "text": "employed",
            "contextSentence": "These technologies are increasingly employed for the production of three-dimensional objects.",
            "pageTitle": "Example Research Page",
        })
        response = asyncio.run(language_endpoint(payload, "valid-token"))
        self.assertEqual(response["status"], "ok")
        self.assertEqual(response["requestId"], "selection-example-001")
        self.assertEqual(response["data"]["provider"], "gateway")
        self.assertEqual(response["data"]["upstreamProvider"], "gemini")
        self.assertNotIn("cached", response["data"])
        self.assertEqual(self.fake_gemini.calls[0]["max_output_tokens"], 256)

    def test_product_mode_routes_inside_gateway_and_legacy_defaults_to_precise(self):
        precise = FakeGeminiClient()
        fast = FakeDeepSeekClient()

        def resolve(mode):
            return fast if mode == "fast" else precise

        with patch("gateway.app.main.get_upstream_client_for_mode", side_effect=resolve) as resolver:
            endpoint = route_endpoint(create_app(), "/v1/language", "POST")
            base = {
                "requestType": "wordAnalysis",
                "analysisMode": "quick",
                "text": "employed",
            }
            legacy = LanguageRequest.model_validate({**base, "requestId": "legacy"})
            explicit_precise = LanguageRequest.model_validate(
                {**base, "requestId": "precise", "mode": "precise"}
            )
            explicit_fast = LanguageRequest.model_validate(
                {**base, "requestId": "fast", "mode": "fast"}
            )
            legacy_response = asyncio.run(endpoint(legacy, "valid-token"))
            precise_response = asyncio.run(endpoint(explicit_precise, "valid-token"))
            fast_response = asyncio.run(endpoint(explicit_fast, "valid-token"))

        self.assertEqual([call.args[0] for call in resolver.call_args_list], ["precise", "precise", "fast"])
        self.assertEqual(legacy_response["data"]["upstreamProvider"], "gemini")
        self.assertEqual(precise_response["data"]["upstreamProvider"], "gemini")
        self.assertEqual(fast_response["data"]["upstreamProvider"], "deepseek")

    def test_language_uses_injected_deepseek_upstream_without_contract_changes(self):
        deepseek = FakeDeepSeekClient()
        app = create_app(deepseek)
        language_endpoint = route_endpoint(app, "/v1/language", "POST")
        payload = LanguageRequest.model_validate({
            "requestId": "selection-deepseek-001",
            "mode": "fast",
            "requestType": "wordAnalysis",
            "analysisMode": "detail",
            "text": "employed",
            "contextSentence": "The method was employed for classification.",
        })
        response = asyncio.run(language_endpoint(payload, "valid-token"))
        self.assertEqual(response["data"]["provider"], "gateway")
        self.assertEqual(response["data"]["upstreamProvider"], "deepseek")
        self.assertEqual(response["data"]["skillVersion"], "deepseek-v4-flash-context-v12")
        self.assertIsNone(deepseek.calls[0]["max_output_tokens"])
        self.assertEqual(deepseek.calls[0]["thinking_type"], "enabled")
        self.assertEqual(deepseek.calls[0]["reasoning_effort"], "max")

    def test_language_rejects_invalid_combination_and_unknown_fields(self):
        self.assertEqual(LanguageRequest.model_validate({
            "requestId": "legacy", "requestType": "wordAnalysis", "analysisMode": "quick", "text": "word"
        }).mode, "precise")
        with self.assertRaises(ValidationError):
            LanguageRequest.model_validate({
                "requestId": "bad-mode", "requestType": "wordAnalysis", "analysisMode": "quick",
                "text": "word", "mode": "deepseek",
            })
        with self.assertRaises(ValidationError):
            LanguageRequest.model_validate({
                "requestId": "selection-bad",
                "requestType": "sentenceTranslation",
                "analysisMode": "detail",
                "text": "A sentence.",
            })
        with self.assertRaises(ValidationError):
            LanguageRequest.model_validate({
                "requestId": "selection-bad",
                "requestType": "sentenceTranslation",
                "analysisMode": "quick",
                "text": "A sentence.",
                "userQuestion": "must not be accepted",
            })

    def test_field_limits_and_body_limit_constants(self):
        with self.assertRaises(ValidationError):
            LanguageRequest.model_validate({
                "requestId": "selection-long",
                "requestType": "wordAnalysis",
                "analysisMode": "quick",
                "text": "x" * 5001,
            })
        with self.assertRaises(ValidationError):
            LanguageRequest.model_validate({
                "requestId": "selection-title",
                "requestType": "wordAnalysis",
                "analysisMode": "quick",
                "text": "word",
                "pageTitle": "x" * 301,
            })
        self.assertEqual(MAX_REQUEST_BODY_BYTES, 32 * 1024)

    def test_constant_time_compare_is_used(self):
        source = Path(PROJECT_ROOT / "gateway" / "app" / "auth.py").read_text(encoding="utf-8")
        self.assertIn("hmac.compare_digest", source)

    def test_fixtures_match_contract_shape(self):
        for name in [
            "word-quick-success.json",
            "word-detail-success.json",
            "word-detail-null-comparison.json",
            "sentence-success.json",
        ]:
            payload = json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "ok")
            self.assertEqual(payload["data"]["provider"], "gateway")
            self.assertEqual(payload["data"]["upstreamProvider"], "gemini")
            self.assertNotIn("cached", payload["data"])

    def test_sentence_translation_prompt_separates_target_and_context(self):
        payload = LanguageRequest.model_validate({
            "requestId": "selection-sentence-001",
            "requestType": "sentenceTranslation",
            "analysisMode": "quick",
            "sourceLanguage": "en",
            "targetLanguage": "zh-CN",
            "text": "Definition of LLM Agent",
            "contextSentence": "2.1 Definition of LLM Agent\nLLM technology continues to advance and enables autonomous behaviour.",
            "pageTitle": "Survey",
        })
        prompt = sentence_translation.build_prompt(payload)
        system = prompt["system"]
        user = prompt["user"]

        self.assertEqual(sentence_translation.SKILL_VERSION, "sentence-translation-v1.1")
        self.assertEqual(user["targetText"], "Definition of LLM Agent")
        self.assertEqual(user["contextSentence"], "2.1 Definition of LLM Agent\nLLM technology continues to advance and enables autonomous behaviour.")
        self.assertIn("targetText is the only TARGET TEXT", system)
        self.assertIn("contextSentence is CONTEXT ONLY", system)
        self.assertIn("translation field must correspond only to targetText", system)
        self.assertIn("Do not translate, restate, summarize, or output", system)
        self.assertIn("title, numbering, previous sentence, following sentence", system)
        self.assertIn("keyTerm.term must come from targetText", system)

    def test_sentence_translation_prompt_allows_context_for_resolution_only(self):
        payload = LanguageRequest.model_validate({
            "requestId": "selection-pronoun-001",
            "requestType": "sentenceTranslation",
            "analysisMode": "quick",
            "text": "These agents exhibit remarkable capabilities.",
            "contextSentence": "An LLM agent is an artificial intelligence system that uses a large language model.",
        })
        prompt = sentence_translation.build_prompt(payload)
        system = prompt["system"]

        self.assertEqual(prompt["user"]["targetText"], "These agents exhibit remarkable capabilities.")
        self.assertEqual(prompt["user"]["contextSentence"], "An LLM agent is an artificial intelligence system that uses a large language model.")
        self.assertIn("pronoun resolution", system)
        self.assertIn("ellipsis recovery", system)
        self.assertIn("must not add independent content outside targetText", system)


if __name__ == "__main__":
    unittest.main()
