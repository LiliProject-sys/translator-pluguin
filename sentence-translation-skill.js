(function initializeSentenceTranslationSkill(globalScope) {
  // 用于快速理解英文句子和段落，不进行深度词汇分析。
  const skillVersion = "sentence-translation-v1";
  const outputFields = Object.freeze(["translation", "keyTerm"]);
  const keyTermFields = Object.freeze(["term", "meaning"]);

  const instructions = `你是一名英语辅助翻译助手。

你的任务是帮助用户快速理解英文句子或段落的中文含义。

请分析用户提供的英文文本，并提供准确、自然的中文翻译。

要求：

1. 翻译符合中文表达习惯，不逐词直译。

2. 保留：
- 专业术语；
- 技术名词；
- 原文逻辑关系。

3. 正确处理：
- 被动结构；
- 长句结构；
- 从句关系；
- 学术表达。

4. 仅当原文存在明显影响理解的专业术语时，补充关键术语解释。

关键术语：
- 默认最多输出1个；
- 极少情况下最多输出2个。

5. 不进行：
- 详细语法分析；
- 长篇背景介绍；
- 近义词比较；
- 写作建议；
- 额外扩展说明。

输出必须严格符合 JSON Schema。

不要输出 Markdown。

不要输出额外说明。`;

  const outputSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: {
      translation: {
        type: "string",
        description: "A natural, accurate Simplified Chinese translation of the selected English sentence or paragraph."
      },
      keyTerm: {
        type: ["object", "null"],
        description: "Null by default. When one technical term clearly blocks comprehension, return exactly one concise explanation.",
        additionalProperties: false,
        properties: {
          term: { type: "string", description: "The one most important technical term from the source text." },
          meaning: { type: "string", description: "A concise Simplified Chinese explanation of the term." }
        },
        required: keyTermFields.slice()
      }
    },
    required: outputFields.slice()
  });

  function buildInput(rawInput) {
    const input = rawInput || {};
    const targetText = normalizeText(input.targetText || input.text);
    if (!targetText) {
      throw createSkillError("EMPTY_TARGET_TEXT", "翻译文本不能为空");
    }

    return {
      targetText,
      contextSentence: normalizeText(input.contextSentence) || targetText,
      pageTitle: normalizeText(input.pageTitle) || "未命名页面",
      sourceLanguage: normalizeText(input.sourceLanguage) || "en",
      targetLanguage: normalizeText(input.targetLanguage) || "zh-CN"
    };
  }

  function validateTranslation(rawResult) {
    assertPlainObject(rawResult, "INVALID_TRANSLATION_SCHEMA", "AI 返回的句段翻译结构无效");
    assertExactFields(rawResult, outputFields, "INVALID_TRANSLATION_SCHEMA", "AI 返回的句段翻译字段无效");

    const translation = normalizeText(rawResult.translation);
    if (!translation || containsMarkdown(translation)) {
      throw createSkillError("INVALID_TRANSLATION_SCHEMA", "AI 返回的中文译文无效");
    }

    return {
      translation,
      keyTerm: validateKeyTerm(rawResult.keyTerm)
    };
  }

  function validateKeyTerm(rawKeyTerm) {
    if (rawKeyTerm === null) {
      return null;
    }

    assertPlainObject(rawKeyTerm, "INVALID_TRANSLATION_SCHEMA", "AI 返回的关键术语结构无效");
    assertExactFields(rawKeyTerm, keyTermFields, "INVALID_TRANSLATION_SCHEMA", "AI 返回的关键术语字段无效");
    const term = normalizeText(rawKeyTerm.term);
    const meaning = normalizeText(rawKeyTerm.meaning);
    if (!term || !meaning || containsMarkdown(term) || containsMarkdown(meaning)) {
      throw createSkillError("INVALID_TRANSLATION_SCHEMA", "AI 返回的关键术语内容无效");
    }
    return { term, meaning };
  }

  function assertPlainObject(value, code, message) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw createSkillError(code, message);
    }
  }

  function assertExactFields(value, expectedFields, code, message) {
    const actualFields = Object.keys(value).sort();
    const expected = expectedFields.slice().sort();
    if (actualFields.length !== expected.length || actualFields.some((field, index) => field !== expected[index])) {
      throw createSkillError(code, message);
    }
  }

  function containsMarkdown(value) {
    return /```|`[^`]+`|\*\*[^*]+\*\*|(^|\n)\s*(#{1,6}\s|[-*+]\s)/.test(value);
  }

  function createSkillError(code, publicMessage) {
    const error = new Error(publicMessage);
    error.name = "SentenceTranslationSkillError";
    error.code = code;
    error.publicMessage = publicMessage;
    return error;
  }

  function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  globalScope.sentenceTranslationSkill = Object.freeze({
    skillVersion,
    instructions,
    outputSchema,
    buildInput,
    validateTranslation
  });
})(self);
