# Translator-plugin

## GitHub 私有 Beta 分发说明

当前项目可作为私有 GitHub 仓库中的 Beta 测试版本分发，推荐先通过压缩包或私有仓库邀请少量用户试用。此项目尚未提交 Chrome Web Store 审核，也未提供生产级密钥保护、账号系统或云端同步。

分发前建议阅读：

- `PRIVACY.md`：说明插件读取、保存和发送哪些数据。
- `SECURITY.md`：说明 API Key、本地存储和安全报告规则。
- `docs/beta-test-guide.md`：给测试用户的安装、配置和反馈说明。
- `docs/architecture.md`：维护者理解代码结构和数据流的入口。
- `docs/release-checklist.md`：打包和上传前检查清单。

本地打包建议使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1
```

脚本会在 `release/` 目录生成用于 Chromium/Chrome 加载测试的 ZIP。生成的 ZIP、用户本地配置、个人词库导出和私密记录默认不会提交到 Git。

Translator-plugin 是一个无需构建步骤的 Chrome Manifest V3 扩展。用户在普通网页中选中英文单词或短语后，浮窗会立即显示本地收录状态，并异步执行所选语言处理模式：百度快速翻译、DeepSeek/Gemini AI 两层语境解析或本地 Mock。词条仍保存到 `chrome.storage.local`。

## 项目状态

当前版本：`v1.0.1`。

Translator Plugin Chrome 版核心功能已基本完善，达到可供真实用户日常使用和收集反馈的稳定版本。这个版本不表示零 Bug 或支持所有网页，而是表示划词理解、生词保存、独立生词本、Provider 配置和论文阅读常见边界修复已经形成完整闭环。

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
- Stage9：AI Skill 3.0 增加“快速词汇信息 + 用户主动触发详细解释”的两层模式。
- Stage9.1：修复 Gemini 详细解释请求的 Structured Output 兼容问题，并补充安全诊断日志。
- Stage9.2：修复浮窗按钮 `mouseup` 被误判为重新划词、进而取消 detail 请求的问题，并拆分选区与详细分析请求 ID。
- Stage10：浮窗改为视口固定定位，页面滚动和 Detail 内部滚动不再关闭浮窗；主动关闭时按 request ID 取消当前语言请求。
- Stage14：Word Analysis Skill v4.1 删除冗余学术含义和作者心理式选词原因，改为更短的词义、当前语境和语义关注点比较。
- Stage15：Word Analysis Skill v6 进一步极简化，Detail 只保留当前句中含义和必要的核心近义词区别。
- Stage16：只优化 Word Analysis Detail 浮窗的视觉密度，在基础信息、当前语境和近义词区别之间增加轻量分区。
- Stage18：新增独立生词本页面，支持增强词条字段、搜索、随机/最近/字母排序和会话内稳定随机顺序。
- Stage18.1：增强语境回忆，在生词本安全高亮原句中的查询词，并为原句异步补写一次性中文译文。
- Stage18.2：修复句子边界启发式，避免把小数点和高频学术缩写中的句点误判为句末。
- v1.0.1：修复保存词条后浮窗自动关闭的问题；保存成功后浮窗保持显示，保存失败后按钮恢复可点击以便重试。

当前插件版本为 `1.0.1`。

## 文件结构

- `manifest.json`：Manifest V3、权限、service worker、content script、popup 和设置页。
- `background.js`：右键菜单、状态查询、统一语言处理、保存去重和设置页消息。
- `content.js`：提取选区与上下文，显示状态感知浮窗并渲染翻译或语境解析。
- `ai-context-skill.js`：Word Analysis Skill v6 指令、快速/详细两层 JSON Schema 和本地结果校验。
- `deepseek-context-provider.js`：DeepSeek Chat Completions 请求、JSON Output、完成状态检查、空响应重试、超时、取消和缓存。
- `gemini-context-provider.js`：Gemini REST 请求、结构化输出、错误映射、超时、取消和内存缓存。
- `baidu-translation-provider.js`：百度翻译签名、请求、限速、错误映射和缓存。
- `translation-provider.js`：四种 Provider 的注册、能力声明、统一调度和旧接口兼容。
- `md5.js`：百度 API 使用的本地 UTF-8 MD5 实现。
- `options.html`、`options.css`、`options.js`：Provider 模式以及百度、DeepSeek、Gemini 凭据设置。
- `popup.html`、`popup.css`、`popup.js`：词条数量、设置入口和独立生词本入口。
- `vocabulary.html`、`vocabulary.css`、`vocabulary.js`：独立生词本页面、搜索、排序、删除和打开来源。

## v1.0.0 核心能力

- 无缝划词浮窗：划词后自动出现 fixed 浮窗，支持 resize、内部滚动、外部点击、Esc 和关闭按钮；旧请求会取消或被迟到响应隔离。
- Word Analysis：显示 `word / lemma / phonetic / partOfSpeech / meaning`，并按需提供简洁 `meaningInSentence` 和可选 `comparison`。不输出 `academicMeaning`、`wordChoiceReason` 或作者意图分析。
- Sentence Translation：自动识别句子或段落，输出自然中文翻译和必要关键术语；与 Word Analysis 使用独立 Skill。
- Provider Framework：支持 Gemini、DeepSeek、百度和 Mock，可在设置页切换；包含缓存、超时、错误处理和请求生命周期控制。
- 独立生词本：保存原词、原形、音标、词性、释义、英文语境、中文语境译文、来源和时间；支持安全高亮、搜索、随机/最近/字母排序、删除和打开来源。
- 论文文本边界修复：保护 `4.0`、`95.5` 等数字小数点，并保护有限高频学术缩写，如 `Fig.`、`Eq.`、`Ref.`、`Sec.`、`No.`、`e.g.`、`i.e.`、`et al.` 和 `vs.`。

## 安装或更新

1. 打开 `chrome://extensions`。
2. 开启“开发者模式”。
3. 首次安装时点击“加载已解压的扩展程序”。
4. 选择 `D:\Project_Experimental\Translator_Plugin`。
5. 已安装旧版本时点击扩展卡片上的“重新加载”。
6. 确认版本显示为 `1.0.1`。

