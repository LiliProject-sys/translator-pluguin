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

const quickCases = Object.freeze({
  employed: {
    word: "employed",
    lemma: "employ",
    phonetic: "/ɪmˈplɔɪ/",
    partOfSpeech: "v.",
    meaning: "使用；采用"
  },
  reinforcing: {
    word: "reinforcing",
    lemma: "reinforce",
    phonetic: "/ˌriːɪnˈfɔːrs/",
    partOfSpeech: "adj.",
    meaning: "增强的"
  },
  exposed: {
    word: "exposed",
    lemma: "expose",
    phonetic: "/ɪkˈspoʊz/",
    partOfSpeech: "v.",
    meaning: "暴露；接触"
  },
  challenging: {
    word: "challenging",
    lemma: "challenge",
    phonetic: "/ˈtʃælɪndʒ/",
    partOfSpeech: "adj.",
    meaning: "具有挑战性的"
  }
});

const detailCases = Object.freeze({
  employed: {
    meaningInSentence: "表示将该方法或技术作为完成目标的手段使用。",
    comparison: {
      word: "apply",
      difference: "employ 强调把技术、工具作为手段使用；apply 强调把方法作用于具体对象。"
    }
  },
  reinforcing: {
    meaningInSentence: "表示增强已有结构或性能。",
    comparison: null
  },
  exposed: {
    meaningInSentence: "表示样品处于某种条件作用下。",
    comparison: null
  },
  challenging: {
    meaningInSentence: "表示该过程或问题具有较高难度。",
    comparison: null
  }
});

