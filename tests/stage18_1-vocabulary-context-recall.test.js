const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const projectRoot = path.resolve(__dirname, "..");

function createBackgroundContext(initialEntries) {
  const state = {
    vocabularyEntries: initialEntries ? initialEntries.slice() : []
  };
  const context = {
    console,
    URL,
    Set,
    Map,
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
            callback(defaults || {});
          },
          set(values, callback) {
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

function createVocabularyHooks() {
  const elements = new Map();
  function createNode(type, text) {
    return {
      type,
      tagName: type,
      children: [],
      className: "",
      textContent: text || "",
      appendChild(child) {
        this.children.push(child);
        return child;
      }
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
          elements.set(id, createNode("div"));
        }
        return elements.get(id);
      },
      createElement(tagName) {
        return createNode(tagName);
      },
      createTextNode(text) {
        return createNode("#text", text);
      },
      createDocumentFragment() {
        return createNode("#fragment");
      }
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
    context.saveVocabularyEntry(entry, { callback: resolve });
  });
}

async function testSaveResponseAndContextTranslationMerge() {
  const { context, state } = createBackgroundContext([
    {
      id: "old",
      word: "art",
      contextSentence: "The art method improves accuracy.",
      pageTitle: "Paper",
      pageUrl: "https://example.com/paper",
      createdAt: "2024-01-01T00:00:00.000Z"
    }
  ]);

  const duplicate = await saveEntry(context, {
    word: "art",
    contextSentence: "The art method improves accuracy.",
    pageTitle: "Paper",
    pageUrl: "https://example.com/paper",
    contextTranslation: "该方法提高了准确率。"
  });

  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.entryId, "old");
  assert.equal(duplicate.hasContextTranslation, true);
  assert.equal(state.vocabularyEntries.length, 1);
  assert.equal(state.vocabularyEntries[0].contextTranslation, "该方法提高了准确率。");
}

async function testSameContextTranslationReuseAndTaskSharing() {
  const { context, state } = createBackgroundContext([
    {
      id: "a",
      word: "employ",
      contextSentence: "The study employed a new method.",
      pageUrl: "https://example.com/paper",
      createdAt: "2024-01-01T00:00:00.000Z"
    },
    {
      id: "b",
      word: "method",
      contextSentence: "The study employed a new method.",
      pageUrl: "https://example.com/paper",
      createdAt: "2024-01-02T00:00:00.000Z"
    }
  ]);

  let providerCalls = 0;
  context.self.languageService = {
    process() {
      providerCalls += 1;
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            resultType: "sentenceTranslation",
            translation: "该研究采用了一种新方法。"
          });
        }, 5);
      });
    }
  };

  const first = context.generateVocabularyContextTranslation({
    entryId: "a",
    word: "employ",
    contextSentence: "The study employed a new method.",
    pageUrl: "https://example.com/paper"
  });
  const second = context.generateVocabularyContextTranslation({
    entryId: "b",
    word: "method",
    contextSentence: "The study employed a new method.",
    pageUrl: "https://example.com/paper"
  });

  const results = await Promise.all([first, second]);
  assert.equal(providerCalls, 1);
  assert(results.every((result) => result.status === "ok"));
  assert.equal(state.vocabularyEntries[0].contextTranslation, "该研究采用了一种新方法。");
  assert.equal(state.vocabularyEntries[1].contextTranslation, "该研究采用了一种新方法。");
}

async function testExistingSameContextTranslationIsReused() {
  const { context, state } = createBackgroundContext([
    {
      id: "a",
      word: "employ",
      contextSentence: "The study employed a new method.",
      pageUrl: "https://example.com/paper",
      contextTranslation: "该研究采用了一种新方法。",
      createdAt: "2024-01-01T00:00:00.000Z"
    },
    {
      id: "b",
      word: "method",
      contextSentence: "  The   study employed a new method. ",
      pageUrl: "https://example.com/paper",
      createdAt: "2024-01-02T00:00:00.000Z"
    }
  ]);
  context.self.languageService = {
    process() {
      throw new Error("Provider should not be called when translation can be reused.");
    }
  };

  const response = await context.generateVocabularyContextTranslation({
    entryId: "b",
    word: "method",
    contextSentence: "The study employed a new method.",
    pageUrl: "https://example.com/paper"
  });

  assert.equal(response.status, "ok");
  assert.equal(response.reused, true);
  assert.equal(state.vocabularyEntries[1].contextTranslation, "该研究采用了一种新方法。");
}

function testHighlightBoundariesAndSafety() {
  const hooks = createVocabularyHooks();

  assert.deepEqual(hooks.findLiteralMatches("The art method uses Art.", "art"), [
    { start: 4, end: 7 },
    { start: 20, end: 23 }
  ]);
  assert.deepEqual(hooks.findLiteralMatches("partial artifacts", "art"), []);
  assert.deepEqual(hooks.findLiteralMatches("state-of-the-art method", "art"), []);
  assert.deepEqual(hooks.findLiteralMatches("artist's approach", "artist"), []);
  assert.deepEqual(hooks.findLiteralMatches("Use a C++ method.", "C++"), [
    { start: 6, end: 9 }
  ]);
  assert.equal(hooks.shouldHighlightContext("art", "art"), false);
  assert.equal(hooks.shouldHighlightContext("This is a short sentence.", "This is a short sentence"), false);

  const fragment = hooks.createHighlightedContextFragment("<b>art</b> and art", "art");
  assert.equal(fragment.children.length, 4);
  assert.equal(fragment.children[0].textContent, "<b>");
  assert.equal(fragment.children[1].tagName, "mark");
  assert.equal(fragment.children[1].textContent, "art");
  assert.equal(fragment.children[2].textContent, "</b> and ");
  assert.equal(fragment.children[3].tagName, "mark");
}

function testStaticStage18_1Boundaries() {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));
  const background = fs.readFileSync(path.join(projectRoot, "background.js"), "utf8");
  const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
  const vocabulary = fs.readFileSync(path.join(projectRoot, "vocabulary.js"), "utf8");
  const readme = fs.readFileSync(path.join(projectRoot, "README.md"), "utf8");

  assert.equal(manifest.version, "1.0.0");
  assert(background.includes("GENERATE_VOCABULARY_CONTEXT_TRANSLATION"));
  assert(background.includes("contextTranslationTasks"));
  assert(background.includes("createVocabularyContextKey"));
  assert(content.includes("maybeStoreContextTranslationOnSnapshot"));
  assert(content.includes("GENERATE_VOCABULARY_CONTEXT_TRANSLATION"));
  assert(content.includes("response.hasContextTranslation"));
  assert(vocabulary.includes("createHighlightedContextFragment"));
  assert(vocabulary.includes("createTextNode"));
  assert.equal(vocabulary.includes(".innerHTML = entry.contextSentence"), false);
  assert(readme.includes("Stage18.1"));
}

(async () => {
  await testSaveResponseAndContextTranslationMerge();
  await testSameContextTranslationReuseAndTaskSharing();
  await testExistingSameContextTranslationIsReused();
  testHighlightBoundariesAndSafety();
  testStaticStage18_1Boundaries();
  console.log("stage18.1-vocabulary-context-recall-tests-ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
