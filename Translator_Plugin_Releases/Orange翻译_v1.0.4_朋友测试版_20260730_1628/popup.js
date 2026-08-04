const STORAGE_KEY = "vocabularyEntries";
const AUTO_TRANSLATE_KEY = "autoTranslateEnabled";

const entryCountElement = document.getElementById("entryCount");
const emptyStateElement = document.getElementById("emptyState");
const settingsButton = document.getElementById("settingsButton");
const openVocabularyButton = document.getElementById("openVocabularyButton");
const autoTranslateToggle = document.getElementById("autoTranslateToggle");
const autoTranslateStatus = document.getElementById("autoTranslateStatus");

let autoTranslateEnabled = true;

document.addEventListener("DOMContentLoaded", () => {
  renderSummary();
  renderAutoTranslateSetting();
});
settingsButton.addEventListener("click", openSettings);
openVocabularyButton.addEventListener("click", openVocabularyBook);
autoTranslateToggle.addEventListener("click", toggleAutoTranslate);

function openSettings() {
  chrome.runtime.openOptionsPage(() => {
    if (chrome.runtime.lastError) {
      console.error("Failed to open extension options page:", chrome.runtime.lastError.message);
    }
  });
}

function openVocabularyBook() {
  chrome.tabs.create({ url: chrome.runtime.getURL("vocabulary.html") }, () => {
    if (chrome.runtime.lastError) {
      console.error("Failed to open vocabulary book:", chrome.runtime.lastError.message);
    }
  });
}

function renderSummary() {
  chrome.storage.local.get({ [STORAGE_KEY]: [] }, (result) => {
    if (chrome.runtime.lastError) {
      console.error("Failed to read vocabulary entries:", chrome.runtime.lastError.message);
      entryCountElement.textContent = "词条数量读取失败";
      emptyStateElement.hidden = false;
      return;
    }

    const entries = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
    entryCountElement.textContent = `${entries.length} 个词条`;
    emptyStateElement.hidden = entries.length > 0;
  });
}

function renderAutoTranslateSetting() {
  chrome.storage.local.get({ [AUTO_TRANSLATE_KEY]: true }, (result) => {
    if (chrome.runtime.lastError) {
      console.error("Failed to read auto translate setting:", chrome.runtime.lastError.message);
      showAutoTranslateStatus("设置读取失败");
      updateAutoTranslateToggle(autoTranslateEnabled);
      return;
    }

    autoTranslateEnabled = getAutoTranslateEnabledFromStorageValue(result[AUTO_TRANSLATE_KEY]);
    updateAutoTranslateToggle(autoTranslateEnabled);
    showAutoTranslateStatus("");
  });
}

function toggleAutoTranslate() {
  const previousValue = autoTranslateEnabled;
  const nextValue = !previousValue;

  autoTranslateToggle.disabled = true;
  showAutoTranslateStatus("");
  updateAutoTranslateToggle(nextValue);

  chrome.storage.local.set({ [AUTO_TRANSLATE_KEY]: nextValue }, () => {
    if (chrome.runtime.lastError) {
      console.error("Failed to save auto translate setting:", chrome.runtime.lastError.message);
      autoTranslateEnabled = previousValue;
      updateAutoTranslateToggle(previousValue);
      showAutoTranslateStatus("保存失败，请重试");
      autoTranslateToggle.disabled = false;
      return;
    }

    autoTranslateEnabled = nextValue;
    updateAutoTranslateToggle(nextValue);
    autoTranslateToggle.disabled = false;
  });
}

function updateAutoTranslateToggle(enabled) {
  autoTranslateToggle.setAttribute("aria-checked", enabled ? "true" : "false");
  autoTranslateToggle.textContent = enabled ? "当前已开启" : "当前已关闭";
}

function showAutoTranslateStatus(message) {
  autoTranslateStatus.textContent = message;
}

function getAutoTranslateEnabledFromStorageValue(value) {
  return value === undefined ? true : value !== false;
}
