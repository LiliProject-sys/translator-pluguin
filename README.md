# Translator-plugin

Translator-plugin 是一个无需构建步骤的 Chrome Manifest V3 扩展。用户在普通网页中选中英文单词或短语后，浮窗会立即显示本地收录状态，并异步执行所选语言处理模式：百度快速翻译、DeepSeek/Gemini AI 语境解析或本地 Mock。词条仍保存到 `chrome.storage.local`。

## 当前阶段

- Stage1：本地生词本、右键保存、popup 查看/删除/打开来源。
- Stage2：划词后自动显示轻量收藏浮窗。
- Stage3：区分未收录、单词已收录和当前语境已保存。
- Stage4：可替换的异步 Translation Provider。
- Stage5：接入百度通用文本翻译 API 和本地凭据设置。
- Stage6：增加通用 AI 语境解析 Skill，并接入 Gemini Provider。
- Stage6 Bugfix：版本从 `0.3.0` 升至 `0.3.1`，Gemini Provider 迁移到 Interactions API，修复结构化输出请求和错误诊断。
- Stage7：增加统一 AI Provider 注册框架，并接入 DeepSeek Chat Completions 语境解析。
- Stage8：AI Skill 2.0 面向科研论文阅读，统一输出单词、IPA 音标、词性、常见含义和论文中含义。

当前插件版本为 `0.4.0`。

## 文件结构

- `manifest.json`：Manifest V3、权限、service worker、content script、popup 和设置页。
- `background.js`：右键菜单、状态查询、统一语言处理、保存去重和设置页消息。
- `content.js`：提取选区与上下文，显示状态感知浮窗并渲染翻译或语境解析。
- `ai-context-skill.js`：Skill 2.0 学术语境指令、输入构造、五字段 JSON Schema 和本地结果校验。
- `deepseek-context-provider.js`：DeepSeek Chat Completions 请求、JSON Output、完成状态检查、空响应重试、超时、取消和缓存。
- `gemini-context-provider.js`：Gemini REST 请求、结构化输出、错误映射、超时、取消和内存缓存。
- `baidu-translation-provider.js`：百度翻译签名、请求、限速、错误映射和缓存。
- `translation-provider.js`：四种 Provider 的注册、能力声明、统一调度和旧接口兼容。
- `md5.js`：百度 API 使用的本地 UTF-8 MD5 实现。
- `options.html`、`options.css`、`options.js`：Provider 模式以及百度、DeepSeek、Gemini 凭据设置。
- `popup.html`、`popup.css`、`popup.js`：词条列表、删除、打开来源及设置入口。

## 安装或更新

1. 打开 `chrome://extensions`。
2. 开启“开发者模式”。
3. 首次安装时点击“加载已解压的扩展程序”。
4. 选择 `D:\Project_Experimental\Translator_Plugin`。
5. 已安装旧版本时点击扩展卡片上的“重新加载”。
6. 确认版本显示为 `0.4.0`。

项目不需要 `npm install`，不包含 React、Vue、TypeScript 或后端服务。

## 使用方法

1. 点击工具栏插件图标，在 popup 顶部点击“设置”。
2. 选择“百度快速翻译”“DeepSeek AI 语境解析”“Gemini AI 语境解析”或“Mock 测试”。
3. 根据所选模式保存凭据并执行连接测试。
4. 打开普通英文网页，选中单词或短语。
5. 浮窗立即出现；收录状态和语言处理结果分别异步更新。
6. 点击“加入生词本”或“保存当前语境”。
7. 备用方式：选中文字后右键点击“加入生词本”。
8. 在 popup 中查看、打开来源或删除词条。

## Stage7 DeepSeek AI 语境解析

Stage7 将语言处理调度改为 Provider 注册表。每个 Provider 声明自己的 `resultType` 和执行函数；浮窗只关心 `quickTranslation` 或 `contextAnalysis`，不需要识别具体服务名称。当前注册项为百度、DeepSeek、Gemini 和 Mock，未来接入 OpenAI 时可增加同契约的注册项，无需重写浮窗。

