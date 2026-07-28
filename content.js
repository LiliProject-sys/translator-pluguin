const SENTENCE_BOUNDARY_PATTERN = /[.?!;]/;
const SINGLE_TOKEN_ABBREVIATIONS = new Set(["fig", "eq", "ref", "sec", "no", "vs"]);
const MULTI_PERIOD_ABBREVIATIONS = ["e.g.", "i.e."];
const MULTI_TOKEN_ABBREVIATIONS = ["et al."];
const TOAST_ID = "web-vocabulary-collector-toast";
const FLOATING_PANEL_ID = "translator-plugin-selection-panel";
const FLOATING_PANEL_STYLE_ID = "translator-plugin-selection-panel-style";
const FLOATING_PANEL_MARGIN = 10;
const AUTO_TRANSLATE_KEY = "autoTranslateEnabled";
const HAN_PATTERN = /\p{Script=Han}/u;

let currentSelectionSnapshot = null;
let currentSelectionRect = null;
let currentPanelViewportPosition = null;
let currentQuickRequestId = "";
let currentDetailRequestId = "";
let currentSelectionRequestType = "wordAnalysis";
let selectionPanel = null;
let selectionPanelResizeObserver = null;
let mouseupTimer = null;
let panelPointerDown = false;
let currentSelectionId = 0;
let detailAnalysisRequestId = 0;
let selectionIntentId = 0;
let autoTranslateEnabled = false;
let autoTranslateSettingsReady = false;
let autoTranslateSettingsPromise = loadAutoTranslateSettings();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "GET_SELECTION_CONTEXT") {
    sendResponse(getSelectionContext());
    return true;
  }

  if (message.type === "SHOW_VOCABULARY_NOTICE") {
    showToast(message.message || "已处理");
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

function getSelectionContext() {
  const selection = window.getSelection();
  const selectedText = selection ? selection.toString().trim() : "";

  if (!selection || selection.rangeCount === 0 || !selectedText) {
    return {
      word: selectedText,
      contextSentence: selectedText,
      pageTitle: document.title || "未命名页面",
      pageUrl: window.location.href || ""
    };
  }

  const range = selection.getRangeAt(0);
  const nearbyText = getNearbyText(range);
  const contextSentence = extractSentence(nearbyText.text, nearbyText.selectionStart, nearbyText.selectionEnd)
    || selectedText;

  return {
    word: selectedText,
    contextSentence,
    pageTitle: document.title || "未命名页面",
    pageUrl: window.location.href || ""
  };
}

document.addEventListener("mouseup", (event) => {
  const mouseupInsidePanel = isEventInsideSelectionPanel(event);
  if (mouseupInsidePanel || panelPointerDown) {
    window.setTimeout(() => {
      panelPointerDown = false;
    }, 0);
    return;
  }

  window.clearTimeout(mouseupTimer);
  mouseupTimer = window.setTimeout(showPanelForCurrentSelection, 80);
});

document.addEventListener("mousedown", (event) => {
  if (selectionPanel && !isEventInsideSelectionPanel(event)) {
    closeSelectionPanel();
  }
}, true);

document.addEventListener("selectionchange", () => {
  if (panelPointerDown) {
    return;
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSelectionPanel();
  }
});

window.addEventListener("resize", keepSelectionPanelInViewport);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes || !changes[AUTO_TRANSLATE_KEY]) {
    return;
  }

  autoTranslateEnabled = getAutoTranslateEnabledFromStorageValue(changes[AUTO_TRANSLATE_KEY].newValue);
  autoTranslateSettingsReady = true;

  if (!autoTranslateEnabled) {
    selectionIntentId += 1;
    closeSelectionPanel();
  }
});

async function showPanelForCurrentSelection() {
  const selection = window.getSelection();
  const selectedText = selection ? selection.toString().trim() : "";

  if (!selection || selection.rangeCount === 0 || !selectedText) {
    closeSelectionPanel();
    return;
  }

  const range = selection.getRangeAt(0);
  const rect = getUsefulSelectionRect(range);

  if (!rect) {
    closeSelectionPanel();
    return;
  }

  const intentId = ++selectionIntentId;
  closeSelectionPanel();

  await autoTranslateSettingsPromise;
  if (intentId !== selectionIntentId) {
    return;
  }

  if (!autoTranslateEnabled || containsHanScript(selectedText)) {
    return;
  }

  currentSelectionSnapshot = getSelectionContext();
  currentSelectionRect = copyRect(rect);
  const selectionId = ++currentSelectionId;
  currentSelectionRequestType = detectSelectionRequestType(currentSelectionSnapshot.word);
  currentQuickRequestId = `selection-${selectionId}-quick`;
  currentDetailRequestId = "";
  createOrUpdateSelectionPanel(currentSelectionSnapshot.word);
  positionSelectionPanel(currentSelectionRect);
  checkCurrentSelectionStatus(selectionId);
  updateLanguageLoadingLabel(selectionId);
  requestTranslation(selectionId);
}

function loadAutoTranslateSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [AUTO_TRANSLATE_KEY]: true }, (result) => {
      if (chrome.runtime.lastError) {
        console.error("Failed to read auto translate setting:", chrome.runtime.lastError.message);
        autoTranslateEnabled = false;
        autoTranslateSettingsReady = true;
        resolve(false);
        return;
      }

      autoTranslateEnabled = getAutoTranslateEnabledFromStorageValue(result[AUTO_TRANSLATE_KEY]);
      autoTranslateSettingsReady = true;
      resolve(autoTranslateEnabled);
    });
  });
}

function getAutoTranslateEnabledFromStorageValue(value) {
  return value === undefined ? true : value !== false;
}

