import asyncio
import json
import os
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from gateway.app import auth
from gateway.app.config import Settings
from gateway.app.main import create_app


class MultiAccessTests(unittest.TestCase):
    def configured(self, legacy='', additional=''):
        with patch.dict(os.environ, {'BETA_ACCESS_TOKEN': legacy, 'BETA_ACCESS_TOKENS': additional}):
            return Settings()

    def test_legacy_and_each_list_member_with_dedup(self):
        config = self.configured('test-token-a', json.dumps(['test-token-a', 'test-token-b', 'test-token-c']))
        self.assertEqual(len(config.valid_access_tokens), 3)
        with patch.object(auth, 'settings', config):
            for token in config.valid_access_tokens:
                self.assertIsNone(auth.verify_token_value(token))
            with self.assertRaises(HTTPException) as caught:
                auth.verify_token_value('test-invalid')
            self.assertEqual(caught.exception.status_code, 401)

    def test_legacy_only_and_list_only(self):
        for config in (self.configured('test-token-a'), self.configured('', '["test-token-a"]')):
            with patch.object(auth, 'settings', config):
                self.assertIsNone(auth.verify_token_value('test-token-a'))

    def test_empty_allowlist_is_closed(self):
        for additional in ('', '[]', '  '):
            with patch.object(auth, 'settings', self.configured('', additional)):
                for token in ('', 'test-token-a'):
                    with self.assertRaises(HTTPException) as caught:
                        auth.verify_token_value(token)
                    self.assertEqual(caught.exception.status_code, 401)

    def test_bad_config_fails_without_payload_in_error(self):
        for raw in ('["test-private-fixture",', '{}', 'null', '"test-private-fixture"',
                    '[1]', '[""]', '["with space"]', '["\\ud800"]'):
            with self.assertRaises(ValueError) as caught:
                self.configured('test-token-a', raw)
            self.assertNotIn('test-private-fixture', str(caught.exception))
            self.assertNotIn(raw, str(caught.exception))

    def test_unicode_invalid_input_is_401_not_500(self):
        with patch.object(auth, 'settings', self.configured('test-token-a')):
            for token in ('测试非法码', '\ud800'):
                with self.assertRaises(HTTPException) as caught:
                    auth.verify_token_value(token)
                self.assertEqual(caught.exception.status_code, 401)
        with patch.object(auth, 'settings', self.configured('', '["测试假值"]')):
            self.assertIsNone(auth.verify_token_value('测试假值'))

    def test_no_response_or_normal_log_disclosure(self):
        config = self.configured('test-private-fixture', '["test-token-b"]')
        with patch.object(auth, 'settings', config), self.assertNoLogs(level='INFO'):
            auth.require_beta_token('Bearer test-private-fixture')
            with self.assertRaises(HTTPException) as caught:
                auth.require_beta_token('Bearer test-invalid')
            endpoint = next(route.endpoint for route in create_app().routes
                            if getattr(route, 'path', '') == '/v1/auth/verify')
            response = asyncio.run(endpoint())
        serialized = json.dumps([response, caught.exception.detail])
        self.assertNotIn('test-private-fixture', serialized)
        self.assertNotIn('test-token-b', serialized)
        self.assertNotIn('test-invalid', serialized)
        self.assertEqual(response, {'status': 'ok', 'access': 'granted'})


if __name__ == '__main__':
    unittest.main()
