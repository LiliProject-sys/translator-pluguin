const STORAGE_KEY = "vocabularyEntries";

const entryCountElement = document.getElementById("entryCount");
const emptyStateElement = document.getElementById("emptyState");
const entryListElement = document.getElementById("entryList");
const settingsButton = document.getElementById("settingsButton");

document.addEventListener("DOMContentLoaded", renderEntries);
settingsButton.addEventListener("click", openSettings);

function openSettings() {
  chrome.runtime.openOptionsPage(() => {
    if (chrome.runtime.lastError) {
      console.error("Failed to open extension options page:", chrome.runtime.lastError.message);
    }
  });
}

function renderEntries() {
  readEntries((entries) => {
    const sortedEntries = entries.slice().sort((first, second) => {
      return new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime();
    });

    entryCountElement.textContent = `${sortedEntries.length} 个词条`;
    emptyStateElement.hidden = sortedEntries.length > 0;
    entryListElement.innerHTML = "";

    sortedEntries.forEach((entry) => {
      entryListElement.appendChild(createEntryCard(entry));
    });
  });
}

function createEntryCard(entry) {
  const card = document.createElement("article");
  card.className = "entry-card";

  const word = document.createElement("h2");
  word.className = "entry-word";
  word.textContent = entry.word || "未命名词条";

  const context = document.createElement("p");
  context.className = "entry-context";
  context.textContent = entry.contextSentence || entry.word || "暂无上下文";

  const meta = document.createElement("div");
  meta.className = "entry-meta";

  const pageTitle = document.createElement("span");
  pageTitle.textContent = entry.pageTitle || "未命名页面";

  const createdAt = document.createElement("span");
  createdAt.textContent = formatDate(entry.createdAt);

  meta.append(pageTitle, createdAt);

  const actions = document.createElement("div");
  actions.className = "entry-actions";

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.textContent = "打开来源";
  openButton.addEventListener("click", () => openSource(entry.pageUrl));

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "delete-button";
  deleteButton.textContent = "删除";
  deleteButton.addEventListener("click", () => deleteEntry(entry.id));

  actions.append(openButton, deleteButton);
  card.append(word, context, meta, actions);

  return card;
}

function readEntries(callback) {
  chrome.storage.local.get({ [STORAGE_KEY]: [] }, (result) => {
    if (chrome.runtime.lastError) {
      console.error("Failed to read vocabulary entries:", chrome.runtime.lastError.message);
      callback([]);
      return;
    }

    callback(Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : []);
  });
}

function deleteEntry(entryId) {
  readEntries((entries) => {
    const nextEntries = entries.filter((entry) => entry.id !== entryId);

    chrome.storage.local.set({ [STORAGE_KEY]: nextEntries }, () => {
      if (chrome.runtime.lastError) {
        console.error("Failed to delete vocabulary entry:", chrome.runtime.lastError.message);
        return;
      }

      renderEntries();
    });
  });
}

function openSource(pageUrl) {
  if (!pageUrl) {
    console.error("Cannot open source because pageUrl is empty.");
    return;
  }

  chrome.tabs.create({ url: pageUrl }, () => {
    if (chrome.runtime.lastError) {
      console.error("Failed to open source page:", chrome.runtime.lastError.message);
    }
  });
}

function formatDate(value) {
  if (!value) {
    return "保存时间未知";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "保存时间未知";
  }

  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
