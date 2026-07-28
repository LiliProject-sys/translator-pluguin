# Contributing

Orange翻译 is intentionally built with native Chrome Extension APIs, HTML, CSS, and JavaScript.

## Development Rules

- Do not introduce React, Vue, TypeScript, a Node backend, a database, or a build system without an explicit project decision.
- Keep `vocabularyEntries` backward compatible unless a migration plan is documented.
- Keep Word Analysis and Sentence Translation as separate skills and flows.
- Keep provider code separate from UI code.
- Do not persist AI detail output unless the project explicitly adds that feature.
- Do not commit API keys, local Chrome storage exports, or release ZIP files.

## Before Submitting Changes

Run the relevant checks:

```powershell
node --check background.js
node --check content.js
node --check popup.js
node --check options.js
node --check vocabulary.js
node --check translation-provider.js
node --check gemini-context-provider.js
node --check deepseek-context-provider.js
node --check baidu-translation-provider.js
node --check ai-context-skill.js
node --check sentence-translation-skill.js
```

Run the test files in `tests/` with Node. Then load the unpacked extension in Chrome and manually verify the changed user flow.

## Packaging

Use `scripts/package-extension.ps1` to create a local test ZIP. Generated ZIP files are ignored by Git by default.
