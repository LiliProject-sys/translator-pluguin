(function initializeGeminiContextProvider(globalScope) {
  const GEMINI_INTERACTIONS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
  const TRANSLATION_SETTINGS_KEY = "translationSettings";
  const DEFAULT_MODEL = "gemini-3.5-flash";
  const DEFAULT_TIMEOUT_MS = 20000;
  const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 240;
  let requestSequence = 0;

  function createGeminiContextProvider(options) {
    const providerOptions = options || {};
    const storageArea = providerOptions.storageArea || chrome.storage.local;
    const fetchImpl = providerOptions.fetchImpl || globalScope.fetch.bind(globalScope);
    const setTimer = providerOptions.setTimer || globalScope.setTimeout.bind(globalScope);
    const clearTimer = providerOptions.clearTimer || globalScope.clearTimeout.bind(globalScope);
    const timeoutMs = Number.isFinite(providerOptions.timeoutMs)
      ? Math.max(1, providerOptions.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
    const skill = providerOptions.skill || globalScope.aiContextSkill;
    const cache = new Map();
    let activeController = null;

    if (!skill || typeof skill.buildInput !== "function" || typeof skill.validateAnalysis !== "function") {
      throw new Error("Gemini provider requires the AI context skill.");
    }

    return {
      id: "gemini",

      async analyze(request) {
        const input = skill.buildInput(request);
        const settings = await readSettings(storageArea);
        const apiKey = normalizeText(settings.geminiApiKey);
        const model = normalizeModel(settings.geminiModel) || DEFAULT_MODEL;

        if (!apiKey) {
          throw createProviderError(
            "CONFIG_REQUIRED",
            "请先在插件设置中配置 Gemini API Key",
            { requiresConfiguration: true }
          );
        }

        const cacheKey = createCacheKey(input, model, skill.skillVersion);
        if (cache.has(cacheKey)) {
          return createResult(cache.get(cacheKey), true);
        }

        if (activeController) {
          activeController.abort("superseded");
        }

        const requestId = createRequestId();
        const controller = new AbortController();
        activeController = controller;
        const timeoutId = setTimer(() => controller.abort("timeout"), timeoutMs);

        try {
          const response = await fetchImpl(GEMINI_INTERACTIONS_ENDPOINT, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey
            },
            body: JSON.stringify(createRequestBody(input, skill, model)),
            signal: controller.signal
          });

          const responseData = await readResponseBody(response);
          if (!response.ok) {
            throw mapHttpError(response.status, responseData, requestId, input, apiKey);
          }

          const analysisText = extractInteractionText(responseData, requestId, input, apiKey);
          let rawAnalysis;
          try {
            rawAnalysis = JSON.parse(analysisText);
          } catch (error) {
            throw createProviderError(
              "INVALID_JSON",
              "Gemini 返回的语境解析无法读取",
              { diagnostics: createDiagnostics(requestId, response.status, responseData, input, apiKey) }
            );
          }

          const analysis = skill.validateAnalysis(rawAnalysis);
          cache.set(cacheKey, analysis);
          return createResult(analysis, false);
        } catch (error) {
          if (error && error.name === "AbortError") {
            const isTimeout = controller.signal.reason === "timeout";
            throw createProviderError(
              isTimeout ? "REQUEST_TIMEOUT" : "REQUEST_SUPERSEDED",
              isTimeout ? "Gemini 请求超时，请重试" : "Gemini 请求已被新的选词替换",
              { diagnostics: createDiagnostics(requestId, 0, {}, input, apiKey) }
            );
          }

          if (error && (error.publicMessage || error.code)) {
            throw error;
          }

          throw createProviderError(
            "NETWORK_ERROR",
            "无法连接 Gemini，请检查网络后重试",
            { diagnostics: createDiagnostics(requestId, 0, {}, input, apiKey) }
          );
        } finally {
          clearTimer(timeoutId);
          if (activeController === controller) {
            activeController = null;
          }
        }
      },

      clearCache() {
        cache.clear();
      },

      reset() {
        cache.clear();
        if (activeController) {
          activeController.abort("settings-changed");
          activeController = null;
        }
      }
    };

    function createResult(analysis, cached) {
      return {
        provider: "gemini",
        resultType: "contextAnalysis",
        skillVersion: skill.skillVersion,
        analysis: { ...analysis },
        cached
      };
    }
  }

  function createRequestBody(input, skill, model) {
    return {
      model: normalizeModel(model) || DEFAULT_MODEL,
      system_instruction: skill.instructions,
      input: JSON.stringify(input),
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: skill.outputSchema
      },
      store: false
    };
  }

  function extractInteractionText(responseData, requestId, input, apiKey) {
    const interactionStatus = normalizeText(responseData && responseData.status).toLocaleLowerCase();

    if (interactionStatus !== "completed") {
      throw createInteractionStatusError(interactionStatus, responseData, requestId, input, apiKey);
    }

    const steps = responseData && Array.isArray(responseData.steps) ? responseData.steps : [];
    const modelOutputSteps = steps.filter((step) => step && step.type === "model_output");
    const text = modelOutputSteps.flatMap((step) => {
      return Array.isArray(step.content) ? step.content : [];
    }).filter((content) => content && content.type === "text")
      .map((content) => normalizeText(content.text))
      .filter(Boolean)
      .join("");

    if (!text) {
      const diagnostics = createDiagnostics(requestId, 200, responseData, input, apiKey);
      if (isSafetyRefusal(responseData)) {
        throw createProviderError("CONTENT_BLOCKED", "Gemini 拒绝处理当前内容", { diagnostics });
      }
      if (modelOutputSteps.length === 0) {
        throw createProviderError("MODEL_OUTPUT_MISSING", "Gemini 未返回模型输出", { diagnostics });
      }
      throw createProviderError("EMPTY_RESPONSE", "Gemini 未返回语境解析结果", { diagnostics });
    }

    return text;
  }

  function createInteractionStatusError(status, responseData, requestId, input, apiKey) {
    const diagnostics = createDiagnostics(requestId, 200, responseData, input, apiKey);
    const statusErrors = {
      failed: ["INTERACTION_FAILED", "Gemini 处理失败，请重试"],
      incomplete: ["INTERACTION_INCOMPLETE", "Gemini 返回结果不完整，请重试"],
      cancelled: ["INTERACTION_CANCELLED", "Gemini 请求已取消，请重试"],
      budget_exceeded: ["BUDGET_EXCEEDED", "Gemini 处理预算不足，请稍后重试"],
      requires_action: ["REQUIRES_ACTION", "Gemini 请求需要当前插件不支持的额外操作"],
      in_progress: ["INTERACTION_IN_PROGRESS", "Gemini 请求尚未完成，请重试"]
    };

    if (isSafetyRefusal(responseData)) {
      return createProviderError("CONTENT_BLOCKED", "Gemini 拒绝处理当前内容", { diagnostics });
    }

    const selectedError = statusErrors[status]
      || ["INTERACTION_NOT_COMPLETED", "Gemini 未完成当前请求，请重试"];
    return createProviderError(selectedError[0], selectedError[1], { diagnostics });
  }

  async function readResponseBody(response) {
    try {
      return await response.json();
    } catch (error) {
      return {};
    }
  }

  function mapHttpError(status, responseData, requestId, input, apiKey) {
    const apiStatus = normalizeText(responseData && responseData.error && responseData.error.status);
    const errorOptions = {
      diagnostics: createDiagnostics(requestId, status, responseData, input, apiKey)
    };

    if (status === 400) {
      return createProviderError(
        "BAD_REQUEST",
        "Gemini 请求参数无效，请检查模型或请求配置",
        errorOptions
      );
    }
    if (status === 401 || status === 403) {
      return createProviderError(
        "AUTH_FAILED",
        "Gemini API Key 无效或没有访问权限",
        { ...errorOptions, requiresConfiguration: true }
      );
    }
    if (status === 404) {
      return createProviderError(
        "MODEL_NOT_FOUND",
        "Gemini 模型不存在或当前 Key 无权使用",
        { ...errorOptions, requiresConfiguration: true }
      );
    }
    if (status === 429 || apiStatus === "RESOURCE_EXHAUSTED") {
      return createProviderError(
        "RATE_LIMITED",
        "Gemini 请求过于频繁或额度不足，请稍后重试",
        errorOptions
      );
    }
    if (status >= 500) {
      return createProviderError(
        "SERVICE_ERROR",
        "Gemini 服务暂时不可用，请稍后重试",
        errorOptions
      );
    }
    return createProviderError("API_ERROR", "Gemini 请求失败，请稍后重试", errorOptions);
  }

  function createDiagnostics(requestId, httpStatus, responseData, input, apiKey) {
    const apiError = responseData && responseData.error && typeof responseData.error === "object"
      ? responseData.error
      : {};
    return {
      provider: "gemini",
      httpStatus: Number.isFinite(httpStatus) ? httpStatus : 0,
      apiStatus: sanitizeDiagnosticValue(apiError.status, input, apiKey, 80),
      apiMessage: sanitizeDiagnosticValue(apiError.message, input, apiKey, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
      requestId
    };
  }

  function sanitizeDiagnosticValue(value, input, apiKey, maxLength) {
    let safeValue = normalizeText(value).replace(/\s+/g, " ");
    const sensitiveValues = [
      input && input.targetText,
      input && input.contextSentence,
      input && input.pageTitle,
      apiKey
    ].map(normalizeText).filter((item) => item.length >= 3);

    sensitiveValues.forEach((sensitiveValue) => {
      safeValue = replaceAllLiteralIgnoreCase(safeValue, sensitiveValue, "[redacted]");
    });

    if (safeValue.length > maxLength) {
      return `${safeValue.slice(0, maxLength)}…`;
    }
    return safeValue;
  }

  function replaceAllLiteralIgnoreCase(value, searchValue, replacement) {
    if (!searchValue) {
      return value;
    }

    let result = value;
    let searchStart = 0;
    const normalizedSearch = searchValue.toLocaleLowerCase();
    while (searchStart < result.length) {
      const matchIndex = result.toLocaleLowerCase().indexOf(normalizedSearch, searchStart);
      if (matchIndex < 0) {
        break;
      }
      result = `${result.slice(0, matchIndex)}${replacement}${result.slice(matchIndex + searchValue.length)}`;
      searchStart = matchIndex + replacement.length;
    }
    return result;
  }

  function isSafetyRefusal(responseData) {
    const apiError = responseData && responseData.error && typeof responseData.error === "object"
      ? responseData.error
      : {};
    const combined = `${normalizeText(apiError.status)} ${normalizeText(apiError.message)}`.toLocaleLowerCase();
    if (["safety", "blocked", "blocklist", "prohibited", "refused"].some((term) => combined.includes(term))) {
      return true;
    }

    const steps = responseData && Array.isArray(responseData.steps) ? responseData.steps : [];
    return steps.some((step) => {
      const contentBlocks = step && Array.isArray(step.content) ? step.content : [];
      return contentBlocks.some((content) => {
        const contentType = normalizeText(content && content.type).toLocaleLowerCase();
        return ["refusal", "safety", "blocked", "prohibited_content"].includes(contentType);
      });
    });
  }

  function readSettings(storageArea) {
    return new Promise((resolve, reject) => {
      storageArea.get({ [TRANSLATION_SETTINGS_KEY]: {} }, (result) => {
        const runtimeError = globalScope.chrome && globalScope.chrome.runtime
          ? globalScope.chrome.runtime.lastError
          : null;
        if (runtimeError) {
          reject(createProviderError("STORAGE_ERROR", "无法读取 Gemini 设置"));
          return;
        }
        const settings = result && result[TRANSLATION_SETTINGS_KEY];
        resolve(settings && typeof settings === "object" ? settings : {});
      });
    });
  }

  function createCacheKey(input, model, skillVersion) {
    return JSON.stringify([
      normalizeText(input.targetText).toLocaleLowerCase(),
      normalizeText(input.contextSentence),
      normalizeText(input.pageTitle),
      model,
      skillVersion
    ]);
  }

  function normalizeModel(value) {
    return normalizeText(value).replace(/^models\//, "");
  }

  function createRequestId() {
    requestSequence += 1;
    return `gemini-${Date.now()}-${requestSequence}`;
  }

  function createProviderError(code, publicMessage, options) {
    const errorOptions = options || {};
    const error = new Error(publicMessage);
    error.name = "GeminiContextProviderError";
    error.code = code;
    error.publicMessage = publicMessage;
    error.requiresConfiguration = !!errorOptions.requiresConfiguration;
    error.diagnostics = errorOptions.diagnostics || null;
    return error;
  }

  function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  globalScope.geminiContextProviderFactory = Object.freeze({
    DEFAULT_MODEL,
    GEMINI_INTERACTIONS_ENDPOINT,
    createGeminiContextProvider,
    createRequestBody,
    extractInteractionText,
    sanitizeDiagnosticValue
  });
})(self);
