(function initializeDeepSeekContextProvider(globalScope) {
  const TRANSLATION_SETTINGS_KEY = "translationSettings";
  const DEEPSEEK_CHAT_ENDPOINT = "https://api.deepseek.com/chat/completions";
  const DEFAULT_MODEL = "deepseek-v4-flash";
  const DEFAULT_TIMEOUT_MS = 20000;
  const DEFAULT_MAX_TOKENS = 500;
  const MAX_EMPTY_CONTENT_RETRIES = 1;
  const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 240;

  function createDeepSeekContextProvider(options) {
    const providerOptions = options || {};
    const storageArea = providerOptions.storageArea || chrome.storage.local;
    const fetchImpl = providerOptions.fetchImpl || globalScope.fetch.bind(globalScope);
    const skill = providerOptions.skill || globalScope.aiContextSkill;
    const timeoutMs = Number.isFinite(providerOptions.timeoutMs)
      ? Math.max(1, providerOptions.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
    const cache = new Map();
    let activeController = null;
    let requestSequence = 0;

    if (!skill || typeof skill.buildInput !== "function" || typeof skill.validateAnalysis !== "function") {
      throw new Error("DeepSeek provider requires the AI context skill.");
    }

    async function analyze(rawRequest) {
      const input = skill.buildInput(rawRequest);
      const settings = await readSettings(storageArea);
      const apiKey = normalizeText(settings.deepseekApiKey);
      const model = normalizeText(settings.deepseekModel) || DEFAULT_MODEL;

      if (!apiKey) {
        throw createProviderError("CONFIG_MISSING", "请先配置 DeepSeek API Key", {
          requiresConfiguration: true
        });
      }

      const cacheKey = createCacheKey(input, model, skill.skillVersion);
      if (cache.has(cacheKey)) {
        return { ...cache.get(cacheKey), cached: true };
      }

      if (activeController) {
        activeController.abort();
      }

      const controller = new AbortController();
      activeController = controller;
      const requestId = `deepseek-${Date.now()}-${++requestSequence}`;
      let timedOut = false;
      const timeoutId = globalScope.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      try {
        let emptyContentAttempts = 0;
        while (true) {
          const response = await fetchImpl(DEEPSEEK_CHAT_ENDPOINT, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(createRequestBody(input, model, skill)),
            signal: controller.signal
          });
          const responseData = await readResponseBody(response);

          if (!response.ok) {
            throw mapHttpError(response.status, responseData, requestId, input, apiKey);
          }

          const choice = responseData && Array.isArray(responseData.choices)
            ? responseData.choices[0]
            : null;
          const finishReason = normalizeText(choice && choice.finish_reason).toLocaleLowerCase();
          assertCompletedChoice(finishReason, requestId);

          const content = normalizeText(choice && choice.message && choice.message.content);
          if (!content) {
            if (emptyContentAttempts < MAX_EMPTY_CONTENT_RETRIES) {
              emptyContentAttempts += 1;
              continue;
            }
            throw createProviderError("EMPTY_RESPONSE", "DeepSeek 返回了空结果，请重试", {
              diagnostics: createDiagnostics(requestId, 200, responseData, input, apiKey)
            });
          }

          let parsed;
          try {
            parsed = JSON.parse(content);
          } catch (error) {
            throw createProviderError("INVALID_JSON", "DeepSeek 返回的 JSON 无法解析", {
              diagnostics: createDiagnostics(requestId, 200, responseData, input, apiKey)
            });
          }

          const analysis = skill.validateAnalysis(parsed);
          const result = {
            provider: "deepseek",
            resultType: "contextAnalysis",
            skillVersion: skill.skillVersion,
            analysis
          };
          cache.set(cacheKey, result);
          return result;
        }
      } catch (error) {
        if (error && error.name === "AbortError") {
          throw timedOut
            ? createProviderError("REQUEST_TIMEOUT", "DeepSeek 请求超时，请重试")
            : createProviderError("REQUEST_CANCELLED", "DeepSeek 请求已取消");
        }
        if (error && error.publicMessage) {
          throw error;
        }
        throw createProviderError("NETWORK_ERROR", "无法连接 DeepSeek 服务，请检查网络");
      } finally {
        globalScope.clearTimeout(timeoutId);
        if (activeController === controller) {
          activeController = null;
        }
      }
    }

    function reset() {
      if (activeController) {
        activeController.abort();
        activeController = null;
      }
      cache.clear();
    }

    return { id: "deepseek", analyze, reset };
  }

  function createRequestBody(input, model, skill) {
    const example = {
      lemma: "employ",
      phonetic: "/ɪmˈplɔɪ/",
      partOfSpeech: "v.",
      commonMeaning: "雇用；使用",
      contextualMeaning: "论文语境中指采用某种方法"
    };
    const jsonRules = [
      "You must return JSON only.",
      "Do not output Markdown, code fences, prose, or any text outside the JSON object.",
      "The JSON must contain exactly these five non-empty string fields: lemma, phonetic, partOfSpeech, commonMeaning, contextualMeaning.",
      "The partOfSpeech value must be exactly one of adj., v., n., adv., prep., or phr.",
      `Five-field JSON example: ${JSON.stringify(example)}`,
      `Required JSON Schema: ${JSON.stringify(skill.outputSchema)}`
    ].join(" ");

    return {
      model,
      messages: [
        { role: "system", content: `${skill.instructions} ${jsonRules}` },
        { role: "user", content: JSON.stringify(skill.buildInput(input)) }
      ],
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: false
    };
  }

  function assertCompletedChoice(finishReason, requestId) {
    const diagnostics = {
      provider: "deepseek",
      httpStatus: 200,
      apiStatus: finishReason || "missing",
      apiMessage: "",
      requestId
    };
    const errors = {
      length: ["OUTPUT_TRUNCATED", "DeepSeek 输出被截断，请重试"],
      content_filter: ["CONTENT_BLOCKED", "DeepSeek 拒绝处理当前内容"],
      insufficient_system_resource: ["SERVICE_BUSY", "DeepSeek 服务资源不足，请稍后重试"],
      tool_calls: ["UNEXPECTED_TOOL_CALL", "DeepSeek 返回了当前流程不支持的工具调用"]
    };

    if (finishReason === "stop") {
      return;
    }
    const selected = errors[finishReason]
      || ["UNKNOWN_FINISH_REASON", "DeepSeek 未正常完成当前请求，请重试"];
    throw createProviderError(selected[0], selected[1], { diagnostics });
  }

  function mapHttpError(status, responseData, requestId, input, apiKey) {
    const apiError = responseData && responseData.error && typeof responseData.error === "object"
      ? responseData.error
      : {};
    const diagnostics = createDiagnostics(requestId, status, responseData, input, apiKey);
    const options = { diagnostics };

    if (status === 400) {
      return createProviderError("BAD_REQUEST", "DeepSeek 请求参数无效，请检查模型配置", options);
    }
    if (status === 401 || status === 403) {
      return createProviderError("AUTH_FAILED", "DeepSeek API Key 无效或没有访问权限", {
        ...options,
        requiresConfiguration: true
      });
    }
    if (status === 404) {
      return createProviderError("MODEL_NOT_FOUND", "DeepSeek 模型不存在或当前账号无权使用", {
        ...options,
        requiresConfiguration: true
      });
    }
    if (status === 429 || normalizeText(apiError.type).includes("rate")) {
      return createProviderError("RATE_LIMITED", "DeepSeek 请求过于频繁或额度不足，请稍后重试", options);
    }
    if (status >= 500) {
      return createProviderError("SERVICE_ERROR", "DeepSeek 服务暂时不可用，请稍后重试", options);
    }
    return createProviderError("API_ERROR", "DeepSeek 请求失败，请稍后重试", options);
  }

  function createDiagnostics(requestId, httpStatus, responseData, input, apiKey) {
    const apiError = responseData && responseData.error && typeof responseData.error === "object"
      ? responseData.error
      : {};
    return {
      provider: "deepseek",
      httpStatus: Number.isFinite(httpStatus) ? httpStatus : 0,
      apiStatus: sanitizeDiagnosticValue(apiError.type || apiError.code, input, apiKey, 80),
      apiMessage: sanitizeDiagnosticValue(apiError.message, input, apiKey, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
      requestId
    };
  }

  function sanitizeDiagnosticValue(value, input, apiKey, maxLength) {
    let safeValue = normalizeText(value).replace(/\s+/g, " ");
    [input && input.targetText, input && input.contextSentence, input && input.pageTitle, apiKey]
      .map(normalizeText)
      .filter((item) => item.length >= 3)
      .forEach((item) => {
        safeValue = replaceAllLiteralIgnoreCase(safeValue, item, "[redacted]");
      });
    return safeValue.length > maxLength ? `${safeValue.slice(0, maxLength)}…` : safeValue;
  }

  function replaceAllLiteralIgnoreCase(value, searchValue, replacement) {
    let result = value;
    let start = 0;
    const normalizedSearch = searchValue.toLocaleLowerCase();
    while (start < result.length) {
      const index = result.toLocaleLowerCase().indexOf(normalizedSearch, start);
      if (index < 0) break;
      result = `${result.slice(0, index)}${replacement}${result.slice(index + searchValue.length)}`;
      start = index + replacement.length;
    }
    return result;
  }

  function readSettings(storageArea) {
    return new Promise((resolve, reject) => {
      storageArea.get({ [TRANSLATION_SETTINGS_KEY]: {} }, (result) => {
        const runtimeError = globalScope.chrome && globalScope.chrome.runtime
          ? globalScope.chrome.runtime.lastError
          : null;
        if (runtimeError) {
          reject(createProviderError("STORAGE_ERROR", "无法读取 DeepSeek 设置"));
          return;
        }
        const settings = result && result[TRANSLATION_SETTINGS_KEY];
        resolve(settings && typeof settings === "object" ? settings : {});
      });
    });
  }

  async function readResponseBody(response) {
    try {
      return await response.json();
    } catch (error) {
      return {};
    }
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

  function createProviderError(code, publicMessage, options) {
    const errorOptions = options || {};
    const error = new Error(publicMessage);
    error.name = "DeepSeekContextProviderError";
    error.code = code;
    error.publicMessage = publicMessage;
    error.requiresConfiguration = !!errorOptions.requiresConfiguration;
    error.diagnostics = errorOptions.diagnostics || null;
    return error;
  }

  function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  globalScope.deepSeekContextProviderFactory = Object.freeze({
    DEFAULT_MODEL,
    DEFAULT_MAX_TOKENS,
    DEEPSEEK_CHAT_ENDPOINT,
    createDeepSeekContextProvider,
    createRequestBody,
    sanitizeDiagnosticValue
  });
})(self);