项目不需要 `npm install`，不包含 React、Vue、TypeScript 或后端服务。

## 使用方法

1. 点击工具栏插件图标，在 popup 顶部点击“设置”。
2. 选择“百度快速翻译”“DeepSeek AI 语境解析”“Gemini AI 语境解析”或“Mock 测试”。
3. 根据所选模式保存凭据并执行连接测试。
4. 打开普通英文网页，选中单词或短语。
5. 浮窗立即出现；收录状态和语言处理结果分别异步更新。
6. 点击“加入生词本”或“保存当前语境”。
7. 备用方式：选中文字后右键点击“加入生词本”。
8. 在 popup 中点击“打开生词本”，在独立页面查看、搜索、排序、打开来源或删除词条。

## Stage7 DeepSeek AI 语境解析

Stage7 将语言处理调度改为 Provider 注册表。每个 Provider 声明自己的 `resultType` 和执行函数；浮窗只关心 `quickTranslation` 或 `contextAnalysis`，不需要识别具体服务名称。当前注册项为百度、DeepSeek、Gemini 和 Mock，未来接入 OpenAI 时可增加同契约的注册项，无需重写浮窗。

DeepSeek 使用：

```text
POST https://api.deepseek.com/chat/completions
Authorization: Bearer <DeepSeek API Key>
Content-Type: application/json
```

默认模型为 `deepseek-v4-flash`，设置页允许填写账号可用的其它模型且不使用模型白名单。请求使用 `response_format: { type: "json_object" }`、`thinking: { type: "disabled" }`、`max_tokens: 500` 和 `stream: false`。提示明确要求只能返回 JSON，并按 `analysisMode` 包含快速层或详细层 JSON 示例；结果仍通过 `ai-context-skill.js` 的严格本地校验。

只有 `finish_reason === "stop"` 才进入 JSON 解析。`length`、`content_filter`、`insufficient_system_resource`、`tool_calls`、缺失值和未知状态均直接转为明确错误。若正常完成但 `content` 为空，Provider 会在同一超时和取消控制范围内自动重试一次；第二次仍为空即失败，不会无限重试。

