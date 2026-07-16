const assert = require("assert");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
global.self = global;
global.chrome = {
  runtime: { lastError: null },
  storage: { local: null }
};

require(path.join(projectRoot, "ai-context-skill.js"));
require(path.join(projectRoot, "gemini-context-provider.js"));
require(path.join(projectRoot, "deepseek-context-provider.js"));

const validAnalysis = Object.freeze({
  word: "employed",
  lemma: "employ",
  phonetic: "/ɪmˈplɔɪ/",
  partOfSpeech: "v.",
  meaning: "雇用；使用"
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
    async json() {
      return data;
    }
  };
}

function createCompletedResponse(analysis) {
  return {
    status: "completed",
    steps: [{
      type: "model_output",
      content: [{ type: "text", text: JSON.stringify(analysis || validAnalysis) }]
    }]
  };
}

function createProvider(fetchImpl, settings, extraOptions) {
  return geminiContextProviderFactory.createGeminiContextProvider({
    storageArea: createStorage(settings || {
      geminiApiKey: "test-api-key",
      geminiModel: "gemini-3.5-flash"
    }),
    fetchImpl,
    ...(extraOptions || {})
  });
}

async function expectErrorCode(promiseFactory, expectedCode) {
  await assert.rejects(promiseFactory, (error) => error && error.code === expectedCode);
}

async function testInteractionsRequestAndCompletedResponse() {
  let capturedRequest;
  const provider = createProvider(async (url, options) => {
    capturedRequest = { url, options };
    return createResponse(200, createCompletedResponse());
  }, {
    geminiApiKey: "test-api-key",
    geminiModel: "models/gemini-3.1-flash-lite"
  });

  const result = await provider.analyze({
    targetText: "employed",
    contextSentence: "The company employed engineers.",
    pageTitle: "Test page",
    sourceLanguage: "en",
    targetLanguage: "zh-CN"
  });

  assert.equal(capturedRequest.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(capturedRequest.options.headers["x-goog-api-key"], "test-api-key");
  const body = JSON.parse(capturedRequest.options.body);
  assert.equal(body.model, "gemini-3.1-flash-lite");
  assert.match(body.system_instruction, /Mode: quick/);
  assert.equal(typeof body.input, "string");
  assert.deepEqual(JSON.parse(body.input), aiContextSkill.buildInput({
    targetText: "employed",
    contextSentence: "The company employed engineers.",
    pageTitle: "Test page",
    sourceLanguage: "en",
    targetLanguage: "zh-CN"
  }));
  assert.equal(body.response_format.type, "text");
  assert.equal(body.response_format.mime_type, "application/json");
  assert.deepEqual(body.response_format.schema, aiContextSkill.getOutputSchema("quick"));
  assert.equal(body.store, false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, "generationConfig"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, "previous_interaction_id"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, "tools"), false);
  assert.equal(result.resultType, "contextAnalysis");
  assert.deepEqual(result.analysis, validAnalysis);
}

async function testNonCompletedStatusesNeverValidateJson() {
  const cases = [
    ["failed", "INTERACTION_FAILED"],
    ["incomplete", "INTERACTION_INCOMPLETE"],
    ["cancelled", "INTERACTION_CANCELLED"],
    ["budget_exceeded", "BUDGET_EXCEEDED"],
    ["requires_action", "REQUIRES_ACTION"],
    ["in_progress", "INTERACTION_IN_PROGRESS"],
    ["unknown_state", "INTERACTION_NOT_COMPLETED"]
  ];

  for (const [status, expectedCode] of cases) {
    let validationCalls = 0;
    const skill = {
      ...aiContextSkill,
      validateAnalysis(value) {
        validationCalls += 1;
        return aiContextSkill.validateAnalysis(value);
      }
    };
    const provider = createProvider(
      async () => createResponse(200, {
        status,
        steps: [{
          type: "model_output",
          content: [{ type: "text", text: JSON.stringify(validAnalysis) }]
        }]
      }),
      null,
      { skill }
    );
    await expectErrorCode(() => provider.analyze({ targetText: `word-${status}` }), expectedCode);
    assert.equal(validationCalls, 0, `${status} must not validate JSON output`);
  }
}

