# Orange翻译 Architecture

## Overview

Orange翻译 is a Chrome Manifest V3 extension. It uses native HTML, CSS, and JavaScript only. There is no build step, backend server, or database.

## Main Runtime Parts

- `content.js`: Reads selections from ordinary webpages, extracts context, renders the floating panel, and sends runtime messages.
- `background.js`: Runs as the MV3 service worker. It owns context menus, vocabulary save/delete/open-source messages, provider dispatch, storage updates, and URL safety checks.
- `translation-provider.js`: Dispatches language requests to the active provider.
- `ai-context-skill.js`: Defines Word Analysis behavior, JSON schemas, prompt constraints, and validation.
- `sentence-translation-skill.js`: Defines Sentence Translation behavior, JSON schema, prompt constraints, and validation.
- Provider files: `baidu-translation-provider.js`, `gemini-context-provider.js`, and `deepseek-context-provider.js`.
- `popup.*`: Shows count, settings entry, and a button to open the vocabulary book.
- `vocabulary.*`: Renders the standalone vocabulary book, search, sort modes, source opening, deletion, context highlighting, and context translation display.
- `options.*`: Lets users select and configure providers.

## Data Flow

```text
User selects text
-> content.js extracts selected text and context
-> floating panel appears immediately
-> background.js checks saved status and dispatches language processing
-> content.js renders Word Analysis, Sentence Translation, or quick translation
-> user saves vocabulary
-> background.js normalizes, deduplicates, enriches, and writes chrome.storage.local
-> vocabulary.html reads vocabularyEntries and renders the vocabulary book
```

## Storage Keys

- `vocabularyEntries`: Persistent vocabulary records.
- `translationSettings`: Provider mode and local API credentials.
- `vocabularySortMode`: Persistent vocabulary book sort preference.
- `vocabularyRandomOrder`: Session-only random order stored in `chrome.storage.session`.

## Compatibility Principle

Vocabulary records remain backward compatible. Optional fields may be absent on older entries. Duplicate detection is still based on `word + contextSentence + pageUrl`.
