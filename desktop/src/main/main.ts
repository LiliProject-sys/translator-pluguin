import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ClipboardUnicodeDiagnostic,
  GatewayAccessVerificationResult,
  GatewayTestState,
  MainSection,
  MockScenario,
  RuntimeState,
  SettingsView,
  TargetDiagnostics,
  VocabularyEntry,
  VocabularyExportResult,
  VocabularyImportResult,
  VocabularyListResult,
} from "../shared/contracts";
import { EVENTS } from "../shared/contracts";
import "../shared/base.css";
import "./main.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Main root is missing");

app.innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">Orange翻译</div>
      <nav aria-label="主导航">
        <button class="nav-item is-active" data-section="home">首页</button>
        <button class="nav-item" data-section="vocabulary">生词本</button>
        <button class="nav-item" data-section="settings">设置</button>
      </nav>
      <p class="stage-label">Windows 桌面端</p>
    </aside>
    <main class="content">
      <section class="page is-active" data-page="home">
        <header><p class="eyebrow">ORANGE TRANSLATOR</p><h1>桌面翻译控制台</h1><p>自动翻译默认开启；随时按 F1 暂停或恢复。</p></header>
        <article class="card status-card">
          <div><span class="label">自动翻译 · F1 暂停/恢复</span><strong id="runtime-status">自动翻译：已开启</strong><small id="capture-status"></small></div>
          <button id="auto-toggle" class="primary" data-enabled="true" disabled>暂停自动翻译</button>
        </article>
        <details class="developer-tools">
          <summary><span>开发工具</span><span class="developer-tools-chevron" aria-hidden="true">›</span></summary>
          <div class="developer-tools-content">
        <article class="card">
          <div class="card-heading"><div><span class="label">开发测试</span><h2>Mock 翻译浮窗</h2></div><span class="mock-badge">MOCK</span></div>
          <p class="muted">只验证 Popup 状态与生命周期，不读取选区、剪贴板或网络。</p>
          <div class="mock-grid">
            <button data-mock="loading">Loading</button>
            <button data-mock="wordSuccess">Word success</button>
            <button data-mock="sentenceSuccess">Sentence success</button>
            <button data-mock="error">Error</button>
            <button data-mock="retry">Retry flow</button>
          </div>
        </article>
        <article class="card diagnostic-card">
          <div class="card-heading">
            <div><span class="label">控制变量测试</span><h2>Clipboard Unicode Test</h2></div>
            <button id="read-clipboard" class="primary">读取当前剪贴板</button>
          </div>
          <p class="muted">只调用 production Unicode reader；不发送 Ctrl+C、不修改或恢复剪贴板、不触发 Popup。</p>
          <dl class="diagnostic-grid">
            <div><dt>CF_UNICODETEXT available</dt><dd id="clipboard-format">未测试</dd></div>
            <div><dt>GetClipboardData</dt><dd id="clipboard-get-data">NotAttempted</dd></div>
            <div><dt>GlobalLock</dt><dd id="clipboard-global-lock">NotAttempted</dd></div>
            <div><dt>字符数</dt><dd id="clipboard-length">0</dd></div>
            <div><dt>读取结果</dt><dd id="clipboard-result">未测试</dd></div>
            <div><dt>错误阶段</dt><dd id="clipboard-error-stage">none</dd></div>
            <div><dt>Reason</dt><dd id="clipboard-reason">—</dd></div>
            <div><dt>GetLastError</dt><dd id="clipboard-last-error">0</dd></div>
            <div class="wide target-preview"><dt>内容（运行期预览）</dt><dd id="clipboard-preview">—</dd></div>
          </dl>
        </article>
        <article class="card diagnostic-card">
          <div class="card-heading"><div><span class="label">开发诊断</span><h2>TARGET 捕获诊断</h2></div><span id="diagnostic-result" class="diagnostic-badge">None</span></div>
          <p class="muted">系统事件与外部捕获分开记录；TARGET 预览仅保存在本次运行内存中。</p>
          <h3 class="diagnostic-section-title">最近系统 / 鼠标事件</h3>
          <dl class="diagnostic-grid">
            <div><dt>Hook</dt><dd id="diag-hook">Checking</dd></div>
            <div><dt>最近事件</dt><dd id="diag-event">None</dd></div>
            <div><dt>系统原因</dt><dd id="diag-system-reason">—</dd></div>
            <div><dt>Generation</dt><dd id="diag-system-generation">0</dd></div>
            <div class="wide"><dt>当前前台窗口</dt><dd id="diag-system-foreground">—</dd></div>
          </dl>
          <h3 class="diagnostic-section-title">最近一次外部 TARGET 捕获</h3>
          <p id="diag-external-empty" class="muted">尚无外部捕获记录。</p>
          <dl id="diag-external" class="diagnostic-grid" hidden>
            <div><dt>阶段</dt><dd id="diag-stage">Idle</dd></div>
            <div><dt>结果 / 原因</dt><dd id="diag-reason">None / —</dd></div>
            <div><dt>候选类型</dt><dd id="diag-candidate">None</dd></div>
            <div><dt>TARGET 长度</dt><dd id="diag-length">0</dd></div>
            <div><dt>分类</dt><dd id="diag-request">None</dd></div>
            <div><dt>Clipboard 恢复</dt><dd id="diag-restore">NotNeeded</dd></div>
            <div><dt>Popup window / show</dt><dd id="diag-popup-show">NotChecked / NotAttempted</dd></div>
            <div><dt>Popup emit</dt><dd id="diag-popup-emit">NotAttempted</dd></div>
            <div><dt>Popup listener / ACK</dt><dd id="diag-popup-client">NotReady / NotExpected</dd></div>
            <div><dt>Capture / Translation Gen</dt><dd id="diag-generations">0 / 0</dd></div>
            <div class="wide"><dt>来源程序</dt><dd id="diag-foreground">—</dd></div>
            <div class="wide target-preview"><dt>捕获到的 TARGET</dt><dd id="diag-target">—</dd></div>
          </dl>
        </article>
        <article class="card diagnostic-card gateway-card">
          <div class="card-heading">
            <div><span class="label">真实网络 · 手动触发</span><h2>Gateway 真实链路验证</h2></div>
            <button id="send-gateway" class="primary" disabled>发送最新 TARGET</button>
          </div>
          <p id="gateway-hint" class="muted">请先划取英文 TARGET，并在设置中验证访问码。</p>
          <dl class="diagnostic-grid">
            <div><dt>连接状态</dt><dd id="gateway-state">Idle</dd></div>
            <div><dt>访问码</dt><dd id="gateway-access">未配置</dd></div>
            <div><dt>请求分类</dt><dd id="gateway-request-type">—</dd></div>
            <div><dt>TARGET 长度</dt><dd id="gateway-target-length">0</dd></div>
            <div><dt>HTTP / 延迟</dt><dd id="gateway-http">—</dd></div>
            <div><dt>解析状态</dt><dd id="gateway-parse">NotAttempted</dd></div>
            <div class="wide"><dt>requestId</dt><dd id="gateway-request-id">—</dd></div>
            <div><dt>Context 状态</dt><dd id="gateway-context-status">—</dd></div>
            <div><dt>Context 来源 / 单位</dt><dd id="gateway-context-source">—</dd></div>
            <div><dt>Context 长度</dt><dd id="gateway-context-length">0</dd></div>
            <div class="wide target-preview"><dt>Context Preview（仅运行期）</dt><dd id="gateway-context-preview">—</dd></div>
            <div class="wide"><dt>前台标题</dt><dd id="gateway-page-title">—</dd></div>
            <div class="wide target-preview"><dt>最新 TARGET（仅运行期）</dt><dd id="gateway-target">—</dd></div>
            <div class="wide target-preview"><dt>严格解析结果</dt><dd><pre id="gateway-result">—</pre></dd></div>
            <div class="wide target-preview" id="gateway-raw-row" hidden><dt>解析失败响应预览（最多 1000 字符）</dt><dd><pre id="gateway-raw">—</pre></dd></div>
            <div class="wide"><dt>错误</dt><dd id="gateway-error">—</dd></div>
          </dl>
        </article>
          </div>
        </details>
        <p id="main-message" class="message" role="status"></p>
      </section>
      <section class="page vocabulary-page" data-page="vocabulary">
        <div class="vocabulary-header">
          <div><p class="eyebrow">VOCABULARY</p><h1>生词本</h1><p id="vocabulary-count" class="muted">正在读取…</p></div>
          <div class="vocabulary-file-actions">
            <div class="vocabulary-order-toggle" role="group" aria-label="生词浏览顺序">
              <button type="button" data-vocabulary-order="sequential" class="is-active" aria-pressed="true">顺序</button>
              <button type="button" data-vocabulary-order="random" aria-pressed="false">随机</button>
            </div>
            <button id="import-vocabulary">导入</button><button id="export-vocabulary">导出</button>
          </div>
        </div>
        <label class="vocabulary-search"><span>搜索</span><input id="vocabulary-query" type="search" placeholder="单词、原形或含义" autocomplete="off"></label>
        <p id="vocabulary-message" class="message" role="status"></p>
        <div class="vocabulary-layout">
          <div id="vocabulary-list" class="vocabulary-list" aria-label="生词列表"></div>
          <article id="vocabulary-detail" class="vocabulary-detail"><p class="muted">选择一个词条查看详情。</p></article>
        </div>
      </section>
      <section class="page placeholder" data-page="settings">
        <p class="eyebrow">SETTINGS</p><h1>设置</h1>
        <div class="placeholder-card settings-card">
          <h2>访问码</h2>
          <div id="settings-access-panel" class="settings-access-panel" data-state="unset" role="status">
            <strong id="settings-access-title">访问码未设置，请输入访问码</strong>
          </div>
          <label id="settings-access-label" for="gateway-access-code">请输入访问码</label>
          <input id="gateway-access-code" type="password" autocomplete="off" spellcheck="false" placeholder="输入访问码">
          <div class="settings-actions"><button id="verify-access-code" class="primary">验证并保存</button></div>
        </div>
      </section>
    </main>
  </div>
