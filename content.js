const SENTENCE_BOUNDARY_PATTERN = /[.?!;]/;
const TOAST_ID = "web-vocabulary-collector-toast";
const FLOATING_PANEL_ID = "translator-plugin-selection-panel";
const FLOATING_PANEL_STYLE_ID = "translator-plugin-selection-panel-style";
const FLOATING_PANEL_MARGIN = 10;

let currentSelectionSnapshot = null;
let currentSelectionRect = null;
let selectionPanel = null;
let mouseupTimer = null;
let panelPointerDown = false;
let selectionRequestId = 0;

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

document.addEventListener("mouseup", () => {
  window.clearTimeout(mouseupTimer);
  mouseupTimer = window.setTimeout(showPanelForCurrentSelection, 80);
});

document.addEventListener("mousedown", (event) => {
  if (selectionPanel && !selectionPanel.contains(event.target)) {
    closeSelectionPanel();
  }
}, true);

document.addEventListener("selectionchange", () => {
  if (panelPointerDown) {
    return;
  }

  const selectedText = window.getSelection() ? window.getSelection().toString().trim() : "";

  if (!selectedText) {
    closeSelectionPanel();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSelectionPanel();
  }
});

window.addEventListener("scroll", closeSelectionPanel, true);
window.addEventListener("resize", closeSelectionPanel);

