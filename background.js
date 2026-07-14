importScripts(
  "md5.js",
  "ai-context-skill.js",
  "baidu-translation-provider.js",
  "deepseek-context-provider.js",
  "gemini-context-provider.js",
  "translation-provider.js"
);

const STORAGE_KEY = "vocabularyEntries";
const CONTEXT_MENU_ID = "add-to-vocabulary";

chrome.runtime.onInstalled.addListener(createContextMenu);
chrome.runtime.onStartup.addListener(createContextMenu);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.translationSettings) {
    return;
  }

  if (self.baiduTranslationProvider && typeof self.baiduTranslationProvider.reset === "function") {
    self.baiduTranslationProvider.reset();
  }

  if (self.geminiContextProvider && typeof self.geminiContextProvider.reset === "function") {
    self.geminiContextProvider.reset();
  }

  if (self.deepSeekContextProvider && typeof self.deepSeekContextProvider.reset === "function") {
    self.deepSeekContextProvider.reset();
  }
});

function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) {
      console.error("Failed to clear context menus:", chrome.runtime.lastError.message);
    }

    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "加入生词本",
      contexts: ["selection"]
    }, () => {
      if (chrome.runtime.lastError) {
        console.error("Failed to create context menu:", chrome.runtime.lastError.message);
      }
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab || !tab.id) {
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "GET_SELECTION_CONTEXT" }, (selectionData) => {
    if (chrome.runtime.lastError) {
      console.error("Failed to read selection from content script:", chrome.runtime.lastError.message);
      const fallbackWord = (info.selectionText || "").trim();

      if (!fallbackWord) {
        return;
      }

      saveVocabularyEntry({
        word: fallbackWord,
        contextSentence: fallbackWord,
        pageTitle: tab.title || "未命名页面",
        pageUrl: tab.url || ""
      }, { tabId: tab.id, showToast: true });
      return;
    }

    const word = (selectionData && selectionData.word ? selectionData.word : info.selectionText || "").trim();

    if (!word) {
      return;
    }

    saveVocabularyEntry({
      word,
      contextSentence: normalizeText(selectionData && selectionData.contextSentence) || word,
      pageTitle: normalizeText(selectionData && selectionData.pageTitle) || tab.title || "未命名页面",
      pageUrl: normalizeText(selectionData && selectionData.pageUrl) || tab.url || ""
    }, { tabId: tab.id, showToast: true });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "CHECK_VOCABULARY_STATUS") {
    const candidate = createComparableEntry(message.entry || {});

    if (!candidate.word) {
      sendResponse({
        status: "error",
        message: "状态检查失败"
      });
      return false;
    }

    readEntries((entries, readError) => {
      if (readError) {
        sendResponse({
          status: "error",
          message: "状态检查失败"
        });
        return;
      }

      const matchStatus = getVocabularyMatchStatus(entries, candidate);
      sendResponse({
        status: "ok",
        wordExists: matchStatus.wordExists,
        exactEntryExists: matchStatus.exactEntryExists
      });
    });

    return true;
  }

  if (message.type === "TRANSLATE_TEXT") {
    handleLanguageRequest(message.payload || {}, sendResponse);
    return true;
  }

  if (message.type === "GET_ACTIVE_LANGUAGE_MODE") {
    handleActiveLanguageModeRequest(sendResponse);
    return true;
  }

  if (message.type === "TEST_LANGUAGE_PROVIDER") {
    const providerId = normalizeText(message.provider);
    handleLanguageRequest(createProviderTestPayload(providerId), sendResponse, providerId);
    return true;
  }

  if (message.type === "TEST_TRANSLATION_CONNECTION") {
    handleLanguageRequest(createProviderTestPayload(""), sendResponse);
    return true;
  }

  if (message.type === "OPEN_OPTIONS_PAGE") {
    chrome.runtime.openOptionsPage(() => {
      if (chrome.runtime.lastError) {
        console.error("Failed to open extension options page:", chrome.runtime.lastError.message);
        sendResponse({ status: "error", message: "无法打开插件设置" });
        return;
      }

      sendResponse({ status: "ok" });
    });
    return true;
  }

  if (message.type !== "SAVE_VOCABULARY_ENTRY") {
    return false;
  }

  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  const entry = createComparableEntry(message.entry || {});

  if (!entry.word) {
    sendResponse({
      status: "error",
      message: "保存失败"
    });
    return false;
  }

  saveVocabularyEntry(entry, {
    tabId,
    showToast: false,
    callback: sendResponse
  });

  return true;
});

