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

const employedQuick = Object.freeze({
  word: "employed",
  lemma: "employ",
  phonetic: "/ɪmˈplɔɪ/",
  partOfSpeech: "v.",
  meaning: "使用；采用"
});

const employedDetail = Object.freeze({
  meaningInSentence: "表示将3D打印技术作为生产3D对象的制造手段使用。",
  comparison: {
    word: "apply",
    difference: "employ 强调把技术、工具或资源作为手段使用；apply 强调把方法作用于明确对象。",
  }
});

const reinforcingQuick = Object.freeze({
  word: "reinforcing",
  lemma: "reinforce",
  phonetic: "/ˌriːɪnˈfɔːrs/",
  partOfSpeech: "adj.",
  meaning: "加强的；增强的"
});

const reinforcingDetail = Object.freeze({
  meaningInSentence: "修饰 effect，表示该效应具有增强材料力学性能的作用。",
  comparison: null
});

const electrochemicalQuick = Object.freeze({
  word: "electrochemical",
  lemma: "electrochemical",
  phonetic: "/ɪˌlektroʊˈkemɪkəl/",
  partOfSpeech: "adj.",
  meaning: "电化学的"
});

const electrochemicalDetail = Object.freeze({
  meaningInSentence: "表示研究对象同时涉及电过程与化学反应过程。",
  comparison: null
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

function completedDeepSeek(analysis) {
  return {
    choices: [{
      finish_reason: "stop",
      message: { content: JSON.stringify(analysis) }
    }]
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

function expectSkillError(factory, expectedCode) {
  assert.throws(factory, (error) => error && error.code === expectedCode);
}

function testSkillContract() {
  assert.equal(aiContextSkill.skillVersion, "context-analysis-v6");
  assert.match(aiContextSkill.instructions, /AI 不替用户完成理解/);
  assert.match(aiContextSkill.instructions, /employ vs apply/);
  assert.match(aiContextSkill.instructions, /不要输出 Markdown/);

  assert.deepEqual(aiContextSkill.getOutputSchema("quick").required, [
    "word", "lemma", "phonetic", "partOfSpeech", "meaning"
  ]);
  assert.deepEqual(aiContextSkill.getOutputSchema("detail").required, [
    "meaningInSentence", "comparison"
  ]);
  assert.equal(aiContextSkill.getOutputSchema("quick").additionalProperties, false);
  assert.equal(aiContextSkill.getOutputSchema("detail").additionalProperties, false);

  const comparisonSchema = aiContextSkill.getOutputSchema("detail").properties.comparison;
  assert.deepEqual(comparisonSchema.type, ["object", "null"]);
  assert.deepEqual(comparisonSchema.required, ["word", "difference"]);
  assert.equal(comparisonSchema.additionalProperties, false);

  assert.deepEqual(aiContextSkill.validateAnalysis(employedQuick, "quick"), employedQuick);
  assert.deepEqual(aiContextSkill.validateAnalysis(employedDetail, "detail"), employedDetail);
  assert.equal(aiContextSkill.validateAnalysis(reinforcingDetail, "detail").comparison, null);
  assert.equal(aiContextSkill.validateAnalysis(electrochemicalDetail, "detail").comparison, null);

  expectSkillError(() => aiContextSkill.validateAnalysis({
    ...employedQuick,
    partOfSpeech: "verb"
  }, "quick"), "INVALID_PART_OF_SPEECH");
  expectSkillError(() => aiContextSkill.validateAnalysis({
    ...employedQuick,
    phonetic: ""
  }, "quick"), "EMPTY_ANALYSIS_FIELD");
  ["ipa", "commonMeaning", "academicMeaning"].forEach((oldField) => {
    expectSkillError(() => aiContextSkill.validateAnalysis({
      ...employedQuick,
      [oldField]: "old"
    }, "quick"), "INVALID_ANALYSIS_SCHEMA");
  });
  ["wordChoiceReason", "confusableWord"].forEach((oldField) => {
    expectSkillError(() => aiContextSkill.validateAnalysis({
      ...employedDetail,
      [oldField]: "old"
    }, "detail"), "INVALID_ANALYSIS_SCHEMA");
  });
  expectSkillError(() => aiContextSkill.validateAnalysis({
    ...employedDetail,
    comparison: "apply"
  }, "detail"), "INVALID_COMPARISON");
  expectSkillError(() => aiContextSkill.validateAnalysis({
    ...employedDetail,
    comparison: ["apply"]
  }, "detail"), "INVALID_COMPARISON");
  expectSkillError(() => aiContextSkill.validateAnalysis({
    ...employedDetail,
    comparison: { word: "apply", difference: "" }
  }, "detail"), "INVALID_COMPARISON");
  expectSkillError(() => aiContextSkill.validateAnalysis({
    ...employedDetail,
    comparison: { word: "apply", difference: "x", contextReason: "y", extra: "z" }
  }, "detail"), "INVALID_ANALYSIS_SCHEMA");
}

function testExamples() {
  assert.equal(aiContextSkill.validateAnalysis(employedQuick, "quick").lemma, "employ");
  assert.equal(aiContextSkill.validateAnalysis(employedQuick, "quick").partOfSpeech, "v.");
  assert.match(aiContextSkill.validateAnalysis(employedDetail, "detail").meaningInSentence, /制造手段|生产/);
  assert.equal(aiContextSkill.validateAnalysis(employedDetail, "detail").comparison.word, "apply");
  assert.match(aiContextSkill.validateAnalysis(employedDetail, "detail").comparison.difference, /手段|对象/);

  assert.equal(aiContextSkill.validateAnalysis(reinforcingQuick, "quick").lemma, "reinforce");
  assert.equal(aiContextSkill.validateAnalysis(reinforcingQuick, "quick").partOfSpeech, "adj.");
  assert.equal(aiContextSkill.validateAnalysis(reinforcingDetail, "detail").comparison, null);

  assert.deepEqual(aiContextSkill.validateAnalysis(electrochemicalQuick, "quick"), electrochemicalQuick);
  assert.equal(aiContextSkill.validateAnalysis(electrochemicalDetail, "detail").comparison, null);
}

async function testProviderPrompts() {
  const deepSeekBodies = [];
  const deepSeek = deepSeekContextProviderFactory.createDeepSeekContextProvider({
    storageArea: createStorage({ deepseekApiKey: "key", deepseekModel: "deepseek-v4-flash" }),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      deepSeekBodies.push(body);
      return createResponse(200, completedDeepSeek(
        body.messages[0].content.includes("Mode: detail") ? employedDetail : employedQuick
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
        body.system_instruction.includes("Mode: detail") ? employedDetail : employedQuick
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
    assert.doesNotMatch(prompt, /commonMeaning/);
  });
  [deepSeekBodies[1].messages[0].content, geminiBodies[1].system_instruction].forEach((prompt) => {
    assert.match(prompt, /JSON only/i);
    assert.match(prompt, /meaningInSentence/);
    assert.match(prompt, /comparison/);
    assert.match(prompt, /contextReason/);
    assert.match(prompt, /semantic-focus|语义关注点/);
    assert.doesNotMatch(prompt, /wordChoiceReason/);
  });
}

function testUiAndCompatibility() {
  const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
  const background = fs.readFileSync(path.join(projectRoot, "background.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "1.0.4");
  assert(content.includes("analysis.phonetic"));
  assert(content.includes("analysis.meaning"));
  assert(content.includes("formatComparisonDisplay"));
  assert.equal(content.includes("comparison.contextReason"), false);
  assert.equal(content.includes("analysis.ipa"), false);
  assert.equal(content.includes("analysis.commonMeaning"), false);
  assert.equal(content.includes("analysis.academicMeaning"), false);
  assert.equal(content.includes("analysis.wordChoiceReason"), false);
  assert.equal(content.includes("为什么使用该词"), false);
  assert(content.includes("function renderSentenceTranslation"));
  assert(content.includes('result.resultType === "sentenceTranslation"'));
  assert(background.includes('const STORAGE_KEY = "vocabularyEntries"'));
  assert(background.includes("contextTranslation"));
  assert.equal(background.includes("analysis:"), false);
}

(async () => {
  testSkillContract();
  testExamples();
  await testProviderPrompts();
  testUiAndCompatibility();
  console.log("stage14-word-skill-v4.1-tests-ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