### 配置 DeepSeek

1. 在 DeepSeek 平台创建个人 API Key。
2. 在插件设置页选择“DeepSeek AI 语境解析”。
3. 填写 API Key 和 Model ID；留空 Model ID 时使用 `deepseek-v4-flash`。
4. 点击“保存 DeepSeek 配置”，随后点击“测试 DeepSeek”。
5. Key 输入框保存后会清空，留空再次保存会保留已有 Key；“清除”只删除 DeepSeek 配置。

DeepSeek 分析结果、Gemini 分析结果和快速译文都只存在于当前浮窗或 service worker 内存缓存中，不写入生词记录。

## Stage15 Word Analysis Skill v6

Skill v6 的定位是“最小有效阅读支点”，只服务 Word Analysis，不替代 Stage13 的 Sentence Translation。Gemini 与 DeepSeek 共用 `context-analysis-v6`，并分为两层：

- 快速层：划词后自动请求，返回紧凑词汇信息，不打断阅读。
- 详细层：用户点击“详细解释”后才请求，只解释该词在当前句子中的含义；只有存在明显近义词语义区别时，才比较一个最相关近义词的核心区别。

快速层固定返回：

```js
{
  word,
  lemma,
  phonetic,
  partOfSpeech,
  meaning
}
```

- `word`：用户选择的原始单词或短语。
- `lemma`：真实词典原形，不解释词形变化。
- `phonetic`：由当前 AI Provider 在同一次请求中生成的简洁 IPA。
- `partOfSpeech`：严格限定为 `adj.`、`v.`、`n.`、`adv.`、`prep.` 或 `phr.`。
- `meaning`：该词本身的常见中文含义，不再单独生成“论文中含义”。

详细层固定返回：

```js
{
  meaningInSentence,
  comparison
}
```

- `meaningInSentence`：简洁说明该词在当前句子里具体表示什么。
- `comparison`：只有存在明显近义词语义区别时，返回 `{ word, difference }`；否则为 `null`。

两层 Schema 都禁止额外字段。快速层所有字段必须是非空字符串；详细层的 `meaningInSentence` 必须非空，`comparison` 必须是严格的两字段对象或 `null`。词性根据当前句子的实际功能判断，例如 `reinforcing effect` 中应判断为 `adj.`。指令明确强调：AI 不替用户完成理解，只提供理解支点；`comparison` 是语义区别，不是原因分析。禁止 Markdown、作者心理分析、论文背景扩展、长篇总结、同义词列表和写作建议。

Stage15 继续沿用 Stage14 删除 `academicMeaning` 和 `wordChoiceReason` 的方向，并删除 `comparison.contextReason`。`comparison.difference` 只说明两个词的核心语义区别，例如 `employ` 强调把技术、工具作为手段使用，`apply` 强调把方法作用于具体对象；`reinforcing` 强调增强已有结构或性能，`strengthening` 强调整体上使某物变得更强。

## Gemini AI 语境解析

Gemini 模式已经可以通过 Interactions API 运行。它接收当前选词和上下文句子，按 Word Analysis Skill v6 返回快速层或详细层结果：

```js
{
  word,
  lemma,
  phonetic,
  partOfSpeech,
  meaning
}
```

浮窗分别显示“单词”“音标”“词性”和“含义”，不会显示原始 JSON。用户点击“详细解释”后，Gemini 再请求详细层并展示“当前语境”，并在确有必要时显示一个“近义词区别”。分析 Skill 版本为 `context-analysis-v6`。

Gemini Provider 的运行时结果格式为：

```js
{
  provider: "gemini",
  resultType: "contextAnalysis",
  skillVersion: "context-analysis-v6",
  analysisMode: "quick" | "detail",
  analysis
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
    schema: geminiCompatibleSchema
  },
  store: false
}
```

每次划词都是独立请求，不发送工具或 `previous_interaction_id`。`store: false` 禁止服务端保存 Interaction 供后续会话复用。