async function testOutputFailures() {
  await expectErrorCode(() => createProvider(
    async () => createResponse(200, { status: "completed", steps: [] })
  ).analyze({ targetText: "missing" }), "MODEL_OUTPUT_MISSING");

  await expectErrorCode(() => createProvider(
    async () => createResponse(200, {
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: "" }] }]
    })
  ).analyze({ targetText: "empty" }), "EMPTY_RESPONSE");

  await expectErrorCode(() => createProvider(
    async () => createResponse(200, {
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: "{bad" }] }]
    })
  ).analyze({ targetText: "invalid-json" }), "INVALID_JSON");

  await expectErrorCode(() => createProvider(
    async () => createResponse(200, createCompletedResponse({
      lemma: "test",
      phonetic: "/test/",
      partOfSpeech: "n.",
      meaning: "test"
    }))
  ).analyze({ targetText: "missing-field" }), "INVALID_ANALYSIS_SCHEMA");

  await expectErrorCode(() => createProvider(
    async () => createResponse(200, {
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "refusal", text: "" }] }]
    })
  ).analyze({ targetText: "blocked" }), "CONTENT_BLOCKED");
}

async function testSafeHttpDiagnostics() {
  const targetText = "SecretWord";
  const contextSentence = "The private context contains SecretWord and should not be logged.";
  const apiKey = "private-api-key";
  const provider = createProvider(async () => createResponse(400, {
    error: {
      status: "INVALID_ARGUMENT",
      message: `Bad request for ${targetText}: ${contextSentence}; key=${apiKey}; ${"x".repeat(400)}`
    }
  }), {
    geminiApiKey: apiKey,
    geminiModel: "gemini-3.5-flash"
  });

  try {
    await provider.analyze({ targetText, contextSentence, pageTitle: "Private page" });
    assert.fail("Expected BAD_REQUEST");
  } catch (error) {
    assert.equal(error.code, "BAD_REQUEST");
    assert.equal(error.publicMessage, "Gemini 请求参数无效，请检查模型或请求配置");
    assert.equal(error.diagnostics.httpStatus, 400);
    assert.equal(error.diagnostics.apiStatus, "INVALID_ARGUMENT");
    const serializedDiagnostics = JSON.stringify(error.diagnostics);
    assert.equal(serializedDiagnostics.includes(targetText), false);
    assert.equal(serializedDiagnostics.includes(contextSentence), false);
    assert.equal(serializedDiagnostics.includes(apiKey), false);
    assert(error.diagnostics.apiMessage.includes("[redacted]"));
    assert(error.diagnostics.apiMessage.length <= 241);
    assert.match(error.diagnostics.requestId, /^gemini-\d+-\d+$/);
  }
}

async function testBaiduAndMockRoutingRegression() {
  let settings = { provider: "baidu" };
  chrome.storage.local = {
    get(defaults, callback) {
      callback({ translationSettings: settings });
    }
  };
  global.baiduTranslationProviderFactory = {
    createBaiduTranslationProvider() {
      return {
        id: "baidu",
        async translate() {
          return { provider: "baidu", translatedText: "苹果" };
        }
      };
    }
  };
  require(path.join(projectRoot, "translation-provider.js"));

  const baiduResult = await languageService.process({ text: "apple" });
  assert.equal(baiduResult.provider, "baidu");
  assert.equal(baiduResult.resultType, "quickTranslation");
  assert.equal(baiduResult.translatedText, "苹果");

  settings = { provider: "mock" };
  const mockResult = await languageService.process({ text: "hello" });
  assert.equal(mockResult.provider, "mock");
  assert.equal(mockResult.resultType, "quickTranslation");
}

function testVocabularyShapeAndSourceInvariants() {
  const background = fs.readFileSync(path.join(projectRoot, "background.js"), "utf8");
  const providerSource = fs.readFileSync(path.join(projectRoot, "gemini-context-provider.js"), "utf8");
  const entryShape = /id: createId\(\),[\s\S]*?word: comparableEntry\.word,[\s\S]*?contextSentence: comparableEntry\.contextSentence,[\s\S]*?pageTitle: comparableEntry\.pageTitle,[\s\S]*?pageUrl: comparableEntry\.pageUrl,[\s\S]*?createdAt: new Date\(\)\.toISOString\(\)/;
  assert(entryShape.test(background));
  assert.equal(providerSource.includes(":generateContent"), false);
  assert.equal(providerSource.includes("generationConfig"), false);
  assert.equal(providerSource.includes("candidates"), false);
  assert(background.includes("safeError.diagnostics"));
  assert.equal(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8").includes('"version": "1.0.0"'), true);
  assert.equal(fs.readFileSync(path.join(projectRoot, "options.js"), "utf8").includes('"gemini-3.5-flash"'), true);
}

(async () => {
  await testInteractionsRequestAndCompletedResponse();
  await testNonCompletedStatusesNeverValidateJson();
  await testOutputFailures();
  await testSafeHttpDiagnostics();
  await testBaiduAndMockRoutingRegression();
  testVocabularyShapeAndSourceInvariants();
  console.log("stage6-interactions-bugfix-tests-ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
