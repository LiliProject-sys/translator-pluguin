const assert = require("assert");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
const popupHtml = fs.readFileSync(path.join(projectRoot, "popup.html"), "utf8");
const popupCss = fs.readFileSync(path.join(projectRoot, "popup.css"), "utf8");
const popupJs = fs.readFileSync(path.join(projectRoot, "popup.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "1.0.2");
assert(manifest.permissions.includes("storage"));

assert(content.includes('const AUTO_TRANSLATE_KEY = "autoTranslateEnabled";'));
assert(content.includes("const HAN_PATTERN = /\\p{Script=Han}/u;"));
assert(content.includes("let selectionIntentId = 0;"));
assert(content.includes("let autoTranslateEnabled = false;"));
assert(content.includes("let autoTranslateSettingsPromise = loadAutoTranslateSettings();"));
assert(content.includes("chrome.storage.onChanged.addListener"));
assert(content.includes('areaName !== "local"'));
assert(content.includes("changes[AUTO_TRANSLATE_KEY]"));
assert(content.includes("changes[AUTO_TRANSLATE_KEY].newValue"));
assert(content.includes("selectionIntentId += 1;"));

const mouseupHandler = content.slice(
  content.indexOf('document.addEventListener("mouseup", (event) => {'),
  content.indexOf('document.addEventListener("mousedown"')
);
assert(mouseupHandler.includes("mouseupInsidePanel || panelPointerDown"));
assert(mouseupHandler.indexOf("mouseupInsidePanel || panelPointerDown") < mouseupHandler.indexOf("window.setTimeout(showPanelForCurrentSelection, 80)"));
assert.equal(mouseupHandler.includes("closeSelectionPanel()"), false);
assert.equal(mouseupHandler.includes("selectionIntentId"), false);
assert.equal(mouseupHandler.includes("cancelLanguageRequests"), false);

const selectionFunction = content.slice(
  content.indexOf("async function showPanelForCurrentSelection()"),
  content.indexOf("function loadAutoTranslateSettings()")
);
assert(selectionFunction.includes("const intentId = ++selectionIntentId;"));
assert(selectionFunction.includes("closeSelectionPanel();"));
assert(selectionFunction.includes("await autoTranslateSettingsPromise;"));
assert(selectionFunction.includes("intentId !== selectionIntentId"));
assert(selectionFunction.includes("!autoTranslateEnabled || containsHanScript(selectedText)"));
assert(selectionFunction.indexOf("!autoTranslateEnabled || containsHanScript(selectedText)") < selectionFunction.indexOf("currentSelectionSnapshot = getSelectionContext();"));
assert(selectionFunction.indexOf("!autoTranslateEnabled || containsHanScript(selectedText)") < selectionFunction.indexOf("checkCurrentSelectionStatus(selectionId);"));
assert(selectionFunction.indexOf("!autoTranslateEnabled || containsHanScript(selectedText)") < selectionFunction.indexOf("requestTranslation(selectionId);"));

const settingsFunction = content.slice(
  content.indexOf("function loadAutoTranslateSettings()"),
  content.indexOf("function getUsefulSelectionRect(")
);
assert(settingsFunction.includes("chrome.storage.local.get({ [AUTO_TRANSLATE_KEY]: true }"));
assert(settingsFunction.includes("autoTranslateEnabled = false;"));
assert(settingsFunction.includes("getAutoTranslateEnabledFromStorageValue(result[AUTO_TRANSLATE_KEY])"));
assert(settingsFunction.includes("return value === undefined ? true : value !== false;"));
assert(settingsFunction.includes("return HAN_PATTERN.test"));

const selectionChangeHandler = content.slice(
  content.indexOf('document.addEventListener("selectionchange"'),
  content.indexOf('document.addEventListener("keydown"')
);
assert.equal(selectionChangeHandler.includes("showPanelForCurrentSelection"), false);
assert.equal(selectionChangeHandler.includes("closeSelectionPanel"), false);

assert(popupHtml.includes("autoTranslateToggle"));
assert(popupHtml.includes('role="switch"'));
assert(popupHtml.includes('aria-checked="true"'));
assert(popupHtml.includes("划词自动翻译"));
assert(popupHtml.indexOf("autoTranslateToggle") < popupHtml.indexOf("openVocabularyButton"));

assert(popupCss.includes(".auto-translate-row"));
assert(popupCss.includes(".auto-translate-switch[aria-checked=\"true\"]"));
assert(popupCss.includes(".auto-translate-switch[aria-checked=\"false\"]"));
assert(popupCss.includes(".popup-status"));

assert(popupJs.includes('const AUTO_TRANSLATE_KEY = "autoTranslateEnabled";'));
assert(popupJs.includes("renderAutoTranslateSetting();"));
assert(popupJs.includes("chrome.storage.local.get({ [AUTO_TRANSLATE_KEY]: true }"));
assert(popupJs.includes("const previousValue = autoTranslateEnabled;"));
assert(popupJs.includes("const nextValue = !previousValue;"));
assert(popupJs.includes("autoTranslateToggle.disabled = true;"));
assert(popupJs.includes("chrome.storage.local.set({ [AUTO_TRANSLATE_KEY]: nextValue }"));
assert(popupJs.includes("autoTranslateEnabled = previousValue;"));
assert(popupJs.includes("updateAutoTranslateToggle(previousValue);"));
assert(popupJs.includes('showAutoTranslateStatus("保存失败，请重试")'));
assert(popupJs.includes('autoTranslateToggle.setAttribute("aria-checked", enabled ? "true" : "false")'));
assert(popupJs.includes('autoTranslateToggle.textContent = enabled ? "开启" : "关闭";'));
assert(popupJs.includes("return value === undefined ? true : value !== false;"));

console.log("auto-translate-toggle-and-han-filter-tests-ok");