`;

const runtimeStatus = document.querySelector<HTMLElement>("#runtime-status")!;
const toggleButton = document.querySelector<HTMLButtonElement>("#auto-toggle")!;
const captureStatus = document.querySelector<HTMLElement>("#capture-status")!;
const mainMessage = document.querySelector<HTMLElement>("#main-message")!;
const diagnosticResult = document.querySelector<HTMLElement>("#diagnostic-result")!;
const readClipboardButton = document.querySelector<HTMLButtonElement>("#read-clipboard")!;
const sendGatewayButton = document.querySelector<HTMLButtonElement>("#send-gateway")!;
const verifyAccessButton = document.querySelector<HTMLButtonElement>("#verify-access-code")!;
const accessCodeInput = document.querySelector<HTMLInputElement>("#gateway-access-code")!;
const accessStatusPanel = document.querySelector<HTMLElement>("#settings-access-panel")!;
const accessStatusTitle = document.querySelector<HTMLElement>("#settings-access-title")!;
const accessCodeLabel = document.querySelector<HTMLLabelElement>("#settings-access-label")!;
const vocabularyCount = document.querySelector<HTMLElement>("#vocabulary-count")!;
const vocabularyMessage = document.querySelector<HTMLElement>("#vocabulary-message")!;
const vocabularyQuery = document.querySelector<HTMLInputElement>("#vocabulary-query")!;
const vocabularyList = document.querySelector<HTMLElement>("#vocabulary-list")!;
const vocabularyDetail = document.querySelector<HTMLElement>("#vocabulary-detail")!;
const importVocabularyButton = document.querySelector<HTMLButtonElement>("#import-vocabulary")!;
const exportVocabularyButton = document.querySelector<HTMLButtonElement>("#export-vocabulary")!;

let settingsState: SettingsView = { schemaVersion: 1, gatewayAccessConfigured: false };
let gatewayState: GatewayTestState = { connectionState: "idle", parseStatus: "notAttempted" };
type AccessCodeUiState = "unset" | "verifying" | "success" | "failure";
let accessCodeUiState: AccessCodeUiState = "unset";
let vocabularyEntries: VocabularyEntry[] = [];
let selectedVocabularyId = "";
let vocabularySearchTimer: number | undefined;
type VocabularyOrderMode = "sequential" | "random";
let vocabularyOrderMode: VocabularyOrderMode = "sequential";
let vocabularyRandomOrder: string[] = [];

function shuffleVocabularyIds(ids: string[]): string[] {
  const shuffled = ids.slice();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function reconcileVocabularyRandomOrder(allEntries: VocabularyEntry[]): void {
  const currentIds = new Set(allEntries.map((entry) => entry.id));
  const retained = vocabularyRandomOrder.filter((id) => currentIds.has(id));
  const retainedIds = new Set(retained);
  for (const entry of allEntries) {
    if (!retainedIds.has(entry.id)) retained.push(entry.id);
  }
  vocabularyRandomOrder = retained;
}

function applyVocabularyOrder(entries: VocabularyEntry[]): VocabularyEntry[] {
  if (vocabularyOrderMode === "sequential") return entries;
  const position = new Map(vocabularyRandomOrder.map((id, index) => [id, index]));
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const leftPosition = position.get(left.entry.id) ?? Number.MAX_SAFE_INTEGER;
      const rightPosition = position.get(right.entry.id) ?? Number.MAX_SAFE_INTEGER;
      return leftPosition - rightPosition || left.index - right.index;
    })
    .map(({ entry }) => entry);
}

function renderVocabularyOrderMode(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-vocabulary-order]").forEach((button) => {
    const active = button.dataset.vocabularyOrder === vocabularyOrderMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function addVocabularyField(container: HTMLElement, label: string, value: string): void {
  const row = document.createElement("div");
  row.className = "vocabulary-field";
  const term = document.createElement("span");
  term.textContent = label;
  const content = document.createElement("p");
  content.textContent = value || "—";
  row.append(term, content);
  container.append(row);
}

function renderVocabularyDetail(entry?: VocabularyEntry): void {
  vocabularyDetail.replaceChildren();
  if (!entry) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = vocabularyEntries.length ? "选择一个词条查看详情。" : "生词本还是空的。";
    vocabularyDetail.append(empty);
    return;
  }
  const heading = document.createElement("div");
  heading.className = "vocabulary-detail-heading";
  const title = document.createElement("h2");
  title.textContent = entry.word;
  const remove = document.createElement("button");
  remove.className = "vocabulary-delete";
  remove.textContent = "删除";
  remove.addEventListener("click", async () => {
    if (!window.confirm(`确定删除“${entry.word}”吗？`)) return;
    try {
      await invoke<VocabularyListResult>("delete_vocabulary_entry", { id: entry.id });
      selectedVocabularyId = "";
      vocabularyMessage.textContent = "词条已删除。";
      await loadVocabulary();
    } catch (error) {
      vocabularyMessage.textContent = `删除失败：${String(error)}`;
    }
  });
  heading.append(title, remove);
  vocabularyDetail.append(heading);
  addVocabularyField(vocabularyDetail, "原形", entry.lemma);
  addVocabularyField(vocabularyDetail, "音标", entry.phonetic);
  addVocabularyField(vocabularyDetail, "词性", entry.partOfSpeech);
  addVocabularyField(vocabularyDetail, "含义", entry.meaning);
  if (entry.detail) {
    addVocabularyField(vocabularyDetail, "当前语境", entry.detail.meaningInSentence);
    if (entry.detail.comparison) {
      addVocabularyField(
        vocabularyDetail,
        "近义词区别",
        `${entry.word} vs ${entry.detail.comparison.word}\n${entry.detail.comparison.difference}`,
      );
    }
  }
  addVocabularyField(vocabularyDetail, "来源程序", entry.source.app);
  addVocabularyField(vocabularyDetail, "来源标题", entry.source.title);
  if (entry.source.url) {
    const open = document.createElement("button");
    open.className = "vocabulary-open-source";
    open.textContent = "打开来源";
    open.addEventListener("click", async () => {
      try {
        await invoke("open_vocabulary_source", { id: entry.id });
      } catch (error) {
        vocabularyMessage.textContent = `打开来源失败：${String(error)}`;
      }
    });
    vocabularyDetail.append(open);
  }
  if (entry.context.trim()) {
    addVocabularyField(vocabularyDetail, "语境", entry.context);
  }
  const times = document.createElement("p");
  times.className = "vocabulary-times";
  times.textContent = `创建：${entry.createdAt} · 更新：${entry.updatedAt}`;
  vocabularyDetail.append(times);
}

function renderVocabulary(result: VocabularyListResult): void {
  const orderedEntries = applyVocabularyOrder(result.entries);
  vocabularyEntries = orderedEntries;
  vocabularyCount.textContent = `共 ${result.total} 个词条${result.entries.length === result.total ? "" : `，当前显示 ${result.entries.length} 个`}`;
  vocabularyList.replaceChildren();
  if (!orderedEntries.some((entry) => entry.id === selectedVocabularyId)) {
    selectedVocabularyId = orderedEntries[0]?.id ?? "";
  }
  for (const entry of orderedEntries) {
    const button = document.createElement("button");
    button.className = "vocabulary-item";
    button.classList.toggle("is-active", entry.id === selectedVocabularyId);
    const word = document.createElement("strong");
    word.textContent = entry.word;
    const meta = document.createElement("span");
    meta.textContent = `${entry.partOfSpeech} ${entry.meaning}`;
    button.append(word, meta);
    button.addEventListener("click", () => {
      selectedVocabularyId = entry.id;
      renderVocabulary({ ...result, entries: orderedEntries });
      renderVocabularyDetail(entry);
    });
    vocabularyList.append(button);
  }
  renderVocabularyDetail(orderedEntries.find((entry) => entry.id === selectedVocabularyId));
}

async function loadVocabulary(): Promise<void> {
  try {
    if (vocabularyOrderMode === "random") {
      const all = await invoke<VocabularyListResult>("list_vocabulary", { query: null });
      reconcileVocabularyRandomOrder(all.entries);
    }
    const result = await invoke<VocabularyListResult>("list_vocabulary", {
      query: vocabularyQuery.value.trim() || null,
    });
    renderVocabulary(result);
  } catch (error) {
    vocabularyMessage.textContent = `生词本读取失败：${String(error)}`;
  }
}

async function setVocabularyOrderMode(mode: VocabularyOrderMode): Promise<void> {
  if (mode === vocabularyOrderMode) return;
  if (mode === "random") {
    const all = await invoke<VocabularyListResult>("list_vocabulary", { query: null });
    vocabularyRandomOrder = shuffleVocabularyIds(all.entries.map((entry) => entry.id));
  }
  vocabularyOrderMode = mode;
  renderVocabularyOrderMode();
  await loadVocabulary();
}

function diagnosticField(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`#${id}`)!;
}