DeepSeek 使用：

```text
POST https://api.deepseek.com/chat/completions
Authorization: Bearer <DeepSeek API Key>
Content-Type: application/json
```

默认模型为 `deepseek-v4-flash`，设置页允许填写账号可用的其它模型且不使用模型白名单。请求使用 `response_format: { type: "json_object" }`、`thinking: { type: "disabled" }`、`max_tokens: 500` 和 `stream: false`。提示明确要求只能返回 JSON，并包含固定五字段 JSON 示例；结果仍通过 `ai-context-skill.js` 的严格本地校验。

只有 `finish_reason === "stop"` 才进入 JSON 解析。`length`、`content_filter`、`insufficient_system_resource`、`tool_calls`、缺失值和未知状态均直接转为明确错误。若正常完成但 `content` 为空，Provider 会在同一超时和取消控制范围内自动重试一次；第二次仍为空即失败，不会无限重试。

### 配置 DeepSeek

1. 在 DeepSeek 平台创建个人 API Key。
2. 在插件设置页选择“DeepSeek AI 语境解析”。
3. 填写 API Key 和 Model ID；留空 Model ID 时使用 `deepseek-v4-flash`。
4. 点击“保存 DeepSeek 配置”，随后点击“测试 DeepSeek”。
5. Key 输入框保存后会清空，留空再次保存会保留已有 Key；“清除”只删除 DeepSeek 配置。

DeepSeek 分析结果、Gemini 分析结果和快速译文都只存在于当前浮窗或 service worker 内存缓存中，不写入生词记录。

## Stage8 AI Skill 2.0

Skill 2.0 的定位是辅助科研论文阅读，不是通用翻译或长篇 AI 解释。Gemini 与 DeepSeek 共用 `context-analysis-v2`，固定返回：

```js
{
  lemma,
  phonetic,
  partOfSpeech,
  commonMeaning,
  contextualMeaning
}
```

- `lemma`：基础词形。
- `phonetic`：由当前 AI Provider 在同一次请求中生成的简洁 IPA。
- `partOfSpeech`：严格限定为 `adj.`、`v.`、`n.`、`adv.`、`prep.` 或 `phr.`。
- `commonMeaning`：该词常见的简洁中文含义。
- `contextualMeaning`：当前论文语境中的简洁中文含义，学术表达优先。

Schema 禁止额外字段，五个字段都必须是非空字符串。指令明确禁止 Markdown、长篇解释、罗列多个义项和主动进行近义词比较。浮窗以紧凑五行展示“单词、音标、词性、常见含义、论文中含义”。

## Gemini AI 语境解析

Gemini 模式已经可以通过 Interactions API 运行。它接收当前选词和上下文句子，按 Skill 2.0 返回固定五字段结果：

```js
{
  lemma,
  phonetic,
  partOfSpeech,
  commonMeaning,
  contextualMeaning
}
```

浮窗分别显示“单词”“音标”“词性”“常见含义”和“论文中含义”，不会显示原始 JSON。分析 Skill 版本为 `context-analysis-v2`。

Gemini Provider 的运行时结果格式为：

```js
{
  provider: "gemini",
  resultType: "contextAnalysis",
  skillVersion: "context-analysis-v2",
  analysis: { lemma, phonetic, partOfSpeech, commonMeaning, contextualMeaning }
}
```

默认模型为 `gemini-3.5-flash`。Model ID 可以在设置页修改，例如 `gemini-3.1-flash-lite`；填写 `models/` 前缀也会被规范化。插件不使用固定模型白名单。

Stage6 `0.3.1` 使用 Gemini Interactions API：

```text
POST https://generativelanguage.googleapis.com/v1beta/interactions
Content-Type: application/json
x-goog-api-key: <Gemini API Key>
```

请求使用顶层结构化输出配置：

```js
{
  model,
  system_instruction: skill.instructions,
  input: JSON.stringify(skill.buildInput(request)),
  response_format: {
    type: "text",
    mime_type: "application/json",
    schema: skill.outputSchema
  },
  store: false
}
```

