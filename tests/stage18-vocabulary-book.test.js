const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const projectRoot = path.resolve(__dirname, "..");

function createBackgroundContext(initialEntries, initialRandomOrder) {
  const state = {
    vocabularyEntries: initialEntries ? initialEntries.slice() : [],
    vocabularyRandomOrder: initialRandomOrder ? initialRandomOrder.slice() : []
  };
  const context = {
    console,
    URL,
    Set,
    Date,
    Math,
    crypto: { randomUUID: () => "generated-id" },
    self: {},
    importScripts() {},
    chrome: {
      runtime: {
        lastError: null,
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        onMessage: { addListener() {} }
      },
      contextMenus: {
        removeAll(callback) { callback && callback(); },
        create(options, callback) { callback && callback(); },
        onClicked: { addListener() {} }
      },
      storage: {
        onChanged: { addListener() {} },
        local: {
          get(defaults, callback) {
            callback({ vocabularyEntries: state.vocabularyEntries });
          },
          set(values, callback) {
            if (Array.isArray(values.vocabularyEntries)) {
              state.vocabularyEntries = values.vocabularyEntries;
            }
            callback && callback();
          }
        },
        session: {
          get(defaults, callback) {
            callback({ vocabularyRandomOrder: state.vocabularyRandomOrder });
          },
          set(values, callback) {
            if (Array.isArray(values.vocabularyRandomOrder)) {
              state.vocabularyRandomOrder = values.vocabularyRandomOrder;
            }
            callback && callback();
          }
        }
      },
      tabs: {
        create(options, callback) {
          state.openedUrl = options.url;
          callback && callback();
        },
        sendMessage(tabId, message, callback) {
          callback && callback();
        }
      }
    }
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(projectRoot, "background.js"), "utf8"), context);
  return { context, state };
}

function createVocabularyContext() {
  const elements = new Map();
  function createElement(tagName) {
    return {
      tagName,
      children: [],
      className: "",
      textContent: "",
      hidden: false,
      disabled: false,
      value: "",
      innerHTML: "",
      addEventListener() {},
      appendChild(child) { this.children.push(child); return child; },
      append(...children) { children.forEach((child) => this.appendChild(child)); }
    };
  }
  const context = {
    console,
    URL,
    Math,
    Set,
    Map,
    document: {
      addEventListener() {},
      getElementById(id) {
        if (!elements.has(id)) {
          elements.set(id, createElement("div"));
        }
        return elements.get(id);
      },
      createElement
    },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage() {},
        openOptionsPage() {}
      },
      storage: {
        onChanged: { addListener() {} },
        local: {},
        session: {}
      }
    }
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(projectRoot, "vocabulary.js"), "utf8"), context);
  return context.vocabularyBookTestHooks;
}

function saveEntry(context, entry) {
  return new Promise((resolve) => {
    context.saveVocabularyEntry(entry, {
      callback: resolve
    });
  });
}

function deleteEntry(context, entryId) {
  return new Promise((resolve) => {
    context.deleteVocabularyEntry(entryId, resolve);
  });
}

function openSource(context, pageUrl) {
  return new Promise((resolve) => {
    context.openVocabularySource(pageUrl, resolve);
  });
}

async function testSaveSupplementalFieldsAndNoAiFields() {
  const { context, state } = createBackgroundContext();
  const response = await saveEntry(context, {
    word: "employed",
    lemma: "employ",
    phonetic: "/ɪmˈplɔɪ/",
    partOfSpeech: "v.",
    meaning: "使用；采用",
    meaningInSentence: "不应保存",
    comparison: { word: "apply", difference: "x" },
    translation: "不应保存",
    keyTerm: { term: "x", meaning: "y" },
    contextSentence: "The method was employed.",
    pageTitle: "Paper",
    pageUrl: "https://example.com"
  });

  assert.equal(response.status, "saved");
  assert.equal(state.vocabularyEntries.length, 1);
  assert.deepEqual(Object.keys(state.vocabularyEntries[0]).sort(), [
    "contextSentence",
    "createdAt",
    "id",
    "lemma",
    "meaning",
    "pageTitle",
    "pageUrl",
    "partOfSpeech",
    "phonetic",
    "word"
  ].sort());
}

async function testLegacyEntryAndProgressiveMerge() {
  const legacy = {
    id: "old-id",
    word: "exposed",
    contextSentence: "Samples were exposed to air.",
    pageTitle: "Old",
    pageUrl: "https://example.com/old",
    createdAt: "2024-01-01T00:00:00.000Z"
  };
  const { context, state } = createBackgroundContext([legacy], ["old-id"]);
  const response = await saveEntry(context, {
    ...legacy,
    lemma: "expose",
    phonetic: "/ɪkˈspoʊz/",
    partOfSpeech: "v.",
    meaning: "暴露；接触"
  });

  assert.equal(response.status, "duplicate");
  assert.equal(state.vocabularyEntries.length, 1);
  assert.equal(state.vocabularyEntries[0].id, "old-id");
  assert.equal(state.vocabularyEntries[0].createdAt, legacy.createdAt);
  assert.equal(state.vocabularyEntries[0].lemma, "expose");
  assert.deepEqual(state.vocabularyRandomOrder, ["old-id"]);

  await saveEntry(context, {
    ...legacy,
    lemma: "override",
    meaning: "覆盖"
  });
  assert.equal(state.vocabularyEntries[0].lemma, "expose");
  assert.equal(state.vocabularyEntries[0].meaning, "暴露；接触");
}

