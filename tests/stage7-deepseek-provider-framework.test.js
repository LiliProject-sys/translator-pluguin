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
      callback({ translationSettings: settings || {
        deepseekApiKey: "test-key",
        deepseekModel: "deepseek-v4-flash"
      } });
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

function completed(content, finishReason = "stop") {
  return {
    choices: [{
      finish_reason: finishReason,
      message: { content }
    }]
  };
}

function createProvider(fetchImpl, settings, extraOptions) {
  return deepSeekContextProviderFactory.createDeepSeekContextProvider({
    storageArea: createStorage(settings),
    fetchImpl,
    ...(extraOptions || {})
  });
}

async function expectCode(factory, code) {
  await assert.rejects(factory, (error) => error && error.code === code);
}

async function testRequestAndSuccess() {
  let captured;
  const provider = createProvider(async (url, options) => {
    captured = { url, options };
    return createResponse(200, completed(JSON.stringify(validAnalysis)));
  });
  const result = await provider.analyze({
    targetText: "employed",
    contextSentence: "The company employed engineers.",
    pageTitle: "Test"
  });

  assert.equal(captured.url, "https://api.deepseek.com/chat/completions");
  assert.equal(captured.options.headers.Authorization, "Bearer test-key");
  const body = JSON.parse(captured.options.body);
  assert.equal(body.model, "deepseek-v4-flash");
  assert.equal(body.max_tokens, 500);
  assert.equal(body.stream, false);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.match(body.messages[0].content, /JSON only/i);
  assert.match(body.messages[0].content, /lemma/);
  assert.match(body.messages[0].content, /phonetic/);
  assert.match(body.messages[0].content, /partOfSpeech/);
  assert.match(body.messages[0].content, /meaning/);
  assert.doesNotMatch(body.messages[0].content, /academicMeaning/);
  assert.equal(result.provider, "deepseek");
  assert.equal(result.resultType, "contextAnalysis");
  assert.deepEqual(result.analysis, validAnalysis);
}

async function testFinishReasons() {
  const cases = [
    ["length", "OUTPUT_TRUNCATED"],
    ["content_filter", "CONTENT_BLOCKED"],
    ["insufficient_system_resource", "SERVICE_BUSY"],
    ["tool_calls", "UNEXPECTED_TOOL_CALL"],
    ["unexpected", "UNKNOWN_FINISH_REASON"],
    ["", "UNKNOWN_FINISH_REASON"]
  ];
  for (const [finishReason, code] of cases) {
    const provider = createProvider(async () => createResponse(
      200,
      completed(JSON.stringify(validAnalysis), finishReason)
    ));
    await expectCode(() => provider.analyze({ targetText: `word-${code}` }), code);
  }
}

async function testSingleEmptyRetry() {
  let calls = 0;
  const provider = createProvider(async () => {
    calls += 1;
    return createResponse(200, completed(calls === 1 ? "" : JSON.stringify(validAnalysis)));
  });
  const result = await provider.analyze({ targetText: "retry-success" });
  assert.equal(calls, 2);
  assert.deepEqual(result.analysis, validAnalysis);

  calls = 0;
  const emptyProvider = createProvider(async () => {
    calls += 1;
    return createResponse(200, completed(""));
  });
  await expectCode(() => emptyProvider.analyze({ targetText: "retry-empty" }), "EMPTY_RESPONSE");
  assert.equal(calls, 2);
}

async function testValidationAndDiagnostics() {
  await expectCode(() => createProvider(async () => createResponse(
    200,
    completed("{bad")
  )).analyze({ targetText: "bad-json" }), "INVALID_JSON");

  await expectCode(() => createProvider(async () => createResponse(
    200,
    completed(JSON.stringify({ ...validAnalysis, extra: "not allowed" }))
  )).analyze({ targetText: "extra-field" }), "INVALID_ANALYSIS_SCHEMA");

  const targetText = "SecretWord";
  const apiKey = "private-key";
  try {
    await createProvider(async () => createResponse(400, {
      error: {
        type: "invalid_request_error",
        message: `Bad request for ${targetText}; key=${apiKey}; ${"x".repeat(400)}`
      }
    }), { deepseekApiKey: apiKey }).analyze({ targetText });
    assert.fail("Expected BAD_REQUEST");
  } catch (error) {
    assert.equal(error.code, "BAD_REQUEST");
    const serialized = JSON.stringify(error.diagnostics);
    assert.equal(serialized.includes(targetText), false);
    assert.equal(serialized.includes(apiKey), false);
    assert(error.diagnostics.apiMessage.includes("[redacted]"));
    assert(error.diagnostics.apiMessage.length <= 241);
  }
}

