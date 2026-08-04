# Release Checklist

## Before Packaging

- [ ] Confirm `manifest.json` version and name.
- [ ] Run JavaScript syntax checks.
- [ ] Run the Node test suite in `tests/`.
- [ ] Run `git diff --check`.
- [ ] Scan source and history for secrets.
- [ ] Confirm no real API keys are in the repository.
- [ ] Confirm `.gitignore` excludes ZIP files, local credentials, local storage exports, and private notes.

## Packaging

- [ ] Run `scripts/package-extension.ps1`.
- [ ] Confirm the ZIP contains `manifest.json` at the root.
- [ ] Confirm the ZIP does not contain `.git`, `.agents`, `.codex`, docs render folders, tests, reports, private notes, or credential files.
- [ ] Compute and record the SHA-256 hash.

## Chrome Manual Check

- [ ] Load the unzipped extension in Chrome.
- [ ] Configure Mock, Gemini, DeepSeek, or Baidu.
- [ ] Test Word Analysis.
- [ ] Test Sentence Translation.
- [ ] Save a vocabulary entry.
- [ ] Open the vocabulary book.
- [ ] Delete an entry.
- [ ] Open a source link.
- [ ] Verify panel close, resize, and retry behavior.

## GitHub

- [ ] Confirm the target repository is private.
- [ ] Confirm the authenticated GitHub account is correct.
- [ ] Push only after secret scan and manual confirmation.
- [ ] Do not tag or create a release unless explicitly requested.