function containsHanScript(text) {
  return HAN_PATTERN.test(typeof text === "string" ? text : "");
}

function getUsefulSelectionRect(range) {
  const rect = range.getBoundingClientRect();

  if (rect && (rect.width > 0 || rect.height > 0)) {
    return rect;
  }

  const rects = range.getClientRects();
  return rects.length > 0 ? rects[0] : null;
}

function createOrUpdateSelectionPanel(selectedText) {
  injectSelectionPanelStyles();

  if (!selectionPanel) {
    selectionPanel = document.createElement("div");
    selectionPanel.id = FLOATING_PANEL_ID;
    selectionPanel.className = "translator-plugin-panel";
    selectionPanel.addEventListener("mousedown", (event) => {
      panelPointerDown = true;
      event.stopPropagation();
    });
    selectionPanel.addEventListener("mouseup", (event) => {
      event.stopPropagation();
      window.setTimeout(() => {
        panelPointerDown = false;
      }, 0);
    });
    selectionPanel.addEventListener("click", (event) => {
      event.stopPropagation();
      window.setTimeout(() => {
        panelPointerDown = false;
      }, 0);
    });
    document.documentElement.appendChild(selectionPanel);
    observeSelectionPanelResize();
  }

  selectionPanel.innerHTML = "";

  const textElement = document.createElement("div");
  textElement.className = "translator-plugin-panel-text";
  textElement.textContent = selectedText || "";

  const translationElement = document.createElement("div");
  translationElement.className = "translator-plugin-panel-translation is-loading";
  translationElement.textContent = "正在处理…";

  const statusElement = document.createElement("div");
  statusElement.className = "translator-plugin-panel-status";
  statusElement.textContent = "正在检查收录状态...";

  const actions = document.createElement("div");
  actions.className = "translator-plugin-panel-actions";

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "translator-plugin-panel-primary";
  addButton.textContent = "检查中...";
  addButton.disabled = true;
  addButton.dataset.saveEnabled = "false";
  addButton.addEventListener("click", () => saveCurrentSelection(addButton));

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "translator-plugin-panel-close";
  closeButton.setAttribute("aria-label", "关闭");
  closeButton.textContent = "×";
  closeButton.addEventListener("click", closeSelectionPanel);

  actions.append(addButton, closeButton);
  selectionPanel.append(textElement, translationElement, statusElement, actions);
}

function checkCurrentSelectionStatus(selectionId) {
  const snapshot = currentSelectionSnapshot;

  chrome.runtime.sendMessage({
    type: "CHECK_VOCABULARY_STATUS",
    entry: snapshot
  }, (response) => {
    const runtimeError = chrome.runtime.lastError;

    if (selectionId !== currentSelectionId || !selectionPanel || snapshot !== currentSelectionSnapshot) {
      return;
    }

    if (runtimeError) {
      console.error("Failed to check vocabulary status:", runtimeError.message);
      renderSelectionStatus({ status: "error" });
      return;
    }

    if (!response || response.status !== "ok") {
      console.error("Failed to check vocabulary status:", response && response.message ? response.message : "Unknown error");
      renderSelectionStatus({ status: "error" });
      return;
    }

    renderSelectionStatus(response);
  });
}

function requestTranslation(selectionId) {
  const snapshot = currentSelectionSnapshot;
  const quickRequestId = currentQuickRequestId;

  setLanguageLoadingState("正在处理…", true);

  chrome.runtime.sendMessage({
    type: "TRANSLATE_TEXT",
    payload: {
      text: snapshot && snapshot.word,
      contextSentence: snapshot && snapshot.contextSentence,
      pageTitle: snapshot && snapshot.pageTitle,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      requestType: currentSelectionRequestType,
      analysisMode: "quick",
      requestId: quickRequestId,
      selectionId
    }
  }, (response) => {
    const runtimeError = chrome.runtime.lastError;

    if (selectionId !== currentSelectionId
      || quickRequestId !== currentQuickRequestId
      || !selectionPanel
      || snapshot !== currentSelectionSnapshot) {
      return;
    }

    if (runtimeError) {
      console.error("Failed to process selected text:", runtimeError.message);
      renderLanguageResult({ errorMessage: "处理失败，请稍后重试" }, selectionId);
      return;
    }

    if (!response || response.status !== "ok") {
      console.error("Language request failed:", {
        code: response && response.errorCode ? response.errorCode : "UNKNOWN_ERROR",
        type: "LanguageResponseError"
      });
      renderLanguageResult({
        errorMessage: response && response.message ? response.message : "处理失败，请稍后重试",
        requiresConfiguration: !!(response && response.requiresConfiguration)
      }, selectionId);
      return;
    }

    maybeStoreQuickAnalysisOnSnapshot(response, selectionId, quickRequestId, snapshot);
    maybeStoreContextTranslationOnSnapshot(response, selectionId, quickRequestId, snapshot);
    renderLanguageResult(response, selectionId);
  });
}

function maybeStoreQuickAnalysisOnSnapshot(response, selectionId, quickRequestId, snapshot) {
  if (!response
    || response.resultType !== "contextAnalysis"
    || response.analysisMode !== "quick"
    || !response.analysis
    || currentSelectionRequestType !== "wordAnalysis"
    || selectionId !== currentSelectionId
    || quickRequestId !== currentQuickRequestId
    || !selectionPanel
    || snapshot !== currentSelectionSnapshot) {
    return;
  }

  ["lemma", "phonetic", "partOfSpeech", "meaning"].forEach((field) => {
    const value = normalizeWhitespace(response.analysis[field]);
    if (value) {
      snapshot[field] = value;
    }
  });
}