每次划词都是独立请求，不发送工具或 `previous_interaction_id`。`store: false` 禁止服务端保存 Interaction 供后续会话复用。

### 配置 Gemini

1. 在 Google AI Studio 创建 Gemini API Key，并确认账号可访问所填模型。
2. 在插件设置页选择“Gemini AI 语境解析”。
3. 填写 API Key 和 Model ID；默认值为 `gemini-3.5-flash`。
4. 点击“保存 Gemini 配置”。保存后 Key 输入框清空，不回显完整 Key。
5. 点击“测试 Gemini”。测试使用单词 `employed` 和一条英文例句。

Gemini 请求具有 20 秒超时。快速重新划词会取消同一 service worker 中仍在进行的旧 Gemini 请求；相同选词、上下文、标题、模型和 Skill 版本可命中会话内存缓存。配置变化时缓存会清除。

Interactions API 返回后，Provider 仅在 `status === "completed"` 时读取 `steps[].model_output.content[].text`。`failed`、`incomplete`、`cancelled`、`budget_exceeded`、`requires_action`、`in_progress` 和其它非 completed 状态都会直接转为明确错误，不进入五字段 JSON 解析。

## 百度快速翻译

百度模式沿用 Stage5，实现：

```text
POST https://fanyi-api.baidu.com/api/trans/vip/translate
sign = MD5(appid + q + salt + appkey)
```

设置页分别保存 APPID 和 App Key。百度 Provider 继续执行 QPS 间隔控制、最新待处理请求替换、错误码映射和会话内存缓存。返回格式统一为：

```js
{
  provider: "baidu",
  resultType: "quickTranslation",
  translatedText
}
```

Mock 也返回 `quickTranslation`，但不访问网络。选择 `mock-translation-error` 可验证失败和重试状态。

## 消息与数据流

```text
用户划词
-> content.js 保存选区与上下文快照并立即显示浮窗
-> CHECK_VOCABULARY_STATUS 查询本地收录状态
-> GET_ACTIVE_LANGUAGE_MODE 获取无凭据的 Provider 与 resultType
-> TRANSLATE_TEXT 进入 background.js 的统一语言处理入口
-> Baidu / DeepSeek / Gemini / Mock Provider 返回带 resultType 的结果
-> content.js 分支渲染快速译文或五字段学术语境解析
-> SAVE_VOCABULARY_ENTRY 再次去重并写入 chrome.storage.local
-> popup.js 读取 vocabularyEntries
```

状态查询、保存和语言处理相互独立。翻译或 AI 请求失败不会禁用生词保存。

## 数据兼容性

Stage7 继续扩展同一个 `translationSettings`：

```js
{
  provider: "baidu" | "deepseek" | "gemini" | "mock",
  baiduAppId,
  baiduAppKey,
  deepseekApiKey,
  deepseekModel,
  geminiApiKey,
  geminiModel
}
```

Stage5/Stage6 旧设置没有 DeepSeek 字段时仍可直接读取，无需迁移。切换 Provider 不会清除其他 Provider 的凭据，清除按钮只删除对应配置。

生词数据结构没有变化：

```js
{
  id,
  word,
  contextSentence,
  pageTitle,
  pageUrl,
  createdAt
}
```

翻译和 AI 分析均为运行时数据，不写入 `vocabularyEntries`。完全相同的 `word + contextSentence + pageUrl` 仍会被阻止；同一个词可以保存多个不同语境。

## 第二层深入理解预留（未实现）

Stage8 只定义未来接口方向，不增加“深入理解”按钮、不发送第二次请求，也不保存第二层结果。候选接口为：

```js
DeepContextAnalysisProvider.analyze({
  targetText,
  contextSentence,
  pageTitle,
  firstLayerAnalysis,
  sourceLanguage,
  targetLanguage
}) -> Promise<{
  provider,
  resultType: "deepContextAnalysis",
  analysis
}>
```

