const assert = require("assert");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const CLOUD_RUN_GATEWAY_BASE_URL = "https://translator-gateway-beta-268073468344.asia-northeast1.run.app";
global.self = global;
global.chrome = {
  runtime: { lastError: null },
  storage: { local: null }
};

require(path.join(projectRoot, "ai-context-skill.js"));
require(path.join(projectRoot, "sentence-translation-skill.js"));
require(path.join(projectRoot, "gateway-language-provider.js"));

function createStorage(settings) {
  return {
    get(defaults, callback) {
      callback({ translationSettings: settings || { gatewayAccessToken: "valid-token", provider: "gateway" } });
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

const successEnvelope = Object.freeze({
  status: "ok",
  requestId: "selection-example-001",
  data: {
    provider: "gateway",
    upstreamProvider: "gemini",
    resultType: "contextAnalysis",
    skillVersion: "context-analysis-v6",
    analysisMode: "quick",
    analysis: {
      word: "employed",
      lemma: "employ",
      phonetic: "/ɪmˈplɔɪ/",
      partOfSpeech: "v.",
      meaning: "使用；采用"
    }
  }
});

const sentenceSuccessEnvelope = Object.freeze({
  status: "ok",
  requestId: "selection-sentence-001",
  data: {
    provider: "gateway",
    upstreamProvider: "gemini",
    resultType: "sentenceTranslation",
    skillVersion: "sentence-translation-v1.1",
    translation: "大语言模型智能体的定义",
    keyTerm: {
      term: "LLM Agent",
      meaning: "大语言模型智能体，可借助上下文理解为基于大语言模型的智能体。"
    }
  }
});

async function expectCode(factory, code) {
  await assert.rejects(factory, (error) => error && error.code === code);
}

async function testLanguageRequestWhitelist() {
  let captured;
  const provider = gatewayLanguageProviderFactory.createGatewayLanguageProvider({
    storageArea: createStorage(),
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return createResponse(200, successEnvelope);
    }
  });

  const result = await provider.process({
    text: "employed",
    contextSentence: "These technologies are increasingly employed for the production of three-dimensional objects.",
    pageTitle: `${"P".repeat(350)}`,
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    requestType: "wordAnalysis",
    analysisMode: "quick",
    requestId: "selection-example-001",
    userQuestion: "must not be sent",
    pageUrl: "https://example.com"
  });

  assert.equal(captured.url, `${CLOUD_RUN_GATEWAY_BASE_URL}/v1/language`);
  assert.equal(captured.options.headers.Authorization, "Bearer valid-token");
  assert.equal(captured.body.text, "employed");
  assert.equal(captured.body.pageTitle.length, 300);
  assert.equal(captured.body.requestId, "selection-example-001");
  assert.equal(Object.prototype.hasOwnProperty.call(captured.body, "userQuestion"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(captured.body, "pageUrl"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(captured.body, "providerPreference"), false);
  assert.equal(JSON.stringify(captured.body).includes("valid-token"), false);
  assert.equal(JSON.stringify(captured.body).includes("translator-gateway-beta"), false);
  assert.equal(result.provider, "gateway");
  assert.equal(result.upstreamProvider, "gemini");
  assert.equal(result.requestId, "selection-example-001");
  assert.equal(result.cached, undefined);
  assert.equal(provider.getPendingRequestCount(), 0);
}

async function testSentenceTranslationKeepsTargetAndContextSeparate() {
  let captured;
  const selectedText = "Definition of LLM Agent";
  const contextSentence = "2.1 Definition of LLM Agent\nLLM technology continues to advance and enables autonomous behaviour.";
  const provider = gatewayLanguageProviderFactory.createGatewayLanguageProvider({
    storageArea: createStorage(),
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return createResponse(200, sentenceSuccessEnvelope);
    }
  });

  const result = await provider.process({
    text: selectedText,
    contextSentence,
    pageTitle: "Survey",
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    requestType: "sentenceTranslation",
    analysisMode: "quick",
    requestId: "selection-sentence-001",
    pageUrl: "https://example.com/paper",
    userQuestion: "must not be sent"
  });

  assert.equal(captured.url, `${CLOUD_RUN_GATEWAY_BASE_URL}/v1/language`);
  assert.equal(captured.body.text, selectedText);
  assert.equal(captured.body.contextSentence, contextSentence);
  assert.equal(captured.body.requestType, "sentenceTranslation");
  assert.equal(captured.body.analysisMode, "quick");
  assert.equal(captured.body.text.includes("LLM technology continues to advance"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(captured.body, "userQuestion"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(captured.body, "pageUrl"), false);
  assert.equal(result.resultType, "sentenceTranslation");
  assert.equal(result.skillVersion, "sentence-translation-v1.1");
  assert.equal(result.translation, "大语言模型智能体的定义");
  assert.equal(result.keyTerm.term, "LLM Agent");
}

async function testRequestIdMismatchAndErrors() {
  const provider = gatewayLanguageProviderFactory.createGatewayLanguageProvider({
    storageArea: createStorage(),
    fetchImpl: async () => createResponse(200, { ...successEnvelope, requestId: "different" })
  });
  await expectCode(() => provider.process({ text: "employed", requestId: "selection-example-001" }), "GATEWAY_REQUEST_ID_MISMATCH");
  assert.equal(provider.getPendingRequestCount(), 0);

  const invalidTokenProvider = gatewayLanguageProviderFactory.createGatewayLanguageProvider({
    storageArea: createStorage(),
    fetchImpl: async () => createResponse(401, {
      status: "error",
      requestId: "selection-example-001",
      errorCode: "INVALID_ACCESS_TOKEN",
      message: "测试访问码无效",
      requiresConfiguration: true
    })
  });
  await expectCode(() => invalidTokenProvider.process({ text: "employed", requestId: "selection-example-001" }), "INVALID_ACCESS_TOKEN");
  assert.equal(invalidTokenProvider.getPendingRequestCount(), 0);

  let called = false;
  const tooLongProvider = gatewayLanguageProviderFactory.createGatewayLanguageProvider({
    storageArea: createStorage(),
    fetchImpl: async () => {
      called = true;
      return createResponse(200, successEnvelope);
    }
  });
  await expectCode(() => tooLongProvider.process({ text: "x".repeat(5001), requestId: "selection-long" }), "INVALID_REQUEST");
  assert.equal(called, false);
  assert.equal(tooLongProvider.getPendingRequestCount(), 0);
}

async function testAbortCleanupAndMapping() {
  const provider = gatewayLanguageProviderFactory.createGatewayLanguageProvider({
    storageArea: createStorage(),
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    })
  });
  const pending = provider.process({ text: "employed", requestId: "selection-abort" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(provider.getPendingRequestCount(), 1);
  assert.equal(provider.cancelRequest("selection-abort"), true);
  await expectCode(() => pending, "REQUEST_CANCELLED");
  assert.equal(provider.getPendingRequestCount(), 0);
}

async function testVerifyAccessTokenContract() {
  let captured;
  const provider = gatewayLanguageProviderFactory.createGatewayLanguageProvider({
    storageArea: createStorage(),
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return createResponse(200, { status: "ok", access: "granted" });
    }
  });
  const result = await provider.verifyAccessToken("candidate-token");
  assert.deepEqual(result, { status: "ok", access: "granted" });
  assert.equal(captured.url, `${CLOUD_RUN_GATEWAY_BASE_URL}/v1/auth/verify`);
  assert.equal(captured.options.headers.Authorization, "Bearer candidate-token");
}

async function testRegistryAndFixtures() {
  global.baiduTranslationProviderFactory = {
    createBaiduTranslationProvider() {
      return { translate: async () => ({ provider: "baidu", translatedText: "苹果" }) };
    }
  };
  global.deepSeekContextProviderFactory = {
    createDeepSeekContextProvider() {
      return { analyze: async () => ({ provider: "deepseek", resultType: "contextAnalysis", analysis: successEnvelope.data.analysis }) };
    }
  };
  global.geminiContextProviderFactory = {
    createGeminiContextProvider() {
      return { analyze: async () => ({ provider: "gemini", resultType: "contextAnalysis", analysis: successEnvelope.data.analysis }) };
    }
  };
  chrome.storage.local = createStorage({ provider: "gateway", gatewayAccessToken: "valid-token" });
  const originalFactory = global.gatewayLanguageProviderFactory;
  global.gatewayLanguageProviderFactory = {
    ...originalFactory,
    createGatewayLanguageProvider() {
      return {
        process: async () => successEnvelope.data,
        cancelRequest: () => false
      };
    }
  };
  require(path.join(projectRoot, "translation-provider.js"));
  const result = await languageService.process({ text: "employed", requestId: "selection-example-001" });
  assert.equal(result.provider, "gateway");
  assert.equal(result.upstreamProvider, "gemini");
  assert.equal(result.cached, undefined);

  const fixtureDir = path.join(projectRoot, "gateway", "contracts", "fixtures");
  ["word-quick-success.json", "word-detail-success.json", "word-detail-null-comparison.json"].forEach((file) => {
    const fixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, file), "utf8"));
    assert.equal(fixture.data.resultType, "contextAnalysis");
    assert.doesNotThrow(() => aiContextSkill.validateAnalysis(fixture.data.analysis, fixture.data.analysisMode));
  });
  const sentenceFixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, "sentence-success.json"), "utf8"));
  assert.doesNotThrow(() => sentenceTranslationSkill.validateTranslation({
    translation: sentenceFixture.data.translation,
    keyTerm: sentenceFixture.data.keyTerm
  }));
}

