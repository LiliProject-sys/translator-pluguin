const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const projectRoot = path.resolve(__dirname, "..");
global.self = global;
global.chrome = {
  runtime: { lastError: null },
  storage: { local: null }
};

require(path.join(projectRoot, "ai-context-skill.js"));
require(path.join(projectRoot, "sentence-translation-skill.js"));
require(path.join(projectRoot, "deepseek-context-provider.js"));
require(path.join(projectRoot, "gemini-context-provider.js"));

const sentenceResult = Object.freeze({
  translation: "研究人员通过电化学方法评估了该材料的性能。",
  keyTerm: {
    term: "electrochemical method",
    meaning: "电化学方法，利用电极反应或电化学信号进行测量或分析的方法。"
  }
});

function createStorage(settings) {
  return {
    get(defaults, callback) {
      callback({ translationSettings: settings });
    }
  };
}

function createResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; }
  };
}

function testSentenceSkillContract() {
  assert.equal(sentenceTranslationSkill.skillVersion, "sentence-translation-v1.1");
  assert.match(sentenceTranslationSkill.instructions, /快速理解英文句子或段落/);
  assert.match(sentenceTranslationSkill.instructions, /targetText：用户实际选中的文本，是唯一翻译目标/);
  assert.match(sentenceTranslationSkill.instructions, /translation 字段只能对应 targetText/);
  assert.match(sentenceTranslationSkill.instructions, /contextSentence：自动提取的辅助上下文/);
  assert.match(sentenceTranslationSkill.instructions, /不得翻译、复述、总结或输出 contextSentence/);
  assert.match(sentenceTranslationSkill.instructions, /keyTerm 的源术语必须来自 targetText/);
  assert.match(sentenceTranslationSkill.instructions, /keyTerm\.meaning 可以参考 contextSentence/);
  assert.match(sentenceTranslationSkill.instructions, /不要输出 Markdown/);
  assert.equal(sentenceTranslationSkill.validateTranslation(sentenceResult).translation, sentenceResult.translation);
  assert.equal(sentenceTranslationSkill.validateTranslation({ ...sentenceResult, keyTerm: null }).keyTerm, null);

  const noContextInput = sentenceTranslationSkill.buildInput({
    text: "Definition of LLM Agent"
  });
  assert.equal(noContextInput.targetText, "Definition of LLM Agent");
  assert.equal(noContextInput.contextSentence, "Definition of LLM Agent");

  const repeatedTargetInput = sentenceTranslationSkill.buildInput({
    targetText: "Definition of LLM Agent",
    contextSentence: "2.1 Definition of LLM Agent\nDefinition of LLM Agent introduces the following section."
  });
  assert.equal(repeatedTargetInput.targetText, "Definition of LLM Agent");
  assert.equal(repeatedTargetInput.contextSentence, "2.1 Definition of LLM Agent\nDefinition of LLM Agent introduces the following section.");

  [
    { translation: "译文", keyTerm: [] },
    { translation: "译文", keyTerm: { term: "x", meaning: "y", extra: "z" } },
    { translation: "译文", keyTerm: { term: "", meaning: "解释" } },
    { translation: "- 译文", keyTerm: null },
    { translation: "**译文**", keyTerm: null },
    { ...sentenceResult, extra: "not allowed" }
  ].forEach((invalidResult) => {
    assert.throws(() => sentenceTranslationSkill.validateTranslation(invalidResult));
  });
}

