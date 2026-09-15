Translator-plugin Gateway Beta 本地服务说明

本目录为 Chrome Translator-plugin 的轻量 Beta Gateway。

当前范围：
- 本地 FastAPI Gateway；
- 本地 /health、/v1/auth/verify、/v1/language；
- Gateway 通过 GATEWAY_UPSTREAM_PROVIDER 在 Gemini 与 DeepSeek V4 Flash 之间选择上游；
- Chrome 插件当前 Beta 默认连接 Cloud Run 远程 Gateway；
- 本地 http://127.0.0.1:8000 仅用于开发调试。

本阶段不包含：
- 用户账号、注册、登录、支付；
- 数据库、Redis、云端生词本；
- 浏览器按请求选择 Gateway 上游模型（计划在第二阶段实现）；
- 已部署的 Cloud Run 服务端本身；
- 远程朋友 Beta 打包；
- manifest 版本升级到 1.1.0。

环境变量：
- BETA_ACCESS_TOKEN：共享 Beta Token；
- GATEWAY_UPSTREAM_PROVIDER：gemini 或 deepseek，缺失时默认 gemini；
- GEMINI_API_KEY：服务端 Gemini Key；
- GEMINI_MODEL：默认 gemini-3.1-flash-lite；
- DEEPSEEK_API_KEY：服务端 DeepSeek Key；
- DEEPSEEK_MODEL：默认 deepseek-flash；
- DEEPSEEK_BASE_URL：默认 https://api.deepseek.com；
- PORT：本地或 Cloud Run 注入端口。

本地开发推荐启动方式：
.\gateway\启动本地网关.ps1

脚本说明：
- 自动定位 gateway/.venv/Scripts/python.exe；
- 自动检查 gateway/.env 是否存在；
- 自动检查 BETA_ACCESS_TOKEN，并按当前上游只检查 GEMINI_API_KEY 或 DEEPSEEK_API_KEY；
- 显式通过 --env-file gateway/.env 加载本地配置；
- 固定监听 http://127.0.0.1:8000；
- /health 用于检查服务是否存活；
- /docs 用于查看本地接口文档；
- Uvicorn 在当前窗口前台运行，按 Ctrl+C 停止。

注意：
- 本地脚本只用于开发调试，不是普通用户远程 Beta 的启动方式；
- 当前插件 Beta 默认连接 Cloud Run，普通用户不需要运行本地 Gateway；
- 127.0.0.1 只供开发者本机调试使用；
- Cloud Run Source Deploy 应在仓库的 gateway/ 目录执行，gateway/ 是 Docker build context；
- Dockerfile 的 COPY 路径均以 gateway/ 为根，不依赖仓库根目录；
- 容器启动后监听 0.0.0.0，并读取 Cloud Run 注入的 PORT，默认回退 8080；
- Cloud Run 不使用本地启动脚本，也不读取本地 .env，而是使用平台环境变量；
- BETA_ACCESS_TOKEN、GEMINI_API_KEY 与 DEEPSEEK_API_KEY 通过 Secret Manager 或等价安全方式注入；
- GATEWAY_UPSTREAM_PROVIDER、GEMINI_MODEL、DEEPSEEK_MODEL 与 DEEPSEEK_BASE_URL 通过 Cloud Run 平台环境变量设置；
- DeepSeek Secret 建议命名为 translator-deepseek-api-key，Secret 值不得写入仓库或报告；
- 第一阶段通过 Revision 级环境变量统一切换上游，旧扩展协议不变；验证通过后再增加前端按请求选择。

隐私约束：
- Token 只通过 Authorization: Bearer 发送；
- 语言请求 body 只允许 requestId、requestType、analysisMode、sourceLanguage、targetLanguage、text、contextSentence、pageTitle；
- 不发送 pageUrl、userQuestion、Prompt、模型名、Gateway URL、Gemini API Key 或整页正文；
- 日志不得记录完整用户文本、完整 Prompt、完整模型响应、Token 或 API Key。

Translation Mode v2（2026-09-15）补充，以下覆盖旧阶段路由说明：
- /v1/language 的 mode 支持 ultra_fast / fast / precise。
- ultra_fast：DeepSeek Flash，thinking disabled，不发送 reasoning_effort。
- fast：同一 DeepSeek 模型和正式 Skill，thinking enabled + reasoning_effort max。
- precise：现有 Gemini 模型、Prompt、请求和解析保持不变。
- 路由配置集中在 app/translation_profiles.py；DeepSeek 两档沿用 Lab 的非流式 JSON 请求，不指定 max_tokens。
- Desktop 新配置或缺 mode 默认 ultra_fast；已明确保存的 fast/precise 不迁移。
- 未传 mode 的旧 Gateway 调用仍默认 precise，避免影响旧浏览器客户端。
- 正式 DeepSeek Detail 保留 V12；Quick 和句子继续各自原有 Skill；不导入 Lab 默认 V1。
- Gateway 本地 translation_profile 日志仅包含模式、模型、推理配置、耗时和成功状态，无正文。
- 桌面正式地址仍为远程 Gateway；新桌面启用 ultra_fast 前，需要另行授权部署兼容服务端。
# Release authentication: one Bearer code per client, multiple server-side codes.
# BETA_ACCESS_TOKEN remains valid. Optional BETA_ACCESS_TOKENS is a JSON array
# of nonempty strings from Secret Manager; duplicates are removed. Malformed
# JSON fails startup; an empty combined allowlist rejects every request.
# Never put real codes in this file, examples, fixtures, or portable artifacts.
