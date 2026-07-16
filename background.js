importScripts(
  "md5.js",
  "ai-context-skill.js",
  "sentence-translation-skill.js",
  "baidu-translation-provider.js",
  "deepseek-context-provider.js",
  "gemini-context-provider.js",
  "translation-provider.js"
);

const STORAGE_KEY = "vocabularyEntries";
const RANDOM_ORDER_KEY = "vocabularyRandomOrder";
const CONTEXT_MENU_ID = "add-to-vocabulary";
const SUPPLEMENTAL_FIELDS = ["lemma", "phonetic", "partOfSpeech", "meaning", "contextTranslation"];
const contextTranslationTasks = new Map();

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
    const payload = message.payload || {};
    if (normalizeAnalysisMode(payload.analysisMode) === "detail") {
      console.info("DETAIL_REQUEST_RECEIVED", {
        analysisMode: "detail",
        requestId: normalizeText(payload.requestId),
        selectionId: Number.isFinite(payload.selectionId) ? payload.selectionId : null,
        analysisRequestId: Number.isFinite(payload.analysisRequestId) ? payload.analysisRequestId : null
      });
    }
    handleLanguageRequest(payload, sendResponse);
    return true;
  }

  if (message.type === "CANCEL_LANGUAGE_REQUEST") {
    const requestIds = Array.isArray(message.requestIds)
      ? message.requestIds.map(normalizeText).filter(Boolean)
      : [];
    const cancelledCount = self.languageService && typeof self.languageService.cancelRequests === "function"
      ? self.languageService.cancelRequests(requestIds)
      : 0;
    sendResponse({ status: "ok", cancelledCount });
    return false;
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

  if (message.type === "DELETE_VOCABULARY_ENTRY") {
    deleteVocabularyEntry(normalizeText(message.entryId), sendResponse);
    return true;
  }

  if (message.type === "OPEN_VOCABULARY_SOURCE") {
    openVocabularySource(normalizeText(message.pageUrl), sendResponse);
    return true;
  }

  if (message.type === "GENERATE_VOCABULARY_CONTEXT_TRANSLATION") {
    handleVocabularyContextTranslation(message.entry || {}, sendResponse);
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
    targetLanguage: normalizeText(payload.targetLanguage) || "zh-CN",
    requestType: normalizeRequestType(payload.requestType),
    analysisMode: normalizeAnalysisMode(payload.analysisMode),
    requestId: normalizeText(payload.requestId),
    userQuestion: normalizeText(payload.userQuestion)
  }, { providerOverride }).then((result) => {
    sendResponse({ status: "ok", ...result });
  }).catch((error) => {
    const safeError = normalizeTranslationError(error);
    if (safeError.errorCode === "REQUEST_CANCELLED") {
      sendResponse({
        status: "cancelled",
        message: "请求已取消",
        errorCode: safeError.errorCode
      });
      return;
    }
    const diagnosticLog = {
      code: safeError.errorCode,
      type: safeError.errorType
    };

    if (safeError.diagnostics) {
      Object.assign(diagnosticLog, safeError.diagnostics);
    }
    diagnosticLog.analysisMode = normalizeAnalysisMode(payload && payload.analysisMode);
    diagnosticLog.requestType = normalizeRequestType(payload && payload.requestType);

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
    targetLanguage: "zh-CN",
    requestType: "wordAnalysis",
    analysisMode: "quick"
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
    analysisMode: normalizeAnalysisMode(rawDiagnostics.analysisMode),
    requestId: normalizeText(rawDiagnostics.requestId)
  };
}

