import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  LiveDetailPopupState,
  LivePopupTranslationState,
  MockTranslationState,
  VocabularySaveResult,
} from "../shared/contracts";
import { EVENTS } from "../shared/contracts";
import "../shared/base.css";
import "./popup.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Popup root is missing");

app.innerHTML = `
  <article class="panel">
    <p id="source-text" class="source-text" hidden></p>
    <main id="result" class="result is-loading">
      <p id="state-label" class="state-label">等待翻译</p>
      <section id="mock-view" hidden>
        <h1 id="result-title"></h1>
        <p id="result-body"></p>
        <section id="captured-target" class="captured-target" hidden><span>捕获的 TARGET</span><p id="target-text"></p></section>
        <dl id="mock-word-meta" hidden><div><dt>音标</dt><dd id="mock-phonetic"></dd></div><div><dt>词性</dt><dd id="mock-part-of-speech"></dd></div></dl>
        <section id="detail" class="detail" hidden><h2>详细解释（Mock）</h2><p id="detail-text"></p></section>
        <p id="error-code" class="error-code" hidden></p>
      </section>
      <section id="loading-view" class="loading-view"><p id="loading-message">正在处理…</p></section>
      <section id="word-view" class="analysis-view" hidden>
        <div class="analysis-row"><span>单词</span><strong id="word-display"></strong></div>
        <div class="analysis-row"><span>音标</span><strong id="word-phonetic"></strong></div>
        <div class="analysis-row"><span>词性</span><strong id="word-part-of-speech"></strong></div>
        <div class="analysis-row contextual-meaning"><span>含义</span><strong id="word-meaning"></strong></div>
        <div class="word-actions">
          <button id="save-vocabulary" class="save-vocabulary-button" type="button">加入生词本</button>
        </div>
        <button id="live-detail-request" class="live-detail-button" type="button">详细解释</button>
        <p id="live-detail-error" class="live-detail-error" hidden></p>
        <section id="live-detail-result" class="live-detail-result" hidden>
          <div class="analysis-row is-detail contextual-meaning"><span>当前语境</span><strong id="detail-meaning"></strong></div>
          <div id="detail-comparison-row" class="analysis-row is-detail is-separated-detail" hidden><span>近义词区别</span><strong id="detail-comparison"></strong></div>
        </section>
      </section>
      <section id="sentence-view" class="sentence-view" hidden>
        <p id="sentence-translation"></p>
        <div id="key-term" class="key-term" hidden><span>关键术语</span><strong id="key-term-value"></strong></div>
      </section>
      <section id="live-error-view" class="live-error-view" hidden><p id="live-error-message"></p></section>
    </main>
    <footer id="mock-actions" hidden>
      <button id="detail-toggle" class="secondary" hidden>详细解释</button>
      <button id="retry" class="danger" hidden>重试</button>
    </footer>
    <footer id="live-error-actions" hidden>
      <button id="live-retry" class="danger" hidden>重试</button>
      <button id="open-settings" class="danger" hidden>前往设置</button>
    </footer>
  </article>
`;

