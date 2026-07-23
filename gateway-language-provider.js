(function initializeGatewayLanguageProvider(globalScope) {
  const GATEWAY_BASE_URL = "http://127.0.0.1:8000";
  const TRANSLATION_SETTINGS_KEY = "translationSettings";
  const REQUEST_TIMEOUT_MS = 30000;
  const MAX_PAGE_TITLE_LENGTH = 300;
  const MAX_TEXT_LENGTH = 5000;
  const MAX_CONTEXT_LENGTH = 5000;

  function createGatewayLanguageProvider(options) {
    const providerOptions = options || {};
    const storageArea = providerOptions.storageArea || chrome.storage.local;
    const fetchImpl = providerOptions.fetchImpl || globalScope.fetch.bind(globalScope);
    const setTimer = providerOptions.setTimer || globalScope.setTimeout.bind(globalScope);
    const clearTimer = providerOptions.clearTimer || globalScope.clearTimeout.bind(globalScope);
    const requestControllers = new Map();

    return {
      id: "gateway",

      async process(request, processOptions) {
        const settings = await readSettings(storageArea);
        const accessToken = normalizeText(
          processOptions && processOptions.gatewayAccessToken
            ? processOptions.gatewayAccessToken
            : settings.gatewayAccessToken
        );
        if (!accessToken) {
          throw createGatewayError("CONFIG_REQUIRED", "请先输入测试访问码", {
            requiresConfiguration: true
          });
        }

        const requestId = normalizeText(request && request.requestId) || createFallbackRequestId();
        const controller = new AbortController();
        const timeoutId = setTimer(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);
        requestControllers.set(requestId, controller);

        try {
          const response = await fetchImpl(`${GATEWAY_BASE_URL}/v1/language`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(createLanguageBody(request, requestId)),
            signal: controller.signal
          });
          return await readLanguageResponse(response, requestId);
        } catch (error) {
          if (isAbortError(error) || controller.signal.aborted) {
            const isTimeout = controller.signal.reason === "timeout";
            throw createGatewayError(
              isTimeout ? "REQUEST_TIMEOUT" : "REQUEST_CANCELLED",
              isTimeout ? "Gateway 请求超时，请重试" : "Gateway 请求已取消"
            );
          }
          if (error && (error.publicMessage || error.code)) {
            throw error;
          }
          throw createGatewayError("GATEWAY_NETWORK_ERROR", "无法连接 Gateway，请稍后重试");
        } finally {
          clearTimer(timeoutId);
          requestControllers.delete(requestId);
        }
      },

      async verifyAccessToken(candidateToken) {
        const accessToken = normalizeText(candidateToken);
        if (!accessToken) {
          throw createGatewayError("CONFIG_REQUIRED", "请先输入测试访问码", {
            requiresConfiguration: true
          });
        }

        const response = await fetchImpl(`${GATEWAY_BASE_URL}/v1/auth/verify`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });
        const payload = await readJson(response);
        if (!response.ok || !payload || payload.status !== "ok" || payload.access !== "granted") {
          throw createGatewayError(
            normalizeText(payload && payload.errorCode) || mapHttpStatusToCode(response.status),
            normalizeText(payload && payload.message) || "测试访问码无效",
            { requiresConfiguration: true, diagnostics: createDiagnostics(response.status, payload, "") }
          );
        }
        return { status: "ok", access: "granted" };
      },

      cancelRequest(requestId) {
        const normalizedRequestId = normalizeText(requestId);
        const controller = requestControllers.get(normalizedRequestId);
        if (!controller) {
          return false;
        }
        controller.abort("panel-closed");
        return true;
      },

      reset() {
        requestControllers.forEach((controller) => controller.abort("settings-changed"));
        requestControllers.clear();
      },

      getPendingRequestCount() {
        return requestControllers.size;
      },

      GATEWAY_BASE_URL
    };
  }

  function createLanguageBody(request, requestId) {
    const text = normalizeText(request && request.text);
    const contextSentence = normalizeText(request && request.contextSentence);
    if (text.length > MAX_TEXT_LENGTH || contextSentence.length > MAX_CONTEXT_LENGTH) {
      throw createGatewayError("INVALID_REQUEST", "请求字段不合法");
    }
    return {
      requestId,
      requestType: normalizeRequestType(request && request.requestType),
      analysisMode: normalizeAnalysisMode(request && request.analysisMode),
      sourceLanguage: normalizeText(request && request.sourceLanguage) || "en",
      targetLanguage: normalizeText(request && request.targetLanguage) || "zh-CN",
      text,
      contextSentence,
      pageTitle: limitText(normalizeText(request && request.pageTitle), MAX_PAGE_TITLE_LENGTH)
    };
  }

  async function readLanguageResponse(response, requestId) {
    const payload = await readJson(response);
    if (!response.ok || !payload || payload.status === "error") {
      throw createGatewayError(
        normalizeText(payload && payload.errorCode) || mapHttpStatusToCode(response && response.status),
        normalizeText(payload && payload.message) || "Gateway 请求失败",
        {
          requiresConfiguration: !!(payload && payload.requiresConfiguration),
          diagnostics: createDiagnostics(response && response.status, payload, requestId)
        }
      );
    }
    if (payload.status !== "ok" || !payload.data || typeof payload.data !== "object") {
      throw createGatewayError("GATEWAY_INVALID_RESPONSE", "Gateway 返回结构无效", {
        diagnostics: createDiagnostics(response && response.status, payload, requestId)
      });
    }
    if (normalizeText(payload.requestId) !== requestId) {
      throw createGatewayError("GATEWAY_REQUEST_ID_MISMATCH", "Gateway 响应标识不一致", {
        diagnostics: createDiagnostics(response && response.status, payload, requestId)
      });
    }
    return {
      ...payload.data,
      requestId
    };
  }

  async function readJson(response) {
    try {
      return response && typeof response.json === "function" ? await response.json() : {};
    } catch (error) {
      return {};
    }
  }

  function readSettings(storageArea) {
    return new Promise((resolve, reject) => {
      storageArea.get({ [TRANSLATION_SETTINGS_KEY]: {} }, (result) => {
        const runtimeError = globalScope.chrome && globalScope.chrome.runtime
          ? globalScope.chrome.runtime.lastError
          : null;
        if (runtimeError) {
          reject(createGatewayError("STORAGE_ERROR", "无法读取 Gateway 设置"));
          return;
        }
        const settings = result && result[TRANSLATION_SETTINGS_KEY];
        resolve(settings && typeof settings === "object" ? settings : {});
      });
    });
  }

  function createDiagnostics(httpStatus, payload, requestId) {
    return {
      provider: "gateway",
      httpStatus: Number.isFinite(httpStatus) ? httpStatus : 0,
      apiStatus: normalizeText(payload && payload.status),
      apiMessage: normalizeText(payload && payload.errorCode),
      requestId
    };
  }

  function mapHttpStatusToCode(status) {
    if (status === 400 || status === 422) return "INVALID_REQUEST";
    if (status === 401 || status === 403) return "INVALID_ACCESS_TOKEN";
    if (status === 408 || status === 504) return "REQUEST_TIMEOUT";
    if (status === 429) return "RATE_LIMITED";
    if (status === 502) return "UPSTREAM_INVALID_RESPONSE";
    if (status === 503) return "UPSTREAM_UNAVAILABLE";
    if (status >= 500) return "GATEWAY_SERVICE_ERROR";
    return "GATEWAY_ERROR";
  }

  function isAbortError(error) {
    return !!(error && error.name === "AbortError");
  }

  function normalizeRequestType(value) {
    return normalizeText(value) === "sentenceTranslation" ? "sentenceTranslation" : "wordAnalysis";
  }

  function normalizeAnalysisMode(value) {
    return normalizeText(value).toLocaleLowerCase() === "detail" ? "detail" : "quick";
  }

  function limitText(value, maxLength) {
    return normalizeText(value).slice(0, maxLength);
  }

  function createFallbackRequestId() {
    return `gateway-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function createGatewayError(code, publicMessage, options) {
    const errorOptions = options || {};
    const error = new Error(publicMessage || "Gateway 请求失败");
    error.name = "GatewayLanguageProviderError";
    error.code = code || "GATEWAY_ERROR";
    error.publicMessage = publicMessage || "Gateway 请求失败";
    error.requiresConfiguration = !!errorOptions.requiresConfiguration;
    error.diagnostics = errorOptions.diagnostics || null;
    return error;
  }

  function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  globalScope.gatewayLanguageProviderFactory = Object.freeze({
    GATEWAY_BASE_URL,
    createGatewayLanguageProvider
  });
})(self);