function showPanelForCurrentSelection() {
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

  currentSelectionSnapshot = getSelectionContext();
  currentSelectionRect = copyRect(rect);
  const requestId = ++selectionRequestId;
  createOrUpdateSelectionPanel(currentSelectionSnapshot.word);
  positionSelectionPanel(currentSelectionRect);
  checkCurrentSelectionStatus(requestId);
  updateLanguageLoadingLabel(requestId);
  requestTranslation(requestId);
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
    selectionPanel.addEventListener("click", (event) => {
      event.stopPropagation();
      window.setTimeout(() => {
        panelPointerDown = false;
      }, 0);
    });
    document.documentElement.appendChild(selectionPanel);
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

function checkCurrentSelectionStatus(requestId) {
  const snapshot = currentSelectionSnapshot;

  chrome.runtime.sendMessage({
    type: "CHECK_VOCABULARY_STATUS",
    entry: snapshot
  }, (response) => {
    const runtimeError = chrome.runtime.lastError;

    if (requestId !== selectionRequestId || !selectionPanel || snapshot !== currentSelectionSnapshot) {
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

function requestTranslation(requestId) {
  const snapshot = currentSelectionSnapshot;

  setLanguageLoadingState("正在处理…", true);

  chrome.runtime.sendMessage({
    type: "TRANSLATE_TEXT",
    payload: {
      text: snapshot && snapshot.word,
      contextSentence: snapshot && snapshot.contextSentence,
      pageTitle: snapshot && snapshot.pageTitle,
      sourceLanguage: "en",
      targetLanguage: "zh-CN"
    }
  }, (response) => {
    const runtimeError = chrome.runtime.lastError;

    if (requestId !== selectionRequestId || !selectionPanel || snapshot !== currentSelectionSnapshot) {
      return;
    }

    if (runtimeError) {
      console.error("Failed to process selected text:", runtimeError.message);
      renderLanguageResult({ errorMessage: "处理失败，请稍后重试" }, requestId);
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
      }, requestId);
      return;
    }

    renderLanguageResult(response, requestId);
  });
}

function updateLanguageLoadingLabel(requestId) {
  chrome.runtime.sendMessage({ type: "GET_ACTIVE_LANGUAGE_MODE" }, (response) => {
    if (requestId !== selectionRequestId || !selectionPanel) {
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

  translationElement.classList.remove("is-error", "is-analysis");
  translationElement.classList.add("is-loading");
  translationElement.textContent = message;
}

function renderLanguageResult(result, requestId) {
  if (!selectionPanel) {
    return;
  }

  const translationElement = selectionPanel.querySelector(".translator-plugin-panel-translation");

  if (!translationElement) {
    return;
  }

  translationElement.classList.remove("is-loading", "is-error", "is-analysis");
  translationElement.innerHTML = "";

  if (result && result.resultType === "contextAnalysis" && result.analysis) {
    renderContextAnalysis(translationElement, result.analysis);
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
    retryButton.addEventListener("click", () => requestTranslation(requestId));
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

  if (currentSelectionRect) {
    positionSelectionPanel(currentSelectionRect);
  }
}

function renderContextAnalysis(container, analysis) {
  container.classList.add("is-analysis");
  const rows = [
    ["单词", analysis.lemma],
    ["音标", analysis.phonetic],
    ["词性", analysis.partOfSpeech],
    ["常见含义", analysis.commonMeaning],
    ["论文中含义", analysis.contextualMeaning]
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

  if (currentSelectionRect) {
    positionSelectionPanel(currentSelectionRect);
  }
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
  selectionPanel.style.display = "block";

  const panelRect = selectionPanel.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const scrollX = window.scrollX || window.pageXOffset;
  const scrollY = window.scrollY || window.pageYOffset;

  let left = selectionRect.left + (selectionRect.width / 2) - (panelRect.width / 2);
  left = clamp(left, FLOATING_PANEL_MARGIN, viewportWidth - panelRect.width - FLOATING_PANEL_MARGIN);

  const spaceAbove = selectionRect.top;
  const spaceBelow = viewportHeight - selectionRect.bottom;
  let top;

  if (spaceAbove >= panelRect.height + FLOATING_PANEL_MARGIN) {
    top = selectionRect.top - panelRect.height - FLOATING_PANEL_MARGIN;
  } else if (spaceBelow >= panelRect.height + FLOATING_PANEL_MARGIN) {
    top = selectionRect.bottom + FLOATING_PANEL_MARGIN;
  } else {
    top = clamp(selectionRect.top - panelRect.height - FLOATING_PANEL_MARGIN, FLOATING_PANEL_MARGIN, viewportHeight - panelRect.height - FLOATING_PANEL_MARGIN);
  }

  selectionPanel.style.left = `${Math.round(left + scrollX)}px`;
  selectionPanel.style.top = `${Math.round(top + scrollY)}px`;
  selectionPanel.style.visibility = "visible";
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

  chrome.runtime.sendMessage({
    type: "SAVE_VOCABULARY_ENTRY",
    entry: currentSelectionSnapshot
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
    updatePanelStatus(button, message, false);
  });
}

function updatePanelStatus(button, message, isError) {
  button.textContent = message;
  button.classList.toggle("is-error", !!isError);

  window.setTimeout(() => {
    closeSelectionPanel();
  }, isError ? 1400 : 900);
}

function closeSelectionPanel() {
  selectionRequestId += 1;
  currentSelectionSnapshot = null;
  currentSelectionRect = null;
  panelPointerDown = false;

  if (selectionPanel) {
    selectionPanel.remove();
    selectionPanel = null;
  }
}

function injectSelectionPanelStyles() {
  if (document.getElementById(FLOATING_PANEL_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = FLOATING_PANEL_STYLE_ID;
  style.textContent = `
    #${FLOATING_PANEL_ID}.translator-plugin-panel {
      position: absolute;
      z-index: 2147483000;
      width: max-content;
      max-width: min(340px, calc(100vw - 20px));
      max-height: calc(100vh - 20px);
      overflow-y: auto;
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
      max-width: 300px;
      margin: 0 0 8px;
      overflow: hidden;
      color: #1f2937;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-panel-translation {
      max-width: 300px;
      margin: 0 0 8px;
      padding: 7px 8px;
      border-left: 3px solid #60a5fa;
      border-radius: 4px;
      color: #1f2937;
      background: #f8fafc;
      font-size: 13px;
      line-height: 1.5;
      overflow-wrap: anywhere;
      white-space: normal;
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

    #${FLOATING_PANEL_ID} .translator-plugin-analysis-label {
      color: #64748b;
      font-size: 12px;
      font-weight: 600;
    }

    #${FLOATING_PANEL_ID} .translator-plugin-analysis-value {
      min-width: 0;
      color: #1f2937;
      overflow-wrap: anywhere;
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

    #${FLOATING_PANEL_ID} .translator-plugin-panel-status {
      max-width: 300px;
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

  while (sentenceStart > 0 && !SENTENCE_BOUNDARY_PATTERN.test(cleanText.charAt(sentenceStart - 1))) {
    sentenceStart -= 1;
  }

  while (sentenceEnd < cleanText.length && !SENTENCE_BOUNDARY_PATTERN.test(cleanText.charAt(sentenceEnd))) {
    sentenceEnd += 1;
  }

  if (sentenceEnd < cleanText.length && SENTENCE_BOUNDARY_PATTERN.test(cleanText.charAt(sentenceEnd))) {
    sentenceEnd += 1;
  }

  const sentence = cleanText.slice(sentenceStart, sentenceEnd).trim();
  return sentence || cleanText.slice(Math.max(0, safeStart - 120), Math.min(cleanText.length, safeEnd + 120)).trim();
}

function normalizeWhitespace(text) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
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
