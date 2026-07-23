# Privacy Policy

Translator-plugin is a local Chrome Extension demo for vocabulary collection, quick translation, and AI-assisted reading.

Gateway Beta local mode sends selected text, the context sentence, and an optional page title to the local Gateway at `http://127.0.0.1:8000`. The Gateway then uses a server-side Gemini API key. The extension does not send page URLs, whole-page text, cookies, browser history, local file paths, full vocabulary data, prompts, model names, provider preferences, or local BYOK API keys to the Gateway.

The shared Beta Token is sent only as an `Authorization: Bearer <Token>` header, not in the language JSON body. Real tokens and Gemini API keys must not be committed to Git, reports, README files, manifests, or tests.

## Data The Extension Reads

When you select text on a webpage, the content script may read:

- The selected word, phrase, sentence, or paragraph.
- Nearby text used as `contextSentence`.
- The current page title.
- The current page URL.

The extension does not read unrelated page content intentionally, but sentence extraction may use nearby text nodes to locate context.

## Data Stored Locally

The extension stores vocabulary records in `chrome.storage.local` under `vocabularyEntries`. Records may include:

- `id`
- `word`
- `contextSentence`
- `pageTitle`
- `pageUrl`
- `createdAt`
- Optional vocabulary fields such as `lemma`, `phonetic`, `partOfSpeech`, `meaning`
- Optional `contextTranslation`

Provider settings are stored in `chrome.storage.local` under `translationSettings`. This can include API keys you enter for Baidu, Gemini, or DeepSeek.

Chrome extension local storage is not a password vault. Do not use shared computers for private API keys or personal vocabulary data.

## External Requests

Depending on the selected provider, selected text and context may be sent directly from the extension service worker to:

- Baidu Translate API
- Gemini API
- DeepSeek API

Mock mode does not send network requests.

The project does not run its own server and does not provide cloud sync. API keys are not sent to content scripts or injected into webpages.

## Data Sharing

The extension does not intentionally share vocabulary data with the project author. Any data sent to external AI or translation providers is governed by those providers' own terms and policies.

## Deleting Data

You can delete saved vocabulary entries in the vocabulary book page. You can also remove all extension data by removing the extension from Chrome or clearing extension storage through Chrome developer tools.

## Logs

The service worker may log provider status and sanitized error messages for debugging. It should not log API keys, full request headers, selected text, full context, or complete provider responses.
