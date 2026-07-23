const assert = require("assert");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
const background = fs.readFileSync(path.join(projectRoot, "background.js"), "utf8");
const framework = fs.readFileSync(path.join(projectRoot, "translation-provider.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "1.0.1");

assert.equal(content.includes('window.addEventListener("scroll", closeSelectionPanel'), false);
assert.equal(content.includes('addEventListener("scroll"'), false);
assert(content.includes("position: fixed;"));
assert.equal(content.includes("position: absolute;"), false);
assert.equal(content.includes("window.scrollX"), false);
assert.equal(content.includes("window.pageYOffset"), false);
assert(content.includes('window.addEventListener("resize", keepSelectionPanelInViewport)'));
assert(content.includes("currentPanelViewportPosition"));
assert(content.includes("clampPanelCoordinate"));
assert(content.includes("keepSelectionPanelInViewport();"));

assert(content.includes("isEventInsideSelectionPanel(event)"));
assert(content.includes('typeof event.composedPath === "function"'));
assert(content.includes("event.composedPath().includes(selectionPanel)"));
assert(content.includes("mouseupInsidePanel || panelPointerDown"));
assert(content.includes("selectionPanel && !isEventInsideSelectionPanel(event)"));
assert(content.includes('event.key === "Escape"'));

assert(content.includes("let currentSelectionId = 0;"));
assert(content.includes("let detailAnalysisRequestId = 0;"));
assert(content.includes("selectionId !== currentSelectionId"));
assert(content.includes("analysisRequestId !== detailAnalysisRequestId"));
assert(content.includes("cancelLanguageRequests(getCurrentLanguageRequestIds())"));
assert(content.includes('type: "CANCEL_LANGUAGE_REQUEST"'));
assert(content.includes("currentQuickRequestId = `selection-${selectionId}-quick`"));
assert(content.includes("currentDetailRequestId = `selection-${selectionId}-detail-${analysisRequestId}`"));

const closeFunction = content.slice(
  content.indexOf("function closeSelectionPanel()"),
  content.indexOf("function getCurrentLanguageRequestIds()")
);
assert(closeFunction.includes("currentSelectionId += 1"));
assert(closeFunction.includes("detailAnalysisRequestId += 1"));
assert(closeFunction.includes("selectionPanel.remove()"));
assert(closeFunction.includes("cancelLanguageRequests(requestIds)"));

assert(content.includes("overflow: hidden;"));
assert(content.includes("overflow: auto;"));
assert(content.includes("flex: 1 1 auto;"));
assert(content.includes(".translator-plugin-detail-section"));
assert(background.includes('message.type === "CANCEL_LANGUAGE_REQUEST"'));
assert(background.includes("self.languageService.cancelRequests(requestIds)"));
assert(framework.includes("cancelRequests(requestIds)"));
assert(framework.includes("cancelProviderRequest"));

global.self = global;
global.chrome = {
  runtime: { lastError: null },
  storage: { local: null }
};

require(path.join(projectRoot, "ai-context-skill.js"));
require(path.join(projectRoot, "md5.js"));
require(path.join(projectRoot, "baidu-translation-provider.js"));
require(path.join(projectRoot, "deepseek-context-provider.js"));
require(path.join(projectRoot, "gemini-context-provider.js"));

function createStorage(settings) {
  return {
    get(defaults, callback) {
      callback({ translationSettings: settings });
    }
  };
}

function waitForAbort(options) {
  return new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
}

global.chrome.storage.local = createStorage({});
require(path.join(projectRoot, "translation-provider.js"));

async function testGeminiRequestScopedCancellation() {
  const provider = geminiContextProviderFactory.createGeminiContextProvider({
    storageArea: createStorage({ geminiApiKey: "key", geminiModel: "gemini-3.5-flash" }),
    fetchImpl: async (url, options) => waitForAbort(options)
  });
  const request = provider.analyze({ targetText: "biosensing", requestId: "selection-1-quick" });
  const rejection = assert.rejects(request, (error) => error && error.code === "REQUEST_CANCELLED");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(provider.cancelRequest("selection-2-quick"), false);
  assert.equal(provider.cancelRequest("selection-1-quick"), true);
  await rejection;
}

async function testDeepSeekRequestScopedCancellation() {
  const provider = deepSeekContextProviderFactory.createDeepSeekContextProvider({
    storageArea: createStorage({ deepseekApiKey: "key", deepseekModel: "deepseek-v4-flash" }),
    fetchImpl: async (url, options) => waitForAbort(options)
  });
  const request = provider.analyze({ targetText: "biosensing", requestId: "selection-3-quick" });
  const rejection = assert.rejects(request, (error) => error && error.code === "REQUEST_CANCELLED");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(provider.cancelRequest("selection-4-quick"), false);
  assert.equal(provider.cancelRequest("selection-3-quick"), true);
  await rejection;
}

async function testBaiduRequestScopedCancellation() {
  const provider = baiduTranslationProviderFactory.createBaiduTranslationProvider({
    storageArea: createStorage({ baiduAppId: "app", baiduAppKey: "key" }),
    md5: () => "signature",
    rateLimitMs: 0,
    fetchImpl: async (url, options) => waitForAbort(options)
  });
  const request = provider.translate({ text: "biosensing", requestId: "selection-5-quick" });
  const rejection = assert.rejects(request, (error) => error && error.code === "REQUEST_CANCELLED");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(provider.cancelRequest("selection-6-quick"), false);
  assert.equal(provider.cancelRequest("selection-5-quick"), true);
  await rejection;
}

async function testMockRequestScopedCancellation() {
  const provider = translationProviderFactory.createMockTranslationProvider({ delayMs: 1000 });
  const request = provider.translate({ text: "biosensing", requestId: "selection-7-quick" });
  const rejection = assert.rejects(request, (error) => error && error.code === "REQUEST_CANCELLED");
  assert.equal(provider.cancelRequest("selection-8-quick"), false);
  assert.equal(provider.cancelRequest("selection-7-quick"), true);
  await rejection;
}

(async () => {
  await testGeminiRequestScopedCancellation();
  await testDeepSeekRequestScopedCancellation();
  await testBaiduRequestScopedCancellation();
  await testMockRequestScopedCancellation();
  console.log("stage10-floating-panel-interaction-tests-ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
