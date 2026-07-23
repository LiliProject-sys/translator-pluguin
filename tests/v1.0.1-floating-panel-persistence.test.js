const assert = require("assert");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "1.0.1");

assert.equal(content.includes("mouseleave"), false);
assert.equal(content.includes("pointerleave"), false);
assert.equal(content.includes("mouseout"), false);
assert.equal(content.includes('addEventListener("blur"'), false);

const selectionChangeHandler = content.slice(
  content.indexOf('document.addEventListener("selectionchange"'),
  content.indexOf('document.addEventListener("keydown"')
);
assert(selectionChangeHandler.includes("panelPointerDown"));
assert.equal(selectionChangeHandler.includes("closeSelectionPanel"), false);
assert.equal(selectionChangeHandler.includes("showPanelForCurrentSelection"), false);
assert.equal(selectionChangeHandler.includes("window.getSelection"), false);

const updatePanelStatusFunction = content.slice(
  content.indexOf("function updatePanelStatus("),
  content.indexOf("function closeSelectionPanel()")
);
assert(updatePanelStatusFunction.includes("button.textContent = message"));
assert(updatePanelStatusFunction.includes('button.classList.toggle("is-error", !!isError)'));
assert(updatePanelStatusFunction.includes("button.disabled = false"));
assert(updatePanelStatusFunction.includes('button.dataset.saveEnabled = "true"'));
assert.equal(updatePanelStatusFunction.includes("closeSelectionPanel"), false);
assert.equal(updatePanelStatusFunction.includes("setTimeout"), false);

const saveFunction = content.slice(
  content.indexOf("function saveCurrentSelection("),
  content.indexOf("function maybeRequestVocabularyContextTranslation(")
);
assert(saveFunction.includes('button.textContent = "保存中..."'));
assert(saveFunction.includes('updatePanelStatus(button, "保存失败", true)'));
assert(saveFunction.includes("maybeRequestVocabularyContextTranslation(response, snapshotForSave)"));
assert(saveFunction.includes("updatePanelStatus(button, message, false)"));
assert.equal(saveFunction.includes("closeSelectionPanel"), false);

assert(content.includes("selectionPanel && !isEventInsideSelectionPanel(event)"));
assert(content.includes('event.key === "Escape"'));
assert(content.includes("closeButton.addEventListener(\"click\", closeSelectionPanel)"));
assert(content.includes("mouseupTimer = window.setTimeout(showPanelForCurrentSelection, 80);"));
assert(content.includes("mouseupInsidePanel || panelPointerDown"));
assert(content.includes("resize: both;"));

console.log("v1.0.1-floating-panel-persistence-tests-ok");
