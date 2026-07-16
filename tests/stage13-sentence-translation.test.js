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
  assert.equal(sentenceTranslationSkill.skillVersion, "sentence-translation-v1");
  assert.match(sentenceTranslationSkill.instructions, /快速理解英文句子或段落/);
  assert.match(sentenceTranslationSkill.instructions, /不要输出 Markdown/);
  assert.equal(sentenceTranslationSkill.validateTranslation(sentenceResult).translation, sentenceResult.translation);
  assert.equal(sentenceTranslationSkill.validateTranslation({ ...sentenceResult, keyTerm: null }).keyTerm, null);

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
    assert.equal(result.skillVersion, "sentence-translation-v1");
    assert.deepEqual(result.keyTerm, sentenceResult.keyTerm);
  });
  assert.match(deepSeekBody.messages[0].content, /JSON only/i);
  assert.match(deepSeekBody.messages[0].content, /keyTerm/);
  assert.match(geminiBody.system_instruction, /JSON only/i);
  assert.match(geminiBody.system_instruction, /keyTerm/);
  assert.deepEqual(geminiBody.response_format.schema, sentenceTranslationSkill.outputSchema);
}

function testUiAndProviderBoundaries() {
  const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
  const framework = fs.readFileSync(path.join(projectRoot, "translation-provider.js"), "utf8");
  const background = fs.readFileSync(path.join(projectRoot, "background.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));

  assert.equal(manifest.version, "1.0.0");
  assert(content.includes("function detectSelectionRequestType"));
  assert(content.includes("wordCount > 10"));
  assert(content.includes("text.length > 80"));
  assert(content.includes('requestType: currentSelectionRequestType'));
  assert(content.includes('result.resultType === "sentenceTranslation"'));
  assert(content.includes("function renderSentenceTranslation"));
  assert(content.includes("translator-plugin-sentence-key-term"));
  assert(framework.includes('resultType === "sentenceTranslation"'));
  assert(background.includes('"sentence-translation-skill.js"'));
  assert(background.includes("requestType: normalizeRequestType(payload.requestType)"));
  assert.equal(content.includes("requestType: \"sentenceTranslation\",\n      analysisMode: \"detail\""), false);

  assert.equal(detectSelectionType("reinforcing"), "wordAnalysis");
  assert.equal(detectSelectionType("reinforcing effect"), "wordAnalysis");
  assert.equal(detectSelectionType("This complete sentence contains enough words to explain a scientific relationship."), "sentenceTranslation");
  assert.equal(detectSelectionType("A".repeat(81)), "sentenceTranslation");
}

function detectSelectionType(text) {
  const normalized = String(text || "").trim().replace(/\s+/g, " ");
  const wordCount = normalized ? normalized.split(/\s+/).length : 0;
  return /[.?!;]/.test(normalized) || wordCount > 10 || normalized.length > 80
    ? "sentenceTranslation"
    : "wordAnalysis";
}

(async () => {
  testSentenceSkillContract();
  await testAiProvidersUseSentenceSkill();
  testUiAndProviderBoundaries();
  console.log("stage13-sentence-translation-tests-ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
