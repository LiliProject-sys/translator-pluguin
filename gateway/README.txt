Translator-plugin Gateway Beta 本地服务说明

本目录为 Chrome Translator-plugin 的轻量 Beta Gateway。

当前范围：
- 本地 FastAPI Gateway；
- 本地 /health、/v1/auth/verify、/v1/language；
- Gateway 固定调用 Gemini 模型 gemini-3.1-flash-lite；
- Chrome 插件本地开发地址 http://127.0.0.1:8000；
- Cloud Run 部署文件准备，但不实际部署。

本阶段不包含：
- 用户账号、注册、登录、支付；
- 数据库、Redis、云端生词本；
- DeepSeek 或百度中转；
- Cloud Run 实际部署；
- 远程朋友 Beta 打包；
- manifest 版本升级到 1.1.0。

环境变量：
- BETA_ACCESS_TOKEN：共享 Beta Token；
- GEMINI_API_KEY：服务端 Gemini Key；
- GEMINI_MODEL：默认 gemini-3.1-flash-lite；
- PORT：本地或 Cloud Run 注入端口。

本地推荐启动方式：
.\gateway\启动本地网关.ps1

脚本说明：
- 自动定位 gateway/.venv/Scripts/python.exe；
- 自动检查 gateway/.env 是否存在；
- 自动检查 BETA_ACCESS_TOKEN、GEMINI_API_KEY、GEMINI_MODEL 是否存在且非空；
- 显式通过 --env-file gateway/.env 加载本地配置；
- 固定监听 http://127.0.0.1:8000；
- /health 用于检查服务是否存活；
- /docs 用于查看本地接口文档；
- Uvicorn 在当前窗口前台运行，按 Ctrl+C 停止。

注意：
- 127.0.0.1 只供本机 Chrome 插件使用；
- 朋友远程使用需要未来部署 Cloud Run；
- Cloud Run Source Deploy 应在仓库的 gateway/ 目录执行，gateway/ 是 Docker build context；
- Dockerfile 的 COPY 路径均以 gateway/ 为根，不依赖仓库根目录；
- 容器启动后监听 0.0.0.0，并读取 Cloud Run 注入的 PORT，默认回退 8080；
- Cloud Run 不使用本地启动脚本，也不读取本地 .env，而是使用平台环境变量；
- BETA_ACCESS_TOKEN 与 GEMINI_API_KEY 将来通过 Secret Manager 或等价安全方式注入；
- GEMINI_MODEL 将来通过 Cloud Run 平台环境变量设置；
- 当前阶段只完成部署准备与审计，尚未实际部署 Cloud Run。

隐私约束：
- Token 只通过 Authorization: Bearer 发送；
- 语言请求 body 只允许 requestId、requestType、analysisMode、sourceLanguage、targetLanguage、text、contextSentence、pageTitle；
- 不发送 pageUrl、userQuestion、Prompt、模型名、Gateway URL、Gemini API Key 或整页正文；
- 日志不得记录完整用户文本、完整 Prompt、完整模型响应、Token 或 API Key。
