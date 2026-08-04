(function initializeBaiduTranslationProvider(globalScope) {
  const BAIDU_TRANSLATION_ENDPOINT = "https://fanyi-api.baidu.com/api/trans/vip/translate";
  const TRANSLATION_SETTINGS_KEY = "translationSettings";
  const DEFAULT_RATE_LIMIT_MS = 1000;

  const ERROR_MESSAGES = Object.freeze({
    "20003": "请求内容存在安全风险，无法翻译",
    "52001": "请求超时，请稍后重试",
    "52002": "百度翻译服务异常，请稍后重试",
    "52003": "APPID 未授权或服务未开通",
    "54000": "请求参数不完整",
    "54001": "签名校验失败，请检查 APPID 和密钥",
    "54003": "请求过于频繁，请稍后再试",
    "54004": "账户余额不足",
    "54005": "长文本请求过于频繁",
    "58000": "客户端 IP 配置不正确",
    "58001": "当前语言方向不支持",
    "58002": "翻译服务未开启",
    "58003": "当前 IP 暂时被限制",
    "90107": "开发者认证未生效"
  });

  function createBaiduTranslationProvider(options) {
    const providerOptions = options || {};
    const storageArea = providerOptions.storageArea || chrome.storage.local;
    const fetchImpl = providerOptions.fetchImpl || globalScope.fetch.bind(globalScope);
    const md5 = providerOptions.md5 || globalScope.md5Hex;
    const now = providerOptions.now || Date.now;
    const setTimer = providerOptions.setTimer || globalScope.setTimeout.bind(globalScope);
    const clearTimer = providerOptions.clearTimer || globalScope.clearTimeout.bind(globalScope);
    const rateLimitMs = Number.isFinite(providerOptions.rateLimitMs)
      ? Math.max(0, providerOptions.rateLimitMs)
      : DEFAULT_RATE_LIMIT_MS;
    const cache = new Map();
    let lastRequestStartedAt = -rateLimitMs;
    let pendingRequest = null;
    let pendingTimer = null;
    let activeRequest = null;

    if (typeof md5 !== "function") {
      throw new Error("Baidu provider requires a local MD5 implementation.");
    }

    return {
      id: "baidu",

      async translate(request) {
        const text = normalizeText(request && request.text);

        if (!text) {
          throw createTranslationError("EMPTY_TEXT", "翻译文本不能为空");
        }

        const settings = await readTranslationSettings(storageArea);
        const appId = normalizeText(settings.baiduAppId);
        const appKey = normalizeText(settings.baiduAppKey);

        if (!appId || !appKey) {
          throw createTranslationError(
            "CONFIG_REQUIRED",
            "请先在插件设置中配置百度翻译 APPID 和密钥",
            true
          );
        }

        const sourceLanguage = mapLanguage(request && request.sourceLanguage, "en");
        const targetLanguage = mapLanguage(request && request.targetLanguage, "zh");
        const cacheKey = createCacheKey(text, sourceLanguage, targetLanguage);

        if (cache.has(cacheKey)) {
          return {
            translatedText: cache.get(cacheKey),
            provider: "baidu",
            cached: true
          };
        }

        return scheduleLatest({
          appId,
          appKey,
          text,
          sourceLanguage,
          targetLanguage,
          cacheKey,
          requestId: normalizeText(request && request.requestId)
        });
      },

      cancelRequest(requestId) {
        const normalizedRequestId = normalizeText(requestId);
        let cancelled = false;

        if (pendingRequest && pendingRequest.requestData.requestId === normalizedRequestId) {
          if (pendingTimer !== null) {
            clearTimer(pendingTimer);
            pendingTimer = null;
          }
          pendingRequest.reject(createTranslationError("REQUEST_CANCELLED", "翻译请求已取消"));
          pendingRequest = null;
          cancelled = true;
        }

        if (activeRequest && activeRequest.requestData.requestId === normalizedRequestId) {
          activeRequest.controller.abort("panel-closed");
          cancelled = true;
        }

        return cancelled;
      },

      clearCache() {
        cache.clear();
      },

      reset() {
        cache.clear();

        if (pendingTimer !== null) {
          clearTimer(pendingTimer);
          pendingTimer = null;
        }

        if (pendingRequest) {
          pendingRequest.reject(createTranslationError("SETTINGS_CHANGED", "翻译配置已更新，请重试"));
          pendingRequest = null;
        }

        if (activeRequest) {
          activeRequest.controller.abort("settings-changed");
          activeRequest = null;
        }
      }
    };

    function scheduleLatest(requestData) {
      return new Promise((resolve, reject) => {
        if (pendingRequest) {
          pendingRequest.reject(createTranslationError("REQUEST_SUPERSEDED", "翻译请求已更新"));
        }

        pendingRequest = { requestData, resolve, reject };
        scheduleDrain();
      });
    }

    function scheduleDrain() {
      if (!pendingRequest || pendingTimer !== null) {
        return;
      }

      const waitMs = Math.max(0, (lastRequestStartedAt + rateLimitMs) - now());

      if (waitMs > 0) {
        pendingTimer = setTimer(() => {
          pendingTimer = null;
          drainPendingRequest();
        }, waitMs);
        return;
      }

      drainPendingRequest();
    }

    function drainPendingRequest() {
      if (!pendingRequest) {
        return;
      }

      if (pendingTimer !== null) {
        clearTimer(pendingTimer);
        pendingTimer = null;
      }

      const requestToRun = pendingRequest;
      pendingRequest = null;
      lastRequestStartedAt = now();
      const controller = new AbortController();
      activeRequest = { ...requestToRun, controller };

      executeBaiduRequest(requestToRun.requestData, controller.signal)
        .then((result) => {
          cache.set(requestToRun.requestData.cacheKey, result.translatedText);
          requestToRun.resolve(result);
        })
        .catch(requestToRun.reject)
        .finally(() => {
          if (activeRequest && activeRequest.controller === controller) {
            activeRequest = null;
          }
          scheduleDrain();
        });
    }

    async function executeBaiduRequest(requestData, signal) {
      const salt = createSalt();
      const signSource = `${requestData.appId}${requestData.text}${salt}${requestData.appKey}`;
      const sign = md5(signSource);
      const body = new URLSearchParams({
        q: requestData.text,
        from: requestData.sourceLanguage,
        to: requestData.targetLanguage,
        appid: requestData.appId,
        salt,
        sign
      });
      let response;

      try {
        response = await fetchImpl(BAIDU_TRANSLATION_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
          },
          body: body.toString(),
          signal
        });
      } catch (error) {
        if (signal && signal.aborted) {
          throw createTranslationError("REQUEST_CANCELLED", "翻译请求已取消");
        }
        throw createTranslationError("NETWORK_ERROR", "网络请求失败，请稍后重试");
      }

      if (!response || !response.ok) {
        throw createTranslationError("HTTP_ERROR", "百度翻译请求失败，请稍后重试");
      }

      let payload;

      try {
        payload = await response.json();
      } catch (error) {
        throw createTranslationError("INVALID_RESPONSE", "百度翻译返回了无法解析的数据");
      }

      if (payload && payload.error_code !== undefined && payload.error_code !== null) {
        const errorCode = String(payload.error_code);
        throw createTranslationError(errorCode, getBaiduErrorMessage(errorCode));
      }

      const translatedText = Array.isArray(payload && payload.trans_result)
        ? payload.trans_result.map((item) => normalizeText(item && item.dst)).filter(Boolean).join("\n")
        : "";

      if (!translatedText) {
        throw createTranslationError("EMPTY_RESULT", "百度翻译没有返回有效译文");
      }

      return {
        translatedText,
        provider: "baidu",
        cached: false
      };
    }
  }

  function readTranslationSettings(storageArea) {
    return new Promise((resolve, reject) => {
      storageArea.get({ [TRANSLATION_SETTINGS_KEY]: {} }, (result) => {
        const runtimeError = globalScope.chrome && globalScope.chrome.runtime
          ? globalScope.chrome.runtime.lastError
          : null;

        if (runtimeError) {
          reject(createTranslationError("SETTINGS_READ_ERROR", "无法读取翻译配置"));
          return;
        }

        const settings = result && result[TRANSLATION_SETTINGS_KEY];
        resolve(settings && typeof settings === "object" ? settings : {});
      });
    });
  }

  function createTranslationError(code, publicMessage, requiresConfiguration) {
    const error = new Error(publicMessage || "翻译失败，请稍后重试");
    error.name = "TranslationProviderError";
    error.code = String(code || "UNKNOWN_ERROR");
    error.publicMessage = publicMessage || "翻译失败，请稍后重试";
    error.requiresConfiguration = !!requiresConfiguration;
    return error;
  }

  function getBaiduErrorMessage(errorCode) {
    return ERROR_MESSAGES[String(errorCode)] || "百度翻译请求失败，请稍后重试";
  }

  function createSalt() {
    if (globalScope.crypto && typeof globalScope.crypto.getRandomValues === "function") {
      const values = new Uint32Array(2);
      globalScope.crypto.getRandomValues(values);
      return `${values[0]}${values[1]}`;
    }

    return `${Date.now()}${Math.floor(Math.random() * 1000000)}`;
  }

  function createCacheKey(text, sourceLanguage, targetLanguage) {
    const normalizedText = normalizeText(text).replace(/\s+/g, " ").toLocaleLowerCase();
    return `${normalizedText}\u0000${sourceLanguage}\u0000${targetLanguage}`;
  }

  function mapLanguage(value, fallback) {
    const normalized = normalizeText(value).toLocaleLowerCase();

    if (normalized === "zh-cn" || normalized === "zh-hans") {
      return "zh";
    }

    return normalized || fallback;
  }

  function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  globalScope.baiduTranslationProviderFactory = Object.freeze({
    BAIDU_TRANSLATION_ENDPOINT,
    TRANSLATION_SETTINGS_KEY,
    createBaiduTranslationProvider,
    createTranslationError,
    getBaiduErrorMessage,
    readTranslationSettings
  });
})(self);
