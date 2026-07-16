const VOCABULARY_STORAGE_KEY = "vocabularyEntries";
const SORT_MODE_KEY = "vocabularySortMode";
const RANDOM_ORDER_KEY = "vocabularyRandomOrder";
const SORT_MODES = new Set(["random", "recent", "alphabetical"]);

let allEntries = [];
let sortMode = "random";
let randomOrder = [];
let searchTerm = "";

const entryCountElement = document.getElementById("entryCount");
const emptyStateElement = document.getElementById("emptyState");
const entryListElement = document.getElementById("entryList");
const searchInput = document.getElementById("searchInput");
const sortSelect = document.getElementById("sortSelect");
const reshuffleButton = document.getElementById("reshuffleButton");
const settingsButton = document.getElementById("settingsButton");

document.addEventListener("DOMContentLoaded", initializeVocabularyBook);

function initializeVocabularyBook() {
  searchInput.addEventListener("input", () => {
    searchTerm = searchInput.value.trim();
    renderVocabulary();
  });

  sortSelect.addEventListener("change", () => {
    setSortMode(sortSelect.value);
  });

  reshuffleButton.addEventListener("click", reshuffleRandomOrder);
  settingsButton.addEventListener("click", openSettings);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && (changes[VOCABULARY_STORAGE_KEY] || changes[SORT_MODE_KEY])) {
      loadVocabularyState();
      return;
    }

    if (areaName === "session" && changes[RANDOM_ORDER_KEY]) {
      randomOrder = Array.isArray(changes[RANDOM_ORDER_KEY].newValue)
        ? changes[RANDOM_ORDER_KEY].newValue
        : [];
      renderVocabulary();
    }
  });

  loadVocabularyState();
}

async function loadVocabularyState() {
  try {
    const localState = await getLocalState({
      [VOCABULARY_STORAGE_KEY]: [],
      [SORT_MODE_KEY]: "random"
    });
    allEntries = Array.isArray(localState[VOCABULARY_STORAGE_KEY])
      ? localState[VOCABULARY_STORAGE_KEY]
      : [];
    sortMode = normalizeSortMode(localState[SORT_MODE_KEY]);
    sortSelect.value = sortMode;
    randomOrder = await reconcileRandomOrder(allEntries);
    renderVocabulary();
  } catch (error) {
    console.error("Failed to load vocabulary book:", error);
    allEntries = [];
    renderVocabulary();
  }
}

function renderVocabulary() {
  const entries = getVisibleEntries(allEntries, sortMode, randomOrder, searchTerm);
  entryCountElement.textContent = `${entries.length} / ${allEntries.length} 个词条`;
  emptyStateElement.hidden = allEntries.length > 0;
  entryListElement.innerHTML = "";
  reshuffleButton.disabled = sortMode !== "random";

  entries.forEach((entry) => {
    entryListElement.appendChild(createEntryCard(entry));
  });
}

function createEntryCard(entry) {
  const card = document.createElement("article");
  card.className = "entry-card";

  const word = document.createElement("h2");
  word.className = "entry-word";
  word.textContent = formatEntryTitle(entry);
  card.appendChild(word);

  const facts = createFacts(entry);
  if (facts) {
    card.appendChild(facts);
  }

  const context = document.createElement("p");
  context.className = "entry-context";
  context.appendChild(createHighlightedContextFragment(entry.contextSentence || entry.word || "", entry.word || ""));
  card.appendChild(context);

  const contextTranslation = normalizeText(entry.contextTranslation);
  if (contextTranslation) {
    const translation = document.createElement("p");
    translation.className = "entry-context-translation";
    const label = document.createElement("span");
    label.className = "entry-context-translation-label";
    label.textContent = "译";
    translation.appendChild(label);
    translation.appendChild(document.createTextNode(contextTranslation));
    card.appendChild(translation);
  }

  const meta = document.createElement("div");
  meta.className = "entry-meta";
  appendText(meta, entry.pageTitle || "未命名页面");
  appendText(meta, formatDate(entry.createdAt));
  card.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "entry-actions";

  if (isAllowedSourceUrl(entry.pageUrl)) {
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.textContent = "打开来源";
    openButton.addEventListener("click", () => openSource(entry.pageUrl));
    actions.appendChild(openButton);
  }

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "delete-button";
  deleteButton.textContent = "删除";
  deleteButton.addEventListener("click", () => deleteEntry(entry.id));
  actions.appendChild(deleteButton);

  card.appendChild(actions);
  return card;
}

function createFacts(entry) {
  const facts = [
    normalizeText(entry.phonetic),
    normalizeText(entry.partOfSpeech),
    normalizeText(entry.meaning)
  ].filter(Boolean);

  if (facts.length === 0) {
    return null;
  }

  const container = document.createElement("div");
  container.className = "entry-facts";
  facts.forEach((fact) => {
    const element = document.createElement("span");
    element.className = "entry-fact";
    element.textContent = fact;
    container.appendChild(element);
  });
  return container;
}

