const STORAGE_KEY = "vocabularyEntries";

const entryCountElement = document.getElementById("entryCount");
const emptyStateElement = document.getElementById("emptyState");
const settingsButton = document.getElementById("settingsButton");
const openVocabularyButton = document.getElementById("openVocabularyButton");

document.addEventListener("DOMContentLoaded", renderSummary);
settingsButton.addEventListener("click", openSettings);
openVocabularyButton.addEventListener("click", openVocabularyBook);

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