未来实现时应继续与第一层 `contextAnalysis`、词条保存和状态查询分离。

## 近义词分析设计（未实现）

近义词分析只在模型判断存在明显混淆风险时进入第二层，并且只比较“当前词 + 一个最容易混淆词”，例如 `employ vs apply`。输出重点是说明为什么论文当前语境使用目标词，不同时罗列多个近义词。Stage8 没有新增此类请求或 UI。

## 安全说明

- 百度密钥、DeepSeek API Key 和 Gemini API Key 不硬编码在源码中，也不会发送给 content script。
- Service Worker 控制台只记录 Provider、HTTP 状态、内部错误码、requestId 及经过脱敏和截断的 API 错误信息；不记录凭据、请求头、选词、完整上下文、请求体或完整服务响应。
- `chrome.storage.local` 不是加密保险箱。本实现适合个人本机 Demo，不适合共享电脑或把统一密钥打包公开发布。
- 正式发布时应评估用户自有凭据、安全后端代理、配额保护、隐私政策和数据处理说明。

## 手动验收清单

- 重新加载后确认 Manifest V3 和版本 `0.4.0`。
- popup 顶部“设置”能够打开 options 页面。
- Stage5 百度旧配置仍能读取和翻译。
- 四种模式切换不会清除其它模式的凭据。
- 保存并测试真实 DeepSeek Key，确认默认 `deepseek-v4-flash` 或账号可用模型返回五字段结果。
- 使用无效 DeepSeek Key、错误 Model ID、断网、限流和服务端错误验证中文提示。
- 确认 DeepSeek `length`、内容过滤、资源不足、工具调用和未知完成状态不会进入 JSON 解析。
- 模拟一次空 content 后成功，确认只自动重试一次；连续两次空 content 时明确失败。
- 使用真实 Gemini Key 测试 `gemini-3.5-flash`。
- 切换到 `gemini-3.1-flash-lite` 再测试一次。
- Gemini 浮窗显示“单词、音标、词性、常见含义、论文中含义”，不显示原始 JSON。
- 用论文句子验证 `contextualMeaning` 优先反映当前学术语境，而不是罗列通用词典义项。
- 确认 `partOfSpeech` 只显示约定的六种缩写之一。
- 加载语境解析期间仍可保存词条。
- 使用无效 Key、错误 Model ID、断网和限流场景验证错误提示。
- 若请求失败，确认 Service Worker Console 显示安全的 Google `error.status` 和 `error.message`，且不包含选词、上下文或 API Key。
- 失败后点击“重试”，确认重新发起当前选区请求。
- 快速连续选择不同文本，确认旧响应不覆盖新浮窗。
- 重复选择相同文本和上下文，确认当前 service worker 会话可命中缓存。
- 回归三种收录状态、完全重复去重和多语境保存。
- 回归右键保存、popup 排序/删除/打开来源和升级前旧词条。

## 已知限制

- DeepSeek 和 Gemini 结果由外部模型生成，可能存在语义错误；Schema 校验只能保证结构，不能保证事实正确。
- 当前没有 OpenAI/GPT、DeepL、一词多义列表、发音、词典详情、搜索、标签、复习算法或云同步。
- IPA 由 AI Provider 生成，当前不接入权威发音词典，也不播放音频。
- “深入理解”和一对一近义词辨析目前只有接口设计，没有 UI 或运行时请求。
- AI 分析和翻译结果不持久化，service worker 休眠后内存缓存会消失。
- API 可用性、额度、限流、模型生命周期和费用由服务提供方决定。
- PDF、Canvas、扫描文本和复杂阅读器可能无法正确提供选区或完整上下文。
- 与其它划词插件同时启用时，允许多个浮窗同时出现。

## 后续候选

- 为 Provider 请求增加更细粒度的诊断和可选重试策略。
- 评估安全后端代理和生产级密钥管理。
- 为 Skill 增加版本回归样例与自动化浏览器测试。
- 在不改变现有词条结构的前提下评估用户可选的分析结果持久化。
