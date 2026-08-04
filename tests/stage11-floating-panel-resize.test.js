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
assert(content.includes("let hasUserPanelPosition = false;"));
assert(content.includes("let isPanelDragging = false;"));
assert(content.includes("let panelDragState = null;"));
assert(content.includes("const FLOATING_PANEL_DRAG_THRESHOLD = 3;"));
assert(content.includes("function observeSelectionPanelResize()"));
assert(content.includes("new ResizeObserver"));
assert(content.includes("keepSelectionPanelInViewport"));
assert(content.includes("function disconnectSelectionPanelResizeObserver()"));
assert(content.includes("disconnectSelectionPanelResizeObserver();"));
assert(content.includes("function startPanelDrag(event)"));
assert(content.includes("function movePanelDrag(event)"));
assert(content.includes("function endPanelDrag(event)"));
assert.equal(content.includes("function handlePanelDragClick(event)"), false);
assert(content.includes("setPointerCapture(event.pointerId)"));
assert(content.includes("releasePointerCapture(event.pointerId)"));
assert(content.includes('addEventListener("lostpointercapture", endPanelDrag)'));
assert(content.includes('removeEventListener("lostpointercapture", endPanelDrag)'));

assert(content.includes('selectionPanel.addEventListener("mousedown"'));
assert(content.includes('selectionPanel.addEventListener("mouseup"'));
assert(content.includes('selectionPanel.addEventListener("click"'));
assert(content.includes("event.stopPropagation();"));
assert(content.includes("mouseupInsidePanel || panelPointerDown"));
assert(content.includes("isEventInsideSelectionPanel(event)"));
assert.equal(content.includes("translator-plugin-panel-drag-handle"), false);
assert.equal(content.includes("radial-gradient"), false);
assert(content.includes('textElement.className = "translator-plugin-panel-text translator-plugin-panel-drag-region";'));
assert(content.includes('textElement.addEventListener("pointerdown", startPanelDrag);'));
assert(content.includes(".translator-plugin-panel-drag-region"));
assert(content.includes("touch-action: none;"));
assert(content.includes("user-select: none;"));
assert(content.includes("cursor: grab;"));
assert(content.includes("cursor: grabbing;"));

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
assert(keepInViewportFunction.includes("currentPanelViewportPosition = clampPanelViewportPosition"));
assert(!keepInViewportFunction.includes("showPanelForCurrentSelection"));
assert(!keepInViewportFunction.includes("closeSelectionPanel"));
assert(!keepInViewportFunction.includes("cancelLanguageRequests"));
assert(!keepInViewportFunction.includes("currentSelectionId +="));
assert(!keepInViewportFunction.includes("detailAnalysisRequestId +="));

const positionFunction = content.slice(
  content.indexOf("function positionSelectionPanel("),
  content.indexOf("function keepSelectionPanelInViewport()")
);
assert(positionFunction.includes("hasUserPanelPosition && currentPanelViewportPosition"));
assert(positionFunction.includes("clampPanelViewportPosition"));

const closeFunction = content.slice(
  content.indexOf("function closeSelectionPanel()"),
  content.indexOf("function getCurrentLanguageRequestIds()")
);
assert(closeFunction.includes("currentSelectionId += 1"));
assert(closeFunction.includes("detailAnalysisRequestId += 1"));
assert(closeFunction.includes("disconnectSelectionPanelResizeObserver();"));
assert(closeFunction.includes("cancelLanguageRequests(requestIds)"));
assert(closeFunction.includes("if (!hasUserPanelPosition)"));
assert(!closeFunction.includes("hasUserPanelPosition = false"));

assert(content.includes("selectionPanel && !isEventInsideSelectionPanel(event)"));
assert(content.includes('event.key === "Escape"'));
assert(content.includes("currentQuickRequestId = `selection-${selectionId}-quick`"));
assert(content.includes("currentDetailRequestId = `selection-${selectionId}-detail-${analysisRequestId}`"));

const dragFunctions = content.slice(
  content.indexOf("function startPanelDrag(event)"),
  content.indexOf("function saveCurrentSelection(")
);
assert(dragFunctions.includes("event.preventDefault();"));
assert(dragFunctions.includes("event.stopPropagation();"));
assert(dragFunctions.includes("Math.hypot(deltaX, deltaY)"));
assert.equal(dragFunctions.includes("suppressNextPanelDragClick"), false);
assert(dragFunctions.includes("hasUserPanelPosition = true;"));
assert(dragFunctions.includes("currentPanelViewportPosition = clampPanelViewportPosition"));
assert(!dragFunctions.includes('type: "TRANSLATE_TEXT"'));
assert(!dragFunctions.includes("cancelLanguageRequests"));
assert(!dragFunctions.includes("currentSelectionId +="));

console.log("stage11-floating-panel-resize-tests-ok");