async function testAiProvidersUseSentenceSkill() {
  let deepSeekBody;
  const deepSeek = deepSeekContextProviderFactory.createDeepSeekContextProvider({
    storageArea: createStorage({ deepseekApiKey: "key", deepseekModel: "deepseek-v4-flash" }),
    fetchImpl: async (url, options) => {
      deepSeekBody = JSON.parse(options.body);
      return createResponse(200, {
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(sentenceResult) } }]
      });
    }
  });

  let geminiBody;
  const gemini = geminiContextProviderFactory.createGeminiContextProvider({
    storageArea: createStorage({ geminiApiKey: "key", geminiModel: "gemini-3.5-flash" }),
    fetchImpl: async (url, options) => {
      geminiBody = JSON.parse(options.body);
      return createResponse(200, {
        status: "completed",
        steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(sentenceResult) }] }]
      });
    }
  });

  const request = {
    targetText: "Researchers evaluated the material using an electrochemical method.",
    contextSentence: "Researchers evaluated the material using an electrochemical method.",
    pageTitle: "Paper",
    requestType: "sentenceTranslation"
  };
  const [deepSeekResult, geminiResult] = await Promise.all([
    deepSeek.analyze(request),
    gemini.analyze(request)
  ]);

  [deepSeekResult, geminiResult].forEach((result) => {
    assert.equal(result.resultType, "sentenceTranslation");
    assert.equal(result.skillVersion, "sentence-translation-v1.1");
    assert.deepEqual(result.keyTerm, sentenceResult.keyTerm);
  });
  assert.match(deepSeekBody.messages[0].content, /JSON only/i);
  assert.match(deepSeekBody.messages[0].content, /keyTerm/);
  assert.match(deepSeekBody.messages[0].content, /targetText is the only TARGET TEXT|targetText：用户实际选中的文本，是唯一翻译目标/);
  assert.match(deepSeekBody.messages[0].content, /contextSentence is CONTEXT ONLY|contextSentence：自动提取的辅助上下文/);
  assert.match(deepSeekBody.messages[0].content, /keyTerm\.term must come from targetText|keyTerm 的源术语必须来自 targetText/);
  assert.match(geminiBody.system_instruction, /JSON only/i);
  assert.match(geminiBody.system_instruction, /keyTerm/);
  assert.match(geminiBody.system_instruction, /targetText is the only TARGET TEXT|targetText：用户实际选中的文本，是唯一翻译目标/);
  assert.match(geminiBody.system_instruction, /contextSentence is CONTEXT ONLY|contextSentence：自动提取的辅助上下文/);
  assert.match(geminiBody.system_instruction, /keyTerm\.term must come from targetText|keyTerm 的源术语必须来自 targetText/);
  assert.deepEqual(geminiBody.response_format.schema, sentenceTranslationSkill.outputSchema);
}

function testUiAndProviderBoundaries() {
  const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
  const framework = fs.readFileSync(path.join(projectRoot, "translation-provider.js"), "utf8");
  const background = fs.readFileSync(path.join(projectRoot, "background.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));

  assert.equal(manifest.version, "1.0.2");
  assert(content.includes("function detectSelectionRequestType"));
  assert(content.includes('return /\\s/u.test(text) ? "sentenceTranslation" : "wordAnalysis";'));
  assert.equal(content.includes("wordCount > 10"), false);
  assert.equal(content.includes("text.length > 80"), false);
  assert(content.includes('requestType: currentSelectionRequestType'));
  assert(content.includes('result.resultType === "sentenceTranslation"'));
  assert(content.includes("function renderSentenceTranslation"));
  assert(content.includes("translator-plugin-sentence-key-term"));
  assert(framework.includes('resultType === "sentenceTranslation"'));
  assert(background.includes('"sentence-translation-skill.js"'));
  assert(background.includes("requestType: normalizeRequestType(payload.requestType)"));
  assert.equal(content.includes("requestType: \"sentenceTranslation\",\n      analysisMode: \"detail\""), false);

  [
    "roadmap",
    "capability",
    "LLM",
    "state-of-the-art",
    "state‑of‑the‑art",
    "don't",
    "don’t",
    "user's",
    "LLM-based",
    "GPT-4",
    "agent-based",
    "roadmap.",
    "  roadmap  "
  ].forEach((text) => {
    assert.equal(detectSelectionType(text), "wordAnalysis", `${text} should be wordAnalysis`);
  });

  [
    "machine learning",
    "machine    learning",
    "machine\tlearning",
    "machine\nlearning",
    "machine\u00A0learning",
    "in terms of",
    "LLM Agent",
    "Definition of LLM Agent",
    "A Roadmap of Agent Research and Development",
    "Security and Privacy",
    "additive manufacturing defect detection",
    "  Definition of LLM Agent  "
  ].forEach((text) => {
    assert.equal(detectSelectionType(text), "sentenceTranslation", `${text} should be sentenceTranslation`);
  });
}

function detectSelectionType(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return "wordAnalysis";
  }

  return /\s/u.test(normalized) ? "sentenceTranslation" : "wordAnalysis";
}

function createElement(tagName) {
  const element = {
    tagName: tagName.toUpperCase(),
    id: "",
    className: "",
    dataset: {},
    style: {},
    hidden: false,
    disabled: false,
    children: [],
    parentElement: null,
    _textContent: "",
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; }
    },
    append(...children) {
      children.forEach((child) => {
        if (child && typeof child === "object") {
          child.parentElement = element;
        }
        element.children.push(child);
      });
    },
    appendChild(child) {
      if (child && typeof child === "object") {
        child.parentElement = element;
      }
      element.children.push(child);
      return child;
    },
    prepend(child) {
      if (child && typeof child === "object") {
        child.parentElement = element;
      }
      element.children.unshift(child);
      return child;
    },
    addEventListener() {},
    removeEventListener() {},
    remove() {},
    setAttribute(name, value) {
      element[name] = value;
    },
    insertAdjacentElement() {},
    cloneNode() {
      return createElement(tagName);
    },
    querySelector() {
      return null;
    },
    contains(target) {
      return target === element || element.children.includes(target);
    },
    getBoundingClientRect() {
      return { left: 20, top: 20, right: 380, bottom: 240, width: 360, height: 220 };
    },
    set textContent(value) {
      element._textContent = value;
    },
    get textContent() {
      return element._textContent;
    },
    set innerHTML(value) {
      element._innerHTML = value;
      element.children = [];
    },
    get innerHTML() {
      return element._innerHTML || "";
    }
  };
  return element;
}

