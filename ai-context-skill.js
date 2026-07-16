(function initializeAiContextSkill(globalScope) {
  const skillVersion = "context-analysis-v6";
  const analysisModes = Object.freeze({
    QUICK: "quick",
    DETAIL: "detail"
  });
  const quickFields = Object.freeze([
    "word",
    "lemma",
    "phonetic",
    "partOfSpeech",
    "meaning"
  ]);
  const detailFields = Object.freeze([
    "meaningInSentence",
    "comparison"
  ]);
  const comparisonFields = Object.freeze([
    "word",
    "difference"
  ]);
  const allowedPartsOfSpeech = Object.freeze([
    "adj.",
    "v.",
    "n.",
    "adv.",
    "prep.",
    "phr."
  ]);

  const instructions = `你是一名英语阅读辅助助手。

你的任务是帮助用户继续阅读英文论文，而不是替用户完成理解。

核心原则：

AI 不替用户完成理解，只提供最小有效的信息支点。

只回答当前划选词汇在阅读时最需要知道的信息：

1. 这个词本身的基础含义；
2. 这个词在当前句子里的具体含义；
3. 只有存在明显近义词语义区别时，补充一个最核心的语义区别。

第一层：快速词汇信息

只提供：

- word：用户查询的单词；
- lemma：真实词典原形；
- phonetic：IPA音标；
- partOfSpeech：标准英语词典缩写词性；
- meaning：基础中文含义。

要求：

1. 简洁准确。
2. lemma 只提供真实词典原形，不解释 -ing、-ed 等基础词形变化。
3. partOfSpeech 必须根据当前句子中的实际词性判断，只使用 n.、v.、adj.、adv.、prep.、phr.。
4. 不扩展论文背景。
5. 不做长篇解释。

第二层：当前语境

提供：

meaningInSentence：

说明这个词在当前句子里具体表示什么。

要求：

1. 必须结合当前句子。
2. 简短直接。
3. 不重复词典释义。
4. 不分析作者心理。
5. 不解释为什么作者选择该词。
6. 不输出总结句。

第三层：近义词区别（可选）

comparison 不是原因分析，而是语义区别。

只有存在明显近义词语义区别时生成 comparison。

否则 comparison 返回 null。

comparison 只比较一个最相关的近义词。

comparison 只说明两个词最核心的语义关注点区别。

不要输出：

- 为什么作者选择该词；
- 因此这里使用某词；
- 作者写作意图；
- 论文背景扩展；
- 长篇总结；
- 大量同义词扩展；
- 写作建议。

comparison 行为示例：

employ vs apply

employ：
强调把技术、工具作为手段使用。

apply：
强调把方法作用于具体对象。

reinforcing vs strengthening

reinforcing：
强调增强已有结构或性能。

strengthening：
强调整体上使某物变得更强。

输出必须严格符合 JSON Schema。

不要输出 Markdown。

不要输出额外说明。`;

  const quickOutputSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: {
      word: {
        type: "string",
        description: "The original selected English word or phrase."
      },
      lemma: {
        type: "string",
        description: "The true dictionary headword or base form only; do not explain inflection."
      },
      phonetic: {
        type: "string",
        description: "A single concise IPA transcription for the lemma, including delimiters such as /.../."
      },
      partOfSpeech: {
        type: "string",
        enum: allowedPartsOfSpeech.slice(),
        description: "The part of speech used in this context, exactly one of adj., v., n., adv., prep., or phr."
      },
      meaning: {
        type: "string",
        description: "A concise Simplified Chinese basic meaning of the selected word."
      }
    },
    required: quickFields.slice()
  });

  const detailOutputSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: {
      meaningInSentence: {
        type: "string",
        description: "A concise explanation of what the selected word means in the current sentence."
      },
      comparison: {
        type: ["object", "null"],
        description: "One core semantic difference only when an obvious close synonym distinction exists; otherwise null.",
        additionalProperties: false,
        properties: {
          word: {
            type: "string",
            description: "The single most relevant close synonym."
          },
          difference: {
            type: "string",
            description: "The core semantic-focus difference between the selected word and the close synonym."
          }
        },
        required: comparisonFields.slice()
      }
    },
    required: detailFields.slice()
  });

  function buildInput(rawInput) {
    const input = rawInput || {};
    const targetText = normalizeText(input.targetText || input.text);

    if (!targetText) {
      throw createSkillError("EMPTY_TARGET_TEXT", "分析文本不能为空");
    }

    return {
      targetText,
      contextSentence: normalizeText(input.contextSentence) || targetText,
      pageTitle: normalizeText(input.pageTitle) || "未命名页面",
      sourceLanguage: normalizeText(input.sourceLanguage) || "en",
      targetLanguage: normalizeText(input.targetLanguage) || "zh-CN",
      userQuestion: normalizeText(input.userQuestion)
    };
  }

  function getOutputSchema(mode) {
    return normalizeAnalysisMode(mode) === analysisModes.DETAIL
      ? detailOutputSchema
      : quickOutputSchema;
  }

  function validateAnalysis(rawAnalysis, mode) {
    const analysisMode = normalizeAnalysisMode(mode);
    return analysisMode === analysisModes.DETAIL
      ? validateDetailAnalysis(rawAnalysis)
      : validateQuickAnalysis(rawAnalysis);
  }

  function validateQuickAnalysis(rawAnalysis) {
    assertPlainObject(rawAnalysis);
    assertExactFields(rawAnalysis, quickFields);

    const analysis = {};
    quickFields.forEach((field) => {
      const value = normalizeText(rawAnalysis[field]);
      if (!value) {
        throw createSkillError("EMPTY_ANALYSIS_FIELD", `AI 返回字段 ${field} 为空`);
      }
      analysis[field] = value;
    });

    if (!allowedPartsOfSpeech.includes(analysis.partOfSpeech)) {
      throw createSkillError("INVALID_PART_OF_SPEECH", "AI 返回的词性缩写无效");
    }

    return analysis;
  }

  function validateDetailAnalysis(rawAnalysis) {
    assertPlainObject(rawAnalysis);
    assertExactFields(rawAnalysis, detailFields);

    const meaningInSentence = normalizeText(rawAnalysis.meaningInSentence);
    if (!meaningInSentence) {
      throw createSkillError("EMPTY_ANALYSIS_FIELD", "AI 返回字段 meaningInSentence 为空");
    }

    return {
      meaningInSentence,
      comparison: validateComparison(rawAnalysis.comparison)
    };
  }

  function validateComparison(rawComparison) {
    if (rawComparison === null) {
      return null;
    }

    if (!rawComparison || typeof rawComparison !== "object" || Array.isArray(rawComparison)) {
      throw createSkillError("INVALID_COMPARISON", "AI 返回的近义词区别格式无效");
    }
    assertExactFields(rawComparison, comparisonFields);
    const comparison = {};
    comparisonFields.forEach((field) => {
      const value = normalizeText(rawComparison[field]);
      if (!value) {
        throw createSkillError("INVALID_COMPARISON", "AI 返回的近义词区别内容无效");
      }
      comparison[field] = value;
    });

    return comparison;
  }

  function assertPlainObject(rawAnalysis) {
    if (!rawAnalysis || typeof rawAnalysis !== "object" || Array.isArray(rawAnalysis)) {
      throw createSkillError("INVALID_ANALYSIS", "AI 返回的语境解析格式无效");
    }
  }

  function assertExactFields(rawAnalysis, requiredFields) {
    const actualKeys = Object.keys(rawAnalysis);
    const hasUnexpectedField = actualKeys.some((key) => !requiredFields.includes(key));
    const hasMissingField = requiredFields.some((key) => !actualKeys.includes(key));

    if (hasUnexpectedField || hasMissingField) {
      throw createSkillError("INVALID_ANALYSIS_SCHEMA", "AI 返回的语境解析字段不完整");
    }
  }

  function normalizeAnalysisMode(value) {
    return normalizeText(value).toLocaleLowerCase() === analysisModes.DETAIL
      ? analysisModes.DETAIL
      : analysisModes.QUICK;
  }

  function createSkillError(code, message) {
    const error = new Error(message);
    error.name = "AiContextSkillError";
    error.code = code;
    error.publicMessage = message;
    return error;
  }

  function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  globalScope.aiContextSkill = Object.freeze({
    skillVersion,
    analysisModes,
    instructions,
    outputSchema: quickOutputSchema,
    quickOutputSchema,
    detailOutputSchema,
    allowedPartsOfSpeech,
    buildInput,
    getOutputSchema,
    normalizeAnalysisMode,
    validateAnalysis,
    validateQuickAnalysis,
    validateDetailAnalysis
  });
})(self);