function renderDiagnostic(diagnostics: TargetDiagnostics): void {
  const system = diagnostics.systemEvent;
  diagnosticField("diag-hook").textContent = system.hookReady ? "Ready" : "Failed";
  diagnosticField("diag-event").textContent = system.lastMouseEvent;
  diagnosticField("diag-system-reason").textContent = system.reasonCode || "—";
  diagnosticField("diag-system-generation").textContent = String(system.generation);
  diagnosticField("diag-system-foreground").textContent = system.foregroundTitle
    ? `${system.foregroundTitle} (PID ${system.foregroundPid})`
    : "—";

  const external = diagnostics.externalCapture;
  document.querySelector<HTMLElement>("#diag-external")!.hidden = !external;
  document.querySelector<HTMLElement>("#diag-external-empty")!.hidden = Boolean(external);
  if (!external) {
    diagnosticResult.textContent = "None";
    diagnosticResult.dataset.result = "none";
    return;
  }
  diagnosticResult.textContent = external.result;
  diagnosticResult.dataset.result = external.result;
  diagnosticField("diag-stage").textContent = external.stage;
  diagnosticField("diag-reason").textContent = `${external.result} / ${external.reasonCode || "—"}`;
  diagnosticField("diag-candidate").textContent = external.candidateType ?? "None";
  diagnosticField("diag-length").textContent = String(external.targetLength);
  diagnosticField("diag-request").textContent = external.requestType ?? "None";
  diagnosticField("diag-restore").textContent = external.clipboardRestoreState;
  diagnosticField("diag-popup-show").textContent = `${external.popupWindowState} / ${external.popupShowState}`;
  diagnosticField("diag-popup-emit").textContent = external.popupEmitState;
  diagnosticField("diag-popup-client").textContent = `${external.popupListenerState} / ${external.popupAckState}`;
  diagnosticField("diag-generations").textContent = `${external.captureGeneration} / ${external.translationGeneration}`;
  diagnosticField("diag-foreground").textContent = external.foregroundTitle
    ? `${external.foregroundTitle} (PID ${external.foregroundPid})`
    : "—";
  diagnosticField("diag-target").textContent = external.targetPreview || "—";
}