function normalizeRequestType(value) {
  return normalizeText(value) === "sentenceTranslation"
    ? "sentenceTranslation"
    : "wordAnalysis";
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
      ...getSupplementalFields(comparableEntry),
      contextSentence: comparableEntry.contextSentence,
      pageTitle: comparableEntry.pageTitle,
      pageUrl: comparableEntry.pageUrl,
      createdAt: new Date().toISOString()
    };

    const matchStatus = getVocabularyMatchStatus(entries, entry);

    if (matchStatus.exactEntryExists) {
      const mergeResult = mergeMissingVocabularyFields(entries, matchStatus.exactEntryIndex, entry);
      if (mergeResult.changed) {
        chrome.storage.local.set({ [STORAGE_KEY]: mergeResult.entries }, () => {
          if (chrome.runtime.lastError) {
            handleSaveError(saveOptions, chrome.runtime.lastError.message);
            return;
          }

          handleDuplicateSave(saveOptions, mergeResult.entries[matchStatus.exactEntryIndex]);
        });
        return;
      }

      handleDuplicateSave(saveOptions, entries[matchStatus.exactEntryIndex]);
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
          message: "已加入",
          entryId: entry.id,
          hasContextTranslation: !!entry.contextTranslation
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
    ...getSupplementalFields(rawEntry),
    contextSentence: normalizeText(rawEntry && rawEntry.contextSentence) || word,
    pageTitle: normalizeText(rawEntry && rawEntry.pageTitle) || "未命名页面",
    pageUrl: normalizeText(rawEntry && rawEntry.pageUrl)
  };
}

function getSupplementalFields(rawEntry) {
  return SUPPLEMENTAL_FIELDS.reduce((fields, field) => {
    const value = normalizeText(rawEntry && rawEntry[field]);
    if (value) {
      fields[field] = value;
    }
    return fields;
  }, {});
}

function mergeMissingVocabularyFields(entries, entryIndex, candidate) {
  if (!Number.isInteger(entryIndex) || entryIndex < 0 || entryIndex >= entries.length) {
    return { changed: false, entries };
  }

  const existingEntry = entries[entryIndex] || {};
  const updates = {};

  SUPPLEMENTAL_FIELDS.forEach((field) => {
    const existingValue = normalizeText(existingEntry[field]);
    const candidateValue = normalizeText(candidate[field]);
    if (!existingValue && candidateValue) {
      updates[field] = candidateValue;
    }
  });

  if (Object.keys(updates).length === 0) {
    return { changed: false, entries };
  }

  const nextEntries = entries.slice();
  nextEntries[entryIndex] = {
    ...existingEntry,
    ...updates
  };

  return { changed: true, entries: nextEntries };
}

function handleDuplicateSave(saveOptions, existingEntry) {
  if (saveOptions.showToast) {
    showPageNotice(saveOptions.tabId, "该词已保存");
  }
  if (saveOptions.callback) {
    saveOptions.callback({
      status: "duplicate",
      message: "已保存",
      entryId: existingEntry && existingEntry.id ? existingEntry.id : "",
      hasContextTranslation: !!(existingEntry && normalizeText(existingEntry.contextTranslation))
    });
  }
}

function getVocabularyMatchStatus(entries, candidate) {
  const candidateWordKey = normalizeWordForMatch(candidate.word);
  let wordExists = false;
  let exactEntryExists = false;
  let exactEntryIndex = -1;

  entries.forEach((existingEntry, index) => {
    if (normalizeWordForMatch(existingEntry && existingEntry.word) === candidateWordKey) {
      wordExists = true;
    }

    if (!exactEntryExists
      && existingEntry
      && existingEntry.word === candidate.word
      && existingEntry.contextSentence === candidate.contextSentence
      && existingEntry.pageUrl === candidate.pageUrl) {
      exactEntryExists = true;
      exactEntryIndex = index;
    }
  });

  return {
    wordExists,
    exactEntryExists,
    exactEntryIndex
  };
}

function deleteVocabularyEntry(entryId, sendResponse) {
  if (!entryId) {
    sendResponse({ status: "error", message: "删除失败" });
    return;
  }

  readEntries((entries, readError) => {
    if (readError) {
      sendResponse({ status: "error", message: "删除失败" });
      return;
    }

    const nextEntries = entries.filter((entry) => entry && entry.id !== entryId);
    chrome.storage.local.set({ [STORAGE_KEY]: nextEntries }, () => {
      if (chrome.runtime.lastError) {
        console.error("Failed to delete vocabulary entry:", chrome.runtime.lastError.message);
        sendResponse({ status: "error", message: "删除失败" });
        return;
      }

      removeEntryFromRandomOrder(entryId, () => {
        sendResponse({ status: "ok" });
      });
    });
  });
}