function maybeStoreContextTranslationOnSnapshot(response, selectionId, quickRequestId, snapshot) {
  if (!response
    || currentSelectionRequestType !== "sentenceTranslation"
    || selectionId !== currentSelectionId
    || quickRequestId !== currentQuickRequestId
    || !selectionPanel
    || snapshot !== currentSelectionSnapshot
    || !isTranslationResultForSnapshot(response, snapshot)) {
    return;
  }

  let contextTranslation = "";
  if (response.resultType === "sentenceTranslation") {
    contextTranslation = normalizeWhitespace(response.translation);
  } else if (response.resultType === "quickTranslation") {
    contextTranslation = normalizeWhitespace(response.translatedText);
  }

  if (contextTranslation) {
    snapshot.contextTranslation = contextTranslation;
  }
}

function isTranslationResultForSnapshot(response, snapshot) {
  if (!snapshot) {
    return false;
  }

  const contextSentence = normalizeWhitespace(snapshot.contextSentence);
  const selectedText = normalizeWhitespace(snapshot.word);
  if (!contextSentence || !selectedText) {
    return false;
  }

  if (response.resultType === "quickTranslation") {
    return normalizeForLooseCompare(contextSentence) === normalizeForLooseCompare(selectedText);
  }

  return response.resultType === "sentenceTranslation";
}

function updateLanguageLoadingLabel(selectionId) {
  if (currentSelectionRequestType === "sentenceTranslation") {
    setLanguageLoadingState("正在翻译句子…");
    return;
  }

  chrome.runtime.sendMessage({ type: "GET_ACTIVE_LANGUAGE_MODE" }, (response) => {
    if (selectionId !== currentSelectionId || !selectionPanel) {
      return;
    }

    if (chrome.runtime.lastError || !response || response.status !== "ok") {
      return;
    }

    setLanguageLoadingState(response.resultType === "contextAnalysis"
      ? "正在进行语境解析…"
      : "正在翻译…");
  });
}

function setLanguageLoadingState(message, force) {
  if (!selectionPanel) {
    return;
  }

  const translationElement = selectionPanel.querySelector(".translator-plugin-panel-translation");
  if (!translationElement) {
    return;
  }

  if (!force && !translationElement.classList.contains("is-loading")) {
    return;
  }

  translationElement.classList.remove("is-error", "is-analysis", "is-sentence-translation");
  translationElement.classList.add("is-loading");
  translationElement.textContent = message;
}

function renderLanguageResult(result, selectionId) {
  if (!selectionPanel) {
    return;
  }

  const translationElement = selectionPanel.querySelector(".translator-plugin-panel-translation");

  if (!translationElement) {
    return;
  }

  translationElement.classList.remove("is-loading", "is-error", "is-analysis", "is-sentence-translation");
  translationElement.innerHTML = "";

  if (result && result.resultType === "sentenceTranslation" && result.translation) {
    renderSentenceTranslation(translationElement, result);
  } else if (result && result.resultType === "contextAnalysis" && result.analysis) {
    renderContextAnalysis(translationElement, result.analysis, result.analysisMode || "quick", selectionId);
  } else if (result && result.translatedText) {
    translationElement.textContent = result.translatedText;
  } else {
    const errorText = document.createElement("span");
    errorText.textContent = result && result.errorMessage
      ? result.errorMessage
      : "处理失败，请稍后重试";
    translationElement.appendChild(errorText);
    translationElement.classList.add("is-error");

    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = "translator-plugin-panel-settings";
    retryButton.textContent = "重试";
    retryButton.addEventListener("click", () => requestTranslation(selectionId));
    translationElement.appendChild(retryButton);

    if (result && result.requiresConfiguration) {
      const settingsButton = document.createElement("button");
      settingsButton.type = "button";
      settingsButton.className = "translator-plugin-panel-settings";
      settingsButton.textContent = "打开设置";
      settingsButton.addEventListener("click", openTranslationOptions);
      translationElement.appendChild(settingsButton);
    }
  }

  keepSelectionPanelInViewport();
}

function renderSentenceTranslation(container, result) {
  container.classList.add("is-analysis", "is-sentence-translation");

  const translationElement = document.createElement("div");
  translationElement.className = "translator-plugin-sentence-translation";
  translationElement.textContent = result.translation;
  container.appendChild(translationElement);

  if (!result.keyTerm) {
    return;
  }

  const keyTermElement = document.createElement("div");
  keyTermElement.className = "translator-plugin-sentence-key-term";
  const keyTermLabel = document.createElement("span");
  keyTermLabel.textContent = "关键术语";
  const keyTermValue = document.createElement("span");
  keyTermValue.textContent = `${result.keyTerm.term}：${result.keyTerm.meaning}`;
  keyTermElement.append(keyTermLabel, keyTermValue);
  container.appendChild(keyTermElement);
}

function renderContextAnalysis(container, analysis, analysisMode, selectionId) {
  container.classList.add("is-analysis");
  if (analysisMode === "detail") {
    renderDetailAnalysis(container, analysis);
    return;
  }

  const selectedWord = currentSelectionSnapshot && currentSelectionSnapshot.word
    ? currentSelectionSnapshot.word
    : analysis.word;
  const rows = [
    ["单词", formatLemmaDisplay(analysis.lemma, selectedWord)],
    ["音标", analysis.phonetic],
    ["词性", analysis.partOfSpeech],
    ["含义", analysis.meaning]
  ];

  rows.forEach(([label, value], index) => {
    const row = document.createElement("div");
    row.className = "translator-plugin-analysis-row";
    if (index === rows.length - 1) {
      row.classList.add("is-contextual-meaning");
    }

    const labelElement = document.createElement("span");
    labelElement.className = "translator-plugin-analysis-label";
    labelElement.textContent = label;

    const valueElement = document.createElement("span");
    valueElement.className = "translator-plugin-analysis-value";
    valueElement.textContent = value || "-";

    row.append(labelElement, valueElement);
    container.appendChild(row);
  });

  const detailButton = document.createElement("button");
  detailButton.type = "button";
  detailButton.className = "translator-plugin-panel-detail";
  detailButton.textContent = "详细解释";
  detailButton.addEventListener("click", () => requestDetailedAnalysis(selectionId, detailButton));
  container.appendChild(detailButton);
}

