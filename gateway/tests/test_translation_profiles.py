import asyncio
import hashlib
import json
from dataclasses import FrozenInstanceError
from pathlib import Path
import unittest
from unittest.mock import patch

from gateway.app.config import settings
from gateway.app.language_service import process_language_request
from gateway.app.main import create_app
from gateway.app.schemas import LanguageRequest
from gateway.app.translation_profiles import resolve_translation_profile
from gateway.app.upstream import get_upstream_client_for_mode
from gateway.tests.test_deepseek_client import FakeResponse, completion, quick_json
from gateway.tests.test_gateway_contract import FakeGeminiClient, route_endpoint


class TranslationProfileTests(unittest.TestCase):
    def test_resolver_is_frozen_config_driven_and_unknown_mode_rejected(self):
        for mode, provider, options in (
            ("ultra_fast", "deepseek", {"thinking_type": "disabled"}),
            ("fast", "deepseek", {"thinking_type": "enabled", "reasoning_effort": "max"}),
            ("precise", "gemini", {}),
        ):
            profile = resolve_translation_profile(mode)
            self.assertEqual(profile.provider, provider)
            self.assertEqual(profile.generation_options(), options)
            self.assertEqual(profile.model, getattr(settings, provider + "_model"))
            with self.assertRaises(FrozenInstanceError):
                profile.mode = "precise"
        with self.assertRaises(ValueError):
            resolve_translation_profile("invalid")

    @patch("gateway.app.deepseek_client.urllib.request.urlopen")
    def test_flash_modes_reach_wire_with_identical_prompts_and_inputs(self, urlopen):
        cases = (
            ("wordAnalysis", "quick", json.loads(quick_json()), "context-analysis-v6"),
            ("wordAnalysis", "detail", {"meaningInSentence": "测试", "comparison": None},
             "deepseek-v4-flash-context-v12"),
            ("sentenceTranslation", "quick", {"translation": "测试", "keyTerm": None},
             "sentence-translation-v1.1"),
        )
        for kind, analysis, result, version in cases:
            messages = []
            for mode in ("ultra_fast", "fast"):
                with self.subTest(mode=mode, kind=kind, analysis=analysis):
                    urlopen.return_value = FakeResponse(completion(json.dumps(result)))
                    client = get_upstream_client_for_mode(mode)
                    client.api_key = "mock-only"
                    request = LanguageRequest(requestId="test", requestType=kind,
                        analysisMode=analysis, mode=mode, text="sample",
                        contextSentence="This is a sample.")
                    telemetry = {}
                    output = process_language_request(request, client, telemetry)
                    body = json.loads(urlopen.call_args.args[0].data)
                    messages.append(body["messages"])
                    self.assertEqual(body["model"], settings.deepseek_model)
                    self.assertEqual(body["thinking"]["type"],
                                     "disabled" if mode == "ultra_fast" else "enabled")
                    self.assertEqual(body.get("reasoning_effort"), None if mode == "ultra_fast" else "max")
                    self.assertNotIn("max_tokens", body)
                    self.assertFalse(body["stream"])
                    self.assertEqual(body["response_format"], {"type": "json_object"})
                    self.assertEqual(output["skillVersion"], version)
                    self.assertEqual(telemetry["translationMode"], mode)
                    self.assertEqual(telemetry["resolvedModel"], client.model)
                    self.assertNotIn("translationMode", output)
            self.assertEqual(messages[0], messages[1])

    def test_client_keeps_resolved_model_when_configuration_changes(self):
        client = get_upstream_client_for_mode("fast")
        captured = client.translation_profile
        with patch.object(settings, "deepseek_model", "future-model"):
            self.assertEqual(client.translation_profile, captured)
            self.assertEqual(client.model, captured.model)
            self.assertEqual(resolve_translation_profile("fast").model, "future-model")

    def test_mismatched_client_profile_is_rejected_before_network(self):
        from fastapi import HTTPException
        from gateway.tests.test_gateway_contract import FakeDeepSeekClient
        wrong_mode = get_upstream_client_for_mode("fast")
        wrong_model = get_upstream_client_for_mode("ultra_fast")
        wrong_model.model = "other-model"
        for client, mode in ((wrong_mode, "ultra_fast"), (wrong_model, "ultra_fast"),
                             (FakeDeepSeekClient(), "precise")):
            with patch.object(client, "generate_json") as generate:
                with self.assertRaises(HTTPException) as caught:
                    process_language_request(LanguageRequest(requestId="mismatch", mode=mode,
                        requestType="wordAnalysis", analysisMode="quick", text="test"), client)
                self.assertEqual(caught.exception.detail["errorCode"], "GATEWAY_PROFILE_MISMATCH")
                generate.assert_not_called()

    def test_precise_keeps_existing_skills_limits_and_no_thinking_options(self):
        client = FakeGeminiClient()
        for kind, analysis, limit, version in (
            ("wordAnalysis", "quick", 256, "context-analysis-v6"),
            ("wordAnalysis", "detail", 8192, "context-analysis-v6"),
            ("sentenceTranslation", "quick", 8192, "sentence-translation-v1.1"),
        ):
            result = process_language_request(LanguageRequest(requestId="regression", mode="precise",
                requestType=kind, analysisMode=analysis, text="sample"), client)
            self.assertEqual(result["skillVersion"], version)
            self.assertEqual(client.calls[-1]["max_output_tokens"], limit)
            self.assertIsNone(client.calls[-1]["thinking_type"])
            self.assertIsNone(client.calls[-1]["reasoning_effort"])

    def test_diagnostics_are_request_scoped_and_never_log_input(self):
        client = get_upstream_client_for_mode("ultra_fast")
        endpoint = route_endpoint(create_app(client), "/v1/language", "POST")
        payload = LanguageRequest(requestId="private-request-id", mode="ultra_fast",
            requestType="wordAnalysis", analysisMode="quick", text="private-test-target")
        with patch.object(client, "generate_json", side_effect=RuntimeError("private-upstream-body")):
            with self.assertLogs("uvicorn.error", level="INFO") as captured:
                with self.assertRaises(RuntimeError):
                    asyncio.run(endpoint(payload, "private-token"))
        output = " ".join(captured.output)
        self.assertIn('"translationMode": "ultra_fast"', output)
        self.assertIn('"success": false', output)
        self.assertNotIn("private", output)

    def test_formal_skill_files_are_unchanged(self):
        root = Path(__file__).resolve().parents[1] / "app" / "skills"
        # Baseline hashes recorded before this mode-only change.
        expected = {
            "D189CCBDEF0FD863D9CB4927DA6F6F21B26ADA1543B8959774756B448129387F",
            "CC9DAA72A625BD107EDC1CB3BE9E2000E32AD989056C6180E8B00F43C2F882BD",
            "0BC4B630ABE597349D807739EB84523D4BDE393E894ADBFA6039E3DACB015106",
            "88F57EFBBCCF627ACBB1696500C25FD0D769F83AD4D6EB820F7AA01540BF0702",
        }
        actual = {hashlib.sha256(p.read_bytes().replace(b"\r\n", b"\n")).hexdigest().upper()
                  for p in root.glob("*.py")}
        self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