function createStorage(settings) {
  return {
    get(defaults, callback) {
      callback({
        translationSettings: settings || {
          deepseekApiKey: "test-key",
          deepseekModel: "deepseek-v4-flash"
        }
      });
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

function createProvider(fetchImpl) {
  return deepSeekContextProviderFactory.createDeepSeekContextProvider({
    storageArea: createStorage(),
    fetchImpl
  });
}

function getRequestedWord(body) {
  const userPayload = JSON.parse(body.messages[1].content);
  return userPayload.targetText || userPayload.word;
}

function isDetailBody(body) {
  return body.messages[0].content.includes("Mode: detail.");
}

async function testDeepSeekQuickAndDetailContract() {
  const bodies = [];
  const provider = createProvider(async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    const requestedWord = getRequestedWord(body);
    const response = isDetailBody(body)
      ? detailCases[requestedWord]
      : quickCases[requestedWord];
    return createResponse(200, completedDeepSeek(response));
  });

  for (const word of Object.keys(quickCases)) {
    const quick = await provider.analyze({
      targetText: word,
      contextSentence: `${word} materials were evaluated in this study.`,
      pageTitle: "DeepSeek sync check",
      analysisMode: "quick"
    });
    assert.equal(quick.provider, "deepseek");
    assert.equal(quick.resultType, "contextAnalysis");
    assert.equal(quick.skillVersion, "context-analysis-v6");
    assert.equal(quick.analysisMode, "quick");
    assert.deepEqual(quick.analysis, quickCases[word]);

    const detail = await provider.analyze({
      targetText: word,
      contextSentence: `${word} materials were evaluated in this study.`,
      pageTitle: "DeepSeek sync check",
      analysisMode: "detail"
    });
    assert.equal(detail.provider, "deepseek");
    assert.equal(detail.resultType, "contextAnalysis");
    assert.equal(detail.skillVersion, "context-analysis-v6");
    assert.equal(detail.analysisMode, "detail");
    assert.deepEqual(detail.analysis, detailCases[word]);
  }

  const quickPrompt = bodies.find((body) => !isDetailBody(body)).messages[0].content;
  const detailPrompt = bodies.find(isDetailBody).messages[0].content;
  assert.match(quickPrompt, /exactly these five non-empty string fields: word, lemma, phonetic, partOfSpeech, meaning/);
  assert.match(quickPrompt, /lemma must be the true dictionary base form only/);
  assert.match(detailPrompt, /meaningInSentence/);
  assert.match(detailPrompt, /comparison/);
  assert.match(detailPrompt, /minimal anchors|最小有效的信息支点|理解支点/);
  assert.match(detailPrompt, /semantic difference|语义区别/);
  assert.match(detailPrompt, /not a reason analysis/);
  assert.match(detailPrompt, /not an author-intention analysis/);
  assert.match(detailPrompt, /employ vs apply/);
  assert.match(detailPrompt, /reinforcing vs strengthening/);
  assert.match(detailPrompt, /Do not explain why the author chose the word/);
  assert.match(detailPrompt, /long summary/);
}

function testDeepSeekSchemaAndOldFieldRejection() {
  assert.deepEqual(aiContextSkill.getOutputSchema("quick").required, [
    "word", "lemma", "phonetic", "partOfSpeech", "meaning"
  ]);
  assert.deepEqual(aiContextSkill.getOutputSchema("detail").required, [
    "meaningInSentence", "comparison"
  ]);
  const comparisonSchema = aiContextSkill.getOutputSchema("detail").properties.comparison;
  assert.deepEqual(comparisonSchema.required, ["word", "difference"]);
  assert.equal(comparisonSchema.additionalProperties, false);

  assert.throws(() => aiContextSkill.validateAnalysis({
    ...quickCases.challenging,
    academicMeaning: "old"
  }, "quick"), (error) => error && error.code === "INVALID_ANALYSIS_SCHEMA");
  ["contextualMeaning", "contextReason", "wordChoiceReason"].forEach((oldField) => {
    assert.throws(() => aiContextSkill.validateAnalysis({
      ...detailCases.employed,
      [oldField]: "old"
    }, "detail"), (error) => error && error.code === "INVALID_ANALYSIS_SCHEMA");
  });
}

async function testDeepSeekCacheKeyIncludesModeAndSkillVersion() {
  let calls = 0;
  const provider = createProvider(async (url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    return createResponse(200, completedDeepSeek(
      isDetailBody(body) ? detailCases.challenging : quickCases.challenging
    ));
  });

  const request = {
    targetText: "challenging",
    contextSentence: "The fabrication process remains challenging.",
    pageTitle: "Cache check",
    analysisMode: "quick"
  };
  const first = await provider.analyze(request);
  const second = await provider.analyze(request);
  const detail = await provider.analyze({ ...request, analysisMode: "detail" });

  assert.equal(calls, 2);
  assert.equal(first.cached, undefined);
  assert.equal(second.cached, true);
  assert.equal(detail.analysisMode, "detail");

  const source = fs.readFileSync(path.join(projectRoot, "deepseek-context-provider.js"), "utf8");
  assert.match(source, /createCacheKey\(input, model, activeSkill\.skillVersion, analysisMode, requestType\)/);
  assert.match(source, /normalizeRequestType\(requestType\)/);
  assert.match(source, /normalizeAnalysisMode\(analysisMode\)/);
  assert.match(source, /skillVersion/);
}

function testFrontendCompatibility() {
  const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
  assert(content.includes('result.resultType === "contextAnalysis"'));
  assert(content.includes("result.analysisMode || \"quick\""));
  assert(content.includes("analysis.meaningInSentence"));
  assert(content.includes("formatComparisonDisplay"));
  assert.equal(content.includes("analysis.contextualMeaning"), false);
  assert.equal(content.includes("analysis.academicMeaning"), false);
  assert.equal(content.includes("analysis.wordChoiceReason"), false);
  assert.equal(content.includes("comparison.contextReason"), false);
}

(async () => {
  await testDeepSeekQuickAndDetailContract();
  testDeepSeekSchemaAndOldFieldRejection();
  await testDeepSeekCacheKeyIncludesModeAndSkillVersion();
  testFrontendCompatibility();
  console.log("stage16.5-deepseek-provider-sync-tests-ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
