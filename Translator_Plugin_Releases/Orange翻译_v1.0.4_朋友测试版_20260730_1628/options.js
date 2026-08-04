const TRANSLATION_SETTINGS_KEY = "translationSettings";
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";

const providerSelect = document.getElementById("providerSelect");
const versionText = document.getElementById("versionText");
const modeStatus = document.getElementById("modeStatus");
const gatewayAccessTokenInput = document.getElementById("gatewayAccessTokenInput");
const gatewayTokenHint = document.getElementById("gatewayTokenHint");
const appIdInput = document.getElementById("appIdInput");
const appKeyInput = document.getElementById("appKeyInput");
const appKeyHint = document.getElementById("appKeyHint");
const deepseekApiKeyInput = document.getElementById("deepseekApiKeyInput");
const deepseekModelInput = document.getElementById("deepseekModelInput");
const deepseekKeyHint = document.getElementById("deepseekKeyHint");
const geminiApiKeyInput = document.getElementById("geminiApiKeyInput");
const geminiModelInput = document.getElementById("geminiModelInput");
const geminiKeyHint = document.getElementById("geminiKeyHint");

document.addEventListener("DOMContentLoaded", loadSettings);
providerSelect.addEventListener("change", saveProviderSelection);
document.getElementById("gatewayStartButton").addEventListener("click", verifyGatewayAccessToken);
document.getElementById("baiduSaveButton").addEventListener("click", saveBaiduSettings);
document.getElementById("baiduTestButton").addEventListener("click", () => testProvider("baidu"));
document.getElementById("baiduClearButton").addEventListener("click", clearBaiduSettings);
document.getElementById("deepseekSaveButton").addEventListener("click", saveDeepSeekSettings);
document.getElementById("deepseekTestButton").addEventListener("click", () => testProvider("deepseek"));
document.getElementById("deepseekClearButton").addEventListener("click", clearDeepSeekSettings);
document.getElementById("geminiSaveButton").addEventListener("click", saveGeminiSettings);
document.getElementById("geminiTestButton").addEventListener("click", () => testProvider("gemini"));
document.getElementById("geminiClearButton").addEventListener("click", clearGeminiSettings);
document.getElementById("mockTestButton").addEventListener("click", () => testProvider("mock"));

function loadSettings() {
  versionText.textContent = `v${chrome.runtime.getManifest().version}`;
  readSettings((settings) => {
    providerSelect.value = normalizeProvider(settings.provider);
    gatewayAccessTokenInput.value = "";
    appIdInput.value = normalizeText(settings.baiduAppId);
    appKeyInput.value = "";
    deepseekApiKeyInput.value = "";
    deepseekModelInput.value = normalizeText(settings.deepseekModel) || DEFAULT_DEEPSEEK_MODEL;
    geminiApiKeyInput.value = "";
    geminiModelInput.value = normalizeText(settings.geminiModel) || DEFAULT_GEMINI_MODEL;
    updateKeyHints(settings);
    updateProviderVisibility();
    renderModeStatus();
    renderGatewayConnectionStatus(settings);
  });
}

function verifyGatewayAccessToken() {
  const candidateToken = normalizeText(gatewayAccessTokenInput.value);
  if (!candidateToken) {
    showStatus("gatewayStatus", "请填写测试访问码", true);
    return;
  }

  readSettings((settings) => {
    showStatus("gatewayStatus", "正在验证测试访问码…", false);
    chrome.runtime.sendMessage({
      type: "TEST_LANGUAGE_PROVIDER",
      provider: "gateway",
      config: {
        gatewayAccessToken: candidateToken
      }
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error("Failed to verify Gateway token:", chrome.runtime.lastError.message);
        showGatewayVerificationFailure(settings, "验证失败，请查看扩展控制台");
        return;
      }
      if (!response || response.status !== "ok") {
        showGatewayVerificationFailure(settings, response && response.message ? response.message : "测试访问码无效");
        return;
      }
      writeSettings({
        ...settings,
        gatewayAccessToken: candidateToken,
        provider: "gateway"
      }, () => {
        gatewayAccessTokenInput.value = "";
        providerSelect.value = "gateway";
        updateKeyHints({ ...settings, gatewayAccessToken: candidateToken });
        updateProviderVisibility();
        renderModeStatus();
        showStatus("gatewayStatus", "已连接，可以开始使用", false);
      });
    });
  });
}

