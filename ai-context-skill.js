(function initializeAiContextSkill(globalScope) {
  const skillVersion = "context-analysis-v2";
  const requiredFields = Object.freeze([
    "lemma",
    "phonetic",
    "partOfSpeech",
    "commonMeaning",
    "contextualMeaning"
  ]);
  const allowedPartsOfSpeech = Object.freeze([
    "adj.",
    "v.",
    "n.",
    "adv.",
    "prep.",
    "phr."
  ]);

  const instructions = [
    "You assist a researcher who is reading an English academic paper.",
    "Analyze the selected English word or phrase with academic usage and the supplied paper context taking priority over general translation.",
    "Return the base lemma, one concise IPA transcription, one part-of-speech label, a concise common Simplified Chinese meaning, and a concise Simplified Chinese meaning in this exact paper context.",
    "The partOfSpeech value must be exactly one of adj., v., n., adv., prep., or phr.",
    "Do not provide a long explanation, multiple dictionary senses, synonym comparison, citations, or Markdown.",
    "Return strict JSON only, with no commentary or fields outside the supplied JSON schema."
  ].join(" ");

  const outputSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: {
      lemma: {
        type: "string",
        description: "The dictionary headword or normalized base form of the selected English text."
      },
      phonetic: {
        type: "string",
        description: "A single concise IPA transcription for the lemma, including IPA delimiters such as /.../."
      },
      partOfSpeech: {
        type: "string",
        enum: allowedPartsOfSpeech.slice(),
        description: "The part of speech used in this context, using exactly adj., v., n., adv., prep., or phr."
      },
      commonMeaning: {
        type: "string",
        description: "A concise Simplified Chinese meaning commonly associated with the selected word or phrase."
      },
      contextualMeaning: {
        type: "string",
        description: "A concise Simplified Chinese meaning for the selected text in this exact academic-paper context."
      }
    },
    required: requiredFields.slice()
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
      targetLanguage: normalizeText(input.targetLanguage) || "zh-CN"
    };
  }

  function validateAnalysis(rawAnalysis) {
    if (!rawAnalysis || typeof rawAnalysis !== "object" || Array.isArray(rawAnalysis)) {
      throw createSkillError("INVALID_ANALYSIS", "AI 返回的语境解析格式无效");
    }

    const actualKeys = Object.keys(rawAnalysis);
    const hasUnexpectedField = actualKeys.some((key) => !requiredFields.includes(key));
    const hasMissingField = requiredFields.some((key) => !actualKeys.includes(key));

    if (hasUnexpectedField || hasMissingField) {
      throw createSkillError("INVALID_ANALYSIS_SCHEMA", "AI 返回的语境解析字段不完整");
    }

    const analysis = {};
    requiredFields.forEach((field) => {
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
    instructions,
    outputSchema,
    allowedPartsOfSpeech,
    buildInput,
    validateAnalysis
  });
})(self);