function removeEntryFromRandomOrder(entryId, callback) {
  if (!chrome.storage.session) {
    callback();
    return;
  }

  chrome.storage.session.get({ [RANDOM_ORDER_KEY]: [] }, (result) => {
    if (chrome.runtime.lastError) {
      console.error("Failed to read vocabulary random order:", chrome.runtime.lastError.message);
      callback();
      return;
    }

    const currentOrder = Array.isArray(result[RANDOM_ORDER_KEY]) ? result[RANDOM_ORDER_KEY] : [];
    const nextOrder = currentOrder.filter((id) => id !== entryId);
    chrome.storage.session.set({ [RANDOM_ORDER_KEY]: nextOrder }, () => {
      if (chrome.runtime.lastError) {
        console.error("Failed to update vocabulary random order:", chrome.runtime.lastError.message);
      }
      callback();
    });
  });
}

function openVocabularySource(pageUrl, sendResponse) {
  const url = normalizeSourceUrl(pageUrl);
  if (!url) {
    sendResponse({ status: "error", message: "来源地址无效" });
    return;
  }

  chrome.tabs.create({ url }, () => {
    if (chrome.runtime.lastError) {
      console.error("Failed to open source page:", chrome.runtime.lastError.message);
      sendResponse({ status: "error", message: "无法打开来源" });
      return;
    }

    sendResponse({ status: "ok" });
  });
}

async function handleVocabularyContextTranslation(rawEntry, sendResponse) {
  try {
    const result = await generateVocabularyContextTranslation(rawEntry);
    sendResponse(result);
  } catch (error) {
    const safeError = normalizeTranslationError(error);
    console.error("Failed to generate vocabulary context translation:", {
      code: safeError.errorCode,
      type: safeError.errorType
    });
    sendResponse({
      status: "error",
      message: "语境翻译失败",
      errorCode: safeError.errorCode
    });
  }
}

async function generateVocabularyContextTranslation(rawEntry) {
  const entryId = normalizeText(rawEntry && rawEntry.entryId);
  const contextSentence = normalizeText(rawEntry && rawEntry.contextSentence);
  const pageUrl = normalizeText(rawEntry && rawEntry.pageUrl);
  const word = normalizeText(rawEntry && rawEntry.word);

  if (!entryId || !shouldTranslateVocabularyContext(word, contextSentence)) {
    return { status: "skipped", reason: "not_needed" };
  }

  const entries = await readEntriesAsync();
  const targetEntry = entries.find((entry) => entry && entry.id === entryId);
  if (!targetEntry || normalizeText(targetEntry.contextTranslation)) {
    return { status: "skipped", reason: "entry_missing_or_translated" };
  }

  const contextKey = createVocabularyContextKey(pageUrl || targetEntry.pageUrl, contextSentence || targetEntry.contextSentence);
  if (!contextKey) {
    return { status: "skipped", reason: "invalid_context" };
  }

  const existingTranslation = await findExistingContextTranslation(contextKey);
  if (existingTranslation) {
    const updatedCount = await writeContextTranslationForMatchingEntries(contextKey, existingTranslation);
    return {
      status: "ok",
      reused: true,
      updatedCount,
      contextTranslation: existingTranslation
    };
  }

  if (contextTranslationTasks.has(contextKey)) {
    return contextTranslationTasks.get(contextKey);
  }

  const task = runVocabularyContextTranslationTask(contextKey, contextSentence || targetEntry.contextSentence)
    .finally(() => {
      contextTranslationTasks.delete(contextKey);
    });
  contextTranslationTasks.set(contextKey, task);
  return task;
}