Stage12 中，详细层使用 `comparison: { type: ["object", "null"] }` 表达可选的语义比较，对象内部严格限定为 `word` 和 `difference`。该写法沿用 Gemini Structured Output 已验证的联合类型方式，不转换为旧式 `nullable: true`。detail 请求仍带有安全的请求关联 ID，并在 content script、service worker 和 Gemini Provider 中记录不含 API Key 与完整上下文的生命周期日志，便于区分主动取消、HTTP 错误和网络异常。Provider 通过 `controller.signal.aborted` 识别带字符串 reason 的取消，避免把 `superseded` 或 `timeout` 错误包装为 `NETWORK_ERROR/httpStatus: 0`。

Stage9.2 进一步修复页面交互生命周期：浮窗内部按钮的 `mouseup` 不再进入“重新读取选区并创建浮窗”的 document 级处理，因此点击“详细解释”不会偷偷启动新的 quick 请求并取消当前 detail。`currentSelectionId` 只代表当前用户选区，`detailAnalysisRequestId` 只代表当前详细分析请求；detail 响应必须同时匹配两者才会更新浮窗。安全日志使用 `DETAIL_REQUEST_START`、`DETAIL_RESPONSE_RECEIVED`、`DETAIL_RESPONSE_APPLIED` 和 `DETAIL_RESPONSE_DISCARDED`，只记录 ID、状态和丢弃原因，不记录用户文本。

## Stage10 浮窗交互

浮窗现在使用 `position: fixed`：首次出现时仍根据选区定位，随后保持当前视口位置。页面滚动不会关闭浮窗、改变 `currentSelectionId`、增加 `detailAnalysisRequestId`、重新创建浮窗或取消 Quick/Detail；Detail 内容较长时由浮窗内部区域滚动。

Quick、状态或 Detail 内容改变浮窗尺寸后，只执行视口边界修正，不再重新跟随原文字。窗口 resize 时同样只修正边界。浮窗内部事件通过 `event.composedPath()` 或 `contains()` 识别，按钮操作、文本选择、滚动条和内部 `mouseup` 不会被当成页面外部操作。

点击页面外部、关闭按钮或按 Esc 会关闭浮窗、清理选区快照并使双 ID 生命周期失效。关闭时通过 `CANCEL_LANGUAGE_REQUEST` 发送当前 Quick/Detail 的精确 request ID；Provider 只取消匹配请求，迟到的旧关闭消息不会误伤新选词。重新划选正文中的新词会替换旧浮窗，旧响应继续由 selection/detail 双 ID 检查阻止。

### 配置 Gemini

1. 在 Google AI Studio 创建 Gemini API Key，并确认账号可访问所填模型。
2. 在插件设置页选择“Gemini AI 语境解析”。
3. 填写 API Key 和 Model ID；默认值为 `gemini-3.5-flash`。
4. 点击“保存 Gemini 配置”。保存后 Key 输入框清空，不回显完整 Key。
5. 点击“测试 Gemini”。测试使用单词 `employed` 和一条英文例句。

Gemini 请求具有 20 秒超时。快速重新划词会取消同一 service worker 中仍在进行的旧 Gemini 请求；相同选词、上下文、标题、模型和 Skill 版本可命中会话内存缓存。配置变化时缓存会清除。

Interactions API 返回后，Provider 仅在 `status === "completed"` 时读取 `steps[].model_output.content[].text`。`failed`、`incomplete`、`cancelled`、`budget_exceeded`、`requires_action`、`in_progress` 和其它非 completed 状态都会直接转为明确错误，不进入 JSON 解析。

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
-> TRANSLATE_TEXT 进入 background.js 的统一语言处理入口，默认 analysisMode=quick
-> Baidu / DeepSeek / Gemini / Mock Provider 返回带 resultType 的结果
-> content.js 分支渲染快速译文或快速层学术语境解析
-> 用户点击“详细解释”时再次发送 TRANSLATE_TEXT，analysisMode=detail
-> DeepSeek / Gemini 返回详细层语境解析并在原浮窗展开
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

生词基础字段保持不变，Stage18/Stage18.1 只增加可选增强字段：

```js
{
  id,
  word,
  contextSentence,
  pageTitle,
  pageUrl,
  createdAt,
  lemma,
  phonetic,
  partOfSpeech,
  meaning,
  contextTranslation
}
```

