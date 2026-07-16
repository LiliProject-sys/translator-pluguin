const assert = require("assert");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
const background = fs.readFileSync(path.join(projectRoot, "background.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "1.0.0");

assert(content.includes("let currentSelectionId = 0;"));
assert(content.includes("let detailAnalysisRequestId = 0;"));
assert.equal(content.includes("selectionRequestId"), false);

const mouseupHandlerStart = content.indexOf('document.addEventListener("mouseup", (event) => {');
const panelMouseupGuard = content.indexOf("if (mouseupInsidePanel || panelPointerDown)", mouseupHandlerStart);
const selectionTimer = content.indexOf("mouseupTimer = window.setTimeout(showPanelForCurrentSelection, 80);", mouseupHandlerStart);
assert(mouseupHandlerStart >= 0);
assert(panelMouseupGuard > mouseupHandlerStart);
assert(selectionTimer > panelMouseupGuard);
assert(content.slice(panelMouseupGuard, selectionTimer).includes("return;"));

assert(content.includes('console.info("DETAIL_REQUEST_START"'));
assert(content.includes('console.info("DETAIL_RESPONSE_RECEIVED"'));
assert(content.includes('console.info("DETAIL_RESPONSE_APPLIED"'));
assert(content.includes('console.info("DETAIL_RESPONSE_DISCARDED"'));
assert(content.includes('logDiscardedDetailResponse(selectionId, analysisRequestId, "old_selection")'));
assert(content.includes('logDiscardedDetailResponse(selectionId, analysisRequestId, "old_request")'));
assert(content.includes("analysisRequestId !== detailAnalysisRequestId"));
assert(content.includes("selectionId !== currentSelectionId"));
assert.equal(content.includes("word: createSafeDebugWord"), false);

assert(background.includes('console.info("DETAIL_REQUEST_RECEIVED"'));
assert(background.includes("selectionId: Number.isFinite(payload.selectionId)"));
assert(background.includes("analysisRequestId: Number.isFinite(payload.analysisRequestId)"));
assert(background.includes('const STORAGE_KEY = "vocabularyEntries"'));

console.log("stage9.2-detail-lifecycle-tests-ok");
