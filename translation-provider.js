(function initializeLanguageProvider(globalScope) {
  const DEFAULT_MOCK_DELAY_MS = 400;
  const MOCK_ERROR_TEXT = "mock-translation-error";
  const MOCK_TRANSLATIONS = Object.freeze({
    "add to vocabulary": "加入生词本",
    "context": "语境",
    "good morning": "早上好",
    "hello": "你好",
    "save current context": "保存当前语境",
    "translation": "翻译",
    "vocabulary": "词汇",
    "web vocabulary collector": "网页生词本",
    "world": "世界"
  });

  function createLanguageService(provider) {
    if (!provider || typeof provider.process !== "function") {
      throw new Error("Language provider must implement process(request, options).");
    }

    async function process(request, options) {
      const normalizedRequest = normalizeLanguageRequest(request);
      if (!normalizedRequest.text) {
        throw createLanguageError("EMPTY_TEXT", "处理文本不能为空");
      }

      const result = await provider.process(normalizedRequest, options || {});
      return normalizeProviderResult(result);
    }

    return {
      providerId: normalizeText(provider.id) || "unknown",
      process,

      // Stage4/Stage5 compatibility: existing callers can continue to use translate().
      translate(request, options) {
        return process(request, options);
      },

      getActiveMode() {
        return typeof provider.getActiveMode === "function"
          ? provider.getActiveMode()
          : Promise.resolve("baidu");
      },

      getActiveModeInfo() {
        if (typeof provider.getActiveModeInfo === "function") {
          return provider.getActiveModeInfo();
        }
        return this.getActiveMode().then((activeProvider) => ({
          provider: activeProvider,
          resultType: "quickTranslation"
        }));
      },

      cancelRequests(requestIds) {
        return typeof provider.cancelRequests === "function"
          ? provider.cancelRequests(normalizeRequestIds(requestIds))
          : 0;
      }
    };
  }

  function createMockTranslationProvider(options) {
    const providerOptions = options || {};
    const delayMs = Number.isFinite(providerOptions.delayMs)
      ? Math.max(0, providerOptions.delayMs)
      : DEFAULT_MOCK_DELAY_MS;
    const pendingRequests = new Map();

    return {
      id: "mock",

      translate(request) {
        const text = normalizeText(request && request.text);
        const lookupKey = normalizeLookupKey(text);
        const requestId = normalizeText(request && request.requestId);

        return new Promise((resolve, reject) => {
          const timerId = globalScope.setTimeout(() => {
            if (requestId) {
              pendingRequests.delete(requestId);
            }
            if (lookupKey === MOCK_ERROR_TEXT) {
              reject(createLanguageError("MOCK_ERROR", "Mock 翻译失败"));
              return;
            }

            resolve({
              provider: "mock",
              resultType: "quickTranslation",
              translatedText: MOCK_TRANSLATIONS[lookupKey] || `模拟译文：${text}`
            });
          }, delayMs);
          if (requestId) {
            pendingRequests.set(requestId, { timerId, reject });
          }
        });
      },

      cancelRequest(requestId) {
        const normalizedRequestId = normalizeText(requestId);
        const pending = pendingRequests.get(normalizedRequestId);
        if (!pending) {
          return false;
        }
        globalScope.clearTimeout(pending.timerId);
        pendingRequests.delete(normalizedRequestId);
        pending.reject(createLanguageError("REQUEST_CANCELLED", "处理请求已取消"));
        return true;
      }
    };
  }

  function createConfiguredLanguageProvider(options) {
    const providerOptions = options || {};
    const storageArea = providerOptions.storageArea || chrome.storage.local;
    const mockProvider = providerOptions.mockProvider || createMockTranslationProvider();
    const baiduProvider = providerOptions.baiduProvider;
    const deepSeekProvider = providerOptions.deepSeekProvider;
    const geminiProvider = providerOptions.geminiProvider;
    const gatewayProvider = providerOptions.gatewayProvider || null;

    if (!baiduProvider || typeof baiduProvider.translate !== "function") {
      throw new Error("Configured provider requires a Baidu provider.");
    }
    if (!geminiProvider || typeof geminiProvider.analyze !== "function") {
      throw new Error("Configured provider requires a Gemini provider.");
    }
    if (!deepSeekProvider || typeof deepSeekProvider.analyze !== "function") {
      throw new Error("Configured provider requires a DeepSeek provider.");
    }
    const registryEntries = {
      baidu: Object.freeze({
        resultType: "quickTranslation",
        execute: async (request) => {
          const result = await baiduProvider.translate(request);
          return { ...result, provider: "baidu", resultType: "quickTranslation" };
        },
        cancel: (requestId) => cancelProviderRequest(baiduProvider, requestId)
      }),
      deepseek: Object.freeze({
        resultType: "contextAnalysis",
        execute: (request) => deepSeekProvider.analyze(toAiLanguageRequest(request)),
        cancel: (requestId) => cancelProviderRequest(deepSeekProvider, requestId)
      }),
      gemini: Object.freeze({
        resultType: "contextAnalysis",
        execute: (request) => geminiProvider.analyze(toAiLanguageRequest(request)),
        cancel: (requestId) => cancelProviderRequest(geminiProvider, requestId)
      }),
      mock: Object.freeze({
        resultType: "quickTranslation",
        execute: (request) => mockProvider.translate(request),
        cancel: (requestId) => cancelProviderRequest(mockProvider, requestId)
      })
    };

    if (gatewayProvider && typeof gatewayProvider.process === "function") {
      registryEntries.gateway = Object.freeze({
        resultType: "contextAnalysis",
        execute: (request, processOptions) => gatewayProvider.process(request, processOptions || {}),
        cancel: (requestId) => cancelProviderRequest(gatewayProvider, requestId)
      });
    }

    const providerRegistry = Object.freeze(registryEntries);

    async function getActiveMode() {
      const settings = await readSettings(storageArea);
      return normalizeProviderId(settings.provider, providerRegistry);
    }

    async function getActiveModeInfo() {
      const provider = await getActiveMode();
      return {
        provider,
        resultType: providerRegistry[provider].resultType
      };
    }

    return {
      id: "configured",
      getActiveMode,
      getActiveModeInfo,
      providerRegistry,

      cancelRequests(requestIds) {
        let cancelledCount = 0;
        normalizeRequestIds(requestIds).forEach((requestId) => {
          Object.values(providerRegistry).forEach((entry) => {
            if (typeof entry.cancel === "function" && entry.cancel(requestId)) {
              cancelledCount += 1;
            }
          });
        });
        return cancelledCount;
      },

      async process(request, processOptions) {
        const providerOverride = normalizeText(processOptions && processOptions.providerOverride);
        const providerId = providerOverride
          ? normalizeProviderId(providerOverride, providerRegistry)
          : await getActiveMode();
        return providerRegistry[providerId].execute(request, processOptions || {});
      }
    };
  }

  function toAiLanguageRequest(request) {
    return {
      targetText: request.text,
      contextSentence: request.contextSentence,
      pageTitle: request.pageTitle,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      requestType: request.requestType,
      analysisMode: request.analysisMode,
      requestId: request.requestId,
      userQuestion: request.userQuestion
    };
  }

  function normalizeProviderResult(result) {
    const resultType = normalizeText(result && result.resultType) || "quickTranslation";
    const provider = normalizeText(result && result.provider) || "unknown";

    if (resultType === "contextAnalysis") {
      const skill = globalScope.aiContextSkill;
      if (!skill || typeof skill.validateAnalysis !== "function") {
        throw createLanguageError("SKILL_UNAVAILABLE", "语境解析校验模块不可用");
      }
      const analysisMode = normalizeAnalysisMode(result && result.analysisMode);
      return {
        provider,
        requestId: normalizeText(result && result.requestId),
        upstreamProvider: normalizeText(result && result.upstreamProvider),
        resultType,
        skillVersion: normalizeText(result && result.skillVersion) || skill.skillVersion,
        analysisMode,
        analysis: skill.validateAnalysis(result && result.analysis, analysisMode),
        ...(result && result.cached ? { cached: true } : {})
      };
    }

    if (resultType === "sentenceTranslation") {
      const skill = globalScope.sentenceTranslationSkill;
      if (!skill || typeof skill.validateTranslation !== "function") {
        throw createLanguageError("SKILL_UNAVAILABLE", "句段翻译校验模块不可用");
      }
      const translation = skill.validateTranslation({
        translation: result && result.translation,
        keyTerm: result && result.keyTerm
      });
      return {
        provider,
        requestId: normalizeText(result && result.requestId),
        upstreamProvider: normalizeText(result && result.upstreamProvider),
        resultType,
        skillVersion: normalizeText(result && result.skillVersion) || skill.skillVersion,
        translation: translation.translation,
        keyTerm: translation.keyTerm,
        ...(result && result.cached ? { cached: true } : {})
      };
    }

    const translatedText = normalizeText(result && result.translatedText);
    if (!translatedText) {
      throw createLanguageError("EMPTY_RESULT", "翻译服务返回了空结果");
    }
    return {
      provider,
      requestId: normalizeText(result && result.requestId),
      upstreamProvider: normalizeText(result && result.upstreamProvider),
      resultType: "quickTranslation",
      translatedText,
      ...(result && result.cached ? { cached: true } : {})
    };
  }

  function readSettings(storageArea) {
    return new Promise((resolve, reject) => {
      storageArea.get({ translationSettings: {} }, (result) => {
        const runtimeError = globalScope.chrome && globalScope.chrome.runtime
          ? globalScope.chrome.runtime.lastError
          : null;
        if (runtimeError) {
          reject(createLanguageError("STORAGE_ERROR", "无法读取语言服务设置"));
          return;
        }
        const settings = result && result.translationSettings;
        resolve(settings && typeof settings === "object" ? settings : {});
      });
    });
  }

  function normalizeLanguageRequest(request) {
    const payload = request || {};
    return {
      text: normalizeText(payload.text || payload.targetText),
      contextSentence: normalizeText(payload.contextSentence),
      pageTitle: normalizeText(payload.pageTitle),
      sourceLanguage: normalizeText(payload.sourceLanguage) || "en",
      targetLanguage: normalizeText(payload.targetLanguage) || "zh-CN",
      requestType: normalizeRequestType(payload.requestType),
      analysisMode: normalizeAnalysisMode(payload.analysisMode),
      requestId: normalizeText(payload.requestId),
      userQuestion: normalizeText(payload.userQuestion)
    };
  }

  function normalizeAnalysisMode(value) {
    return normalizeText(value).toLocaleLowerCase() === "detail" ? "detail" : "quick";
  }

  function normalizeRequestType(value) {
    return normalizeText(value) === "sentenceTranslation"
      ? "sentenceTranslation"
      : "wordAnalysis";
  }

  function normalizeProviderId(value, providerRegistry) {
    const providerId = normalizeText(value).toLocaleLowerCase();
    return providerRegistry && providerRegistry[providerId] ? providerId : "baidu";
  }

  function normalizeLookupKey(value) {
    return normalizeText(value).replace(/\s+/g, " ").toLocaleLowerCase();
  }

  function normalizeRequestIds(requestIds) {
    if (!Array.isArray(requestIds)) {
      return [];
    }
    return [...new Set(requestIds.map(normalizeText).filter(Boolean))];
  }

  function cancelProviderRequest(provider, requestId) {
    return !!(provider && typeof provider.cancelRequest === "function" && provider.cancelRequest(requestId));
  }

  function createLanguageError(code, publicMessage) {
    const error = new Error(publicMessage);
    error.name = "LanguageServiceError";
    error.code = code;
    error.publicMessage = publicMessage;
    return error;
  }

  function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  globalScope.translationProviderFactory = Object.freeze({
    createConfiguredLanguageProvider,
    createMockTranslationProvider,
    createLanguageService,
    createTranslationService: createLanguageService
  });

  const baiduFactory = globalScope.baiduTranslationProviderFactory;
  const deepSeekFactory = globalScope.deepSeekContextProviderFactory;
  const geminiFactory = globalScope.geminiContextProviderFactory;
  const gatewayFactory = globalScope.gatewayLanguageProviderFactory;
  if (!baiduFactory || typeof baiduFactory.createBaiduTranslationProvider !== "function") {
    throw new Error("Baidu translation provider is unavailable.");
  }
  if (!geminiFactory || typeof geminiFactory.createGeminiContextProvider !== "function") {
    throw new Error("Gemini context provider is unavailable.");
  }
  if (!deepSeekFactory || typeof deepSeekFactory.createDeepSeekContextProvider !== "function") {
    throw new Error("DeepSeek context provider is unavailable.");
  }
  const baiduProvider = baiduFactory.createBaiduTranslationProvider();
  const deepSeekProvider = deepSeekFactory.createDeepSeekContextProvider();
  const geminiProvider = geminiFactory.createGeminiContextProvider();
  const gatewayProvider = gatewayFactory && typeof gatewayFactory.createGatewayLanguageProvider === "function"
    ? gatewayFactory.createGatewayLanguageProvider()
    : null;
  const configuredProvider = createConfiguredLanguageProvider({
    baiduProvider,
    deepSeekProvider,
    geminiProvider,
    gatewayProvider
  });
  const languageService = createLanguageService(configuredProvider);

  globalScope.baiduTranslationProvider = baiduProvider;
  globalScope.deepSeekContextProvider = deepSeekProvider;
  globalScope.geminiContextProvider = geminiProvider;
  if (gatewayProvider) {
    globalScope.gatewayLanguageProvider = gatewayProvider;
  }
  globalScope.languageService = languageService;
  globalScope.translationService = languageService;
})(self);