async function testDeleteAndOpenSourceMessages() {
  const { context, state } = createBackgroundContext([
    { id: "a", word: "a", contextSentence: "a", pageUrl: "https://example.com/a", createdAt: "2024-01-01T00:00:00.000Z" },
    { id: "b", word: "b", contextSentence: "b", pageUrl: "https://example.com/b", createdAt: "2024-01-02T00:00:00.000Z" }
  ], ["b", "a"]);

  const deleteResponse = await deleteEntry(context, "a");
  assert.equal(deleteResponse.status, "ok");
  assert.deepEqual(state.vocabularyEntries.map((entry) => entry.id), ["b"]);
  assert.deepEqual(state.vocabularyRandomOrder, ["b"]);

  assert.equal((await openSource(context, "javascript:alert(1)")).status, "error");
  assert.equal((await openSource(context, "data:text/html,hi")).status, "error");
  assert.equal((await openSource(context, "https://example.com/source")).status, "ok");
  assert.equal(state.openedUrl, "https://example.com/source");
}

function testVocabularySortingSearchingAndUrls() {
  const hooks = createVocabularyContext();
  const entries = [
    { id: "1", word: "beta", lemma: "beta", meaning: "乙", contextSentence: "beta context", pageTitle: "B", createdAt: "2024-01-02T00:00:00.000Z" },
    { id: "2", word: "Alpha", lemma: "alpha", meaning: "甲", contextSentence: "alpha context", pageTitle: "A", createdAt: "2024-01-03T00:00:00.000Z" },
    { id: "3", word: "zeta", meaning: "搜索目标", contextSentence: "long sentence", pageTitle: "Z", createdAt: "bad-date" }
  ];

  assert.equal(hooks.normalizeSortMode("bad"), "random");
  assert.deepEqual(hooks.sortEntries(entries, "random", ["3", "1", "2"]).map((entry) => entry.id), ["3", "1", "2"]);
  assert.deepEqual(hooks.sortEntries(entries, "recent", []).map((entry) => entry.id), ["2", "1", "3"]);
  assert.deepEqual(hooks.sortEntries(entries, "alphabetical", []).map((entry) => entry.id), ["2", "1", "3"]);
  assert.deepEqual(hooks.getVisibleEntries(entries, "random", ["1", "2", "3"], "搜索目标").map((entry) => entry.id), ["3"]);
  assert.equal(hooks.formatEntryTitle({ word: "reinforcing", lemma: "reinforce" }), "reinforce (reinforcing)");
  assert.equal(hooks.formatEntryTitle({ word: "legacy" }), "legacy");
  assert.equal(hooks.isAllowedSourceUrl("https://example.com"), true);
  assert.equal(hooks.isAllowedSourceUrl("javascript:alert(1)"), false);
  assert.equal(hooks.isAllowedSourceUrl("data:text/html,hi"), false);
}

function testStaticStage18Boundaries() {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));
  const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
  const popup = fs.readFileSync(path.join(projectRoot, "popup.js"), "utf8");
  const vocabulary = fs.readFileSync(path.join(projectRoot, "vocabulary.js"), "utf8");
  const skill = fs.readFileSync(path.join(projectRoot, "ai-context-skill.js"), "utf8");
  const gemini = fs.readFileSync(path.join(projectRoot, "gemini-context-provider.js"), "utf8");
  const deepseek = fs.readFileSync(path.join(projectRoot, "deepseek-context-provider.js"), "utf8");

  assert.equal(manifest.version, "1.0.0");
  assert(content.includes("maybeStoreQuickAnalysisOnSnapshot"));
  assert(content.includes('currentSelectionRequestType !== "wordAnalysis"'));
  assert(content.includes("quickRequestId !== currentQuickRequestId"));
  assert(popup.includes("vocabulary.html"));
  assert.equal(popup.includes("deleteEntry("), false);
  assert(vocabulary.includes("vocabularyRandomOrder"));
  assert(vocabulary.includes("vocabularySortMode"));
  assert(vocabulary.includes("chrome.storage.session"));
  assert(skill.includes('const skillVersion = "context-analysis-v6"'));
  assert.equal(gemini.includes("vocabularyRandomOrder"), false);
  assert.equal(deepseek.includes("vocabularyRandomOrder"), false);
}

(async () => {
  await testSaveSupplementalFieldsAndNoAiFields();
  await testLegacyEntryAndProgressiveMerge();
  await testDeleteAndOpenSourceMessages();
  testVocabularySortingSearchingAndUrls();
  testStaticStage18Boundaries();
  console.log("stage18-vocabulary-book-tests-ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