function renderClipboardDiagnostic(diagnostic: ClipboardUnicodeDiagnostic): void {
  diagnosticField("clipboard-format").textContent = diagnostic.formatAvailable;
  diagnosticField("clipboard-get-data").textContent = diagnostic.getDataState;
  diagnosticField("clipboard-global-lock").textContent = diagnostic.globalLockState;
  diagnosticField("clipboard-length").textContent = String(diagnostic.characterCount);
  diagnosticField("clipboard-result").textContent = diagnostic.result;
  diagnosticField("clipboard-error-stage").textContent = diagnostic.errorStage;
  diagnosticField("clipboard-reason").textContent = diagnostic.reasonCode || "—";
  diagnosticField("clipboard-last-error").textContent = String(diagnostic.lastError);
  diagnosticField("clipboard-preview").textContent = diagnostic.textPreview || "—";
}

function renderAccessCodeState(): void {
  const configured = settingsState.gatewayAccessConfigured;
  accessStatusPanel.dataset.state = accessCodeUiState;

  if (accessCodeUiState === "verifying") {
    accessStatusTitle.textContent = "正在验证访问码…";
  } else if (accessCodeUiState === "success") {
    accessStatusTitle.textContent = "✓ 已成功设置，可以正常使用";
  } else if (accessCodeUiState === "failure") {
    accessStatusTitle.textContent = configured
      ? "新访问码验证失败，原有访问码仍可继续使用"
      : "访问码验证失败，请检查后重试";
  } else {
    accessStatusTitle.textContent = "访问码未设置，请输入访问码";
  }

  const verifying = accessCodeUiState === "verifying";
  accessCodeLabel.textContent = configured ? "输入新的访问码" : "请输入访问码";
  accessCodeInput.placeholder = configured ? "输入新的访问码" : "输入访问码";
  accessCodeInput.disabled = verifying;
  verifyAccessButton.disabled = verifying;
  verifyAccessButton.textContent = verifying
    ? "验证中…"
    : configured
      ? "验证并更新"
      : "验证并保存";
}

