# Changelog

## Unreleased

- Add local Gateway Beta scaffolding for FastAPI, fixed Gemini forwarding, plugin GatewayProvider, shared contract fixtures, and local-only onboarding.
- Keep Gateway Beta below the target `1.1.0` version until future Cloud Run deployment and remote Beta validation.

## 1.0.2 - Brand Refresh

- Rename the user-facing extension brand to `Orange翻译`.
- Add Chrome extension icon references for 16, 32, and 128 pixel PNG assets.

## 1.0.1 - Private Beta Candidate

- Keeps the floating reading panel open after saving vocabulary.
- Restores the save button after save failures so users can retry.
- Keeps explicit close actions: close button, Escape, outside click, or selecting new valid text.
- Includes the Stage18 vocabulary book and context recall features from the current workspace.

## 1.0.0 - Stable Local Demo Baseline

- Local vocabulary collection with Chrome Manifest V3.
- Floating selection panel with Word Analysis and Sentence Translation.
- Provider framework for Baidu, Gemini, DeepSeek, and Mock modes.
- Standalone vocabulary book with search, sorting, deletion, source links, context highlighting, and optional context translation.
- Sentence boundary fixes for decimals and common academic abbreviations.