function renderDetailAnalysis(container, analysis) {
  const rows = [
    ["当前语境", analysis.meaningInSentence]
  ];

  if (analysis.comparison) {
    rows.push([
      "近义词区别",
      formatComparisonDisplay(analysis.comparison)
    ]);
  }

  rows.forEach(([label, value], index) => {
    const row = document.createElement("div");
    row.className = "translator-plugin-analysis-row is-detail";
    if (index === 0) {
      row.classList.add("is-contextual-meaning");
    } else {
      row.classList.add("is-separated-detail");
    }

    const labelElement = document.createElement("span");
    labelElement.className = "translator-plugin-analysis-label";
    labelElement.textContent = label;

    const valueElement = document.createElement("span");
    valueElement.className = "translator-plugin-analysis-value";
    valueElement.textContent = value || "-";

    row.append(labelElement, valueElement);
    container.appendChild(row);
  });
}

function formatComparisonDisplay(comparison) {
  if (!comparison) {
    return "";
  }

  const selectedWord = currentSelectionSnapshot && currentSelectionSnapshot.word
    ? normalizeWhitespace(currentSelectionSnapshot.word)
    : "";
  const currentWord = selectedWord || "当前词";
  return [
    `${currentWord} vs ${comparison.word}`,
    comparison.difference
  ].filter(Boolean).join("\n");
}

function requestDetailedAnalysis(selectionId, button) {
  const snapshot = currentSelectionSnapshot;
  if (!snapshot || selectionId !== currentSelectionId) {
    return;
  }

  const analysisRequestId = ++detailAnalysisRequestId;
  currentDetailRequestId = `selection-${selectionId}-detail-${analysisRequestId}`;
  console.info("DETAIL_REQUEST_START", {
    selectionId,
    analysisRequestId
  });

  button.disabled = true;
  button.textContent = "正在详细解释…";

  chrome.runtime.sendMessage({
    type: "TRANSLATE_TEXT",
    payload: {
      text: snapshot.word,
      contextSentence: snapshot.contextSentence,
      pageTitle: snapshot.pageTitle,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      requestType: "wordAnalysis",
      analysisMode: "detail",
      requestId: currentDetailRequestId,
      selectionId,
      analysisRequestId,
      userQuestion: "请用最简洁的信息说明该词在当前句子里的含义；只有近义词语义区别明显时才补充比较。"
    }
  }, (response) => {
    const runtimeError = chrome.runtime.lastError;

    console.info("DETAIL_RESPONSE_RECEIVED", {
      selectionId,
      analysisRequestId,
      status: runtimeError ? "runtime_error" : response && response.status ? response.status : "missing"
    });

    if (selectionId !== currentSelectionId) {
      logDiscardedDetailResponse(selectionId, analysisRequestId, "old_selection");
      return;
    }

    if (analysisRequestId !== detailAnalysisRequestId) {
      logDiscardedDetailResponse(selectionId, analysisRequestId, "old_request");
      return;
    }

    if (!selectionPanel || snapshot !== currentSelectionSnapshot) {
      logDiscardedDetailResponse(selectionId, analysisRequestId, "panel_closed");
      return;
    }

    if (runtimeError) {
      console.error("Failed to request detailed context analysis:", runtimeError.message);
      renderDetailError(button, "详细解释加载失败，请重试", selectionId);
      return;
    }

    if (!response || response.status !== "ok" || response.resultType !== "contextAnalysis") {
      console.error("Detailed context analysis failed:", {
        code: response && response.errorCode ? response.errorCode : "UNKNOWN_ERROR",
        type: "LanguageResponseError"
      });
      renderDetailError(button, "详细解释加载失败，请重试", selectionId);
      return;
    }

    const translationElement = selectionPanel.querySelector(".translator-plugin-panel-translation");
    if (!translationElement) {
      return;
    }

    const detailSection = document.createElement("div");
    detailSection.className = "translator-plugin-detail-section";
    renderDetailAnalysis(detailSection, response.analysis);
    const staleError = selectionPanel.querySelector(".translator-plugin-detail-error");
    if (staleError) {
      staleError.remove();
    }
    button.replaceWith(detailSection);
    console.info("DETAIL_RESPONSE_APPLIED", {
      selectionId,
      analysisRequestId
    });

    keepSelectionPanelInViewport();
  });
}

function logDiscardedDetailResponse(selectionId, analysisRequestId, reason) {
  console.info("DETAIL_RESPONSE_DISCARDED", {
    selectionId,
    analysisRequestId,
    reason
  });
}

function renderDetailError(button, message, selectionId) {
  let errorElement = selectionPanel && selectionPanel.querySelector(".translator-plugin-detail-error");
  if (!errorElement && selectionPanel) {
    errorElement = document.createElement("div");
    errorElement.className = "translator-plugin-detail-error";
    button.insertAdjacentElement("beforebegin", errorElement);
  }
  if (errorElement) {
    errorElement.textContent = message;
  }

  const retryButton = button.cloneNode(true);
  retryButton.disabled = false;
  retryButton.textContent = "重试详细解释";
  retryButton.addEventListener("click", () => requestDetailedAnalysis(selectionId, retryButton));
  button.replaceWith(retryButton);

  keepSelectionPanelInViewport();
}