function renderSettings(settings: SettingsView, uiState?: AccessCodeUiState): void {
  settingsState = settings;
  accessCodeUiState = uiState ?? (settings.gatewayAccessConfigured ? "success" : "unset");
  renderAccessCodeState();
  renderGateway(gatewayState);
}

function renderGateway(state: GatewayTestState): void {
  gatewayState = state;
  const latest = state.latestTarget ?? null;
  diagnosticField("gateway-state").textContent = state.connectionState;
  diagnosticField("gateway-access").textContent = settingsState.gatewayAccessConfigured ? "已配置" : "未配置";
  diagnosticField("gateway-request-type").textContent = state.requestType ?? latest?.requestType ?? "—";
  diagnosticField("gateway-target-length").textContent = String(state.requestTargetLength ?? (latest ? [...latest.target].length : 0));
  diagnosticField("gateway-http").textContent = state.httpStatus
    ? `${state.httpStatus} / ${state.latencyMs ?? 0} ms`
    : state.latencyMs != null ? `— / ${state.latencyMs} ms` : "—";
  diagnosticField("gateway-parse").textContent = state.parseStatus;
  diagnosticField("gateway-request-id").textContent = state.requestId ?? "—";
  diagnosticField("gateway-context-status").textContent = latest?.context.status ?? "—";
  diagnosticField("gateway-context-source").textContent = latest
    ? `${latest.context.source.toUpperCase()} / ${latest.context.unit}`
    : "—";
  diagnosticField("gateway-context-length").textContent = String(latest?.context.contextLength ?? 0);
  diagnosticField("gateway-context-preview").textContent = latest?.context.contextPreview || "—";
  diagnosticField("gateway-page-title").textContent = latest?.pageTitle || "—";
  diagnosticField("gateway-target").textContent = latest?.target || "—";
  diagnosticField("gateway-result").textContent = state.parsedResult
    ? JSON.stringify(state.parsedResult, null, 2)
    : "—";
  diagnosticField("gateway-error").textContent = state.errorCode
    ? `${state.errorCode}${state.gatewayErrorCode ? ` / ${state.gatewayErrorCode}` : ""}: ${state.errorMessage ?? ""}`
    : "—";
  const rawRow = document.querySelector<HTMLElement>("#gateway-raw-row")!;
  rawRow.hidden = !state.rawPreview;
  diagnosticField("gateway-raw").textContent = state.rawPreview ?? "—";

  const sending = state.connectionState === "sending";
  sendGatewayButton.disabled = !latest || !settingsState.gatewayAccessConfigured || sending;
  const hint = document.querySelector<HTMLElement>("#gateway-hint")!;
  hint.textContent = !latest
    ? "请先开启自动翻译并划取英文 TARGET。"
    : !settingsState.gatewayAccessConfigured
      ? "请先到设置页验证并保存访问码。"
      : sending
        ? "正在通过真实 Gateway 发送当前请求快照…"
        : "自动划词会更新 Popup；此按钮仅手动重发当前 TARGET，手动结果只更新 Main。";
}