function handleLanguageRequest(payload, sendResponse, providerOverride) {
  const text = normalizeText(payload && payload.text);

  if (!text) {
    sendResponse({
      status: "error",
      message: "处理失败"
    });
    return;
  }

  if (!self.languageService || typeof self.languageService.process !== "function") {
    console.error("Language service is unavailable.");
    sendResponse({
      status: "error",
      message: "处理失败"
    });
    return;
  }

  self.languageService.process({
    text,
    contextSentence: normalizeText(payload.contextSentence),
    pageTitle: normalizeText(payload.pageTitle),
    sourceLanguage: normalizeText(payload.sourceLanguage) || "en",
    targetLanguage: normalizeText(payload.targetLanguage) || "zh-CN"
  }, { providerOverride }).then((result) => {
    sendResponse({ status: "ok", ...result });
  }).catch((error) => {
    const safeError = normalizeTranslationError(error);
    const diagnosticLog = {
      code: safeError.errorCode,
      type: safeError.errorType
    };

    if (safeError.diagnostics) {
      Object.assign(diagnosticLog, safeError.diagnostics);
    }

    console.error("Language request failed:", diagnosticLog);
    sendResponse({
      status: "error",
      message: safeError.message,
      errorCode: safeError.errorCode,
      requiresConfiguration: safeError.requiresConfiguration
    });
  });
}

function handleActiveLanguageModeRequest(sendResponse) {
  if (!self.languageService || typeof self.languageService.getActiveModeInfo !== "function") {
    sendResponse({ status: "error", message: "无法读取当前处理模式" });
    return;
  }

  self.languageService.getActiveModeInfo().then((modeInfo) => {
    sendResponse({
      status: "ok",
      provider: modeInfo.provider,
      resultType: modeInfo.resultType
    });
  }).catch((error) => {
    const safeError = normalizeTranslationError(error);
    console.error("Failed to read active language mode:", {
      code: safeError.errorCode,
      type: safeError.errorType
    });
    sendResponse({ status: "error", message: safeError.message });
  });
}

function createProviderTestPayload(providerId) {
  const isContextAnalysis = providerId === "gemini" || providerId === "deepseek";
  return {
    text: isContextAnalysis ? "employed" : "apple",
    contextSentence: isContextAnalysis
      ? "The company employed more than two hundred engineers last year."
      : "I ate an apple after lunch.",
    pageTitle: "Translator-plugin Provider Test",
    sourceLanguage: "en",
    targetLanguage: "zh-CN"
  };
}

function normalizeTranslationError(error) {
  const publicMessage = normalizeText(error && error.publicMessage);
  const errorCode = normalizeText(error && error.code) || "UNKNOWN_ERROR";
  const errorType = normalizeText(error && error.name) || "Error";

  return {
    message: publicMessage || "处理失败，请稍后重试",
    errorCode,
    errorType,
    requiresConfiguration: !!(error && error.requiresConfiguration),
    diagnostics: normalizeErrorDiagnostics(error && error.diagnostics)
  };
}

function normalizeErrorDiagnostics(rawDiagnostics) {
  if (!rawDiagnostics || typeof rawDiagnostics !== "object") {
    return null;
  }

  return {
    provider: normalizeText(rawDiagnostics.provider) || "unknown",
    httpStatus: Number.isFinite(rawDiagnostics.httpStatus) ? rawDiagnostics.httpStatus : 0,
    apiStatus: normalizeText(rawDiagnostics.apiStatus),
    apiMessage: normalizeText(rawDiagnostics.apiMessage),
    requestId: normalizeText(rawDiagnostics.requestId)
  };
}