function formatLemmaDisplay(lemma, selectedWord) {
  const normalizedLemma = normalizeWhitespace(lemma);
  const normalizedWord = normalizeWhitespace(selectedWord);
  if (!normalizedLemma) {
    return normalizedWord || "-";
  }
  if (!normalizedWord || normalizedLemma.toLocaleLowerCase() === normalizedWord.toLocaleLowerCase()) {
    return normalizedLemma;
  }
  return `${normalizedLemma} (${normalizedWord})`;
}

function detectSelectionRequestType(selectedText) {
  const text = typeof selectedText === "string" ? selectedText.trim() : "";
  if (!text) {
    return "wordAnalysis";
  }

  return /\s/u.test(text) ? "sentenceTranslation" : "wordAnalysis";
}

function openTranslationOptions() {
  chrome.runtime.sendMessage({ type: "OPEN_OPTIONS_PAGE" }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Failed to open translation settings:", chrome.runtime.lastError.message);
      return;
    }

    if (!response || response.status !== "ok") {
      console.error("Failed to open translation settings:", response && response.message ? response.message : "Unknown error");
    }
  });
}

function renderSelectionStatus(status) {
  if (!selectionPanel) {
    return;
  }

  const statusElement = selectionPanel.querySelector(".translator-plugin-panel-status");
  const addButton = selectionPanel.querySelector(".translator-plugin-panel-primary");

  if (!statusElement || !addButton) {
    return;
  }

  statusElement.classList.remove("is-error");
  addButton.classList.remove("is-error");

  if (status.status === "error") {
    statusElement.hidden = false;
    statusElement.textContent = "状态检查失败，仍可尝试保存";
    statusElement.classList.add("is-error");
    configureSaveButton(addButton, "加入生词本", true);
  } else if (status.exactEntryExists) {
    statusElement.hidden = false;
    statusElement.textContent = "当前语境已保存";
    configureSaveButton(addButton, "已保存", false);
  } else if (status.wordExists) {
    statusElement.hidden = false;
    statusElement.textContent = "该词已收录，可保存当前语境";
    configureSaveButton(addButton, "保存当前语境", true);
  } else {
    statusElement.hidden = true;
    statusElement.textContent = "";
    configureSaveButton(addButton, "加入生词本", true);
  }

  keepSelectionPanelInViewport();
}

function configureSaveButton(button, label, enabled) {
  button.textContent = label;
  button.disabled = !enabled;
  button.dataset.saveEnabled = enabled ? "true" : "false";
}

function positionSelectionPanel(selectionRect) {
  if (!selectionPanel) {
    return;
  }

  selectionPanel.style.left = "0px";
  selectionPanel.style.top = "0px";
  selectionPanel.style.visibility = "hidden";
  selectionPanel.style.display = "flex";

  const panelRect = selectionPanel.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;

  let left = selectionRect.left + (selectionRect.width / 2) - (panelRect.width / 2);
  left = clampPanelCoordinate(left, panelRect.width, viewportWidth);

  const spaceAbove = selectionRect.top;
  const spaceBelow = viewportHeight - selectionRect.bottom;
  let top;

  if (spaceAbove >= panelRect.height + FLOATING_PANEL_MARGIN) {
    top = selectionRect.top - panelRect.height - FLOATING_PANEL_MARGIN;
  } else if (spaceBelow >= panelRect.height + FLOATING_PANEL_MARGIN) {
    top = selectionRect.bottom + FLOATING_PANEL_MARGIN;
  } else {
    top = clampPanelCoordinate(
      selectionRect.top - panelRect.height - FLOATING_PANEL_MARGIN,
      panelRect.height,
      viewportHeight
    );
  }

  top = clampPanelCoordinate(top, panelRect.height, viewportHeight);
  currentPanelViewportPosition = { left, top };
  applyPanelViewportPosition(left, top);
  selectionPanel.style.visibility = "visible";
}

function keepSelectionPanelInViewport() {
  if (!selectionPanel || !currentPanelViewportPosition) {
    return;
  }

  const panelRect = selectionPanel.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const left = clampPanelCoordinate(currentPanelViewportPosition.left, panelRect.width, viewportWidth);
  const top = clampPanelCoordinate(currentPanelViewportPosition.top, panelRect.height, viewportHeight);

  currentPanelViewportPosition = { left, top };
  applyPanelViewportPosition(left, top);
}

function observeSelectionPanelResize() {
  disconnectSelectionPanelResizeObserver();

  if (!selectionPanel || typeof ResizeObserver !== "function") {
    return;
  }

  selectionPanelResizeObserver = new ResizeObserver(() => {
    window.requestAnimationFrame(keepSelectionPanelInViewport);
  });
  selectionPanelResizeObserver.observe(selectionPanel);
}

function disconnectSelectionPanelResizeObserver() {
  if (!selectionPanelResizeObserver) {
    return;
  }

  selectionPanelResizeObserver.disconnect();
  selectionPanelResizeObserver = null;
}

function applyPanelViewportPosition(left, top) {
  if (!selectionPanel) {
    return;
  }
  selectionPanel.style.left = `${Math.round(left)}px`;
  selectionPanel.style.top = `${Math.round(top)}px`;
}

function clampPanelCoordinate(value, elementSize, viewportSize) {
  const maximum = Math.max(FLOATING_PANEL_MARGIN, viewportSize - elementSize - FLOATING_PANEL_MARGIN);
  return clamp(value, FLOATING_PANEL_MARGIN, maximum);
}