async function runVocabularyContextTranslationTask(contextKey, contextSentence) {
  if (!self.languageService || typeof self.languageService.process !== "function") {
    throw createRuntimeError("LANGUAGE_SERVICE_UNAVAILABLE", "Language service is unavailable.");
  }

  const result = await self.languageService.process({
    text: contextSentence,
    contextSentence,
    pageTitle: "Vocabulary Context Translation",
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    requestType: "sentenceTranslation",
    analysisMode: "quick",
    requestId: `vocabulary-context-${Date.now()}-${Math.random().toString(16).slice(2)}`
  });
  const translation = extractContextTranslationText(result);
  if (!translation) {
    throw createRuntimeError("EMPTY_CONTEXT_TRANSLATION", "Language provider returned empty context translation.");
  }

  const updatedCount = await writeContextTranslationForMatchingEntries(contextKey, translation);
  return {
    status: "ok",
    reused: false,
    updatedCount,
    contextTranslation: translation
  };
}

function extractContextTranslationText(result) {
  if (!result || typeof result !== "object") {
    return "";
  }
  if (result.resultType === "sentenceTranslation") {
    return normalizeText(result.translation);
  }
  if (result.resultType === "quickTranslation") {
    return normalizeText(result.translatedText);
  }
  return "";
}

async function findExistingContextTranslation(contextKey) {
  const entries = await readEntriesAsync();
  const match = entries.find((entry) => {
    return entry
      && createVocabularyContextKey(entry.pageUrl, entry.contextSentence) === contextKey
      && normalizeText(entry.contextTranslation);
  });
  return match ? normalizeText(match.contextTranslation) : "";
}

async function writeContextTranslationForMatchingEntries(contextKey, translation) {
  const normalizedTranslation = normalizeText(translation);
  if (!contextKey || !normalizedTranslation) {
    return 0;
  }

  const entries = await readEntriesAsync();
  let updatedCount = 0;
  const nextEntries = entries.map((entry) => {
    if (!entry
      || createVocabularyContextKey(entry.pageUrl, entry.contextSentence) !== contextKey
      || normalizeText(entry.contextTranslation)) {
      return entry;
    }

    updatedCount += 1;
    return {
      ...entry,
      contextTranslation: normalizedTranslation
    };
  });

  if (updatedCount > 0) {
    await writeEntriesAsync(nextEntries);
  }

  return updatedCount;
}

function shouldTranslateVocabularyContext(word, contextSentence) {
  const normalizedWord = normalizeWordForMatch(word);
  const normalizedContext = normalizeWordForMatch(contextSentence);
  if (!normalizedContext) {
    return false;
  }

  const hasSentenceBoundary = /[.?!;]/.test(contextSentence);
  const wordCount = normalizedContext.split(/\s+/).filter(Boolean).length;
  if (normalizedWord && normalizedWord === normalizedContext && wordCount <= 3 && !hasSentenceBoundary) {
    return false;
  }

  return true;
}

function createVocabularyContextKey(pageUrl, contextSentence) {
  const normalizedContext = normalizeWordForMatch(contextSentence);
  if (!normalizedContext) {
    return "";
  }
  return `${normalizeText(pageUrl)}\n${normalizedContext}`;
}

function readEntriesAsync() {
  return new Promise((resolve, reject) => {
    readEntries((entries, readError) => {
      if (readError) {
        reject(createRuntimeError("STORAGE_READ_FAILED", readError));
        return;
      }
      resolve(entries);
    });
  });
}

function writeEntriesAsync(entries) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEY]: entries }, () => {
      if (chrome.runtime.lastError) {
        reject(createRuntimeError("STORAGE_WRITE_FAILED", chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function createRuntimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.publicMessage = "语境翻译失败";
  return error;
}

function normalizeSourceUrl(pageUrl) {
  try {
    const url = new URL(normalizeText(pageUrl));
    const allowedProtocols = new Set(["http:", "https:", "file:", "chrome-extension:"]);
    return allowedProtocols.has(url.protocol) ? url.href : "";
  } catch (error) {
    return "";
  }
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

function normalizeAnalysisMode(value) {
  return normalizeText(value).toLocaleLowerCase() === "detail" ? "detail" : "quick";
}

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