Word Detail、Sentence Translation 的关键术语、近义词比较等 AI 分析仍为运行时数据，不写入 `vocabularyEntries`。完全相同的 `word + contextSentence + pageUrl` 仍会被阻止；同一个词可以保存多个不同语境。

## Stage18 独立生词本

Stage18 将原本挤在 popup 里的词条列表移动到独立扩展页面 `vocabulary.html`。popup 现在只保留词条数量、设置入口和“打开生词本”按钮，长期浏览、搜索、排序、删除和打开来源都在完整标签页中完成。

`vocabularyEntries` 仍使用同一个 `chrome.storage.local` key，不迁移、不清空旧数据。基础字段继续保持：

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

新保存的 Word Analysis 词条如果已经拿到 Quick 结果，会额外保存可选字段：

```js
{
  lemma,
  phonetic,
  partOfSpeech,
  meaning,
  contextTranslation
}
```

`lemma / phonetic / partOfSpeech / meaning` 只在浮窗已有 Word Analysis Quick 结果时随保存一起写入，不会为了补字段而再次调用 AI。`contextTranslation` 是 Stage18.1 新增的可选原句译文，保存操作不等待它完成。右键菜单保存、句子或段落保存仍可只保存基础字段。旧词条缺少新字段时继续正常显示，页面会隐藏缺失项，不显示空标签或 `undefined`。

精确重复仍按 `word + contextSentence + pageUrl` 判断。新增字段不参与重复身份判断。若用户再次保存一个精确重复旧词条，且本次有 Quick 字段或已有语境译文，后台只会补充旧条目中缺失的 `lemma / phonetic / partOfSpeech / meaning / contextTranslation`，不会创建重复词条，也不会覆盖已有非空字段、`id` 或 `createdAt`。

生词本页面提供三种排序：

- 随机：默认模式，适合重新遇见旧词。
- 最近添加：按 `createdAt` 从新到旧。
- 字母顺序：优先按 `lemma`，没有 lemma 时按 `word`。

排序模式保存到 `chrome.storage.local` 的 `vocabularySortMode`。随机顺序保存到 `chrome.storage.session` 的 `vocabularyRandomOrder`，只保存词条 id 数组，不复制词条对象。同一次 Chrome 运行期间，刷新或重开生词本页面都会保持随机顺序；完全关闭并重启 Chrome 后会重新生成。新增词条只追加到随机顺序末尾，删除词条只移除对应 id，搜索只过滤当前顺序，不会重排。

Stage18 不做词根、熟悉度、打卡、智能复习、间隔重复、自动出题、AI 复习内容或云同步。

## Stage18.1 语境回忆

Stage18.1 在独立生词本中增强“看到原句时想起词义”的体验：

- 英文原句中会安全高亮保存时的原始查询词，大小写不敏感，支持短语和多次出现。
- 高亮使用 `createTextNode()`、`mark` 和 `DocumentFragment` 渲染，不拼接未经转义的 `innerHTML`。
- 高亮会做英文边界判断，避免 `art` 错误命中 `partial` 这类其它单词内部子串；连字符、撇号和数字相邻时也不会被简单切开。
- 当保存的是整句、长短语或选区占原句比例过高时，会跳过高亮，避免整段变成高亮文本。
- 原句下方可显示 `contextTranslation`，作为次级中文辅助信息；缺失时不显示空区域。

语境译文是持久化到 `vocabularyEntries` 的可选字段，但不参与三态判断、搜索身份或重复判断。浮窗保存仍然即时完成；如果保存时当前选区已经完成 Sentence Translation，会直接带上译文。否则 content script 会在保存成功后发送后台消息异步补译，浮窗提示和关闭都不等待补译。

后台补译有两个重要限制：

- 打开生词本页面不会批量翻译旧词条，避免无意消耗 API 配额。
- 调用 Provider 前会先查找同一 `pageUrl + contextSentence` 是否已有非空译文；如果有则复用。运行中的同语境任务也会共享，同一句中保存多个不同单词时最多触发一次 Provider，成功后补写所有同语境且缺少译文的现存词条。