let runtimeState: RuntimeState = { autoTranslateEnabled: true, mainSection: "home", targetCaptureAvailable: true };

function renderRuntime(state: RuntimeState): void {
  runtimeState = state;
  runtimeStatus.textContent = state.autoTranslateEnabled ? "自动翻译：已开启" : "自动翻译：已暂停";
  runtimeStatus.classList.toggle("enabled", state.autoTranslateEnabled);
  toggleButton.dataset.enabled = String(state.autoTranslateEnabled);
  toggleButton.textContent = state.autoTranslateEnabled ? "暂停自动翻译" : "恢复自动翻译";
  captureStatus.textContent = state.targetCaptureAvailable ? "TARGET 捕获已就绪" : "TARGET 捕获不可用";
  toggleButton.disabled = !state.targetCaptureAvailable;
  renderSection(state.mainSection);
}

function renderSection(section: MainSection): void {
  document.querySelectorAll<HTMLElement>("[data-page]").forEach((page) => {
    page.classList.toggle("is-active", page.dataset.page === section);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-section]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.section === section);
  });
  if (section === "vocabulary") void loadVocabulary();
}

async function openSection(section: MainSection): Promise<void> {
  await invoke("open_main_section", { section });
}

document.querySelectorAll<HTMLButtonElement>("[data-section]").forEach((button) => {
  button.addEventListener("click", () => void openSection(button.dataset.section as MainSection));
});

