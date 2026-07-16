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

const detailCases = Object.freeze({
  employed: {
    meaningInSentence: "使用；采用。",
    comparison: {
      word: "apply",
      difference: "employ 强调把技术、工具作为手段使用；apply 强调把方法作用于具体对象。"
    }
  },
  reinforcing: {
    meaningInSentence: "增强；加固。",
    comparison: null
  },
  exposed: {
    meaningInSentence: "暴露；接触。",
    comparison: null
  },
  interprets: {
    meaningInSentence: "解释；解读。",
    comparison: null
  },
  requires: {
    meaningInSentence: "需要；要求。",
    comparison: null
  }
});

function createStorage() {
  return {
    get(defaults, callback) {
      callback({
        translationSettings: {
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

function getRequestedWord(body) {
  const userPayload = JSON.parse(body.messages[1].content);
  return userPayload.word || userPayload.targetText;
}

async function captureDeepSeekDetailBodies() {
  const bodies = [];
  const provider = deepSeekContextProviderFactory.createDeepSeekContextProvider({
    storageArea: createStorage(),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      const requestedWord = getRequestedWord(body);
      return createResponse(200, completedDeepSeek(detailCases[requestedWord]));
    }
  });

  for (const word of Object.keys(detailCases)) {
    const result = await provider.analyze({
      targetText: word,
      contextSentence: `The paper ${word} the result in context.`,
      pageTitle: "Stage17 prompt test",
      requestType: "wordAnalysis",
      analysisMode: "detail"
    });
    assert.equal(result.provider, "deepseek");
    assert.equal(result.resultType, "contextAnalysis");
    assert.equal(result.skillVersion, "context-analysis-v6");
    assert.equal(result.analysisMode, "detail");
    assert.deepEqual(result.analysis, detailCases[word]);
  }

  return bodies;
}

async function testDeepSeekDetailMinimalPrompt() {
  const bodies = await captureDeepSeekDetailBodies();
  const prompt = bodies[0].messages[0].content;

  assert.match(prompt, /meaningInSentence/);
  assert.match(prompt, /comparison/);
  assert.match(prompt, /What does this selected word mean in this sentence/);
  assert.match(prompt, /only the queried word itself/);
  assert.match(prompt, /not the whole sentence/);
  assert.match(prompt, /Do not restate the subject, experimental object, research content, paper background, or professional knowledge/);
  assert.match(prompt, /within 20 Chinese characters/);
  assert.match(prompt, /表示LLM识别并理解缺陷的含义、类型或原因/);
  assert.match(prompt, /解释；解读/);
  assert.match(prompt, /表示增材制造技术经过发展后进入工业生产领域，成为重要技术选择/);
  assert.match(prompt, /逐渐出现；显现/);
  assert.match(prompt, /comparison is a semantic difference/);
  assert.match(prompt, /Do not explain why the author chose the word/);

  const body = bodies[0];
  assert.equal(body.max_tokens, 500);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.thinking, { type: "disabled" });
}

function testSchemaAndSkillRemainUnchanged() {
  assert.equal(aiContextSkill.skillVersion, "context-analysis-v6");
  assert.deepEqual(aiContextSkill.getOutputSchema("quick").required, [
    "word", "lemma", "phonetic", "partOfSpeech", "meaning"
  ]);
  assert.deepEqual(aiContextSkill.getOutputSchema("detail").required, [
    "meaningInSentence", "comparison"
  ]);
  assert.equal(aiContextSkill.getOutputSchema("detail").additionalProperties, false);
}

function testGeminiAndUiRemainUnchanged() {
  const gemini = fs.readFileSync(path.join(projectRoot, "gemini-context-provider.js"), "utf8");
  const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
  assert.equal(gemini.includes("within 20 Chinese characters"), false);
  assert.equal(gemini.includes("表示LLM识别并理解缺陷的含义、类型或原因"), false);
  assert(content.includes("analysis.meaningInSentence"));
  assert(content.includes("formatComparisonDisplay"));
  assert.equal(content.includes("analysis.contextualMeaning"), false);
}

(async () => {
  await testDeepSeekDetailMinimalPrompt();
  testSchemaAndSkillRemainUnchanged();
  testGeminiAndUiRemainUnchanged();
  console.log("stage17-deepseek-minimal-output-tests-ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