async function testHttpErrorMapping() {
  const cases = [
    [401, "AUTH_FAILED"],
    [403, "AUTH_FAILED"],
    [404, "MODEL_NOT_FOUND"],
    [429, "RATE_LIMITED"],
    [500, "SERVICE_ERROR"]
  ];
  for (const [status, code] of cases) {
    const provider = createProvider(async () => createResponse(status, {
      error: { type: "api_error", message: "Safe diagnostic message" }
    }));
    await expectCode(() => provider.analyze({ targetText: `http-${status}` }), code);
  }
}

async function testTimeoutAndCancellation() {
  const timeoutProvider = createProvider((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  }), null, { timeoutMs: 5 });
  await expectCode(() => timeoutProvider.analyze({ targetText: "timeout" }), "REQUEST_TIMEOUT");

  let call = 0;
  const cancellationProvider = createProvider((url, options) => {
    call += 1;
    if (call === 1) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }
    return Promise.resolve(createResponse(200, completed(JSON.stringify(validAnalysis))));
  });
  const first = cancellationProvider.analyze({ targetText: "first-request" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = cancellationProvider.analyze({ targetText: "second-request" });
  await expectCode(() => first, "REQUEST_CANCELLED");
  assert.equal((await second).provider, "deepseek");
}

async function testCacheAndReset() {
  let calls = 0;
  const provider = createProvider(async () => {
    calls += 1;
    return createResponse(200, completed(JSON.stringify(validAnalysis)));
  });
  const request = { targetText: "cache", contextSentence: "Cache this context." };
  await provider.analyze(request);
  const cached = await provider.analyze(request);
  assert.equal(calls, 1);
  assert.equal(cached.cached, true);
  provider.reset();
  await provider.analyze(request);
  assert.equal(calls, 2);
}

async function testProviderRegistryRouting() {
  let settings = { provider: "deepseek" };
  chrome.storage.local = {
    get(defaults, callback) {
      callback({ translationSettings: settings });
    }
  };
  global.baiduTranslationProviderFactory = {
    createBaiduTranslationProvider() {
      return { translate: async () => ({ provider: "baidu", translatedText: "苹果" }) };
    }
  };
  global.deepSeekContextProviderFactory = {
    createDeepSeekContextProvider() {
      return {
        analyze: async () => ({
          provider: "deepseek",
          resultType: "contextAnalysis",
          analysis: validAnalysis
        })
      };
    }
  };
  global.geminiContextProviderFactory = {
    createGeminiContextProvider() {
      return {
        analyze: async () => ({
          provider: "gemini",
          resultType: "contextAnalysis",
          analysis: validAnalysis
        })
      };
    }
  };
  require(path.join(projectRoot, "translation-provider.js"));

  const modeInfo = await languageService.getActiveModeInfo();
  assert.deepEqual(modeInfo, { provider: "deepseek", resultType: "contextAnalysis" });
  const result = await languageService.process({ text: "employed" });
  assert.equal(result.provider, "deepseek");
  assert.equal(result.resultType, "contextAnalysis");

  settings = { provider: "gemini" };
  assert.equal((await languageService.getActiveModeInfo()).resultType, "contextAnalysis");
  settings = { provider: "baidu" };
  assert.equal((await languageService.getActiveModeInfo()).resultType, "quickTranslation");
  settings = { provider: "mock" };
  assert.equal((await languageService.getActiveModeInfo()).resultType, "quickTranslation");
}

function testStaticIntegration() {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));
  const background = fs.readFileSync(path.join(projectRoot, "background.js"), "utf8");
  const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
  const options = fs.readFileSync(path.join(projectRoot, "options.js"), "utf8");
  const provider = fs.readFileSync(path.join(projectRoot, "translation-provider.js"), "utf8");
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "1.0.0");
  assert(manifest.host_permissions.includes("https://api.deepseek.com/*"));
  assert(background.includes('"deepseek-context-provider.js"'));
  assert(background.includes("deepSeekContextProvider.reset"));
  assert(content.includes('response.resultType === "contextAnalysis"'));
  assert(options.includes("deepseekApiKey"));
  assert(provider.includes("providerRegistry"));
  assert(provider.includes('resultType: "contextAnalysis"'));
}

(async () => {
  await testRequestAndSuccess();
  await testFinishReasons();
  await testSingleEmptyRetry();
  await testValidationAndDiagnostics();
  await testHttpErrorMapping();
  await testTimeoutAndCancellation();
  await testCacheAndReset();
  await testProviderRegistryRouting();
  testStaticIntegration();
  console.log("stage7-deepseek-provider-framework-tests-ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