已有非空 `contextTranslation` 永不覆盖。翻译失败、Provider 不支持或词条在翻译完成前被删除，都不会影响原词条。

## Stage18.2 句子边界修复

Stage18.2 针对 `content.js` 的 `contextSentence` 提取启发式做小范围修复。此前分句只把 `. ? ! ;` 视为句末，容易把 `Industry 4.0`、`95.5%` 这类数字内部小数点误判成句子边界，也可能在 `Fig. 2`、`e.g.`、`et al.` 等学术写法中提前截断语境。

现在候选句点会先经过两类保护：

- 数字小数点：当 `.` 前后都是数字时，不视为句末，例如 `4.0`、`95.5`、`2.1`。
- 高频学术缩写：有限保护 `Fig.`、`Eq.`、`Ref.`、`Sec.`、`No.`、`e.g.`、`i.e.`、`et al.` 和 `vs.`。

这仍然是轻量启发式，不是完整自然语言句法解析。插件没有引入 `Intl.Segmenter`、NLP 模型、第三方分句库或大型缩写数据库。普通 HTML 页面支持较好，PDF、Canvas、扫描文本和复杂阅读器仍可能无法准确提供完整上下文。

## v1.0.1 浮窗持久性修复

v1.0.1 修复了保存词条后浮窗自动关闭的问题。点击“加入生词本”后，按钮会显示“已加入”或“已保存”，但浮窗不会因为保存成功、鼠标移出、selection 变为空或异步 `contextTranslation` 任务而关闭。用户可以继续查看 Word Analysis、点击 Detail、滚动内容或调整浮窗大小。

保存失败时浮窗同样保持显示，按钮会恢复为可点击状态，允许用户重试。浮窗仍会在明确点击关闭按钮、按 Esc、点击浮窗外部或重新划选有效文本时关闭或替换。

## 两层语境解析

Stage9 已实现两层语境解析，但仍保持运行时展示，不写入生词本：

```text
用户划词
-> 快速层请求
-> 显示 word / lemma / phonetic / partOfSpeech / meaning
-> 用户点击“详细解释”
-> 详细层请求
-> 显示 meaningInSentence / comparison（必要时）
```

详细层重点回答“这个词在这里具体表示什么”。例如 `employ` 与 `apply` 都可译为“使用、应用”，但 `employ` 强调把技术、工具作为手段使用，`apply` 强调把方法作用于具体对象。只有明显近义词语义区别存在时，才返回一个 `comparison`；否则返回 `null`，不生成同义词列表。

## Stage13 句子与段落翻译

Stage13 在原有 Word Analysis 外新增独立的 Sentence Translation。它面向“先快速读懂整体，再回头学习词汇”的论文阅读流程，不会替代单词的科研语境分析。

- Word Analysis：单词、短语或短文本继续显示原形、音标、词性和常见含义，并可按需打开详细解释。
- Sentence Translation：选中包含 `. ? ! ;` 的文本、超过 10 个词的文本或超过 80 个字符的文本时，浮窗显示自然中文译文，以及可选的一个关键技术术语说明。

Gemini 和 DeepSeek 共同使用 `sentence-translation-skill.js` 中的 `sentence-translation-v1`。这个 Skill 只要求自然翻译、专业术语和逻辑关系的准确保留；不输出音标、词性、`comparison`、近义词解释或详细词汇分析。返回结构为：

```js
{
  translation: "中文译文",
  keyTerm: null | { term: "专业术语", meaning: "简短中文解释" }
}
```

`keyTerm` 不是关键词列表，默认是 `null`；仅在一个专业术语明显影响理解时才出现。AI 句段翻译返回 `resultType: "sentenceTranslation"`，而百度和 Mock 即使翻译句子或段落也继续返回 `resultType: "quickTranslation"`。所有译文和术语解释仍只存在于当前浮窗或内存缓存中，不写入 `vocabularyEntries`。

## 安全说明