const result = document.querySelector<HTMLElement>("#result")!;
const stateLabel = document.querySelector<HTMLElement>("#state-label")!;
const sourceText = document.querySelector<HTMLElement>("#source-text")!;
const mockView = document.querySelector<HTMLElement>("#mock-view")!;
const title = document.querySelector<HTMLElement>("#result-title")!;
const body = document.querySelector<HTMLElement>("#result-body")!;
const capturedTarget = document.querySelector<HTMLElement>("#captured-target")!;
const targetText = document.querySelector<HTMLElement>("#target-text")!;
const mockWordMeta = document.querySelector<HTMLElement>("#mock-word-meta")!;
const mockPhonetic = document.querySelector<HTMLElement>("#mock-phonetic")!;
const mockPartOfSpeech = document.querySelector<HTMLElement>("#mock-part-of-speech")!;
const detail = document.querySelector<HTMLElement>("#detail")!;
const detailText = document.querySelector<HTMLElement>("#detail-text")!;
const errorCode = document.querySelector<HTMLElement>("#error-code")!;
const mockActions = document.querySelector<HTMLElement>("#mock-actions")!;
const detailToggle = document.querySelector<HTMLButtonElement>("#detail-toggle")!;
const retry = document.querySelector<HTMLButtonElement>("#retry")!;
const loadingView = document.querySelector<HTMLElement>("#loading-view")!;
const loadingMessage = document.querySelector<HTMLElement>("#loading-message")!;
const wordView = document.querySelector<HTMLElement>("#word-view")!;
const wordDisplay = document.querySelector<HTMLElement>("#word-display")!;
const wordPhonetic = document.querySelector<HTMLElement>("#word-phonetic")!;
const wordPartOfSpeech = document.querySelector<HTMLElement>("#word-part-of-speech")!;
const wordMeaning = document.querySelector<HTMLElement>("#word-meaning")!;
const saveVocabularyButton = document.querySelector<HTMLButtonElement>("#save-vocabulary")!;
const liveDetailButton = document.querySelector<HTMLButtonElement>("#live-detail-request")!;
const liveDetailError = document.querySelector<HTMLElement>("#live-detail-error")!;
const liveDetailResult = document.querySelector<HTMLElement>("#live-detail-result")!;
const detailMeaning = document.querySelector<HTMLElement>("#detail-meaning")!;
const detailComparisonRow = document.querySelector<HTMLElement>("#detail-comparison-row")!;
const detailComparison = document.querySelector<HTMLElement>("#detail-comparison")!;
const sentenceView = document.querySelector<HTMLElement>("#sentence-view")!;
const sentenceTranslation = document.querySelector<HTMLElement>("#sentence-translation")!;
const keyTerm = document.querySelector<HTMLElement>("#key-term")!;
const keyTermValue = document.querySelector<HTMLElement>("#key-term-value")!;
const liveErrorView = document.querySelector<HTMLElement>("#live-error-view")!;
const liveErrorMessage = document.querySelector<HTMLElement>("#live-error-message")!;
const liveErrorActions = document.querySelector<HTMLElement>("#live-error-actions")!;
const liveRetry = document.querySelector<HTMLButtonElement>("#live-retry")!;
const openSettings = document.querySelector<HTMLButtonElement>("#open-settings")!;

let latestGeneration = 0;
let latestLiveError: Extract<LivePopupTranslationState, { phase: "error" }> | null = null;
let latestQuickWord: Extract<LivePopupTranslationState, { phase: "success" }> | null = null;
let latestDetailError: Extract<LiveDetailPopupState, { phase: "error" }> | null = null;
let currentDetailRequestId = "";

function resetLiveDetail(): void {
  latestDetailError = null;
  currentDetailRequestId = "";
  liveDetailButton.hidden = false;
  liveDetailButton.disabled = false;
  liveDetailButton.textContent = "详细解释";
  liveDetailError.hidden = true;
  liveDetailError.textContent = "";
  liveDetailResult.hidden = true;
  detailMeaning.textContent = "";
  detailComparisonRow.hidden = true;
  detailComparison.textContent = "";
}

function resetVocabularySave(): void {
  saveVocabularyButton.disabled = false;
  saveVocabularyButton.textContent = "加入生词本";
}

function hideAllViews(): void {
  mockView.hidden = true;
  mockActions.hidden = true;
  loadingView.hidden = true;
  wordView.hidden = true;
  sentenceView.hidden = true;
  liveErrorView.hidden = true;
  liveErrorActions.hidden = true;
  liveRetry.hidden = true;
  openSettings.hidden = true;
}

function formatLemmaDisplay(lemma: string, target: string, word: string): string {
  const normalizedLemma = lemma.trim();
  const normalizedTarget = target.trim();
  if (!normalizedLemma) return word.trim() || normalizedTarget || "-";
  if (!normalizedTarget || normalizedLemma.toLocaleLowerCase() === normalizedTarget.toLocaleLowerCase()) {
    return normalizedLemma;
  }
  return `${normalizedLemma} (${normalizedTarget})`;
}

