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
    const sentenceSkill = providerOptions.sentenceSkill || globalScope.sentenceTranslationSkill;
    const timeoutMs = Number.isFinite(providerOptions.timeoutMs)
      ? Math.max(1, providerOptions.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
    const cache = new Map();
    let activeController = null;
    let activeClientRequestId = "";
    let requestSequence = 0;

    if (!skill || typeof skill.buildInput !== "function" || typeof skill.validateAnalysis !== "function") {
      throw new Error("DeepSeek provider requires the AI context skill.");
    }

    async function analyze(rawRequest) {
      const requestType = normalizeRequestType(rawRequest && rawRequest.requestType);
      const activeSkill = requestType === "sentenceTranslation" ? sentenceSkill : skill;
      if (requestType === "sentenceTranslation" && (!activeSkill || typeof activeSkill.buildInput !== "function" || typeof activeSkill.validateTranslation !== "function")) {
        throw new Error("DeepSeek provider requires the sentence translation skill for sentenceTranslation requests.");
      }
      const input = activeSkill.buildInput(rawRequest);
      const settings = await readSettings(storageArea);
      const apiKey = normalizeText(settings.deepseekApiKey);
      const model = normalizeText(settings.deepseekModel) || DEFAULT_MODEL;
      const analysisMode = requestType === "sentenceTranslation" ? "quick" : skill.normalizeAnalysisMode
        ? skill.normalizeAnalysisMode(rawRequest && rawRequest.analysisMode)
        : normalizeAnalysisMode(rawRequest && rawRequest.analysisMode);
      const clientRequestId = normalizeText(rawRequest && rawRequest.requestId);

      if (!apiKey) {
        throw createProviderError("CONFIG_MISSING", "请先配置 DeepSeek API Key", {
          requiresConfiguration: true
        });
      }

      const cacheKey = createCacheKey(input, model, activeSkill.skillVersion, analysisMode, requestType);
      if (cache.has(cacheKey)) {
        return { ...cache.get(cacheKey), cached: true };
      }

      if (activeController) {
        activeController.abort();
      }

      const controller = new AbortController();
      activeController = controller;
      activeClientRequestId = clientRequestId;
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
            body: JSON.stringify(createRequestBody(input, model, activeSkill, analysisMode, requestType)),
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

          const analysis = requestType === "sentenceTranslation"
            ? activeSkill.validateTranslation(parsed)
            : activeSkill.validateAnalysis(parsed, analysisMode);
          const result = requestType === "sentenceTranslation"
            ? {
              provider: "deepseek",
              resultType: "sentenceTranslation",
              skillVersion: activeSkill.skillVersion,
              translation: analysis.translation,
              keyTerm: analysis.keyTerm
            }
            : {
              provider: "deepseek",
              resultType: "contextAnalysis",
              skillVersion: activeSkill.skillVersion,
              analysisMode,
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
          activeClientRequestId = "";
        }
      }
    }

    function cancelRequest(requestId) {
      if (!activeController || !activeClientRequestId || activeClientRequestId !== normalizeText(requestId)) {
        return false;
      }
      activeController.abort();
      return true;
    }

    function reset() {
      if (activeController) {
        activeController.abort();
        activeController = null;
        activeClientRequestId = "";
      }
      cache.clear();
    }

    return { id: "deepseek", analyze, cancelRequest, reset };
  }

  function createRequestBody(input, model, skill, analysisMode, requestType) {
    if (normalizeRequestType(requestType) === "sentenceTranslation") {
      const sentenceExample = {
        translation: "研究人员通过电化学方法评估了该材料的性能。",
        keyTerm: {
          term: "electrochemical method",
          meaning: "电化学方法，利用电极反应或电化学信号进行测量、分析或调控的方法。"
        }
      };
      const jsonRules = [
        "You must return JSON only.",
        "Do not output Markdown, code fences, prose, or any text outside the JSON object.",
        "Return exactly translation and keyTerm. translation must be a non-empty natural Simplified Chinese translation.",
        "keyTerm must be null unless one technical term clearly blocks comprehension. When present, it must contain exactly term and meaning; never output a list.",
        "Do not provide IPA, part of speech, comparison, word-choice analysis, or detailed explanation.",
        `Sentence Translation JSON example: ${JSON.stringify(sentenceExample)}`,
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
    const mode = normalizeAnalysisMode(analysisMode);
    const quickExample = {
      word: "employed",
      lemma: "employ",
      phonetic: "/ɪmˈplɔɪ/",
      partOfSpeech: "v.",
      meaning: "使用；采用"
    };
    const detailExample = {
      meaningInSentence: "使用；采用。",
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
    const modeRules = mode === "detail" ? [
      "Mode: detail.",
      "The JSON must contain exactly these fields: meaningInSentence, comparison.",
      "AI must not complete understanding for the user; provide only minimal anchors that help the user continue reading.",
      "meaningInSentence must be a brief Simplified Chinese string explaining what the selected word means in the current sentence.",
      "meaningInSentence must answer only: What does this selected word mean in this sentence?",
      "meaningInSentence must explain only the queried word itself, not the whole sentence.",
      "Do not restate the subject, experimental object, research content, paper background, or professional knowledge.",
      "Keep meaningInSentence as short as possible, preferably within 20 Chinese characters.",
      "Bad meaningInSentence example: 表示LLM识别并理解缺陷的含义、类型或原因。",
      "Good meaningInSentence example: 解释；解读。",
      "Bad meaningInSentence example: 表示增材制造技术经过发展后进入工业生产领域，成为重要技术选择。",
      "Good meaningInSentence example: 逐渐出现；显现。",
      "comparison is a semantic difference, not a reason analysis and not an author-intention analysis.",
      "comparison must contain exactly word and difference for one close synonym only when an obvious semantic distinction exists; otherwise return null.",
      `Comparison examples: ${comparisonExamples}`,
      "Do not explain why the author chose the word.",
      "Do not write phrases like 'therefore this word is used here'.",
      "Do not output author intention, paper background expansion, long summary, writing advice, synonym lists, or contextReason.",
      `Detail JSON example: ${JSON.stringify(detailExample)}`
    ] : [
      "Mode: quick.",
      "The JSON must contain exactly these five non-empty string fields: word, lemma, phonetic, partOfSpeech, meaning.",
      "lemma must be the true dictionary base form only; do not explain inflection.",
      "partOfSpeech must describe the word's actual function in the current sentence and be exactly one of adj., v., n., adv., prep., or phr.",
      "meaning must be the common Simplified Chinese meaning of the word; do not add a separate academic meaning field.",
      `Quick JSON example: ${JSON.stringify(quickExample)}`
    ];
    const jsonRules = [
      "You must return JSON only.",
      "Do not output Markdown, code fences, prose, or any text outside the JSON object.",
      ...modeRules,
      `Required JSON Schema: ${JSON.stringify(getModeSchema(skill, mode))}`
    ].join(" ");

    return {
      model,
      messages: [
        { role: "system", content: `${skill.instructions} ${jsonRules}` },
        { role: "user", content: JSON.stringify(createModeInput(skill.buildInput(input), mode)) }
      ],
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: false
    };
  }

  function createModeInput(input, analysisMode) {
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

  function normalizeAnalysisMode(value) {
    return normalizeText(value).toLocaleLowerCase() === "detail" ? "detail" : "quick";
  }

  function normalizeRequestType(value) {
    return normalizeText(value) === "sentenceTranslation"
      ? "sentenceTranslation"
      : "wordAnalysis";
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
