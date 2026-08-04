# Beta Test Guide

## Install From ZIP

1. Unzip the package to a normal folder, for example `Orange翻译`.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on Developer mode.
4. Click "Load unpacked".
5. Select the unzipped folder that contains `manifest.json`.
6. Confirm the extension name is `Orange翻译`.

## Configure A Provider

1. Click the extension icon.
2. Click Settings.
3. Choose one provider:
   - Mock: local demo mode, no API key needed.
   - Baidu quick translation: requires Baidu App ID and App Key.
   - Gemini AI context analysis: requires Gemini API Key.
   - DeepSeek AI context analysis: requires DeepSeek API Key.
4. Save the selected provider configuration.
5. Use the provider test button before normal reading.

## Try The Core Flow

1. Open a normal English webpage.
2. Select a word such as `employed`.
3. Wait for the floating panel to appear.
4. Save it to the vocabulary book.
5. Open the extension popup and click "Open Vocabulary Book".
6. Confirm the entry appears and the source link opens safely.

## Suggested Beta Checks

- Select a full sentence and confirm Sentence Translation appears.
- Select a word and confirm Word Analysis appears.
- Save the same word in the same sentence twice and confirm no duplicate entry is created.
- Save the same word in different contexts and confirm multiple contexts are allowed.
- Resize the floating panel and confirm it stays usable.
- Delete an entry from the vocabulary book.

## What To Report

Please include:

- Chrome version.
- Operating system.
- Provider mode.
- The page type, such as normal HTML page, PDF viewer, or web reader.
- What you selected.
- What happened versus what you expected.

Do not include real API keys in bug reports.