vocabularyQuery.addEventListener("input", () => {
  window.clearTimeout(vocabularySearchTimer);
  vocabularySearchTimer = window.setTimeout(() => void loadVocabulary(), 160);
});

document.querySelectorAll<HTMLButtonElement>("[data-vocabulary-order]").forEach((button) => {
  button.addEventListener("click", async () => {
    const mode = button.dataset.vocabularyOrder as VocabularyOrderMode;
    try {
      await setVocabularyOrderMode(mode);
    } catch (error) {
      vocabularyMessage.textContent = `切换浏览顺序失败：${String(error)}`;
    }
  });
});

importVocabularyButton.addEventListener("click", async () => {
  importVocabularyButton.disabled = true;
  try {
    const result = await invoke<VocabularyImportResult>("import_vocabulary");
    if (!result.cancelled) {
      vocabularyMessage.textContent = `导入完成：新增 ${result.added}，更新 ${result.updated}。`;
      await loadVocabulary();
    }
  } catch (error) {
    vocabularyMessage.textContent = `导入失败，原有数据未改变：${String(error)}`;
  } finally {
    importVocabularyButton.disabled = false;
  }
});

exportVocabularyButton.addEventListener("click", async () => {
  exportVocabularyButton.disabled = true;
  try {
    const result = await invoke<VocabularyExportResult>("export_vocabulary");
    if (!result.cancelled) vocabularyMessage.textContent = `已导出 ${result.exported} 个词条。`;
  } catch (error) {
    vocabularyMessage.textContent = `导出失败：${String(error)}`;
  } finally {
    exportVocabularyButton.disabled = false;
  }
});

toggleButton.addEventListener("click", async () => {
  toggleButton.disabled = true;
  try {
    const next = await invoke<RuntimeState>("set_auto_translate", {
      enabled: !runtimeState.autoTranslateEnabled,
    });
    renderRuntime(next);
  } catch (error) {
    mainMessage.textContent = `状态切换失败：${String(error)}`;
    toggleButton.disabled = false;
  }
});

document.querySelectorAll<HTMLButtonElement>("[data-mock]").forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      await invoke("show_mock_translation", {
        scenario: button.dataset.mock as MockScenario,
      });
      mainMessage.textContent = "已发送 Mock 状态到翻译浮窗。";
    } catch (error) {
      mainMessage.textContent = `Mock 触发失败：${String(error)}`;
    }
  });
});

