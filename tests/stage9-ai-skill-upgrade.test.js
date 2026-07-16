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
require(path.join(projectRoot, "gemini-context-provider.js"));

const quickAnalysis = Object.freeze({
  word: "reinforcing",
  lemma: "reinforce",
  phonetic: "/ˌriːɪnˈfɔːrs/",
  partOfSpeech: "adj.",
  meaning: "加强；巩固"
});

const detailAnalysis = Object.freeze({
  meaningInSentence: "这里表示该效应具有增强材料结构的作用。",
  comparison: null
});

function createResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    }
  };
}

function createStorage(settings) {
  return {
    get(defaults, callback) {
      callback({ translationSettings: settings });
    }
  };
}

function completedGemini(analysis) {
  return {
    status: "completed",
    steps: [{
      type: "model_output",
      content: [{ type: "text", text: JSON.stringify(analysis) }]
    }]
  };
}

function completedDeepSeek(analysis) {
  return {
    choices: [{
      finish_reason: "stop",
      message: { content: JSON.stringify(analysis) }
    }]
  };
}

function expectSkillError(factory, expectedCode) {
  assert.throws(factory, (error) => error && error.code === expectedCode);
}

async function testSkillSchemas() {
  assert.equal(aiContextSkill.skillVersion, "context-analysis-v6");
  assert.deepEqual(aiContextSkill.getOutputSchema("quick").required, [
    "word",
    "lemma",
    "phonetic",
    "partOfSpeech",
    "meaning"
  ]);
  assert.deepEqual(aiContextSkill.getOutputSchema("detail").required, [
    "meaningInSentence",
    "comparison"
  ]);
  assert.deepEqual(aiContextSkill.validateAnalysis(quickAnalysis, "quick"), quickAnalysis);
  assert.deepEqual(aiContextSkill.validateAnalysis(detailAnalysis, "detail"), detailAnalysis);
  assert.equal(aiContextSkill.validateAnalysis({
    ...detailAnalysis,
    comparison: null
  }, "detail").comparison, null);

  expectSkillError(() => aiContextSkill.validateAnalysis({
    ...quickAnalysis,
    partOfSpeech: "verb"
  }, "quick"), "INVALID_PART_OF_SPEECH");
  expectSkillError(() => aiContextSkill.validateAnalysis({
    ...detailAnalysis,
    comparison: ["apply", "use"]
  }, "detail"), "INVALID_COMPARISON");
  expectSkillError(() => aiContextSkill.validateAnalysis({
    ...detailAnalysis,
    extra: "not allowed"
  }, "detail"), "INVALID_ANALYSIS_SCHEMA");
}

async function testDeepSeekModes() {
  const captures = [];
  const provider = deepSeekContextProviderFactory.createDeepSeekContextProvider({
    storageArea: createStorage({ deepseekApiKey: "key", deepseekModel: "deepseek-v4-flash" }),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      captures.push(body);
      return createResponse(200, completedDeepSeek(
        body.messages[0].content.includes("Mode: detail") ? detailAnalysis : quickAnalysis
      ));
    }
  });

  const quick = await provider.analyze({ targetText: "reinforcing" });
  const detail = await provider.analyze({ targetText: "reinforcing", analysisMode: "detail" });
  assert.equal(quick.analysisMode, "quick");
  assert.equal(detail.analysisMode, "detail");
  assert.match(captures[0].messages[0].content, /Quick JSON example/);
  assert.match(captures[1].messages[0].content, /Detail JSON example/);
  assert.match(captures[1].messages[0].content, /comparison/);
}

async function testGeminiModes() {
  const captures = [];
  const lifecycleLogs = [];
  const originalConsoleInfo = console.info;
  console.info = (...args) => lifecycleLogs.push(args);
  const provider = geminiContextProviderFactory.createGeminiContextProvider({
    storageArea: createStorage({ geminiApiKey: "key", geminiModel: "gemini-3.5-flash" }),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      captures.push(body);
      return createResponse(200, completedGemini(
        body.system_instruction.includes("Mode: detail") ? detailAnalysis : quickAnalysis
      ));
    }
  });

  try {
    await provider.analyze({ targetText: "employed" });
    const detail = await provider.analyze({
      targetText: "employed",
      analysisMode: "detail",
      requestId: "selection-9"
    });
    assert.equal(detail.analysisMode, "detail");
    assert.deepEqual(captures[0].response_format.schema, aiContextSkill.getOutputSchema("quick"));
    assert.equal(aiContextSkill.getOutputSchema("detail").properties.comparison.type[1], "null");
    assert.deepEqual(
      captures[1].response_format.schema.properties.comparison,
      aiContextSkill.getOutputSchema("detail").properties.comparison
    );
    assert.equal("nullable" in captures[1].response_format.schema.properties.comparison, false);
    assert.deepEqual(JSON.parse(captures[1].input), {
      word: "employed",
      sentence: "employed",
      context: "未命名页面",
      userQuestion: "请详细解释该词在当前论文语境中的用法。"
    });
    assert(lifecycleLogs.some(([event, data]) => event === "GEMINI_DETAIL_REQUEST_START"
      && data.requestId === "selection-9"));
    assert(lifecycleLogs.some(([event, data]) => event === "GEMINI_DETAIL_RESPONSE"
      && data.httpStatus === 200));
  } finally {
    console.info = originalConsoleInfo;
  }
}

async function testGeminiAbortReasonMapping() {
  let fetchCount = 0;
  const provider = geminiContextProviderFactory.createGeminiContextProvider({
    storageArea: createStorage({ geminiApiKey: "key", geminiModel: "gemini-3.5-flash" }),
    fetchImpl: async (url, options) => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      }
      return createResponse(200, completedGemini(detailAnalysis));
    }
  });

  const supersededRequest = provider.analyze({ targetText: "first" });
  const supersededAssertion = assert.rejects(supersededRequest, (error) => {
    return error && error.code === "REQUEST_SUPERSEDED" && error.code !== "NETWORK_ERROR";
  });
  await new Promise((resolve) => setImmediate(resolve));
  const detail = await provider.analyze({ targetText: "second", analysisMode: "detail" });
  assert.equal(detail.analysisMode, "detail");
  await supersededAssertion;
}

function testStaticUiAndCompatibility() {
  const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
  const background = fs.readFileSync(path.join(projectRoot, "background.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "1.0.0");
  assert(content.includes("详细解释"));
  assert(content.includes('analysisMode: "detail"'));
  assert(content.includes("formatLemmaDisplay"));
  assert(content.includes("近义词区别"));
  assert.equal(content.includes("易混淆词"), false);
  assert(content.includes('console.info("DETAIL_REQUEST_START"'));
  assert(content.includes('console.info("DETAIL_RESPONSE_APPLIED"'));
  assert(background.includes('console.info("DETAIL_REQUEST_RECEIVED"'));
  assert(background.includes('analysisMode: normalizeAnalysisMode(payload.analysisMode)'));
  assert(background.includes("diagnosticLog.analysisMode"));
  assert(background.includes('const STORAGE_KEY = "vocabularyEntries"'));
  assert(background.includes("contextTranslation"));
  assert.equal(background.includes("analysis:"), false);
}

(async () => {
  await testSkillSchemas();
  await testDeepSeekModes();
  await testGeminiModes();
  await testGeminiAbortReasonMapping();
  testStaticUiAndCompatibility();
  console.log("stage9-ai-skill-upgrade-tests-ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