function saveVocabularyEntry(rawEntry, options) {
  const saveOptions = options || {};

  readEntries((entries, readError) => {
    if (readError) {
      handleSaveError(saveOptions, "Failed to read vocabulary entries before saving.");
      return;
    }

    const comparableEntry = createComparableEntry(rawEntry);
    const entry = {
      id: createId(),
      word: comparableEntry.word,
      contextSentence: comparableEntry.contextSentence,
      pageTitle: comparableEntry.pageTitle,
      pageUrl: comparableEntry.pageUrl,
      createdAt: new Date().toISOString()
    };

    const matchStatus = getVocabularyMatchStatus(entries, entry);

    if (matchStatus.exactEntryExists) {
      if (saveOptions.showToast) {
        showPageNotice(saveOptions.tabId, "该词已保存");
      }
      if (saveOptions.callback) {
        saveOptions.callback({
          status: "duplicate",
          message: "已保存"
        });
      }
      return;
    }

    const nextEntries = [entry, ...entries];

    chrome.storage.local.set({ [STORAGE_KEY]: nextEntries }, () => {
      if (chrome.runtime.lastError) {
        handleSaveError(saveOptions, chrome.runtime.lastError.message);
        return;
      }

      if (saveOptions.showToast) {
        showPageNotice(saveOptions.tabId, "已加入生词本");
      }
      if (saveOptions.callback) {
        saveOptions.callback({
          status: "saved",
          message: "已加入"
        });
      }
    });
  });
}

function readEntries(callback) {
  chrome.storage.local.get({ [STORAGE_KEY]: [] }, (result) => {
    if (chrome.runtime.lastError) {
      console.error("Failed to read vocabulary entries:", chrome.runtime.lastError.message);
      callback([], chrome.runtime.lastError.message);
      return;
    }

    const entries = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
    callback(entries, null);
  });
}

function createComparableEntry(rawEntry) {
  const word = normalizeText(rawEntry && rawEntry.word);

  return {
    word,
    contextSentence: normalizeText(rawEntry && rawEntry.contextSentence) || word,
    pageTitle: normalizeText(rawEntry && rawEntry.pageTitle) || "未命名页面",
    pageUrl: normalizeText(rawEntry && rawEntry.pageUrl)
  };
}

function getVocabularyMatchStatus(entries, candidate) {
  const candidateWordKey = normalizeWordForMatch(candidate.word);
  let wordExists = false;
  let exactEntryExists = false;

  entries.forEach((existingEntry) => {
    if (normalizeWordForMatch(existingEntry && existingEntry.word) === candidateWordKey) {
      wordExists = true;
    }

    if (existingEntry
      && existingEntry.word === candidate.word
      && existingEntry.contextSentence === candidate.contextSentence
      && existingEntry.pageUrl === candidate.pageUrl) {
      exactEntryExists = true;
    }
  });

  return {
    wordExists,
    exactEntryExists
  };
}

function normalizeWordForMatch(value) {
  return normalizeText(value).replace(/\s+/g, " ").toLocaleLowerCase();
}

function handleSaveError(saveOptions, errorMessage) {
  console.error("Failed to save vocabulary entry:", errorMessage);

  if (saveOptions.showToast) {
    showPageNotice(saveOptions.tabId, "保存失败，请查看控制台");
  }

  if (saveOptions.callback) {
    saveOptions.callback({
      status: "error",
      message: "保存失败"
    });
  }
}

function showPageNotice(tabId, message) {
  if (!tabId) {
    return;
  }

  chrome.tabs.sendMessage(tabId, {
    type: "SHOW_VOCABULARY_NOTICE",
    message
  }, () => {
    if (chrome.runtime.lastError) {
      console.error("Failed to show page notice:", chrome.runtime.lastError.message);
    }
  });
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