async function testContentSelectionRequestTypeFlow(selectedText, contextText = selectedText) {
  const sentMessages = [];
  const body = createElement("body");
  body.textContent = contextText;
  body.innerText = contextText;
  const head = createElement("head");
  const selectedIndex = contextText.indexOf(selectedText);
  assert.notEqual(selectedIndex, -1, "test context must contain selected text");
  const textNode = {
    nodeType: 3,
    textContent: contextText,
    parentElement: body
  };
  const range = {
    commonAncestorContainer: textNode,
    startContainer: textNode,
    startOffset: selectedIndex,
    endOffset: selectedIndex + selectedText.length,
    toString() {
      return selectedText;
    },
    getBoundingClientRect() {
      return { left: 24, top: 40, right: 260, bottom: 62, width: 236, height: 22 };
    },
    getClientRects() {
      return [this.getBoundingClientRect()];
    }
  };
  const selection = {
    rangeCount: 1,
    toString() {
      return selectedText;
    },
    getRangeAt() {
      return range;
    }
  };

  const context = {
    console,
    setTimeout(callback) {
      if (typeof callback === "function") {
        callback();
      }
      return 1;
    },
    clearTimeout() {},
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      location: { href: "https://example.test/article" },
      getSelection() {
        return selection;
      },
      addEventListener() {},
      removeEventListener() {},
      setTimeout(callback) {
        if (typeof callback === "function") {
          callback();
        }
        return 1;
      },
      clearTimeout() {},
      requestAnimationFrame(callback) {
        if (typeof callback === "function") {
          callback();
        }
      }
    },
    document: {
      title: "Test Page",
      body,
      head,
      documentElement: {
        clientWidth: 1280,
        clientHeight: 800,
        appendChild() {}
      },
      addEventListener() {},
      removeEventListener() {},
      getElementById() {
        return null;
      },
      createElement,
      createTextNode(text) {
        return { nodeType: 3, textContent: text };
      }
    },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    ResizeObserver: function ResizeObserver() {
      this.observe = function observe() {};
      this.disconnect = function disconnect() {};
    },
    chrome: {
      runtime: {
        lastError: null,
        onMessage: { addListener() {} },
        sendMessage(message, callback) {
          sentMessages.push(message);
          if (message.type === "CHECK_VOCABULARY_STATUS") {
            callback({ status: "ok", wordExists: false, exactEntryExists: false });
            return;
          }
          if (message.type === "GET_ACTIVE_LANGUAGE_MODE") {
            callback({ status: "ok", provider: "gateway", resultType: "sentenceTranslation" });
            return;
          }
          if (message.type === "TRANSLATE_TEXT") {
            callback({
              status: "ok",
              provider: "gateway",
              resultType: "sentenceTranslation",
              skillVersion: "sentence-translation-v1.1",
              translation: "示例译文",
              keyTerm: null
            });
            return;
          }
          callback({ status: "ok" });
        }
      },
      storage: {
        local: {
          get(defaults, callback) {
            callback(defaults);
          }
        },
        onChanged: { addListener() {} }
      }
    }
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(projectRoot, "content.js"), "utf8"), context);
  await context.showPanelForCurrentSelection();

  const translateMessage = sentMessages.find((message) => message.type === "TRANSLATE_TEXT");
  assert(translateMessage, `TRANSLATE_TEXT was not sent for ${selectedText}`);
  assert.equal(translateMessage.payload.text, selectedText);
  assert.equal(translateMessage.payload.contextSentence, contextText.trim().replace(/\s+/g, " "));
  assert.equal(translateMessage.payload.requestType, "sentenceTranslation");
  assert.notEqual(translateMessage.payload.text, "capability");
  assert.notEqual(translateMessage.payload.text, "roadmap");
  assert.equal(translateMessage.payload.text.includes("LLM technology continues to advance"), false);
}

(async () => {
  testSentenceSkillContract();
  await testAiProvidersUseSentenceSkill();
  testUiAndProviderBoundaries();
  await testContentSelectionRequestTypeFlow("Definition of LLM Agent");
  await testContentSelectionRequestTypeFlow("A Roadmap of Agent Research and Development");
  await testContentSelectionRequestTypeFlow(
    "Definition of LLM Agent",
    "2.1 Definition of LLM Agent\nLLM technology continues to advance and enables autonomous behaviour."
  );
  console.log("stage13-sentence-translation-tests-ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
