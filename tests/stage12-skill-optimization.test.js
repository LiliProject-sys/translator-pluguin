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
  word: "employed",
  lemma: "employ",
  phonetic: "/ɪmˈplɔɪ/",
  partOfSpeech: "v.",
  meaning: "使用；采用"
});

const detailAnalysis = Object.freeze({
  meaningInSentence: "表示将3D打印技术作为生产3D对象的技术手段采用。",
  comparison: {
    word: "apply",
    difference: "employ 强调把技术、工具或资源作为手段使用；apply 强调把方法作用于明确对象。",
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

function completedDeepSeek(analysis) {
  return {
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(analysis) } }]
  };
}

function completedGemini(analysis) {
  return {
    status: "completed",
    steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(analysis) }] }]
  };
}

function expectSkillError(factory, expectedCode) {
  assert.throws(factory, (error) => error && error.code === expectedCode);
}

function testSkillContract() {
  assert.equal(aiContextSkill.skillVersion, "context-analysis-v6");
  assert.deepEqual(aiContextSkill.getOutputSchema("quick").required, [
    "word", "lemma", "phonetic", "partOfSpeech", "meaning"
  ]);
  assert.deepEqual(aiContextSkill.getOutputSchema("detail").required, [
    "meaningInSentence", "comparison"
  ]);
  const comparisonSchema = aiContextSkill.getOutputSchema("detail").properties.comparison;
  assert.deepEqual(comparisonSchema.type, ["object", "null"]);
  assert.deepEqual(comparisonSchema.required, ["word", "difference"]);
  assert.equal(comparisonSchema.additionalProperties, false);
  assert.deepEqual(aiContextSkill.validateAnalysis(quickAnalysis, "quick"), quickAnalysis);
  assert.deepEqual(aiContextSkill.validateAnalysis(detailAnalysis, "detail"), detailAnalysis);
  assert.equal(aiContextSkill.validateAnalysis({
    meaningInSentence: "表示增强作用。",
    comparison: null
  }, "detail").comparison, null);

  expectSkillError(() => aiContextSkill.validateAnalysis({ ...quickAnalysis, partOfSpeech: "verb" }, "quick"), "INVALID_PART_OF_SPEECH");
  expectSkillError(() => aiContextSkill.validateAnalysis({ ...quickAnalysis, phonetic: "" }, "quick"), "EMPTY_ANALYSIS_FIELD");
  expectSkillError(() => aiContextSkill.validateAnalysis({ ...quickAnalysis, academicMeaning: "old" }, "quick"), "INVALID_ANALYSIS_SCHEMA");
  expectSkillError(() => aiContextSkill.validateAnalysis({ ...detailAnalysis, wordChoiceReason: "old" }, "detail"), "INVALID_ANALYSIS_SCHEMA");
  expectSkillError(() => aiContextSkill.validateAnalysis({ ...detailAnalysis, comparison: ["apply"] }, "detail"), "INVALID_COMPARISON");
  expectSkillError(() => aiContextSkill.validateAnalysis({
    ...detailAnalysis,
    comparison: { word: "apply", difference: "", extra: "x" }
  }, "detail"), "INVALID_ANALYSIS_SCHEMA");
}

async function testProviderPrompts() {
  const deepSeekBodies = [];
  const deepSeek = deepSeekContextProviderFactory.createDeepSeekContextProvider({
    storageArea: createStorage({ deepseekApiKey: "key", deepseekModel: "deepseek-v4-flash" }),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      deepSeekBodies.push(body);
      return createResponse(200, completedDeepSeek(
        body.messages[0].content.includes("Mode: detail") ? detailAnalysis : quickAnalysis
      ));
    }
  });

  const geminiBodies = [];
  const gemini = geminiContextProviderFactory.createGeminiContextProvider({
    storageArea: createStorage({ geminiApiKey: "key", geminiModel: "gemini-3.5-flash" }),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      geminiBodies.push(body);
      return createResponse(200, completedGemini(
        body.system_instruction.includes("Mode: detail") ? detailAnalysis : quickAnalysis
      ));
    }
  });

  await deepSeek.analyze({ targetText: "employed", analysisMode: "quick" });
  await deepSeek.analyze({ targetText: "employed", analysisMode: "detail" });
  await gemini.analyze({ targetText: "employed", analysisMode: "quick" });
  await gemini.analyze({ targetText: "employed", analysisMode: "detail" });

  [deepSeekBodies[0].messages[0].content, geminiBodies[0].system_instruction].forEach((prompt) => {
    assert.match(prompt, /JSON only/i);
    assert.match(prompt, /phonetic/);
    assert.match(prompt, /meaning/);
    assert.doesNotMatch(prompt, /academicMeaning/);
  });
  [deepSeekBodies[1].messages[0].content, geminiBodies[1].system_instruction].forEach((prompt) => {
    assert.match(prompt, /meaningInSentence/);
    assert.match(prompt, /comparison/);
    assert.match(prompt, /contextReason/);
    assert.doesNotMatch(prompt, /wordChoiceReason/);
  });
}

function testUiAndCompatibility() {
  const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
  const background = fs.readFileSync(path.join(projectRoot, "background.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "1.0.2");
  assert(content.includes("analysis.phonetic"));
  assert(content.includes("analysis.meaning"));
  assert(content.includes("analysis.meaningInSentence"));
  assert(content.includes("analysis.comparison"));
  assert.equal(content.includes("comparison.contextReason"), false);
  assert.equal(content.includes("analysis.academicMeaning"), false);
  assert.equal(content.includes("analysis.wordChoiceReason"), false);
  assert(background.includes('const STORAGE_KEY = "vocabularyEntries"'));
  assert(background.includes("contextTranslation"));
  assert.equal(background.includes("analysis:"), false);
}

(async () => {
  testSkillContract();
  await testProviderPrompts();
  testUiAndCompatibility();
  console.log("stage12-skill-optimization-tests-ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