function appendText(container, text) {
  const element = document.createElement("span");
  element.textContent = text;
  container.appendChild(element);
}

function getVisibleEntries(entries, mode, order, query) {
  return filterEntries(sortEntries(entries, mode, order), query);
}

function sortEntries(entries, mode, order) {
  const list = entries.slice();
  if (mode === "recent") {
    return stableSort(list, compareByRecent);
  }
  if (mode === "alphabetical") {
    return stableSort(list, compareByAlphabetical);
  }
  return sortByRandomOrder(list, order);
}

function sortByRandomOrder(entries, order) {
  const indexById = new Map();
  order.forEach((id, index) => indexById.set(id, index));
  return stableSort(entries, (first, second) => {
    const firstIndex = indexById.has(first.id) ? indexById.get(first.id) : Number.MAX_SAFE_INTEGER;
    const secondIndex = indexById.has(second.id) ? indexById.get(second.id) : Number.MAX_SAFE_INTEGER;
    return firstIndex - secondIndex;
  });
}

function compareByRecent(first, second) {
  const firstTime = parseDateValue(first.createdAt);
  const secondTime = parseDateValue(second.createdAt);
  if (firstTime !== secondTime) {
    return secondTime - firstTime;
  }
  return normalizeText(first.word).localeCompare(normalizeText(second.word), "en", { sensitivity: "base" });
}

function compareByAlphabetical(first, second) {
  const firstKey = normalizeText(first.lemma || first.word).toLocaleLowerCase();
  const secondKey = normalizeText(second.lemma || second.word).toLocaleLowerCase();
  const primary = firstKey.localeCompare(secondKey, "en", { sensitivity: "base" });
  return primary || compareByRecent(first, second);
}

function stableSort(entries, compare) {
  return entries.map((entry, index) => ({ entry, index }))
    .sort((first, second) => compare(first.entry, second.entry) || first.index - second.index)
    .map((item) => item.entry);
}

function filterEntries(entries, query) {
  const normalizedQuery = normalizeText(query).toLocaleLowerCase();
  if (!normalizedQuery) {
    return entries;
  }

  return entries.filter((entry) => {
    return [
      entry.word,
      entry.lemma,
      entry.meaning,
      entry.contextSentence,
      entry.contextTranslation,
      entry.pageTitle
    ].some((value) => normalizeText(value).toLocaleLowerCase().includes(normalizedQuery));
  });
}

function createHighlightedContextFragment(contextSentence, word) {
  const fragment = document.createDocumentFragment();
  const text = typeof contextSentence === "string" ? contextSentence : "";
  const matches = findLiteralMatches(text, word);

  if (matches.length === 0) {
    fragment.appendChild(document.createTextNode(text));
    return fragment;
  }

  let cursor = 0;
  matches.forEach((match) => {
    if (match.start > cursor) {
      fragment.appendChild(document.createTextNode(text.slice(cursor, match.start)));
    }

    const mark = document.createElement("mark");
    mark.className = "vocabulary-context-highlight";
    mark.textContent = text.slice(match.start, match.end);
    fragment.appendChild(mark);
    cursor = match.end;
  });

  if (cursor < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(cursor)));
  }

  return fragment;
}

function findLiteralMatches(contextSentence, word) {
  const text = typeof contextSentence === "string" ? contextSentence : "";
  const needle = typeof word === "string" ? word.trim() : "";
  if (!shouldHighlightContext(text, needle)) {
    return [];
  }

  const lowerText = text.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  const matches = [];
  let index = lowerText.indexOf(lowerNeedle);

  while (index !== -1) {
    const end = index + lowerNeedle.length;
    if (isAllowedHighlightBoundary(text.charAt(index - 1)) && isAllowedHighlightBoundary(text.charAt(end))) {
      matches.push({ start: index, end });
    }
    index = lowerText.indexOf(lowerNeedle, Math.max(index + 1, end));
  }

  return matches;
}

function shouldHighlightContext(contextSentence, word) {
  const text = normalizeText(contextSentence);
  const target = normalizeText(word);
  if (!text || !target) {
    return false;
  }

  if (normalizeForHighlight(text) === normalizeForHighlight(target)) {
    return false;
  }

  if (target.length > 60) {
    return false;
  }

  const wordCount = target.split(/\s+/).filter(Boolean).length;
  if (wordCount > 8) {
    return false;
  }

  return target.length / text.length < 0.6;
}