function saveCurrentSelection(button) {
  if (button.dataset.saveEnabled !== "true") {
    return;
  }

  if (!currentSelectionSnapshot || !currentSelectionSnapshot.word) {
    updatePanelStatus(button, "保存失败", true);
    console.error("Cannot save because the selection snapshot is empty.");
    return;
  }

  button.disabled = true;
  button.dataset.saveEnabled = "false";
  button.textContent = "保存中...";
  const snapshotForSave = currentSelectionSnapshot;

  chrome.runtime.sendMessage({
    type: "SAVE_VOCABULARY_ENTRY",
    entry: snapshotForSave
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Failed to save vocabulary entry:", chrome.runtime.lastError.message);
      updatePanelStatus(button, "保存失败", true);
      return;
    }

    if (!response || response.status === "error") {
      console.error("Failed to save vocabulary entry:", response && response.message ? response.message : "Unknown error");
      updatePanelStatus(button, "保存失败", true);
      return;
    }

    const message = response.status === "duplicate" ? "已保存" : "已加入";
    maybeRequestVocabularyContextTranslation(response, snapshotForSave);
    updatePanelStatus(button, message, false);
  });
}

function maybeRequestVocabularyContextTranslation(response, snapshot) {
  if (!response
    || !response.entryId
    || response.hasContextTranslation
    || !shouldRequestVocabularyContextTranslation(snapshot)) {
    return;
  }

  chrome.runtime.sendMessage({
    type: "GENERATE_VOCABULARY_CONTEXT_TRANSLATION",
    entry: {
      entryId: response.entryId,
      word: snapshot.word,
      contextSentence: snapshot.contextSentence,
      pageUrl: snapshot.pageUrl
    }
  }, (translationResponse) => {
    if (chrome.runtime.lastError) {
      console.error("Failed to request vocabulary context translation:", chrome.runtime.lastError.message);
      return;
    }

    if (!translationResponse || translationResponse.status === "error") {
      console.error("Vocabulary context translation failed:", translationResponse && translationResponse.message
        ? translationResponse.message
        : "Unknown error");
    }
  });
}

function shouldRequestVocabularyContextTranslation(snapshot) {
  if (!snapshot) {
    return false;
  }

  const contextSentence = normalizeWhitespace(snapshot.contextSentence);
  if (!contextSentence) {
    return false;
  }

  const word = normalizeWhitespace(snapshot.word);
  const normalizedWord = normalizeForLooseCompare(word);
  const normalizedContext = normalizeForLooseCompare(contextSentence);
  const wordCount = normalizedContext.split(/\s+/).filter(Boolean).length;
  const hasSentenceBoundary = /[.?!;]/.test(contextSentence);

  return !(normalizedWord && normalizedWord === normalizedContext && wordCount <= 3 && !hasSentenceBoundary);
}

function updatePanelStatus(button, message, isError) {
  button.textContent = message;
  button.classList.toggle("is-error", !!isError);

  if (isError) {
    button.disabled = false;
    button.dataset.saveEnabled = "true";
  }
}

function closeSelectionPanel() {
  const requestIds = getCurrentLanguageRequestIds();
  currentSelectionId += 1;
  detailAnalysisRequestId += 1;
  currentSelectionSnapshot = null;
  currentSelectionRect = null;
  currentPanelViewportPosition = null;
  currentQuickRequestId = "";
  currentDetailRequestId = "";
  currentSelectionRequestType = "wordAnalysis";
  panelPointerDown = false;

  disconnectSelectionPanelResizeObserver();

  if (selectionPanel) {
    selectionPanel.remove();
    selectionPanel = null;
  }

  cancelLanguageRequests(requestIds);
}

function getCurrentLanguageRequestIds() {
  return [currentQuickRequestId, currentDetailRequestId].filter(Boolean);
}

function cancelLanguageRequests(requestIds) {
  if (!Array.isArray(requestIds) || requestIds.length === 0) {
    return;
  }

  chrome.runtime.sendMessage({
    type: "CANCEL_LANGUAGE_REQUEST",
    requestIds
  }, () => {
    if (chrome.runtime.lastError) {
      console.error("Failed to cancel language request:", chrome.runtime.lastError.message);
    }
  });
}

function isEventInsideSelectionPanel(event) {
  if (!selectionPanel || !event) {
    return false;
  }
  if (typeof event.composedPath === "function") {
    return event.composedPath().includes(selectionPanel);
  }
  return !!(event.target && selectionPanel.contains(event.target));
}

