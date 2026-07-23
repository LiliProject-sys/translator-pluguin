# Security Policy

Gateway Beta local `.env` files must remain untracked. Only `gateway/.env.example` may be committed. Gateway logs must not record full user text, full prompts, complete model responses, full Beta Tokens, Gemini API keys, cookies, or real user data.

Gateway Token verification uses the Bearer header and constant-time comparison. This phase includes only basic input limits, request body limits, timeouts, and redacted error mapping; it does not add accounts, payment, databases, Redis, or complex rate limiting.

## Supported Version

The current private beta distribution targets the latest local workspace version shown in `manifest.json`.

## Reporting Security Issues

For private testing, report security problems through the private GitHub repository issue tracker or the maintainer's direct contact channel. Do not post real API keys, exported vocabulary data, browser cookies, or provider responses in public places.

## Sensitive Data Rules

Never commit:

- Real API keys or provider tokens.
- `.env` files.
- Exported `translationSettings` or `vocabularyEntries`.
- Browser profile data.
- Personal reading history or private vocabulary exports.
- Release ZIP files unless a maintainer explicitly asks for them.

## API Key Handling

API keys are entered by users in the extension options page and stored in Chrome local extension storage. This is acceptable for a personal local demo, but it is not production-grade secret protection.

Future production distribution should consider a secure backend proxy, per-user credentials, usage quotas, and a formal privacy policy.

## Safe Source Links

Opening source pages is handled through a protocol whitelist. Unsafe schemes such as `javascript:` and `data:` should be rejected.
