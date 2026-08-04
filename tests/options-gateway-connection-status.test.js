const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const projectRoot = path.resolve(__dirname, "..");
const optionsSource = fs.readFileSync(path.join(projectRoot, "options.js"), "utf8");

function createElement(id) {
  const classes = new Set();
  return {
    id,
    value: "",
    textContent: "",
    className: "",
    hidden: false,
    listeners: {},
    classList: {
      toggle(name, enabled) {
        if (enabled) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
      },
      contains(name) {
        return classes.has(name);
      }
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
  };
}

function createOptionsContext(initialSettings, verifyResponse) {
  const elements = new Map();
  const ids = [
    "providerSelect",
    "versionText",
    "modeStatus",
    "gatewayAccessTokenInput",
    "gatewayTokenHint",
    "gatewayStartButton",
    "gatewayStatus",
    "appIdInput",
    "appKeyInput",
    "appKeyHint",
    "baiduSaveButton",
    "baiduTestButton",
    "baiduClearButton",
    "baiduStatus",
    "baiduSection",
    "deepseekApiKeyInput",
    "deepseekModelInput",
    "deepseekKeyHint",
    "deepseekSaveButton",
    "deepseekTestButton",
    "deepseekClearButton",
    "deepseekStatus",
    "deepseekSection",
    "geminiApiKeyInput",
    "geminiModelInput",
    "geminiKeyHint",
    "geminiSaveButton",
    "geminiTestButton",
    "geminiClearButton",
    "geminiStatus",
    "geminiSection",
    "mockTestButton",
    "mockStatus",
    "mockSection"
  ];
  ids.forEach((id) => elements.set(id, createElement(id)));

  let settings = { ...(initialSettings || {}) };
  const sentMessages = [];
  const context = {
    console,
    document: {
      addEventListener() {},
      getElementById(id) {
        if (!elements.has(id)) {
          elements.set(id, createElement(id));
        }
        return elements.get(id);
      }
    },
    chrome: {
      runtime: {
        lastError: null,
        getManifest() {
          return { version: "1.0.4" };
        },
        sendMessage(message, callback) {
          sentMessages.push(message);
          callback(verifyResponse || { status: "ok" });
        }
      },
      storage: {
        local: {
          get(defaults, callback) {
            callback({ translationSettings: settings });
          },
          set(payload, callback) {
            settings = { ...(payload.translationSettings || {}) };
            callback();
          }
        }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(optionsSource, context);
  return {
    context,
    elements,
    sentMessages,
    getSettings: () => settings
  };
}

function testInitialConnectedState() {
  const harness = createOptionsContext({ gatewayAccessToken: "old-valid-token", provider: "gateway" });
  harness.context.loadSettings();
  assert.equal(harness.elements.get("gatewayStatus").textContent, "已连接，可以开始使用");
  assert.equal(harness.elements.get("gatewayTokenHint").textContent.includes("已保存测试访问码"), true);
  assert.equal(harness.elements.get("gatewayStatus").textContent.includes("old-valid-token"), false);
  assert.equal(harness.sentMessages.length, 0);
}

function testInitialDisconnectedState() {
  const harness = createOptionsContext({});
  harness.context.loadSettings();
  assert.equal(harness.elements.get("gatewayStatus").textContent, "");
  assert.equal(harness.elements.get("gatewayTokenHint").textContent.includes("尚未保存测试访问码"), true);
  assert.equal(harness.sentMessages.length, 0);
}

function testSuccessfulVerificationSavesToken() {
  const harness = createOptionsContext({}, { status: "ok" });
  harness.elements.get("gatewayAccessTokenInput").value = "new-valid-token";
  harness.context.verifyGatewayAccessToken();
  assert.equal(harness.getSettings().gatewayAccessToken, "new-valid-token");
  assert.equal(harness.getSettings().provider, "gateway");
  assert.equal(harness.elements.get("gatewayStatus").textContent, "已连接，可以开始使用");
  assert.equal(harness.elements.get("gatewayAccessTokenInput").value, "");
}

function testFailedVerificationWithoutOldToken() {
  const harness = createOptionsContext({}, { status: "error", message: "测试访问码无效" });
  harness.elements.get("gatewayAccessTokenInput").value = "bad-token";
  harness.context.verifyGatewayAccessToken();
  assert.equal(harness.getSettings().gatewayAccessToken, undefined);
  assert.equal(harness.elements.get("gatewayStatus").textContent, "测试访问码无效");
  assert.equal(harness.elements.get("gatewayStatus").classList.contains("is-error"), true);
}

function testFailedVerificationKeepsOldToken() {
  const harness = createOptionsContext(
    { gatewayAccessToken: "old-valid-token", provider: "gateway" },
    { status: "error", message: "测试访问码无效" }
  );
  harness.elements.get("gatewayAccessTokenInput").value = "bad-token";
  harness.context.verifyGatewayAccessToken();
  assert.equal(harness.getSettings().gatewayAccessToken, "old-valid-token");
  assert.equal(harness.elements.get("gatewayStatus").textContent, "新访问码验证失败，原有连接仍可使用");
  assert.equal(harness.elements.get("gatewayStatus").textContent.includes("bad-token"), false);

  harness.context.loadSettings();
  assert.equal(harness.elements.get("gatewayStatus").textContent, "已连接，可以开始使用");
}

testInitialConnectedState();
testInitialDisconnectedState();
testSuccessfulVerificationSavesToken();
testFailedVerificationWithoutOldToken();
testFailedVerificationKeepsOldToken();

console.log("options-gateway-connection-status-tests-ok");