function renderMock(payload: MockTranslationState): void {
  if (!payload.mock || payload.generation < latestGeneration) return;
  latestGeneration = payload.generation;
  latestQuickWord = null;
  resetVocabularySave();
  resetLiveDetail();
  hideAllViews();
  mockView.hidden = false;
  mockActions.hidden = false;
  sourceText.hidden = true;
  result.className = `result is-${payload.view}`;
  stateLabel.textContent = payload.captureDiagnostic
    ? "TARGET 捕获测试"
    : payload.phase === "loading" ? "正在处理" : payload.phase === "error" ? "处理失败" : "Mock 结果";
  title.textContent = payload.title;
  body.textContent = payload.body;
  capturedTarget.hidden = !payload.target;
  targetText.textContent = payload.target ?? "";
  mockWordMeta.hidden = payload.captureDiagnostic || payload.view !== "word";
  mockPhonetic.textContent = payload.phonetic ?? "";
  mockPartOfSpeech.textContent = payload.partOfSpeech ?? "";
  detail.hidden = true;
  detailText.textContent = payload.detail ?? "";
  detailToggle.hidden = payload.view !== "word" || !payload.detail;
  detailToggle.textContent = "详细解释";
  retry.hidden = !payload.retryable;
  errorCode.hidden = !payload.errorCode;
  errorCode.textContent = payload.errorCode ? `错误码：${payload.errorCode}` : "";
  if (payload.captureDiagnostic && payload.selection) {
    void invoke<boolean>("ack_target_diagnostic", {
      captureGeneration: payload.selection.captureGeneration,
      translationGeneration: payload.generation,
    });
  }
}

function renderLive(payload: LivePopupTranslationState): void {
  if (payload.generation < latestGeneration) return;
  latestGeneration = payload.generation;
  hideAllViews();
  sourceText.hidden = false;
  sourceText.textContent = payload.target;
  latestLiveError = null;
  latestQuickWord = null;
  resetVocabularySave();

  if (payload.phase === "loading") {
    result.className = "result is-loading";
    stateLabel.textContent = "正在处理";
    loadingView.hidden = false;
    loadingMessage.textContent = payload.requestType === "sentenceTranslation"
      ? "正在翻译句子…"
      : "正在进行语境解析…";
    return;
  }

  if (payload.phase === "error") {
    result.className = "result is-error";
    stateLabel.textContent = "处理失败";
    liveErrorView.hidden = false;
    liveErrorMessage.textContent = payload.message;
    latestLiveError = payload;
    liveErrorActions.hidden = payload.errorKind === "terminal";
    liveRetry.hidden = payload.errorKind !== "retryable";
    liveRetry.disabled = false;
    openSettings.hidden = payload.errorKind !== "configuration";
    return;
  }

  stateLabel.textContent = "翻译结果";
  if (payload.result.kind === "word") {
    result.className = "result is-word";
    wordView.hidden = false;
    wordDisplay.textContent = formatLemmaDisplay(payload.result.lemma, payload.target, payload.result.word);
    wordPhonetic.textContent = payload.result.phonetic || "-";
    wordPartOfSpeech.textContent = payload.result.partOfSpeech || "-";
    wordMeaning.textContent = payload.result.meaning || "-";
    latestQuickWord = payload;
    resetLiveDetail();
    return;
  }

  result.className = "result is-sentence";
  sentenceView.hidden = false;
  sentenceTranslation.textContent = payload.result.translation;
  keyTerm.hidden = !payload.result.keyTerm;
  keyTermValue.textContent = payload.result.keyTerm
    ? `${payload.result.keyTerm.term}：${payload.result.keyTerm.meaning}`
    : "";
}