function isAllowedHighlightBoundary(character) {
  return !character || !/[A-Za-z0-9'-]/.test(character);
}

function normalizeForHighlight(value) {
  return normalizeText(value).replace(/\s+/g, " ").toLocaleLowerCase();
}

async function setSortMode(nextMode) {
  sortMode = normalizeSortMode(nextMode);
  sortSelect.value = sortMode;
  await setLocalState({ [SORT_MODE_KEY]: sortMode });
  if (sortMode === "random") {
    randomOrder = await reconcileRandomOrder(allEntries);
  }
  renderVocabulary();
}

async function reconcileRandomOrder(entries) {
  const ids = entries.map((entry) => entry && entry.id).filter(Boolean);
  const idSet = new Set(ids);
  const sessionState = await getSessionState({ [RANDOM_ORDER_KEY]: null });
  const existingOrder = Array.isArray(sessionState[RANDOM_ORDER_KEY])
    ? sessionState[RANDOM_ORDER_KEY]
    : null;
  const nextOrder = existingOrder
    ? existingOrder.filter((id) => idSet.has(id))
    : shuffle(ids);
  const knownIds = new Set(nextOrder);
  ids.forEach((id) => {
    if (!knownIds.has(id)) {
      nextOrder.push(id);
    }
  });

  if (!arraysEqual(existingOrder || [], nextOrder)) {
    await setSessionState({ [RANDOM_ORDER_KEY]: nextOrder });
  }

  return nextOrder;
}

async function reshuffleRandomOrder() {
  randomOrder = shuffle(allEntries.map((entry) => entry && entry.id).filter(Boolean));
  await setSessionState({ [RANDOM_ORDER_KEY]: randomOrder });
  renderVocabulary();
}

async function deleteEntry(entryId) {
  if (!entryId) {
    return;
  }

  chrome.runtime.sendMessage({
    type: "DELETE_VOCABULARY_ENTRY",
    entryId
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Failed to delete vocabulary entry:", chrome.runtime.lastError.message);
      return;
    }
    if (!response || response.status !== "ok") {
      console.error("Failed to delete vocabulary entry:", response && response.message ? response.message : "Unknown error");
    }
  });
}

function openSource(pageUrl) {
  chrome.runtime.sendMessage({
    type: "OPEN_VOCABULARY_SOURCE",
    pageUrl
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Failed to open source page:", chrome.runtime.lastError.message);
      return;
    }
    if (!response || response.status !== "ok") {
      console.error("Failed to open source page:", response && response.message ? response.message : "Unknown error");
    }
  });
}

function openSettings() {
  chrome.runtime.openOptionsPage(() => {
    if (chrome.runtime.lastError) {
      console.error("Failed to open extension options page:", chrome.runtime.lastError.message);
    }
  });
}

function getLocalState(defaults) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(defaults, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result || {});
    });
  });
}

function setLocalState(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function getSessionState(defaults) {
  return new Promise((resolve, reject) => {
    if (!chrome.storage.session) {
      resolve(defaults || {});
      return;
    }
    chrome.storage.session.get(defaults, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result || {});
    });
  });
}

function setSessionState(values) {
  return new Promise((resolve, reject) => {
    if (!chrome.storage.session) {
      resolve();
      return;
    }
    chrome.storage.session.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function formatEntryTitle(entry) {
  const word = normalizeText(entry && entry.word);
  const lemma = normalizeText(entry && entry.lemma);
  if (!lemma) {
    return word || "未命名词条";
  }
  if (!word || lemma.toLocaleLowerCase() === word.toLocaleLowerCase()) {
    return lemma;
  }
  return `${lemma} (${word})`;
}

function formatDate(value) {
  const timestamp = parseDateValue(value);
  if (timestamp <= 0) {
    return "保存时间未知";
  }

  return new Date(timestamp).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function parseDateValue(value) {
  const timestamp = new Date(value || "").getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeSortMode(value) {
  return SORT_MODES.has(value) ? value : "random";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function shuffle(values) {
  const result = values.slice();
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function arraysEqual(first, second) {
  if (!Array.isArray(first) || !Array.isArray(second) || first.length !== second.length) {
    return false;
  }
  return first.every((value, index) => value === second[index]);
}

function isAllowedSourceUrl(pageUrl) {
  try {
    const url = new URL(normalizeText(pageUrl));
    return ["http:", "https:", "file:", "chrome-extension:"].includes(url.protocol);
  } catch (error) {
    return false;
  }
}

self.vocabularyBookTestHooks = Object.freeze({
  getVisibleEntries,
  sortEntries,
  filterEntries,
  reconcileRandomOrder,
  formatEntryTitle,
  createHighlightedContextFragment,
  findLiteralMatches,
  shouldHighlightContext,
  isAllowedHighlightBoundary,
  isAllowedSourceUrl,
  normalizeSortMode
});
