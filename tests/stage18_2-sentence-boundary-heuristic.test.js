const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const projectRoot = path.resolve(__dirname, "..");

function createContentContext() {
  const context = {
    console,
    Set,
    Map,
    window: {
      location: { href: "https://example.com" },
      getSelection() { return null; },
      addEventListener() {},
      setTimeout() {},
      clearTimeout() {},
      requestAnimationFrame(callback) { callback(); }
    },
    document: {
      title: "Test",
      body: {},
      documentElement: {
        appendChild() {}
      },
      addEventListener() {},
      getElementById() { return null; },
      createElement() {
        return {
          style: {},
          classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
          appendChild() {},
          addEventListener() {},
          remove() {},
          querySelector() { return null; },
          set textContent(value) { this._textContent = value; },
          get textContent() { return this._textContent || ""; }
        };
      },
      createTextNode(text) {
        return { textContent: text };
      }
    },
    Node: {
      TEXT_NODE: 3,
      ELEMENT_NODE: 1
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage() {},
        lastError: null
      }
    },
    ResizeObserver: function ResizeObserver() {
      this.observe = function observe() {};
      this.disconnect = function disconnect() {};
    }
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(projectRoot, "content.js"), "utf8"), context);
  return context;
}

function sentenceAround(context, text, selection) {
  const start = text.indexOf(selection);
  assert(start >= 0, `Selection "${selection}" not found in "${text}"`);
  return context.extractSentence(text, start, start + selection.length);
}

function testDecimalBoundaries() {
  const context = createContentContext();

  assert.equal(
    sentenceAround(context, "Industry 4.0 has revolutionized manufacturing.", "revolutionized"),
    "Industry 4.0 has revolutionized manufacturing."
  );
  assert.equal(
    sentenceAround(context, "The accuracy reached 95.5%, demonstrating good performance.", "demonstrating"),
    "The accuracy reached 95.5%, demonstrating good performance."
  );
  assert.equal(
    sentenceAround(context, "The value changed from 1.2 to 3.4.", "changed"),
    "The value changed from 1.2 to 3.4."
  );
  assert.equal(
    sentenceAround(context, "Version 2.0. The next version will be released later.", "Version 2.0"),
    "Version 2.0."
  );
  assert.equal(
    sentenceAround(context, "Version 2.0. The next version will be released later.", "next version"),
    "The next version will be released later."
  );
}

function testAcademicAbbreviationBoundaries() {
  const context = createContentContext();

  assert.equal(sentenceAround(context, "Fig. 2 shows the printing result.", "printing"), "Fig. 2 shows the printing result.");
  assert.equal(sentenceAround(context, "As shown in Eq. 3, the error decreases.", "error"), "As shown in Eq. 3, the error decreases.");
  assert.equal(sentenceAround(context, "See Ref. 12 for details.", "details"), "See Ref. 12 for details.");
  assert.equal(sentenceAround(context, "The method is described in Sec. 4.", "method"), "The method is described in Sec. 4.");
  assert.equal(sentenceAround(context, "Sample No. 5 failed.", "failed"), "Sample No. 5 failed.");
  assert.equal(sentenceAround(context, "Several defects, e.g. stringing and blobs, were observed.", "stringing"), "Several defects, e.g. stringing and blobs, were observed.");
  assert.equal(sentenceAround(context, "The model is robust, i.e. it remains effective under noise.", "effective"), "The model is robust, i.e. it remains effective under noise.");
  assert.equal(sentenceAround(context, "Smith et al. reported similar findings.", "reported"), "Smith et al. reported similar findings.");
  assert.equal(sentenceAround(context, "Method A vs. Method B was evaluated.", "Method B"), "Method A vs. Method B was evaluated.");
}

function testRealSentenceEndingsStillWork() {
  const context = createContentContext();

  assert.equal(
    sentenceAround(context, "Fig. 2 shows the result. The next sentence begins here.", "result"),
    "Fig. 2 shows the result."
  );
  assert.equal(
    sentenceAround(context, "Fig. 2 shows the result. The next sentence begins here.", "next sentence"),
    "The next sentence begins here."
  );
  assert.equal(
    sentenceAround(context, "This is the first sentence. This is the second sentence.", "second"),
    "This is the second sentence."
  );
  assert.equal(
    sentenceAround(context, "See Fig. The next sentence begins here.", "next sentence"),
    "The next sentence begins here."
  );
}

function testBoundaryHelpers() {
  const context = createContentContext();

  assert.equal(context.isDecimalPoint("4.0", 1), true);
  assert.equal(context.isSentenceBoundary("4.0", 1), false);
  assert.equal(context.isSentenceBoundary("4.0. Next", 3), true);
  assert.equal(context.isProtectedAbbreviationPeriod("Fig. 2", 3), true);
  assert.equal(context.isProtectedAbbreviationPeriod("Fig. The", 3), false);
  assert.equal(context.isProtectedAbbreviationPeriod("e.g. stringing", 1), true);
  assert.equal(context.isProtectedAbbreviationPeriod("e.g. stringing", 3), true);
  assert.equal(context.isProtectedAbbreviationPeriod("Smith et al. reported", 11), true);
}

function testStaticStage18_2Boundaries() {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));
  const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
  const background = fs.readFileSync(path.join(projectRoot, "background.js"), "utf8");
  const vocabulary = fs.readFileSync(path.join(projectRoot, "vocabulary.js"), "utf8");

  assert.equal(manifest.version, "1.0.0");
  assert(content.includes("function isSentenceBoundary"));
  assert(content.includes("function isDecimalPoint"));
  assert(content.includes("function isProtectedAbbreviationPeriod"));
  assert(content.includes("MULTI_PERIOD_ABBREVIATIONS"));
  assert(content.includes("MULTI_TOKEN_ABBREVIATIONS"));
  assert.equal(background.includes("isDecimalPoint"), false);
  assert.equal(vocabulary.includes("isDecimalPoint"), false);
}

testDecimalBoundaries();
testAcademicAbbreviationBoundaries();
testRealSentenceEndingsStillWork();
testBoundaryHelpers();
testStaticStage18_2Boundaries();
console.log("stage18.2-sentence-boundary-heuristic-tests-ok");