function renderLiveDetail(payload: LiveDetailPopupState): void {
  const quick = latestQuickWord;
  if (!quick
    || payload.generation !== quick.generation
    || payload.captureGeneration !== quick.captureGeneration
    || payload.quickRequestId !== quick.requestId) return;

  if (payload.phase === "loading") {
    currentDetailRequestId = payload.detailRequestId;
    latestDetailError = null;
    liveDetailError.hidden = true;
    liveDetailResult.hidden = true;
    liveDetailButton.hidden = false;
    liveDetailButton.disabled = true;
    liveDetailButton.textContent = "正在详细解释…";
    return;
  }

  if (payload.detailRequestId !== currentDetailRequestId) return;

  if (payload.phase === "error") {
    latestDetailError = payload;
    liveDetailResult.hidden = true;
    liveDetailError.hidden = false;
    liveDetailError.textContent = payload.message;
    liveDetailButton.hidden = false;
    liveDetailButton.disabled = false;
    liveDetailButton.textContent = "重试详细解释";
    return;
  }

  latestDetailError = null;
  liveDetailError.hidden = true;
  liveDetailButton.hidden = true;
  liveDetailResult.hidden = false;
  detailMeaning.textContent = payload.result.meaningInSentence;
  detailComparisonRow.hidden = !payload.result.comparison;
  detailComparison.textContent = payload.result.comparison
    ? `${quick.target} vs ${payload.result.comparison.word}\n${payload.result.comparison.difference}`
    : "";
}

detailToggle.addEventListener("click", () => {
  detail.hidden = !detail.hidden;
  detailToggle.textContent = detail.hidden ? "详细解释" : "收起详细解释";
});
retry.addEventListener("click", () => void invoke("show_mock_translation", { scenario: "retry" }));
liveRetry.addEventListener("click", async () => {
  const error = latestLiveError;
  if (!error || error.errorKind !== "retryable") return;
  liveRetry.disabled = true;
  try {
    await invoke("retry_live_translation", {
      generation: error.generation,
      requestId: error.requestId,
    });
  } catch {
    if (latestLiveError?.requestId === error.requestId) liveRetry.disabled = false;
  }
});
openSettings.addEventListener("click", async () => {
  await invoke("open_main_section", { section: "settings" });
  await getCurrentWindow().hide();
});
liveDetailButton.addEventListener("click", async () => {
  const quick = latestQuickWord;
  if (!quick) return;
  const detailError = latestDetailError;
  liveDetailButton.disabled = true;
  try {
    if (detailError) {
      await invoke("retry_live_detail", {
        generation: detailError.generation,
        detailRequestId: detailError.detailRequestId,
      });
    } else {
      await invoke("request_live_detail", {
        generation: quick.generation,
        quickRequestId: quick.requestId,
      });
    }
  } catch {
    liveDetailButton.disabled = false;
  }
});

saveVocabularyButton.addEventListener("click", async () => {
  const quick = latestQuickWord;
  if (!quick || quick.result.kind !== "word") return;
  saveVocabularyButton.disabled = true;
  saveVocabularyButton.textContent = "正在保存…";
  try {
    const saved = await invoke<VocabularySaveResult>("save_current_word_to_vocabulary", {
      generation: quick.generation,
      quickRequestId: quick.requestId,
    });
    if (latestQuickWord?.requestId !== quick.requestId) return;
    saveVocabularyButton.textContent = saved.status === "updated" ? "已更新" : "已加入";
  } catch {
    if (latestQuickWord?.requestId === quick.requestId) {
      saveVocabularyButton.disabled = false;
      saveVocabularyButton.textContent = "保存失败，请重试";
    }
  }
});

async function initialize(): Promise<void> {
  await invoke("set_popup_listener_ready", { ready: false });
  await listen<MockTranslationState>(EVENTS.translationStateChanged, (event) => renderMock(event.payload));
  await listen<LivePopupTranslationState>(EVENTS.popupTranslationState, (event) => renderLive(event.payload));
  await listen<LiveDetailPopupState>(EVENTS.popupDetailState, (event) => renderLiveDetail(event.payload));
  await invoke("set_popup_listener_ready", { ready: true });
}

void initialize().catch(() => {
  // Readiness remains false; Rust exposes the failure without logging payload data.
});
