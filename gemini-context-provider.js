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
    const sentenceSkill = providerOptions.sentenceSkill || globalScope.sentenceTranslationSkill;
    const cache = new Map();
    let activeController = null;
    let activeClientRequestId = "";

    if (!skill || typeof skill.buildInput !== "function" || typeof skill.validateAnalysis !== "function") {
      throw new Error("Gemini provider requires the AI context skill.");
    }

    return {
      id: "gemini",

      async analyze(request) {
        const requestType = normalizeRequestType(request && request.requestType);
        const activeSkill = requestType === "sentenceTranslation" ? sentenceSkill : skill;
        if (requestType === "sentenceTranslation" && (!activeSkill || typeof activeSkill.buildInput !== "function" || typeof activeSkill.validateTranslation !== "function")) {
          throw new Error("Gemini provider requires the sentence translation skill for sentenceTranslation requests.");
        }
        const input = activeSkill.buildInput(request);
        const settings = await readSettings(storageArea);
        const apiKey = normalizeText(settings.geminiApiKey);
        const model = normalizeModel(settings.geminiModel) || DEFAULT_MODEL;
        const analysisMode = requestType === "sentenceTranslation" ? "quick" : skill.normalizeAnalysisMode
          ? skill.normalizeAnalysisMode(request && request.analysisMode)
          : normalizeAnalysisMode(request && request.analysisMode);
        const clientRequestId = normalizeText(request && request.requestId);

        if (!apiKey) {
          throw createProviderError(
            "CONFIG_REQUIRED",
            "请先在插件设置中配置 Gemini API Key",
            { requiresConfiguration: true }
          );
        }

        const cacheKey = createCacheKey(input, model, activeSkill.skillVersion, analysisMode, requestType);
        if (cache.has(cacheKey)) {
          return createResult(cache.get(cacheKey), activeSkill, analysisMode, requestType, true);
        }

        if (activeController) {
          activeController.abort("superseded");
        }

        const requestId = createRequestId();
        const controller = new AbortController();
        activeController = controller;
        activeClientRequestId = clientRequestId;
        const timeoutId = setTimer(() => controller.abort("timeout"), timeoutMs);

        try {
          if (analysisMode === "detail") {
            console.info("GEMINI_DETAIL_REQUEST_START", {
              model,
              analysisMode,
              requestId: clientRequestId || requestId
            });
          }

          const response = await fetchImpl(GEMINI_INTERACTIONS_ENDPOINT, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey
            },
            body: JSON.stringify(createRequestBody(input, activeSkill, model, analysisMode, requestType)),
            signal: controller.signal
          });

          const responseData = await readResponseBody(response);
          if (analysisMode === "detail") {
            const diagnostics = createDiagnostics(
              requestId,
              response.status,
              responseData,
              input,
              apiKey,
              analysisMode
            );
            console.info("GEMINI_DETAIL_RESPONSE", {
              httpStatus: diagnostics.httpStatus,
              apiStatus: diagnostics.apiStatus,
              apiMessage: diagnostics.apiMessage,
              analysisMode,
              requestId: clientRequestId || requestId
            });
          }
          if (!response.ok) {
            throw mapHttpError(response.status, responseData, requestId, input, apiKey, analysisMode);
          }

          const analysisText = extractInteractionText(responseData, requestId, input, apiKey, analysisMode);
          let rawResult;
          try {
            rawResult = JSON.parse(analysisText);
          } catch (error) {
            throw createProviderError(
              "INVALID_JSON",
              "Gemini 返回的语境解析无法读取",
              { diagnostics: createDiagnostics(requestId, response.status, responseData, input, apiKey, analysisMode) }
            );
          }

          const result = requestType === "sentenceTranslation"
            ? activeSkill.validateTranslation(rawResult)
            : activeSkill.validateAnalysis(rawResult, analysisMode);
          cache.set(cacheKey, result);
          return createResult(result, activeSkill, analysisMode, requestType, false);
        } catch (error) {
          if (controller.signal.aborted || (error && error.name === "AbortError")) {
            const abortReason = controller.signal.reason;
            const isTimeout = abortReason === "timeout";
            const isPanelClosed = abortReason === "panel-closed";
            if (analysisMode === "detail") {
              console.info("GEMINI_DETAIL_REQUEST_ABORTED", {
                reason: isTimeout ? "timeout" : isPanelClosed ? "panel-closed" : "superseded",
                analysisMode,
                requestId: clientRequestId || requestId
              });
            }
            throw createProviderError(
              isTimeout ? "REQUEST_TIMEOUT" : isPanelClosed ? "REQUEST_CANCELLED" : "REQUEST_SUPERSEDED",
              isTimeout
                ? "Gemini 请求超时，请重试"
                : isPanelClosed ? "Gemini 请求已取消" : "Gemini 请求已被新的选词替换",
              { diagnostics: createDiagnostics(requestId, 0, {}, input, apiKey, analysisMode) }
            );
          }

          if (error && (error.publicMessage || error.code)) {
            throw error;
          }

          throw createProviderError(
            "NETWORK_ERROR",
            "无法连接 Gemini，请检查网络后重试",
            { diagnostics: createDiagnostics(requestId, 0, {}, input, apiKey, analysisMode) }
          );
        } finally {
          clearTimer(timeoutId);
          if (activeController === controller) {
            activeController = null;
            activeClientRequestId = "";
          }
        }
      },

      cancelRequest(requestId) {
        if (!activeController || !activeClientRequestId || activeClientRequestId !== normalizeText(requestId)) {
          return false;
        }
        activeController.abort("panel-closed");
        return true;
      },

      clearCache() {
        cache.clear();
      },

      reset() {
        cache.clear();
        if (activeController) {
          activeController.abort("settings-changed");
          activeController = null;
          activeClientRequestId = "";
        }
      }
    };

    function createResult(result, activeSkill, analysisMode, requestType, cached) {
      if (requestType === "sentenceTranslation") {
        return {
          provider: "gemini",
          resultType: "sentenceTranslation",
          skillVersion: activeSkill.skillVersion,
          translation: result.translation,
          keyTerm: result.keyTerm,
          cached
        };
      }
      return {
        provider: "gemini",
        resultType: "contextAnalysis",
        skillVersion: activeSkill.skillVersion,
        analysisMode,
        analysis: { ...result },
        cached
      };
    }
  }

  function createRequestBody(input, skill, model, analysisMode, requestType) {
    return {
      model: normalizeModel(model) || DEFAULT_MODEL,
      system_instruction: createModeInstructions(skill, analysisMode, requestType),
      input: JSON.stringify(createModeInput(input, analysisMode, requestType)),
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: toGeminiStructuredOutputSchema(getModeSchema(skill, analysisMode))
      },
      store: false
    };
  }

  function createModeInstructions(skill, analysisMode, requestType) {
    if (normalizeRequestType(requestType) === "sentenceTranslation") {
      const sentenceExample = {
        translation: "研究人员通过电化学方法评估了该材料的性能。",
        keyTerm: {
          term: "electrochemical method",
          meaning: "电化学方法，利用电极反应或电化学信号进行测量、分析或调控的方法。"
        }
      };
      return `${skill.instructions} Return JSON only with exactly translation and keyTerm. keyTerm must be null unless one technical term clearly blocks comprehension; when present it must contain exactly term and meaning, never a list. Sentence Translation must not provide IPA, part of speech, comparison, word-choice analysis, or extra explanation. Do not output Markdown, code fences, or text outside the JSON object. Sentence Translation JSON example: ${JSON.stringify(sentenceExample)}`;
    }
    const mode = normalizeAnalysisMode(analysisMode);
    const quickExample = {
      word: "employed",
      lemma: "employ",
      phonetic: "/ɪmˈplɔɪ/",
      partOfSpeech: "v.",
      meaning: "使用；采用"
    };
    const detailExample = {
      meaningInSentence: "表示将3D打印技术作为生产3D对象的制造手段使用。",
      comparison: {
        word: "apply",
        difference: "employ 强调把技术、工具作为手段使用；apply 强调把方法作用于具体对象。"
      }
    };
    const comparisonExamples = [
      "employ vs apply:",
      "employ emphasizes using a technology or tool as a means.",
      "apply emphasizes applying a method to a concrete object.",
      "reinforcing vs strengthening:",
      "reinforcing emphasizes enhancing an existing structure or performance.",
      "strengthening emphasizes making something stronger overall."
    ].join(" ");
    const modeRules = mode === "detail"
      ? [
        "Mode: detail.",
        "Return JSON only with exactly meaningInSentence and comparison.",
        "AI must not complete understanding for the user; provide only minimal anchors that help the user continue reading.",
        "meaningInSentence must briefly explain what the selected word means in the current sentence.",
        "comparison is a semantic difference, not a reason analysis and not an author-intention analysis.",
        "comparison must contain exactly word and difference for one close synonym only when an obvious semantic distinction exists; otherwise use null.",
        `Comparison examples: ${comparisonExamples}`,
        "Do not explain why the author chose the word.",
        "Do not write phrases like 'therefore this word is used here'.",
        "Do not output author intention, paper background expansion, long summary, writing advice, synonym lists, or contextReason.",
        `Detail JSON example: ${JSON.stringify(detailExample)}`
      ]
      : [
        "Mode: quick.",
        "Return JSON only with exactly word, lemma, phonetic, partOfSpeech, meaning.",
        "lemma must be the true dictionary base form only; do not explain inflection.",
        "partOfSpeech must describe the word's actual function in the current sentence, not its surface form.",
        "meaning must be the common Simplified Chinese meaning of the word; do not add a separate academic meaning field.",
        `Quick JSON example: ${JSON.stringify(quickExample)}`
      ];
    return `${skill.instructions} ${modeRules.join(" ")}`;
  }

  function createModeInput(input, analysisMode, requestType) {
    if (normalizeRequestType(requestType) === "sentenceTranslation") {
      return input;
    }
    if (normalizeAnalysisMode(analysisMode) === "detail") {
      return {
        word: input.targetText,
        sentence: input.contextSentence,
        context: input.pageTitle,
        userQuestion: input.userQuestion || "请详细解释该词在当前论文语境中的用法。"
      };
    }
    return input;
  }

  function getModeSchema(skill, analysisMode) {
    if (typeof skill.getOutputSchema === "function") {
      return skill.getOutputSchema(analysisMode);
    }
    return skill.outputSchema;
  }

  function toGeminiStructuredOutputSchema(schema) {
    if (Array.isArray(schema)) {
      return schema.map(toGeminiStructuredOutputSchema);
    }
    if (!schema || typeof schema !== "object") {
      return schema;
    }

    const converted = {};
    Object.keys(schema).forEach((key) => {
      const value = schema[key];
      converted[key] = toGeminiStructuredOutputSchema(value);
    });
    return converted;
  }

  function extractInteractionText(responseData, requestId, input, apiKey, analysisMode) {
    const interactionStatus = normalizeText(responseData && responseData.status).toLocaleLowerCase();

    if (interactionStatus !== "completed") {
      throw createInteractionStatusError(interactionStatus, responseData, requestId, input, apiKey, analysisMode);
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
      const diagnostics = createDiagnostics(requestId, 200, responseData, input, apiKey, analysisMode);
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

  function createInteractionStatusError(status, responseData, requestId, input, apiKey, analysisMode) {
    const diagnostics = createDiagnostics(requestId, 200, responseData, input, apiKey, analysisMode);
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

  function mapHttpError(status, responseData, requestId, input, apiKey, analysisMode) {
    const apiStatus = normalizeText(responseData && responseData.error && responseData.error.status);
    const errorOptions = {
      diagnostics: createDiagnostics(requestId, status, responseData, input, apiKey, analysisMode)
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

  function createDiagnostics(requestId, httpStatus, responseData, input, apiKey, analysisMode) {
    const apiError = responseData && responseData.error && typeof responseData.error === "object"
      ? responseData.error
      : {};
    return {
      provider: "gemini",
      httpStatus: Number.isFinite(httpStatus) ? httpStatus : 0,
      apiStatus: sanitizeDiagnosticValue(apiError.status, input, apiKey, 80),
      apiMessage: sanitizeDiagnosticValue(apiError.message, input, apiKey, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
      analysisMode: normalizeAnalysisMode(analysisMode),
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

  function createCacheKey(input, model, skillVersion, analysisMode, requestType) {
    return JSON.stringify([
      normalizeRequestType(requestType),
      normalizeAnalysisMode(analysisMode),
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

  function normalizeAnalysisMode(value) {
    return normalizeText(value).toLocaleLowerCase() === "detail" ? "detail" : "quick";
  }

  function normalizeRequestType(value) {
    return normalizeText(value) === "sentenceTranslation"
      ? "sentenceTranslation"
      : "wordAnalysis";
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
    toGeminiStructuredOutputSchema,
    sanitizeDiagnosticValue
  });
})(self);