readClipboardButton.addEventListener("click", async () => {
  readClipboardButton.disabled = true;
  mainMessage.textContent = "正在读取当前剪贴板…";
  try {
    const diagnostic = await invoke<ClipboardUnicodeDiagnostic>("read_current_clipboard_unicode");
    renderClipboardDiagnostic(diagnostic);
    mainMessage.textContent = diagnostic.result === "success"
      ? "Clipboard Unicode reader 读取成功。"
      : `Clipboard Unicode reader 读取失败：${diagnostic.reasonCode}`;
  } catch (error) {
    mainMessage.textContent = `Clipboard Unicode reader 调用失败：${String(error)}`;
  } finally {
    readClipboardButton.disabled = false;
  }
});

sendGatewayButton.addEventListener("click", async () => {
  sendGatewayButton.disabled = true;
  renderGateway({ ...gatewayState, connectionState: "sending", parseStatus: "notAttempted" });
  mainMessage.textContent = "正在发送真实 Gateway 请求…";
  try {
    const next = await invoke<GatewayTestState>("send_latest_target_to_gateway");
    renderGateway(next);
    mainMessage.textContent = next.connectionState === "success"
      ? "Gateway 请求和严格解析成功。"
      : `Gateway 请求失败：${next.errorCode ?? "unknown"}`;
  } catch (error) {
    mainMessage.textContent = `Gateway 命令调用失败：${String(error)}`;
    renderGateway({ ...gatewayState, connectionState: "failed" });
  }
});

verifyAccessButton.addEventListener("click", async () => {
  const accessCode = accessCodeInput.value.trim();
  accessCodeUiState = "verifying";
  renderAccessCodeState();
  mainMessage.textContent = "正在验证访问码…";
  try {
    const result = await invoke<GatewayAccessVerificationResult>("verify_and_save_access_code", { accessCode });
    settingsState = { ...settingsState, gatewayAccessConfigured: result.gatewayAccessConfigured };
    if (result.success) {
      accessCodeInput.value = "";
      renderSettings(settingsState, "success");
      mainMessage.textContent = "访问码已成功设置，可以直接划词翻译。";
    } else {
      renderSettings(settingsState, "failure");
      mainMessage.textContent = settingsState.gatewayAccessConfigured
        ? "新访问码验证失败，原有访问码仍保留。"
        : "访问码验证失败，请检查后重试。";
    }
  } catch {
    renderSettings(settingsState, "failure");
    mainMessage.textContent = settingsState.gatewayAccessConfigured
      ? "访问码验证未完成，原有访问码仍保留。"
      : "访问码验证未完成，请稍后重试。";
  }
});

async function initialize(): Promise<void> {
  await listen<RuntimeState>(EVENTS.autoTranslateChanged, (event) => renderRuntime(event.payload));
  await listen<MainSection>(EVENTS.mainSectionChanged, (event) => renderSection(event.payload));
  await listen<TargetDiagnostics>(EVENTS.targetCaptureDiagnostic, (event) => renderDiagnostic(event.payload));
  await listen<GatewayTestState>(EVENTS.gatewayTargetChanged, (event) => renderGateway(event.payload));
  await listen(EVENTS.vocabularyChanged, () => void loadVocabulary());
  const tasks = await Promise.allSettled([
    invoke<RuntimeState>("get_runtime_state"),
    invoke<SettingsView>("get_settings"),
    invoke<TargetDiagnostics>("get_target_capture_diagnostic"),
    invoke<GatewayTestState>("get_gateway_test_state"),
  ]);
  const [runtime, settings, diagnostic, gateway] = tasks;
  if (runtime.status === "fulfilled") renderRuntime(runtime.value as RuntimeState);
  if (settings.status === "fulfilled") renderSettings(settings.value as SettingsView);
  if (diagnostic.status === "fulfilled") renderDiagnostic(diagnostic.value as TargetDiagnostics);
  if (gateway.status === "fulfilled") renderGateway(gateway.value as GatewayTestState);
  const failures = tasks.filter((task) => task.status === "rejected");
  if (failures.length) mainMessage.textContent = `有 ${failures.length} 个初始化区域读取失败，请查看对应状态。`;
}

void initialize().catch((error) => {
  mainMessage.textContent = `初始化失败：${String(error)}`;
});