function injectSelectionPanelStyles() {
  if (document.getElementById(FLOATING_PANEL_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = FLOATING_PANEL_STYLE_ID;
  style.textContent = `
    #${FLOATING_PANEL_ID}.translator-plugin-panel {
      position: fixed;
      z-index: 2147483000;
      width: min(360px, calc(100vw - 24px));
      min-width: 320px;
      min-height: 220px;
      max-width: calc(100vw - 24px);
      max-height: calc(100vh - 24px);
      display: flex;
      flex-direction: column;
      resize: both;
      overflow: hidden;
      padding: 10px;
      border: 1px solid rgba(148, 163, 184, 0.55);
      border-radius: 10px;
      background: #ffffff;
      color: #111827;
      box-shadow: 0 12px 30px rgba(15, 23, 42, 0.18);
      font-family: Arial, "Microsoft YaHei", sans-serif;
      font-size: 14px;
      line-height: 1.4;
      box-sizing: border-box;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-panel-text {
      width: 100%;
      min-width: 0;
      margin: 0 0 8px;
      overflow: hidden;
      color: #1f2937;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-panel-translation {
      flex: 1 1 auto;
      min-height: 0;
      width: 100%;
      margin: 0 0 8px;
      padding: 7px 8px;
      border-left: 3px solid #60a5fa;
      border-radius: 4px;
      color: #1f2937;
      background: #f8fafc;
      font-size: 13px;
      line-height: 1.5;
      overflow: auto;
      overflow-wrap: anywhere;
      white-space: normal;
      box-sizing: border-box;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-panel-translation.is-loading {
      border-left-color: #cbd5e1;
      color: #64748b;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-panel-translation.is-error {
      border-left-color: #dc2626;
      color: #b91c1c;
      background: #fef2f2;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-panel-translation.is-analysis {
      border-left-color: #16a34a;
      padding: 8px 9px;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-panel-translation.is-sentence-translation {
      border-left-color: #0f766e;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-sentence-translation {
      color: #134e4a;
      font-size: 14px;
      line-height: 1.65;
      white-space: pre-wrap;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-sentence-key-term {
      display: grid;
      grid-template-columns: 64px minmax(0, 1fr);
      gap: 8px;
      margin-top: 9px;
      padding-top: 8px;
      border-top: 1px solid #d1fae5;
      color: #334155;
      overflow-wrap: anywhere;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-sentence-key-term > span:first-child {
      color: #0f766e;
      font-weight: 600;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-analysis-row {
      display: grid;
      grid-template-columns: 76px minmax(0, 1fr);
      gap: 8px;
      padding: 2px 0;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-analysis-row.is-contextual-meaning {
      max-height: 88px;
      overflow-y: auto;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-analysis-row.is-detail {
      grid-template-columns: 72px minmax(0, 1fr);
      padding: 3px 0;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-analysis-row.is-separated-detail {
      margin-top: 7px;
      border-top: 1px solid #e5e7eb;
      padding-top: 8px;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-analysis-label {
      color: #64748b;
      font-size: 12px;
      font-weight: 600;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-analysis-value {
      min-width: 0;
      color: #1f2937;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-panel-settings {
      display: inline-block;
      width: max-content;
      min-height: 28px;
      margin: 7px 7px 0 0;
      border: 1px solid #fca5a5;
      padding: 4px 8px;
      color: #991b1b;
      background: #ffffff;
      font-size: 12px;
      font-weight: 600;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-panel-detail {
      display: inline-block;
      width: max-content;
      min-height: 28px;
      margin: 8px 7px 0 0;
      border: 1px solid #16a34a;
      padding: 4px 9px;
      color: #166534;
      background: #ffffff;
      font-size: 12px;
      font-weight: 600;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-panel-detail:disabled {
      cursor: default;
      opacity: 0.78;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-detail-section {
      margin-top: 8px;
      border-top: 1px solid #e5e7eb;
      padding-top: 8px;
      overflow: visible;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-detail-error {
      margin-top: 8px;
      color: #b91c1c;
      font-size: 12px;
      line-height: 1.45;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-panel-status {
      width: 100%;
      min-width: 0;
      margin: 0 0 8px;
      color: #475569;
      font-size: 12px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-panel-status.is-error {
      color: #b91c1c;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-panel-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    #${FLOATING_PANEL_ID} button {
      box-sizing: border-box;
      border-radius: 7px;
      font-family: Arial, "Microsoft YaHei", sans-serif;
      font-size: 13px;
      line-height: 1.2;
      cursor: pointer;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-panel-primary {
      min-width: 86px;
      border: 1px solid #2563eb;
      padding: 7px 10px;
      color: #ffffff;
      background: #2563eb;
      font-weight: 600;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-panel-primary:disabled {
      cursor: default;
      opacity: 0.86;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-panel-primary.is-error {
      border-color: #dc2626;
      background: #dc2626;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-panel-close {
      width: 30px;
      height: 30px;
      border: 1px solid #d1d5db;
      padding: 0;
      color: #374151;
      background: #ffffff;
      font-size: 18px;
    }
  `;
  document.documentElement.appendChild(style);
}

function getNearbyText(range) {
  const commonContainer = range.commonAncestorContainer;
  const textContainer = commonContainer.nodeType === Node.TEXT_NODE
    ? commonContainer.parentElement
    : commonContainer;
  const sourceElement = findReadableContainer(textContainer);
  const fullText = sourceElement ? sourceElement.innerText || sourceElement.textContent || "" : range.toString();
  const selectedText = range.toString();

  let selectionStart = fullText.indexOf(selectedText);

  if (selectionStart === -1 && range.startContainer.nodeType === Node.TEXT_NODE) {
    const nodeText = range.startContainer.textContent || "";
    const localText = nodeText.slice(range.startOffset, range.endOffset);
    selectionStart = fullText.indexOf(localText);
  }

  if (selectionStart === -1) {
    selectionStart = Math.max(0, Math.floor(fullText.length / 2));
  }

  return {
    text: normalizeWhitespace(fullText),
    selectionStart,
    selectionEnd: selectionStart + selectedText.length
  };
}

function findReadableContainer(node) {
  let current = node && node.nodeType === Node.ELEMENT_NODE ? node : null;

  while (current && current !== document.body) {
    const text = current.innerText || current.textContent || "";

    if (text.trim().length >= 40) {
      return current;
    }

    current = current.parentElement;
  }

  return document.body;
}

function extractSentence(text, selectionStart, selectionEnd) {
  const cleanText = normalizeWhitespace(text);

  if (!cleanText) {
    return "";
  }

  const safeStart = clamp(selectionStart, 0, cleanText.length);
  const safeEnd = clamp(selectionEnd, safeStart, cleanText.length);
  let sentenceStart = safeStart;
  let sentenceEnd = safeEnd;

  while (sentenceStart > 0 && !isSentenceBoundary(cleanText, sentenceStart - 1)) {
    sentenceStart -= 1;
  }

  while (sentenceEnd < cleanText.length && !isSentenceBoundary(cleanText, sentenceEnd)) {
    sentenceEnd += 1;
  }

  if (sentenceEnd < cleanText.length && isSentenceBoundary(cleanText, sentenceEnd)) {
    sentenceEnd += 1;
  }

  const sentence = cleanText.slice(sentenceStart, sentenceEnd).trim();
  return sentence || cleanText.slice(Math.max(0, safeStart - 120), Math.min(cleanText.length, safeEnd + 120)).trim();
}

function isSentenceBoundary(text, index) {
  const character = text.charAt(index);
  if (!SENTENCE_BOUNDARY_PATTERN.test(character)) {
    return false;
  }

  if (character === ".") {
    return !isDecimalPoint(text, index) && !isProtectedAbbreviationPeriod(text, index);
  }

  return true;
}

function isDecimalPoint(text, index) {
  return text.charAt(index) === "."
    && isAsciiDigit(text.charAt(index - 1))
    && isAsciiDigit(text.charAt(index + 1));
}

function isProtectedAbbreviationPeriod(text, index) {
  return isMultiPeriodAbbreviationPeriod(text, index)
    || isMultiTokenAbbreviationPeriod(text, index)
    || isSingleTokenAbbreviationPeriod(text, index);
}

function isMultiPeriodAbbreviationPeriod(text, index) {
  const lowerText = text.toLocaleLowerCase();
  return MULTI_PERIOD_ABBREVIATIONS.some((abbreviation) => {
    let searchStart = Math.max(0, index - abbreviation.length + 1);
    while (searchStart <= index) {
      const foundAt = lowerText.indexOf(abbreviation, searchStart);
      if (foundAt === -1 || foundAt > index) {
        return false;
      }

      const foundEnd = foundAt + abbreviation.length;
      if (index < foundEnd
        && text.charAt(index) === "."
        && isTokenBoundary(text.charAt(foundAt - 1))
        && shouldProtectAbbreviationAt(text, foundAt, foundEnd, abbreviation)) {
        return true;
      }

      searchStart = foundAt + 1;
    }
    return false;
  });
}

function isMultiTokenAbbreviationPeriod(text, index) {
  const lowerText = text.toLocaleLowerCase();
  return MULTI_TOKEN_ABBREVIATIONS.some((abbreviation) => {
    const start = index - abbreviation.length + 1;
    const end = index + 1;
    return start >= 0
      && lowerText.slice(start, end) === abbreviation
      && isTokenBoundary(text.charAt(start - 1))
      && shouldProtectAbbreviationAt(text, start, end, abbreviation);
  });
}

function isSingleTokenAbbreviationPeriod(text, index) {
  const tokenStart = findTokenStart(text, index - 1);
  const token = text.slice(tokenStart, index).toLocaleLowerCase();
  if (!SINGLE_TOKEN_ABBREVIATIONS.has(token) || !isTokenBoundary(text.charAt(tokenStart - 1))) {
    return false;
  }

  return shouldProtectAbbreviationAt(text, tokenStart, index + 1, `${token}.`);
}

function shouldProtectAbbreviationAt(text, start, end, abbreviation) {
  const nextSignificantIndex = findNextNonSpaceIndex(text, end);
  if (nextSignificantIndex === -1) {
    return false;
  }

  const key = normalizeAbbreviationKey(abbreviation);
  if (key === "fig." || key === "eq." || key === "ref." || key === "sec." || key === "no.") {
    return nextTokenContainsDigit(text, nextSignificantIndex);
  }

  return /[A-Za-z0-9]/.test(text.charAt(nextSignificantIndex));
}

function normalizeAbbreviationKey(abbreviation) {
  return normalizeWhitespace(abbreviation).toLocaleLowerCase();
}

function nextTokenContainsDigit(text, start) {
  for (let index = start; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (/\s/.test(character) || character === "," || character === ")" || character === "]") {
      break;
    }
    if (isAsciiDigit(character)) {
      return true;
    }
  }
  return false;
}

function findTokenStart(text, index) {
  let cursor = index;
  while (cursor >= 0 && /[A-Za-z]/.test(text.charAt(cursor))) {
    cursor -= 1;
  }
  return cursor + 1;
}

function findNextNonSpaceIndex(text, start) {
  for (let index = start; index < text.length; index += 1) {
    if (!/\s/.test(text.charAt(index))) {
      return index;
    }
  }
  return -1;
}

function isTokenBoundary(character) {
  return !character || !/[A-Za-z]/.test(character);
}

function isAsciiDigit(character) {
  return /[0-9]/.test(character);
}

function normalizeWhitespace(text) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function normalizeForLooseCompare(text) {
  return normalizeWhitespace(text).toLocaleLowerCase();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function copyRect(rect) {
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height
  };
}

function showToast(message) {
  let toast = document.getElementById(TOAST_ID);

  if (!toast) {
    toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.style.position = "fixed";
    toast.style.right = "20px";
    toast.style.bottom = "20px";
    toast.style.zIndex = "2147483647";
    toast.style.maxWidth = "280px";
    toast.style.padding = "10px 14px";
    toast.style.borderRadius = "8px";
    toast.style.background = "rgba(24, 24, 27, 0.92)";
    toast.style.color = "#ffffff";
    toast.style.fontSize = "14px";
    toast.style.lineHeight = "1.4";
    toast.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.18)";
    toast.style.pointerEvents = "none";
    toast.style.transition = "opacity 160ms ease";
    document.documentElement.appendChild(toast);
  }

  toast.textContent = message;
  toast.style.opacity = "1";

  window.clearTimeout(showToast.hideTimer);
  showToast.hideTimer = window.setTimeout(() => {
    toast.style.opacity = "0";
  }, 2400);
}
