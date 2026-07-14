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
      }
    };
  }

  function createMockTranslationProvider(options) {
    const providerOptions = options || {};
    const delayMs = Number.isFinite(providerOptions.delayMs)
      ? Math.max(0, providerOptions.delayMs)
      : DEFAULT_MOCK_DELAY_MS;

    return {
      id: "mock",

      translate(request) {
        const text = normalizeText(request && request.text);
        const lookupKey = normalizeLookupKey(text);

        return new Promise((resolve, reject) => {
          globalScope.setTimeout(() => {
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
        });
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

    if (!baiduProvider || typeof baiduProvider.translate !== "function") {
      throw new Error("Configured provider requires a Baidu provider.");
    }
    if (!geminiProvider || typeof geminiProvider.analyze !== "function") {
      throw new Error("Configured provider requires a Gemini provider.");
    }
    if (!deepSeekProvider || typeof deepSeekProvider.analyze !== "function") {
      throw new Error("Configured provider requires a DeepSeek provider.");
    }

    const providerRegistry = Object.freeze({
      baidu: Object.freeze({
        resultType: "quickTranslation",
        execute: async (request) => {
          const result = await baiduProvider.translate(request);
          return { ...result, provider: "baidu", resultType: "quickTranslation" };
        }
      }),
      deepseek: Object.freeze({
        resultType: "contextAnalysis",
        execute: (request) => deepSeekProvider.analyze(toContextAnalysisRequest(request))
      }),
      gemini: Object.freeze({
        resultType: "contextAnalysis",
        execute: (request) => geminiProvider.analyze(toContextAnalysisRequest(request))
      }),
      mock: Object.freeze({
        resultType: "quickTranslation",
        execute: (request) => mockProvider.translate(request)
      })
    });

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

      async process(request, processOptions) {
        const providerOverride = normalizeText(processOptions && processOptions.providerOverride);
        const providerId = providerOverride
          ? normalizeProviderId(providerOverride, providerRegistry)
          : await getActiveMode();
        return providerRegistry[providerId].execute(request);
      }
    };
  }

  function toContextAnalysisRequest(request) {
    return {
      targetText: request.text,
      contextSentence: request.contextSentence,
      pageTitle: request.pageTitle,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage
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
      return {
        provider,
        resultType,
        skillVersion: normalizeText(result && result.skillVersion) || skill.skillVersion,
        analysis: skill.validateAnalysis(result && result.analysis),
        cached: !!(result && result.cached)
      };
    }

    const translatedText = normalizeText(result && result.translatedText);
    if (!translatedText) {
      throw createLanguageError("EMPTY_RESULT", "翻译服务返回了空结果");
    }
    return {
      provider,
      resultType: "quickTranslation",
      translatedText,
      cached: !!(result && result.cached)
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
      targetLanguage: normalizeText(payload.targetLanguage) || "zh-CN"
    };
  }

  function normalizeProviderId(value, providerRegistry) {
    const providerId = normalizeText(value).toLocaleLowerCase();
    return providerRegistry && providerRegistry[providerId] ? providerId : "baidu";
  }

  function normalizeLookupKey(value) {
    return normalizeText(value).replace(/\s+/g, " ").toLocaleLowerCase();
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
  const configuredProvider = createConfiguredLanguageProvider({
    baiduProvider,
    deepSeekProvider,
    geminiProvider
  });
  const languageService = createLanguageService(configuredProvider);

  globalScope.baiduTranslationProvider = baiduProvider;
  globalScope.deepSeekContextProvider = deepSeekProvider;
  globalScope.geminiContextProvider = geminiProvider;
  globalScope.languageService = languageService;
  globalScope.translationService = languageService;
})(self);
