# WPS PDF HostAdapter helper（本地集成 Spike）

Orange 的 Rust Registry 在原 Clipboard 事务前进行宿主分流。PDF 分支通过一个持久 JSONL helper 获取统一 Snapshot；helper 本身不调用翻译。Quick Integration Spike 在 Rust 的 Selection Bridge 中将 OK、准确 occurrence、exact 上下文的 Snapshot 接入现有 Quick 与 Popup。非 exact / fallback 只保留捕获诊断，不调用 Gateway、不回落复制。Writer 与普通 Windows 应用保留 Generic 捕获及 target-only 翻译语义。

## 本地构建

需要已有 .NET 8、Python 3.10 与 PyMuPDF 1.28.2。本轮复用了已有版本，没有升级依赖。`.venv`、`bin`、`obj` 不纳入源码。

```powershell
dotnet build desktop/helpers/wps-pdf/WpsPdfHelper.csproj -c Release
desktop/helpers/wps-pdf/.venv/Scripts/python.exe -m unittest discover -s desktop/helpers/wps-pdf/python -p "test_*.py"
dotnet desktop/helpers/wps-pdf/bin/Release/net8.0-windows/WpsPdfHelper.dll --self-test
```

开发目录中的 Python 默认使用 `.venv/Scripts/python.exe`，可由 `ORANGE_WPS_PYTHON` 指定已配置相同版本的 Python。随包布局优先使用 `runtime/python/python.exe`；没有项目文件的发布目录缺少此解释器时直接失败，不回退到开发环境。启动忽略 PYTHON 环境变量和 user-site，保留 worker 所在目录的模块导入。运行代码不引用 experiments。

桌面验收程序须使用 Tauri 构建入口嵌入页面。在 desktop 目录执行：

```powershell
node node_modules/@tauri-apps/cli/tauri.js build --no-bundle
```

不要以普通 `cargo build --release` 的成功代替桌面页面启动验收。正式 Rust 构建从 EXE 所在目录寻找 `helpers/wps-pdf/WpsPdfHelper.dll`，使用其下 `runtime/dotnet/dotnet.exe`，不再使用编译时工作区路径或系统 PATH。开发构建仍允许原工作区 helper。helper 从自身目录寻找 `python/worker.py`，仅有项目文件的开发目录允许旧布局。

以上是便携路径准备，不表示 Portable 已完成：仍需准备经许可核查的 .NET/Python/PyMuPDF 运行环境、源码提供材料及新目录实际解析测试。不要把仅含 EXE 和词典的包当成完整 WPS 发布包。

## 边界与生命周期

- Rust 只发送 interactionId 与 surfaceToken，不发送鼠标坐标。5 秒超时，helper 最多启动两次。
- helper 使用 STA COM；Python worker 私有 IPC 负责已验证的 v3 resolver。两者均为懒启动。
- Windows Job Object 仅负责自己启动的 helper/后代；正常退出先发送 exit。不会退出或终止 WPS。
- 读取前后复核表面、文档指纹、单个 Range；250ms 内要求两次一致样本，并校验 UTF-16 inclusive slice。
- PyMuPDF 失败时，仅在 WPS 精确选区已证实时返回局部 PageText fallback；不读整篇正文作为兜底。
- 文档切换清缓存，每个文档最多缓存四页。诊断不公开完整路径或原始异常。

## 真人验收阶段

HostAdapter 的 A-F 人工验收已完成，见 report_log 的 HostAdapter 最终报告。当前待验证的是 Quick 接入：开启自动翻译，在 PDF 选词后检查 loading、Quick 结果及独立 Quick 诊断；同词、多 PDF、快速切词、Writer 往返各取少量样本。只测试 Quick，不点击详细解释；本阶段 WPS Detail 后端准入关闭，原 Popup 按钮布局保留。真实请求由用户主动选词触发，本轮上限 100 次。

仍未覆盖通用工具栏分类、多 Range、其他 WPS 版本与安装分发。Quick 人工验收完成前 Gate 为 NEED_MORE_EVIDENCE；不沿用 HostAdapter 的 GO 作为 Quick 通过证据。
