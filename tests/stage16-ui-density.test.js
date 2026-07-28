const assert = require("assert");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");

const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
const readme = fs.readFileSync(path.join(projectRoot, "README.md"), "utf8");
const skill = fs.readFileSync(path.join(projectRoot, "ai-context-skill.js"), "utf8");
const gemini = fs.readFileSync(path.join(projectRoot, "gemini-context-provider.js"), "utf8");
const deepseek = fs.readFileSync(path.join(projectRoot, "deepseek-context-provider.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));

function testManifestUnchanged() {
  assert.equal(manifest.version, "1.0.2");
  assert.equal(manifest.manifest_version, 3);
}

function testWordDetailSeparators() {
  assert(content.includes("is-separated-detail"));
  assert(content.includes("border-top: 1px solid #e5e7eb"));
  assert(content.includes("translator-plugin-detail-section"));
  assert(content.includes("renderDetailAnalysis(detailSection, response.analysis)"));
  assert(content.includes("if (analysis.comparison)"));
  assert(content.includes('rows.push([\n      "近义词区别",'));
}

function testSentenceTranslationUnaffected() {
  assert(content.includes("function renderSentenceTranslation"));
  assert(content.includes("translator-plugin-sentence-key-term"));
  assert(content.includes('result.resultType === "sentenceTranslation"'));
  assert.equal(content.includes("translator-plugin-sentence-key-term is-separated-detail"), false);
}

function testSkillAndProviderContractsUnaffected() {
  assert(skill.includes('const skillVersion = "context-analysis-v6"'));
  assert(skill.includes("meaningInSentence"));
  assert(skill.includes("comparisonFields"));
  assert(gemini.includes("meaningInSentence"));
  assert(deepseek.includes("meaningInSentence"));
  assert.equal(content.includes("comparison.contextReason"), false);
  assert.equal(content.includes("analysis.contextualMeaning"), false);
}

function testReadmeAndReportIntent() {
  assert(readme.includes("Stage16"));
  assert(readme.includes("视觉密度"));
  assert(readme.includes("浅灰细分割线"));
}

testManifestUnchanged();
testWordDetailSeparators();
testSentenceTranslationUnaffected();
testSkillAndProviderContractsUnaffected();
testReadmeAndReportIntent();

console.log("stage16-ui-density-tests-ok");
