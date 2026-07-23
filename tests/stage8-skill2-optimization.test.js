const assert = require("assert");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
global.self = global;

require(path.join(projectRoot, "ai-context-skill.js"));

const validAnalysis = Object.freeze({
  word: "employed",
  lemma: "employ",
  phonetic: "/ɪmˈplɔɪ/",
  partOfSpeech: "v.",
  meaning: "雇用；使用"
});

const validDetailAnalysis = Object.freeze({
  meaningInSentence: "这里表示采用某种分析方法。",
  comparison: {
    word: "apply",
    difference: "employ 强调把方法作为研究手段采用；apply 强调将方法作用于对象。",
  }
});

function expectSkillError(factory, expectedCode) {
  assert.throws(factory, (error) => error && error.code === expectedCode);
}

function testSkillContract() {
  assert.equal(aiContextSkill.skillVersion, "context-analysis-v6");
  assert.deepEqual(Object.keys(aiContextSkill.outputSchema.properties), [
    "word",
    "lemma",
    "phonetic",
    "partOfSpeech",
    "meaning"
  ]);
  assert.deepEqual(aiContextSkill.outputSchema.required, [
    "word",
    "lemma",
    "phonetic",
    "partOfSpeech",
    "meaning"
  ]);
  assert.equal(aiContextSkill.outputSchema.additionalProperties, false);
  assert.deepEqual(aiContextSkill.outputSchema.properties.partOfSpeech.enum, [
    "adj.", "v.", "n.", "adv.", "prep.", "phr."
  ]);
  assert.deepEqual(aiContextSkill.validateAnalysis(validAnalysis), validAnalysis);
  assert.deepEqual(aiContextSkill.validateAnalysis(validDetailAnalysis, "detail"), validDetailAnalysis);
  assert.deepEqual(aiContextSkill.validateAnalysis({
    ...validDetailAnalysis,
    comparison: null
  }, "detail").comparison, null);
  assert.match(aiContextSkill.instructions, /AI 不替用户完成理解/);
  assert.match(aiContextSkill.instructions, /严格符合 JSON Schema/);
  assert.match(aiContextSkill.instructions, /语义关注点/);
}

function testStrictValidation() {
  expectSkillError(() => aiContextSkill.validateAnalysis({
    ...validAnalysis,
    explanation: "not allowed"
  }), "INVALID_ANALYSIS_SCHEMA");
  expectSkillError(() => aiContextSkill.validateAnalysis({
    ...validAnalysis,
    phonetic: ""
  }), "EMPTY_ANALYSIS_FIELD");
  expectSkillError(() => aiContextSkill.validateAnalysis({
    ...validAnalysis,
    partOfSpeech: "verb"
  }), "INVALID_PART_OF_SPEECH");
  expectSkillError(() => aiContextSkill.validateAnalysis({
    ...validDetailAnalysis,
    comparison: ["apply"]
  }, "detail"), "INVALID_COMPARISON");
}

function testUiAndProviderIntegration() {
  const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
  const deepSeek = fs.readFileSync(path.join(projectRoot, "deepseek-context-provider.js"), "utf8");
  const gemini = fs.readFileSync(path.join(projectRoot, "gemini-context-provider.js"), "utf8");
  ["单词", "音标", "词性", "含义", "详细解释", "当前语境", "近义词区别"].forEach((label) => {
    assert(content.includes(`\"${label}\"`), `Missing UI label: ${label}`);
  });
  ["论文中含义", "为什么使用该词"].forEach((label) => {
    assert.equal(content.includes(`\"${label}\"`), false, `Unexpected old UI label: ${label}`);
  });
  assert.equal(content.includes("analysis.explanation"), false);
  assert.match(deepSeek, /Quick JSON example/);
  assert.match(deepSeek, /Detail JSON example/);
  assert(deepSeek.includes("phonetic"));
  assert(deepSeek.includes("meaning"));
  assert.equal(deepSeek.includes("academicMeaning"), false);
  assert(gemini.includes("skill.outputSchema"));
  assert(gemini.includes("skill.validateAnalysis"));
}

function testCompatibilityInvariants() {
  const background = fs.readFileSync(path.join(projectRoot, "background.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));
  const entryShape = /id: createId\(\),[\s\S]*?word: comparableEntry\.word,[\s\S]*?contextSentence: comparableEntry\.contextSentence,[\s\S]*?pageTitle: comparableEntry\.pageTitle,[\s\S]*?pageUrl: comparableEntry\.pageUrl,[\s\S]*?createdAt: new Date\(\)\.toISOString\(\)/;
  assert(entryShape.test(background));
  assert(background.includes('const STORAGE_KEY = "vocabularyEntries"'));
  assert(background.includes('type === "CHECK_VOCABULARY_STATUS"'));
  assert(background.includes('type !== "SAVE_VOCABULARY_ENTRY"'));
  assert.equal(manifest.version, "1.0.1");
  assert.equal(manifest.manifest_version, 3);
}

testSkillContract();
testStrictValidation();
testUiAndProviderIntegration();
testCompatibilityInvariants();
console.log("stage8-skill2-optimization-tests-ok");