function testStaticIntegration() {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));
  const background = fs.readFileSync(path.join(projectRoot, "background.js"), "utf8");
  const provider = fs.readFileSync(path.join(projectRoot, "gateway-language-provider.js"), "utf8");
  const options = fs.readFileSync(path.join(projectRoot, "options.js"), "utf8");
  assert(manifest.host_permissions.includes(`${CLOUD_RUN_GATEWAY_BASE_URL}/*`));
  assert.equal(manifest.host_permissions.includes("http://127.0.0.1:8000/*"), false);
  assert.equal(manifest.host_permissions.includes("http://localhost:8000/*"), false);
  assert.equal(manifest.host_permissions.includes("https://*.run.app/*"), false);
  assert(background.includes('"gateway-language-provider.js"'));
  assert(background.includes("handleGatewayProviderTest"));
  assert(provider.includes(`const GATEWAY_BASE_URL = "${CLOUD_RUN_GATEWAY_BASE_URL}";`));
  assert.equal(provider.includes("http://127.0.0.1:8000"), false);
  assert.equal(provider.includes("localhost:8000"), false);
  assert.equal((provider.match(/GATEWAY_BASE_URL/g) || []).length >= 2, true);
  assert(options.includes('provider: "gateway"'));
  assert(options.includes("gatewayAccessToken"));
}

(async () => {
  await testLanguageRequestWhitelist();
  await testSentenceTranslationKeepsTargetAndContextSeparate();
  await testRequestIdMismatchAndErrors();
  await testAbortCleanupAndMapping();
  await testVerifyAccessTokenContract();
  await testRegistryAndFixtures();
  testStaticIntegration();
  console.log("gateway-provider-tests-ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
