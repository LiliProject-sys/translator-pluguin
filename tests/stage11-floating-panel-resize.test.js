const assert = require("assert");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(projectRoot, "content.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);

assert(content.includes("resize: both;"));
assert(content.includes("min-width: 320px;"));
assert(content.includes("min-height: 220px;"));
assert(content.includes("max-width: calc(100vw - 24px);"));
assert(content.includes("max-height: calc(100vh - 24px);"));
assert(content.includes("width: min(360px, calc(100vw - 24px));"));
assert(content.includes("display: flex;"));
assert(content.includes("flex-direction: column;"));
assert(content.includes("flex: 1 1 auto;"));
assert(content.includes("overflow: auto;"));

assert(content.includes("let selectionPanelResizeObserver = null;"));
assert(content.includes("function observeSelectionPanelResize()"));
assert(content.includes("new ResizeObserver"));
assert(content.includes("keepSelectionPanelInViewport"));
assert(content.includes("function disconnectSelectionPanelResizeObserver()"));
assert(content.includes("disconnectSelectionPanelResizeObserver();"));

assert(content.includes('selectionPanel.addEventListener("mousedown"'));
assert(content.includes('selectionPanel.addEventListener("mouseup"'));
assert(content.includes('selectionPanel.addEventListener("click"'));
assert(content.includes("event.stopPropagation();"));
assert(content.includes("mouseupInsidePanel || panelPointerDown"));
assert(content.includes("isEventInsideSelectionPanel(event)"));

assert.equal(content.includes('window.addEventListener("scroll", closeSelectionPanel'), false);
assert.equal(content.includes('addEventListener("scroll"'), false);
assert(content.includes('window.addEventListener("resize", keepSelectionPanelInViewport)'));
assert(content.includes('selectionPanel.style.display = "flex";'));

const resizeObserverFunction = content.slice(
  content.indexOf("function observeSelectionPanelResize()"),
  content.indexOf("function disconnectSelectionPanelResizeObserver()")
);
assert(!resizeObserverFunction.includes("showPanelForCurrentSelection"));
assert(!resizeObserverFunction.includes("closeSelectionPanel"));
assert(!resizeObserverFunction.includes("cancelLanguageRequests"));
assert(!resizeObserverFunction.includes("currentSelectionId +="));
assert(!resizeObserverFunction.includes("detailAnalysisRequestId +="));
assert(!resizeObserverFunction.includes('type: "TRANSLATE_TEXT"'));

const keepInViewportFunction = content.slice(
  content.indexOf("function keepSelectionPanelInViewport()"),
  content.indexOf("function applyPanelViewportPosition(")
);
assert(keepInViewportFunction.includes("clampPanelCoordinate"));
assert(!keepInViewportFunction.includes("showPanelForCurrentSelection"));
assert(!keepInViewportFunction.includes("closeSelectionPanel"));
assert(!keepInViewportFunction.includes("cancelLanguageRequests"));
assert(!keepInViewportFunction.includes("currentSelectionId +="));
assert(!keepInViewportFunction.includes("detailAnalysisRequestId +="));

const closeFunction = content.slice(
  content.indexOf("function closeSelectionPanel()"),
  content.indexOf("function getCurrentLanguageRequestIds()")
);
assert(closeFunction.includes("currentSelectionId += 1"));
assert(closeFunction.includes("detailAnalysisRequestId += 1"));
assert(closeFunction.includes("disconnectSelectionPanelResizeObserver();"));
assert(closeFunction.includes("cancelLanguageRequests(requestIds)"));

assert(content.includes("selectionPanel && !isEventInsideSelectionPanel(event)"));
assert(content.includes('event.key === "Escape"'));
assert(content.includes("currentQuickRequestId = `selection-${selectionId}-quick`"));
assert(content.includes("currentDetailRequestId = `selection-${selectionId}-detail-${analysisRequestId}`"));

console.log("stage11-floating-panel-resize-tests-ok");