- 百度密钥、DeepSeek API Key 和 Gemini API Key 不硬编码在源码中，也不会发送给 content script。
- Service Worker 控制台只记录 Provider、HTTP 状态、内部错误码、requestId 及经过脱敏和截断的 API 错误信息；不记录凭据、请求头、选词、完整上下文、请求体或完整服务响应。
- `chrome.storage.local` 不是加密保险箱。本实现适合个人本机 Demo，不适合共享电脑或把统一密钥打包公开发布。
- `vocabularyEntries` 和 `translationSettings` 都保存在当前 Chrome 的扩展本地存储中，不应导出后提交到仓库。
- 仓库不应包含真实 API Key、Token、Cookie、用户个人词库、浏览记录或本地配置文件。
- 正式发布时应评估用户自有凭据、安全后端代理、配额保护、隐私政策和数据处理说明。

## 当前限制

- Chrome 内置 PDF Viewer 当前不支持无缝划词；WPS PDF 插件仍属于下一阶段可行性验证，不属于 v1.0.0。
- 不支持 Windows 全系统全局划词。
- 不做智能复习、间隔重复、打卡、词根、自动出题或云同步。
- 生词本当前采用连续下拉渲染，没有传统分页；词条数量非常大时，未来可考虑前端分批渲染或虚拟列表。
- 打开生词本不会批量补译旧词条，避免无意消耗 API 配额。
- AI 输出可能存在误差，DeepSeek 与 Gemini 的语言质量也可能不同。
- Provider 能力依赖用户配置、网络状态、API 配额和对应服务可用性。
- 句子边界仍是有限启发式，不是完整 NLP 解析；特殊缩写、PDF、Canvas、扫描文本和复杂阅读器仍可能受限。

## 后续方向

- 验证 WPS PDF 无缝划词的可行性。
- 大量词条时优化生词本分批渲染或虚拟滚动。
- 根据真实用户反馈继续优化 Word Analysis、Sentence Translation 和生词复习体验。

## 手动验收清单

