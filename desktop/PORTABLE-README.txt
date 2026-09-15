Orange翻译 Windows x64 便携版

将整个目录解压后运行 Orange翻译.exe，不要只复制 EXE。
需要 Microsoft WebView2 Runtime。使用 WPS 功能还需要本机安装 WPS。
随包包含专用 Python 3.10.11、.NET 8.0.7、PyMuPDF 1.28.2；无须预装 Python/.NET。
这些版本复用了现有测试基线，并非最新安全版本；不要把旧运行时版本理解为长期免维护承诺。

访问码通过独立渠道取得，再由本人在设置中输入。此目录不包含访问码或 API Key。
Quick 优先本地词典；没有有效释义时可能请求在线 Model Quick。
Detail 按需使用目标词和取得的上下文请求在线语境解释。请勿在敏感文档上随意启用在线翻译。
三档模式对应 UltraFast / Fast / Precise。F1 暂停或恢复，托盘可完全退出。

WPS PDF：支持已验收的单选区单词和连字符词。多词、整句、整段、多选区及扫描 PDF
不作通用支持保证。Writer 使用通用捕获路径，不保证取得精确文档上下文。
不自动更新 WPS，不附带 WPS 或 WebView2。不同 WPS 版本和干净机器仍需实际验收。

“便携”指运行依赖随包提供，不代表用户数据全部写在 EXE 旁边。
应用仍按现有逻辑使用本机用户数据目录保存设置、生词本与用户覆盖释义。
初次运行看到旧设置可能是本机已有数据，不是此 ZIP 携带了用户数据。

许可：Orange Desktop（含 WPS helper）采用 AGPL-3.0-only，无担保。
完整条款见 LICENSE.txt，组件范围见 LICENSING.md，第三方通知见 licenses/ 和运行环境内通知。
同时取得与本包匹配的 Orange-Desktop-Source.zip，内含 Desktop 源码、构建说明、Rust
依赖源码及 PyMuPDF/MuPDF 对应源码。转发本包时请一并提供匹配源码，不附加禁止转发条款。
源码不包含 Gateway 凭据、个人文档、生词本或访问码；这些不是编译所需材料。
如未收到对应源码，请联系分发者索取；分发者应同时提供两个文件。