function saveDeepSeekSettings() {
  const newKey = normalizeText(deepseekApiKeyInput.value);
  const model = normalizeText(deepseekModelInput.value) || DEFAULT_DEEPSEEK_MODEL;
  readSettings((settings) => {
    const apiKey = newKey || normalizeText(settings.deepseekApiKey);
    if (!apiKey) {
      showStatus("deepseekStatus", "请填写 DeepSeek API Key", true);
      return;
    }
    writeSettings({
      ...settings,
      deepseekApiKey: apiKey,
      deepseekModel: model
    }, () => {
      deepseekApiKeyInput.value = "";
      deepseekModelInput.value = model;
      updateKeyHints({ ...settings, deepseekApiKey: apiKey });
      showStatus("deepseekStatus", "DeepSeek 配置已保存", false);
    });
  });
}

function saveProviderSelection() {
  updateProviderVisibility();
  readSettings((settings) => {
    writeSettings({ ...settings, provider: normalizeProvider(providerSelect.value) }, () => {
      renderModeStatus();
    });
  });
}

function saveBaiduSettings() {
  const appId = normalizeText(appIdInput.value);
  const newKey = normalizeText(appKeyInput.value);
  readSettings((settings) => {
    const appKey = newKey || normalizeText(settings.baiduAppKey);
    if (!appId || !appKey) {
      showStatus("baiduStatus", "请填写 APPID 和密钥", true);
      return;
    }
    writeSettings({
      ...settings,
      baiduAppId: appId,
      baiduAppKey: appKey
    }, () => {
      appKeyInput.value = "";
      updateKeyHints({ ...settings, baiduAppKey: appKey });
      showStatus("baiduStatus", "百度配置已保存", false);
    });
  });
}

function saveGeminiSettings() {
  const newKey = normalizeText(geminiApiKeyInput.value);
  const model = normalizeText(geminiModelInput.value) || DEFAULT_GEMINI_MODEL;
  readSettings((settings) => {
    const apiKey = newKey || normalizeText(settings.geminiApiKey);
    if (!apiKey) {
      showStatus("geminiStatus", "请填写 Gemini API Key", true);
      return;
    }
    writeSettings({
      ...settings,
      geminiApiKey: apiKey,
      geminiModel: model
    }, () => {
      geminiApiKeyInput.value = "";
      geminiModelInput.value = model;
      updateKeyHints({ ...settings, geminiApiKey: apiKey });
      showStatus("geminiStatus", "Gemini 配置已保存", false);
    });
  });
}

function clearBaiduSettings() {
  readSettings((settings) => {
    const nextSettings = { ...settings };
    delete nextSettings.baiduAppId;
    delete nextSettings.baiduAppKey;
    writeSettings(nextSettings, () => {
      appIdInput.value = "";
      appKeyInput.value = "";
      updateKeyHints(nextSettings);
      showStatus("baiduStatus", "百度配置已清除", false);
    });
  });
}

function clearGeminiSettings() {
  readSettings((settings) => {
    const nextSettings = { ...settings };
    delete nextSettings.geminiApiKey;
    delete nextSettings.geminiModel;
    writeSettings(nextSettings, () => {
      geminiApiKeyInput.value = "";
      geminiModelInput.value = DEFAULT_GEMINI_MODEL;
      updateKeyHints(nextSettings);
      showStatus("geminiStatus", "Gemini 配置已清除", false);
    });
  });
}

function clearDeepSeekSettings() {
  readSettings((settings) => {
    const nextSettings = { ...settings };
    delete nextSettings.deepseekApiKey;
    delete nextSettings.deepseekModel;
    writeSettings(nextSettings, () => {
      deepseekApiKeyInput.value = "";
      deepseekModelInput.value = DEFAULT_DEEPSEEK_MODEL;
      updateKeyHints(nextSettings);
      showStatus("deepseekStatus", "DeepSeek 配置已清除", false);
    });
  });
}