- 重新加载后确认 Manifest V3 和版本 `1.0.1`。
- 划选 `biosensing` 后滚动页面，确认浮窗保持在当前视口位置。
- Detail 加载期间滚动页面，确认请求继续并正常显示结果。
- 在 Detail 长内容区域内部滚动，确认浮窗不关闭。
- 点击浮窗外部、关闭按钮和按 Esc，分别确认浮窗关闭。
- 浮窗存在时重新划选新词，确认旧响应不会覆盖新内容。
- popup 顶部“设置”能够打开 options 页面。
- popup 顶部“打开生词本”能够打开独立 `vocabulary.html` 页面。
- 保存一个已有 Word Analysis Quick 结果的新词，确认生词本显示 lemma、音标、词性和释义。
- 右键保存一个无 AI 字段词条，确认生词本仍正常显示基础字段。
- 保存完整句子或段落，确认只保存基础字段，长文本自然换行且不横向溢出。
- 保存普通单词后确认按钮立即成功，稍后生词本原句下方出现中文语境译文。
- 同一句保存多个不同单词，确认译文被复用并补写到多个词条。
- 确认原句中查询词被高亮，但 `art` 不会高亮到 `partial` 内部。
- 保存整句或长段落时确认不会整段高亮。
- 划选 `Industry 4.0` 后方单词，确认保存语境不是从 `0 has...` 开始。
- 划选包含 `Fig. 2`、`e.g.` 或 `et al.` 的句子中单词，确认语境保留完整句子。
- 划选 `Version 2.0. The next sentence...` 前后两个句子中的词，确认内部小数点不切句、真正句末仍切句。
- 验证随机、最近添加和字母顺序三种排序。
- 刷新或重开生词本页面，确认同一次 Chrome 运行中的随机顺序不变。
- 点击“重新随机”，确认随机顺序更新。
- 搜索词条后清空搜索，确认恢复原随机顺序。
- 删除词条后确认只移除对应 id，不整体重排随机顺序。
- 在生词本页面打开期间从网页新增词条，确认页面实时更新且旧随机顺序不变。
- 对旧精确重复词条进行渐进补全，确认 id、createdAt 和随机位置不变。
- 验证打开来源拒绝 `javascript:`、`data:` 和无效 URL。
- Stage5 百度旧配置仍能读取和翻译。
- 四种模式切换不会清除其它模式的凭据。
- 保存并测试真实 DeepSeek Key，确认默认 `deepseek-v4-flash` 或账号可用模型返回快速层结果。
- 使用无效 DeepSeek Key、错误 Model ID、断网、限流和服务端错误验证中文提示。
- 确认 DeepSeek `length`、内容过滤、资源不足、工具调用和未知完成状态不会进入 JSON 解析。
- 模拟一次空 content 后成功，确认只自动重试一次；连续两次空 content 时明确失败。
- 使用真实 Gemini Key 测试 `gemini-3.5-flash`。
- 切换到 `gemini-3.1-flash-lite` 再测试一次。
- Gemini 浮窗显示“单词、音标、词性、含义”，不显示原始 JSON。
- 点击“详细解释”，确认浮窗只展开当前语境和必要的近义词区别，不出现作者心理分析、背景扩展或长篇总结。
- 选择 `exposure` 并点击“详细解释”，确认基础信息和当前语境之间有浅灰细分割线。
- 验证 `employed` 在确有语义区别时生成 employ/apply 核心区别。
- 验证 `employ` 有 comparison 时，“当前语境”和“近义词区别”之间有浅灰细分割线。
- 验证 `reinforcing` 不强制生成 comparison；若生成，只能是 reinforcing/strengthening 的核心语义区别。
- 验证 `reinforcing` 无 comparison 时，不显示空的近义词区域或多余分割线。
- 验证 `reinforcing effect` 的词性为 `adj.`，且没有明确替代关系时 `comparison` 为 `null`。
- 验证 `electrochemical` 不会被强制生成近义词比较。
- 验证 `reinforcing` 显示类似 `reinforce (reinforcing)`，不展示冗余词形变化长解释。
- 确认 `partOfSpeech` 只显示约定的六种缩写之一。
- 加载语境解析期间仍可保存词条。
- 使用无效 Key、错误 Model ID、断网和限流场景验证错误提示。
- 若请求失败，确认 Service Worker Console 显示安全的 Google `error.status` 和 `error.message`，且不包含选词、上下文或 API Key。
- 失败后点击“重试”，确认重新发起当前选区请求。
- 快速连续选择不同文本，确认旧响应不覆盖新浮窗。
- 重复选择相同文本和上下文，确认当前 service worker 会话可命中缓存。
- 回归三种收录状态、完全重复去重和多语境保存。
- 回归右键保存、popup 排序/删除/打开来源和升级前旧词条。
- 选中 `reinforcing` 和 `reinforcing effect`，确认仍进入 Word Analysis。
- 选中一条完整英文句子或超过 10 个词的段落，确认 Gemini/DeepSeek 显示中文句段译文，不显示音标、词性、comparison 或“详细解释”。
- 在句段中包含阻碍理解的专业术语时，确认最多显示一个“关键术语”；普通文本不应生成词汇列表。
- 切换百度或 Mock 后选中句子，确认仍显示快速译文，且不把它显示为 AI 关键术语结果。

## 已知限制

- DeepSeek 和 Gemini 结果由外部模型生成，可能存在语义错误；Schema 校验只能保证结构，不能保证事实正确。
- 当前没有 OpenAI/GPT、DeepL、一词多义列表、发音、词典详情、搜索、标签、复习算法或云同步。
- 音标由 AI Provider 生成，当前不接入权威发音词典，也不播放音频。
- 当前没有第三层写作辅助，也不保存 AI 详细解释到生词本。
- AI 分析和翻译结果不持久化，service worker 休眠后内存缓存会消失。
- API 可用性、额度、限流、模型生命周期和费用由服务提供方决定。
- PDF、Canvas、扫描文本和复杂阅读器可能无法正确提供选区或完整上下文。
- 与其它划词插件同时启用时，允许多个浮窗同时出现。

## 后续候选

- 为 Provider 请求增加更细粒度的诊断和可选重试策略。
- 评估安全后端代理和生产级密钥管理。
- 为 Skill 增加版本回归样例与自动化浏览器测试。
- 在不改变现有词条结构的前提下评估用户可选的分析结果持久化。
