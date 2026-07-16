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

const quickEmployed = Object.freeze({
  word: "employed",
  lemma: "employ",
  phonetic: "/ɪmˈplɔɪ/",
  partOfSpeech: "v.",
  meaning: "使用；采用"
});

const detailEmployed = Object.freeze({
  meaningInSentence: "表示将3D打印技术作为生产3D对象的制造手段使用。",
  comparison: {
    word: "apply",
    difference: "employ 强调把技术、工具作为手段使用；apply 强调把方法作用于具体对象。"
  }
});

const sampleCases = Object.freeze([
  {
    quick: quickEmployed,
    detail: detailEmployed
  },
  {
    quick: {
      word: "reinforcing",
      lemma: "reinforce",
      phonetic: "/ˌriːɪnˈfɔːrs/",
      partOfSpeech: "adj.",
      meaning: "增强的"
    },
    detail: {
      meaningInSentence: "表示该效应增强已有结构或性能。",
      comparison: null
    }
  },
  {
    quick: {
      word: "exposed",
      lemma: "expose",
      phonetic: "/ɪkˈspoʊz/",
      partOfSpeech: "v.",
      meaning: "暴露；接触"
    },
    detail: {
      meaningInSentence: "表示材料或样品处于某种条件作用下。",
      comparison: null
    }
  },
  {
    quick: {
      word: "robust",
      lemma: "robust",
      phonetic: "/roʊˈbʌst/",
      partOfSpeech: "adj.",
      meaning: "稳健的；强健的"
    },
    detail: {
      meaningInSentence: "表示该方法在变化条件下仍保持稳定表现。",
      comparison: null
    }
  },
  {
    quick: {
      word: "incorporate",
      lemma: "incorporate",
      phonetic: "/ɪnˈkɔːrpəreɪt/",
      partOfSpeech: "v.",
      meaning: "纳入；结合"
    },
    detail: {
      meaningInSentence: "表示把某个组成部分纳入整体结构或方法中。",
      comparison: null
    }
  }
]);

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

function testSkillContractAndInstructions() {
  assert.equal(aiContextSkill.skillVersion, "context-analysis-v6");
  assert.match(aiContextSkill.instructions, /AI 不替用户完成理解/);
  assert.match(aiContextSkill.instructions, /最小有效的信息支点/);
  assert.match(aiContextSkill.instructions, /comparison 不是原因分析/);
  assert.match(aiContextSkill.instructions, /employ vs apply/);
  assert.match(aiContextSkill.instructions, /reinforcing vs strengthening/);
  assert.match(aiContextSkill.instructions, /不要输出 Markdown/);
  assert.match(aiContextSkill.instructions, /不要输出额外说明/);
  ["为什么作者选择该词", "因此这里使用某词", "作者写作意图", "论文背景扩展", "长篇总结", "写作建议"].forEach((phrase) => {
    assert(aiContextSkill.instructions.includes(phrase));
  });

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
}

function testValidation() {
  sampleCases.forEach(({ quick, detail }) => {
    assert.deepEqual(aiContextSkill.validateAnalysis(quick, "quick"), quick);
    assert.deepEqual(aiContextSkill.validateAnalysis(detail, "detail"), detail);
  });

  expectSkillError(() => aiContextSkill.validateAnalysis({ ...quickEmployed, partOfSpeech: "verb" }, "quick"), "INVALID_PART_OF_SPEECH");
  expectSkillError(() => aiContextSkill.validateAnalysis({ ...quickEmployed, phonetic: "" }, "quick"), "EMPTY_ANALYSIS_FIELD");
  ["academicMeaning", "wordChoiceReason", "contextualMeaning", "contextReason"].forEach((oldField) => {
    const base = oldField === "academicMeaning" ? quickEmployed : detailEmployed;
    const mode = oldField === "academicMeaning" ? "quick" : "detail";
    expectSkillError(() => aiContextSkill.validateAnalysis({ ...base, [oldField]: "old" }, mode), "INVALID_ANALYSIS_SCHEMA");
  });
  expectSkillError(() => aiContextSkill.validateAnalysis({ ...detailEmployed, comparison: ["apply", "use"] }, "detail"), "INVALID_COMPARISON");
  expectSkillError(() => aiContextSkill.validateAnalysis({ ...detailEmployed, comparison: "apply" }, "detail"), "INVALID_COMPARISON");
  expectSkillError(() => aiContextSkill.validateAnalysis({
    ...detailEmployed,
    comparison: { word: "apply", difference: "", extra: "x" }
  }, "detail"), "INVALID_ANALYSIS_SCHEMA");
  expectSkillError(() => aiContextSkill.validateAnalysis({
    ...detailEmployed,
    comparison: { word: "apply", difference: "" }
  }, "detail"), "INVALID_COMPARISON");
}

async function testProviderPrompts() {
  const deepSeekBodies = [];
  const deepSeek = deepSeekContextProviderFactory.createDeepSeekContextProvider({
    storageArea: createStorage({ deepseekApiKey: "key", deepseekModel: "deepseek-v4-flash" }),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      deepSeekBodies.push(body);
      return createResponse(200, completedDeepSeek(
        body.messages[0].content.includes("Mode: detail") ? detailEmployed : quickEmployed
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
        body.system_instruction.includes("Mode: detail") ? detailEmployed : quickEmployed
      ));
    }
  });

  await deepSeek.analyze({ targetText: "employed", analysisMode: "quick" });
  await deepSeek.analyze({ targetText: "employed", analysisMode: "detail" });
  await gemini.analyze({ targetText: "employed", analysisMode: "quick" });
  await gemini.analyze({ targetText: "employed", analysisMode: "detail" });

  [deepSeekBodies[1].messages[0].content, geminiBodies[1].system_instruction].forEach((prompt) => {
    assert.match(prompt, /meaningInSentence/);
    assert.match(prompt, /comparison/);
    assert.match(prompt, /minimal anchors|最小有效的信息支点|理解支点/);
    assert.match(prompt, /semantic difference|语义区别/);
    assert.match(prompt, /employ vs apply/);
    assert.match(prompt, /reinforcing vs strengthening/);
    assert.match(prompt, /author intention|作者/);
    assert.match(prompt, /long summary|长篇总结/);
    assert.match(prompt, /meaningInSentence/);
    assert.match(prompt, /contextReason/);
    assert.doesNotMatch(prompt, /wordChoiceReason/);
  });
}

function testUiAndCompatibility() {
  const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
  const background = fs.readFileSync(path.join(projectRoot, "background.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.version, "1.0.0");
  assert(content.includes("analysis.meaningInSentence"));
  assert(content.includes("formatComparisonDisplay"));
  assert.equal(content.includes("analysis.contextualMeaning"), false);
  assert.equal(content.includes("comparison.contextReason"), false);
  assert.equal(content.includes("analysis.wordChoiceReason"), false);
  assert(content.includes("function renderSentenceTranslation"));
  assert(content.includes('result.resultType === "sentenceTranslation"'));
  assert(background.includes('const STORAGE_KEY = "vocabularyEntries"'));
  assert(background.includes("contextTranslation"));
  assert.equal(background.includes("analysis:"), false);
}

(async () => {
  testSkillContractAndInstructions();
  testValidation();
  await testProviderPrompts();
  testUiAndCompatibility();
  console.log("stage15-word-analysis-minimalism-tests-ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
