const assert = require("assert");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
global.self = global;

require(path.join(projectRoot, "ai-context-skill.js"));

const validAnalysis = Object.freeze({
  lemma: "employ",
  phonetic: "/ɪmˈplɔɪ/",
  partOfSpeech: "v.",
  commonMeaning: "雇用；使用",
  contextualMeaning: "论文语境中指采用某种分析方法"
});

function expectSkillError(factory, expectedCode) {
  assert.throws(factory, (error) => error && error.code === expectedCode);
}

function testSkillContract() {
  assert.equal(aiContextSkill.skillVersion, "context-analysis-v2");
  assert.deepEqual(Object.keys(aiContextSkill.outputSchema.properties), [
    "lemma",
    "phonetic",
    "partOfSpeech",
    "commonMeaning",
    "contextualMeaning"
  ]);
  assert.deepEqual(aiContextSkill.outputSchema.required, [
    "lemma",
    "phonetic",
    "partOfSpeech",
    "commonMeaning",
    "contextualMeaning"
  ]);
  assert.equal(aiContextSkill.outputSchema.additionalProperties, false);
  assert.deepEqual(aiContextSkill.outputSchema.properties.partOfSpeech.enum, [
    "adj.", "v.", "n.", "adv.", "prep.", "phr."
  ]);
  assert.deepEqual(aiContextSkill.validateAnalysis(validAnalysis), validAnalysis);
  assert.match(aiContextSkill.instructions, /academic paper/i);
  assert.match(aiContextSkill.instructions, /strict JSON only/i);
  assert.match(aiContextSkill.instructions, /Do not provide a long explanation/i);
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
}

function testUiAndProviderIntegration() {
  const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
  const deepSeek = fs.readFileSync(path.join(projectRoot, "deepseek-context-provider.js"), "utf8");
  const gemini = fs.readFileSync(path.join(projectRoot, "gemini-context-provider.js"), "utf8");
  ["单词", "音标", "词性", "常见含义", "论文中含义"].forEach((label) => {
    assert(content.includes(`\"${label}\"`), `Missing UI label: ${label}`);
  });
  assert.equal(content.includes("analysis.explanation"), false);
  assert.equal(content.includes("深入理解"), false);
  assert.match(deepSeek, /exactly these five non-empty string fields/);
  assert.match(deepSeek, /Five-field JSON example/);
  assert(deepSeek.includes("phonetic"));
  assert(deepSeek.includes("commonMeaning"));
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
  assert.equal(manifest.version, "0.4.0");
  assert.equal(manifest.manifest_version, 3);
}

testSkillContract();
testStrictValidation();
testUiAndProviderIntegration();
testCompatibilityInvariants();
console.log("stage8-skill2-optimization-tests-ok");