function testProvider(provider) {
  const statusId = `${provider}Status`;
  showStatus(statusId, ["deepseek", "gemini"].includes(provider) ? "正在测试语境解析…" : "正在测试…", false);
  chrome.runtime.sendMessage({ type: "TEST_LANGUAGE_PROVIDER", provider }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Failed to test provider:", chrome.runtime.lastError.message);
      showStatus(statusId, "测试失败，请查看扩展控制台", true);
      return;
    }
    if (!response || response.status !== "ok") {
      showStatus(statusId, response && response.message ? response.message : "测试失败", true);
      return;
    }
    if (response.resultType === "contextAnalysis" && response.analysis) {
      const summary = response.analysis.academicMeaning
        || response.analysis.contextualMeaning
        || response.analysis.meaning
        || "语境解析已返回";
      showStatus(statusId, `测试成功：${summary}`, false);
    } else {
      showStatus(statusId, `测试成功：${response.translatedText}`, false);
    }
  });
}

function updateProviderVisibility() {
  ["baidu", "deepseek", "gemini", "mock"].forEach((provider) => {
    document.getElementById(`${provider}Section`).hidden = providerSelect.value !== provider;
  });
}

function updateKeyHints(settings) {
  gatewayTokenHint.textContent = normalizeText(settings.gatewayAccessToken)
    ? "已保存测试访问码。重新输入并验证成功后会替换。"
    : "尚未保存测试访问码。";
  appKeyHint.textContent = normalizeText(settings.baiduAppKey)
    ? "已保存百度密钥。留空保存会保留现有密钥。"
    : "尚未保存百度密钥。";
  geminiKeyHint.textContent = normalizeText(settings.geminiApiKey)
    ? "已保存 Gemini API Key。留空保存会保留现有 Key。"
    : "尚未保存 Gemini API Key。";
  deepseekKeyHint.textContent = normalizeText(settings.deepseekApiKey)
    ? "已保存 DeepSeek API Key。留空保存会保留现有 Key。"
    : "尚未保存 DeepSeek API Key。";
}

function renderGatewayConnectionStatus(settings) {
  if (normalizeText(settings.gatewayAccessToken)) {
    showStatus("gatewayStatus", "已连接，可以开始使用", false);
    return;
  }

  showStatus("gatewayStatus", "", false);
}

function showGatewayVerificationFailure(settings, fallbackMessage) {
  if (normalizeText(settings.gatewayAccessToken)) {
    showStatus("gatewayStatus", "新访问码验证失败，原有连接仍可使用", true);
    return;
  }

  showStatus("gatewayStatus", fallbackMessage || "测试访问码无效", true);
}

function renderModeStatus() {
  const labels = {
    gateway: "Gateway Beta",
    baidu: "百度快速翻译",
    deepseek: "DeepSeek AI 语境解析",
    gemini: "Gemini AI 语境解析",
    mock: "Mock 测试"
  };
  modeStatus.textContent = `当前启用：${labels[providerSelect.value]}`;
  modeStatus.className = "configuration-status is-configured";
}

function readSettings(callback) {
  chrome.storage.local.get({ [TRANSLATION_SETTINGS_KEY]: {} }, (result) => {
    if (chrome.runtime.lastError) {
      console.error("Failed to read translation settings:", chrome.runtime.lastError.message);
      callback({});
      return;
    }
    const settings = result[TRANSLATION_SETTINGS_KEY];
    callback(settings && typeof settings === "object" ? settings : {});
  });
}

function writeSettings(settings, callback) {
  chrome.storage.local.set({ [TRANSLATION_SETTINGS_KEY]: settings }, () => {
    if (chrome.runtime.lastError) {
      console.error("Failed to save translation settings:", chrome.runtime.lastError.message);
      return;
    }
    if (callback) {
      callback();
    }
  });
}

function showStatus(elementId, message, isError) {
  const element = document.getElementById(elementId);
  element.textContent = message || "";
  element.classList.toggle("is-error", !!isError);
  element.classList.toggle("is-success", !isError && !!message);
}

function normalizeProvider(value) {
  const provider = normalizeText(value).toLocaleLowerCase();
  return ["gateway", "baidu", "deepseek", "gemini", "mock"].includes(provider) ? provider : "gateway";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}
