param(
    [string]$OutputRoot = "D:\Project_Experimental\Translator_Plugin_Releases",
    [string]$PackageName = ""
)

$ErrorActionPreference = "Stop"

$CloudRunGatewayUrl = "https://translator-gateway-beta-268073468344.asia-northeast1.run.app"
$LocalGatewayPattern = "127\.0\.0\.1:8000|localhost:8000"

function Stop-WithError {
    param([string]$Message)
    Write-Error $Message
    exit 1
}

function Join-ProjectPath {
    param([string]$RelativePath)
    return Join-Path $ProjectRoot $RelativePath
}

function Copy-AllowlistFile {
    param(
        [string]$RelativePath,
        [string]$DestinationRoot
    )

    $source = Join-ProjectPath $RelativePath
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        Stop-WithError "缺少运行文件：$RelativePath"
    }

    $destination = Join-Path $DestinationRoot $RelativePath
    $destinationDirectory = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $destinationDirectory)) {
        New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
    }
    Copy-Item -LiteralPath $source -Destination $destination -Force
}

function Assert-NoCredentialRisk {
    param([string]$RootPath)

    $patterns = @(
        "AIza[0-9A-Za-z_-]{20,}",
        "sk-[A-Za-z0-9_-]{20,}",
        "Authorization:\s*Bearer\s+[A-Za-z0-9._~+\/-]{16,}",
        "GEMINI_API_KEY\s*=\s*(?!your-|example|$).+",
        "BETA_ACCESS_TOKEN\s*=\s*(?!your-|example|$).+"
    )

    $files = Get-ChildItem -LiteralPath $RootPath -Recurse -File -Force
    $riskFiles = @()
    foreach ($file in $files) {
        foreach ($pattern in $patterns) {
            if (Select-String -LiteralPath $file.FullName -Pattern $pattern -Quiet -ErrorAction SilentlyContinue) {
                $riskFiles += $file.FullName
                break
            }
        }
    }

    if ($riskFiles.Count -gt 0) {
        $relative = $riskFiles | ForEach-Object { Resolve-Path -Relative -LiteralPath $_ }
        Stop-WithError "测试包发现疑似凭据风险文件：$($relative -join ', ')"
    }
}

function Assert-NoCredentialRiskForFiles {
    param([string[]]$RelativePaths)

    $patterns = @(
        "AIza[0-9A-Za-z_-]{20,}",
        "sk-[A-Za-z0-9_-]{20,}",
        "Authorization:\s*Bearer\s+[A-Za-z0-9._~+\/-]{16,}",
        "GEMINI_API_KEY\s*=\s*(?!your-|example|$).+",
        "BETA_ACCESS_TOKEN\s*=\s*(?!your-|example|$).+"
    )

    $riskFiles = @()
    foreach ($relativePath in $RelativePaths) {
        $path = Join-ProjectPath $relativePath
        foreach ($pattern in $patterns) {
            if (Select-String -LiteralPath $path -Pattern $pattern -Quiet -ErrorAction SilentlyContinue) {
                $riskFiles += $relativePath
                break
            }
        }
    }

    if ($riskFiles.Count -gt 0) {
        Stop-WithError "扩展运行文件发现疑似凭据风险：$($riskFiles -join ', ')"
    }
}

function Get-HtmlAssetReferences {
    param([string]$HtmlPath)

    $content = Get-Content -Raw -Encoding UTF8 -LiteralPath $HtmlPath
    $references = @()
    foreach ($match in [regex]::Matches($content, '(?i)<script[^>]+src="([^"]+)"|<link[^>]+href="([^"]+)"')) {
        $value = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
        if ($value -and $value -notmatch '^(https?:)?//' -and $value -notmatch '^#') {
            $references += $value
        }
    }
    return $references
}

function Assert-PackageIntegrity {
    param(
        [string]$PackageRoot,
        [string[]]$Allowlist
    )

    $manifestPath = Join-Path $PackageRoot "manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        Stop-WithError "测试包根目录缺少 manifest.json"
    }

    $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
    if ($manifest.version -ne "1.0.1") {
        Stop-WithError "manifest 版本不是 1.0.1"
    }
    if ($manifest.host_permissions -notcontains "$CloudRunGatewayUrl/*") {
        Stop-WithError "manifest 缺少精确 Cloud Run host permission"
    }
    if ($manifest.host_permissions -contains "http://127.0.0.1:8000/*" -or $manifest.host_permissions -contains "http://localhost:8000/*") {
        Stop-WithError "manifest 仍包含本地 Gateway host permission"
    }
    if ($manifest.host_permissions -contains "https://*.run.app/*") {
        Stop-WithError "manifest 包含过宽 run.app 权限"
    }

    if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot $manifest.background.service_worker) -PathType Leaf)) {
        Stop-WithError "manifest service_worker 引用缺失"
    }

    foreach ($contentScript in $manifest.content_scripts) {
        foreach ($script in $contentScript.js) {
            if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot $script) -PathType Leaf)) {
                Stop-WithError "content script 引用缺失：$script"
            }
        }
    }

    if ($manifest.options_ui.page -and -not (Test-Path -LiteralPath (Join-Path $PackageRoot $manifest.options_ui.page) -PathType Leaf)) {
        Stop-WithError "options 页面引用缺失"
    }
    if ($manifest.action.default_popup -and -not (Test-Path -LiteralPath (Join-Path $PackageRoot $manifest.action.default_popup) -PathType Leaf)) {
        Stop-WithError "popup 页面引用缺失"
    }

    $background = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PackageRoot "background.js")
    foreach ($match in [regex]::Matches($background, '"([^"]+\.js)"')) {
        $script = $match.Groups[1].Value
        if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot $script) -PathType Leaf)) {
            Stop-WithError "background importScripts 引用缺失：$script"
        }
    }

    $htmlFiles = Get-ChildItem -LiteralPath $PackageRoot -Filter "*.html" -File
    foreach ($html in $htmlFiles) {
        foreach ($reference in Get-HtmlAssetReferences -HtmlPath $html.FullName) {
            if ($reference -match '^使用说明_') {
                continue
            }
            if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot $reference) -PathType Leaf)) {
                Stop-WithError "$($html.Name) 引用缺失：$reference"
            }
        }
    }

    $forbidden = @(
        "gateway",
        "tests",
        "report_log",
        ".git",
        ".github",
        "private",
        ".venv",
        "__pycache__",
        ".pytest_cache"
    )
    $entries = Get-ChildItem -LiteralPath $PackageRoot -Recurse -Force
    foreach ($entry in $entries) {
        $relative = $entry.FullName.Substring($PackageRoot.Length).TrimStart("\", "/")
        foreach ($name in $forbidden) {
            if ($relative -eq $name -or $relative.StartsWith("$name\") -or $relative.StartsWith("$name/")) {
                Stop-WithError "测试包包含禁止项：$relative"
            }
        }
        if ($entry.Name -match '\.env|\.pyc|\.pyo|Dockerfile|\.dockerignore|\.ps1|\.cmd|\.zip$') {
            Stop-WithError "测试包包含禁止文件：$relative"
        }
    }

    $provider = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PackageRoot "gateway-language-provider.js")
    if ($provider -notmatch [regex]::Escape($CloudRunGatewayUrl)) {
        Stop-WithError "测试包 GatewayProvider 未使用 Cloud Run URL"
    }

    $runtimeFiles = Get-ChildItem -LiteralPath $PackageRoot -Recurse -File -Force |
        Where-Object { $_.Name -ne "使用说明_Chrome与Edge.html" }
    foreach ($file in $runtimeFiles) {
        if (Select-String -LiteralPath $file.FullName -Pattern $LocalGatewayPattern -Quiet -ErrorAction SilentlyContinue) {
            Stop-WithError "测试包运行文件仍包含本地 Gateway 地址：$($file.Name)"
        }
    }

    Assert-NoCredentialRisk -RootPath $PackageRoot

    $actualFiles = Get-ChildItem -LiteralPath $PackageRoot -Recurse -File -Force |
        ForEach-Object { $_.FullName.Substring($PackageRoot.Length).TrimStart("\", "/") -replace "\\", "/" } |
        Sort-Object
    $expectedFiles = @($Allowlist + "使用说明_Chrome与Edge.html") | Sort-Object

    $unexpected = Compare-Object -ReferenceObject $expectedFiles -DifferenceObject $actualFiles |
        Where-Object { $_.SideIndicator -eq "=>" } |
        ForEach-Object { $_.InputObject }
    if ($unexpected.Count -gt 0) {
        Stop-WithError "测试包包含未在 allowlist 中的文件：$($unexpected -join ', ')"
    }
}

function New-UsageHtml {
    param(
        [string]$DestinationPath,
        [string]$Version,
        [string]$PackageDate
    )

    $html = @"
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Orange翻译 Cloud Run Beta 使用说明</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #17202a;
      --muted: #5d6775;
      --line: #d8dee8;
      --panel: #ffffff;
      --soft: #f4f7fb;
      --accent: #1769aa;
      --ok: #146c43;
      --warn: #8a5a00;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif;
      line-height: 1.65;
      color: var(--ink);
      background: var(--soft);
    }
    main {
      max-width: 980px;
      margin: 0 auto;
      padding: 32px 18px 48px;
    }
    header {
      padding: 24px 0 18px;
      border-bottom: 2px solid var(--line);
      margin-bottom: 20px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 30px;
      line-height: 1.25;
    }
    h2 {
      margin: 28px 0 12px;
      font-size: 21px;
      border-left: 4px solid var(--accent);
      padding-left: 10px;
    }
    h3 {
      margin: 16px 0 8px;
      font-size: 17px;
    }
    p { margin: 8px 0; }
    ol, ul { padding-left: 24px; }
    li { margin: 5px 0; }
    code {
      font-family: Consolas, "Courier New", monospace;
      background: #eef2f7;
      border: 1px solid var(--line);
      padding: 1px 5px;
      border-radius: 4px;
      word-break: break-all;
    }
    .note, .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px 16px;
      margin: 12px 0;
    }
    .note {
      border-left: 4px solid var(--accent);
    }
    .warning {
      border-left-color: var(--warn);
    }
    .success {
      border-left-color: var(--ok);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .muted { color: var(--muted); }
    .checklist li { margin-bottom: 7px; }
    @media (max-width: 720px) {
      main { padding: 22px 14px 36px; }
      h1 { font-size: 24px; }
      .grid { grid-template-columns: 1fr; }
    }
    @media print {
      body { background: #fff; }
      main { max-width: none; padding: 0; }
      .card, .note { break-inside: avoid; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <h1>Orange翻译 Cloud Run Beta 使用说明</h1>
    <p class="muted">当前是小范围 Beta 测试版。插件版本：$Version。测试包日期：$PackageDate。</p>
    <p>支持桌面版 Google Chrome 与 Microsoft Edge。不支持手机浏览器；不承诺 Firefox 或 Safari 兼容。</p>
  </header>

  <section class="note warning">
    <h2>安装前准备</h2>
    <ul class="checklist">
      <li>请先完整解压 ZIP，不能直接从压缩包里加载扩展。</li>
      <li>测试访问码由开发者单独发送，请不要公开或转发。</li>
      <li>不需要安装 Python，不需要启动本地 Gateway，也不需要准备 Gemini API Key。</li>
      <li>如果电脑里已有旧测试版，建议先禁用或移除，避免两个版本混淆。</li>
    </ul>
  </section>

  <section class="grid">
    <div class="card">
      <h2>Google Chrome 安装步骤</h2>
      <ol>
        <li>解压 ZIP。</li>
        <li>在地址栏输入 <code>chrome://extensions</code>。</li>
        <li>打开右上角“开发者模式”。</li>
        <li>点击“加载已解压的扩展程序”。</li>
        <li>选择解压后、根目录直接包含 <code>manifest.json</code> 的文件夹。</li>
        <li>打开插件设置页。</li>
        <li>输入单独收到的测试访问码。</li>
        <li>点击“验证并开始使用”。</li>
        <li>在普通英文网页中划选单词或句子测试。</li>
      </ol>
      <p class="muted">Chrome 可能显示开发者模式扩展提醒，这是测试版的正常现象。不要选择 ZIP 文件本身，也不要只选择外层错误目录。</p>
    </div>

    <div class="card">
      <h2>Microsoft Edge 安装步骤</h2>
      <ol>
        <li>解压 ZIP。</li>
        <li>在地址栏输入 <code>edge://extensions</code>。</li>
        <li>打开“开发人员模式”。</li>
        <li>点击“加载解压缩的扩展”。</li>
        <li>选择直接包含 <code>manifest.json</code> 的文件夹。</li>
        <li>打开设置页。</li>
        <li>输入测试访问码并验证。</li>
        <li>在普通英文网页中划词测试。</li>
      </ol>
      <p class="muted">Edge 的按钮文案可能因版本略有差异，含义通常是“加载解压缩的扩展”。</p>
    </div>
  </section>

  <section>
    <h2>基本使用</h2>
    <ul>
      <li>选中单词：显示词形、音标、词性、语境含义。</li>
      <li>可查看详细解释或近义词区别。</li>
      <li>选中句子：显示整句翻译。</li>
      <li>点击“加入生词本”保存。</li>
      <li>生词的语境译文可能稍后异步补写。</li>
      <li>设置页中普通测试用户应保持 <strong>Gateway Beta</strong>。</li>
      <li>“Gemini AI 语境解析”等高级 Provider 属于自带 API Key 模式，朋友测试时不要切换。</li>
    </ul>
  </section>

  <section class="note success">
    <h2>如何确认连接成功</h2>
    <ul>
      <li>设置页显示“已连接，可以开始使用”。</li>
      <li>当前启用显示 <strong>Gateway Beta</strong>。</li>
      <li>普通英文网页划词后能返回结果。</li>
      <li>首次请求可能因 Cloud Run 冷启动略慢。</li>
      <li>用户无需保持开发者电脑开机。</li>
    </ul>
  </section>

  <section>
    <h2>常见问题</h2>
    <h3>找不到“加载已解压”按钮</h3>
    <p>请确认已经打开 Chrome 的“开发者模式”或 Edge 的“开发人员模式”。</p>
    <h3>选择文件夹后提示 manifest 缺失</h3>
    <p>请选择根目录直接包含 <code>manifest.json</code> 的文件夹，不要选择 ZIP，也不要选择多套一层的外层目录。</p>
    <h3>输入测试访问码后提示无效</h3>
    <p>请确认访问码完整复制，没有多余空格。访问码无效或过期时需要联系开发者重新确认。</p>
    <h3>一直显示正在处理</h3>
    <p>首次请求可能稍慢。若持续失败，请记录时间、浏览器、操作步骤和截图后反馈。</p>
    <h3>Chrome/Edge 重启后插件不见了</h3>
    <p>开发者模式加载的扩展依赖原解压目录。请不要删除或移动该目录；如已移动，请重新加载已解压扩展。</p>
    <h3>页面划词没有反应</h3>
    <p>请先在普通英文网页测试。<code>chrome://</code>、<code>edge://</code>、扩展商店等浏览器内部页面无法运行内容脚本。</p>
    <h3>同时安装旧版和新版导致混淆</h3>
    <p>建议只保留一个 Orange翻译 测试版。先禁用或移除旧测试版，再加载新的解压目录。</p>
    <h3>如何更新到新的测试包</h3>
    <p>先禁用或移除旧测试版，解压新的 ZIP 到新目录，再重新“加载已解压”。不要覆盖旧目录后继续引用已删除的路径。</p>
    <h3>如何卸载</h3>
    <p>Chrome 打开 <code>chrome://extensions</code>，Edge 打开 <code>edge://extensions</code>，找到 Orange翻译 后点击移除。</p>
  </section>

  <section>
    <h2>隐私与安全说明</h2>
    <ul>
      <li>划选的单词或句子和必要上下文会发送到远程 Gateway，再由 Gateway 调用 Gemini。</li>
      <li>可选页面标题可能随请求发送。</li>
      <li>不发送 Cookie、浏览历史、完整网页、pageUrl、全量生词本或本地 API Key。</li>
      <li>共享测试访问码保存在浏览器扩展本地存储中，并通过 Authorization Header 发送。</li>
      <li>Gemini API Key 不在插件包中，而保存在服务端。</li>
      <li>不要把测试访问码转发给无关人员。</li>
      <li>当前是 Beta，遇到敏感网页时不要划选不希望发送的私人内容。</li>
    </ul>
  </section>

  <section>
    <h2>反馈问题时请提供</h2>
    <ul>
      <li>浏览器名称与版本。</li>
      <li>操作步骤。</li>
      <li>问题发生的大概时间。</li>
      <li>问题属于 Token 验证、单词解析、详细解释、整句翻译还是生词保存。</li>
      <li>错误截图。截图中请不要暴露测试访问码或私人网页内容。</li>
    </ul>
  </section>
</main>
</body>
</html>
"@

    Set-Content -LiteralPath $DestinationPath -Encoding UTF8 -Value $html
}

$ScriptDirectory = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $ScriptDirectory
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "manifest.json") -PathType Leaf)) {
    Stop-WithError "无法定位项目根目录。"
}

$manifestPath = Join-ProjectPath "manifest.json"
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
$version = $manifest.version
if ($version -ne "1.0.1") {
    Stop-WithError "manifest 版本必须保持 1.0.1，当前为 $version"
}
if ($manifest.host_permissions -notcontains "$CloudRunGatewayUrl/*") {
    Stop-WithError "manifest 未使用精确 Cloud Run host permission。"
}
if ($manifest.host_permissions -contains "http://127.0.0.1:8000/*" -or $manifest.host_permissions -contains "http://localhost:8000/*") {
    Stop-WithError "manifest 仍包含本地 Gateway host permission。"
}

$providerPath = Join-ProjectPath "gateway-language-provider.js"
$providerContent = Get-Content -Raw -Encoding UTF8 -LiteralPath $providerPath
if ($providerContent -notmatch [regex]::Escape($CloudRunGatewayUrl)) {
    Stop-WithError "gateway-language-provider.js 未使用正式 Cloud Run URL。"
}
if ($providerContent -match $LocalGatewayPattern) {
    Stop-WithError "gateway-language-provider.js 仍包含本地 Gateway 地址。"
}

if ([string]::IsNullOrWhiteSpace($PackageName)) {
    $PackageName = "Orange翻译_CloudRun-Beta_$(Get-Date -Format 'yyyyMMdd')"
}
if ($PackageName -match '[\\/:*?"<>|]') {
    Stop-WithError "PackageName 包含非法路径字符。"
}

$allowlist = @(
    "manifest.json",
    "background.js",
    "content.js",
    "md5.js",
    "ai-context-skill.js",
    "sentence-translation-skill.js",
    "baidu-translation-provider.js",
    "deepseek-context-provider.js",
    "gemini-context-provider.js",
    "gateway-language-provider.js",
    "translation-provider.js",
    "popup.html",
    "popup.css",
    "popup.js",
    "options.html",
    "options.css",
    "options.js",
    "vocabulary.html",
    "vocabulary.css",
    "vocabulary.js",
    "icons/16_16.png",
    "icons/32_32.png",
    "icons/128_128.png"
)

foreach ($relativePath in $allowlist) {
    if (-not (Test-Path -LiteralPath (Join-ProjectPath $relativePath) -PathType Leaf)) {
        Stop-WithError "allowlist 文件不存在：$relativePath"
    }
}

$runtimeScanFiles = $allowlist | Where-Object { $_ -ne "gateway/README.txt" }
foreach ($relativePath in $runtimeScanFiles) {
    $path = Join-ProjectPath $relativePath
    if (Select-String -LiteralPath $path -Pattern $LocalGatewayPattern -Quiet -ErrorAction SilentlyContinue) {
        Stop-WithError "运行文件仍包含本地 Gateway 地址：$relativePath"
    }
}

Assert-NoCredentialRiskForFiles -RelativePaths $allowlist

$resolvedOutputRoot = if ([System.IO.Path]::IsPathRooted($OutputRoot)) {
    $OutputRoot
} else {
    Join-Path $ProjectRoot $OutputRoot
}

New-Item -ItemType Directory -Force -Path $resolvedOutputRoot | Out-Null

$packageRoot = Join-Path $resolvedOutputRoot $PackageName
$zipPath = Join-Path $resolvedOutputRoot "$PackageName.zip"
$verifyRoot = Join-Path $resolvedOutputRoot "$PackageName.verify"

if (Test-Path -LiteralPath $packageRoot) {
    Remove-Item -LiteralPath $packageRoot -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
if (Test-Path -LiteralPath $verifyRoot) {
    Remove-Item -LiteralPath $verifyRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null

foreach ($relativePath in $allowlist) {
    Copy-AllowlistFile -RelativePath $relativePath -DestinationRoot $packageRoot
}

New-UsageHtml -DestinationPath (Join-Path $packageRoot "使用说明_Chrome与Edge.html") -Version $version -PackageDate (Get-Date -Format "yyyy-MM-dd")

Assert-PackageIntegrity -PackageRoot $packageRoot -Allowlist $allowlist

Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal

New-Item -ItemType Directory -Force -Path $verifyRoot | Out-Null
Expand-Archive -LiteralPath $zipPath -DestinationPath $verifyRoot -Force
$verifiedPackageRoot = Join-Path $verifyRoot $PackageName
Assert-PackageIntegrity -PackageRoot $verifiedPackageRoot -Allowlist $allowlist

$stagingFiles = Get-ChildItem -LiteralPath $packageRoot -Recurse -File -Force |
    ForEach-Object { $_.FullName.Substring($packageRoot.Length).TrimStart("\", "/") -replace "\\", "/" } |
    Sort-Object
$verifiedFiles = Get-ChildItem -LiteralPath $verifiedPackageRoot -Recurse -File -Force |
    ForEach-Object { $_.FullName.Substring($verifiedPackageRoot.Length).TrimStart("\", "/") -replace "\\", "/" } |
    Sort-Object
$fileDiff = Compare-Object -ReferenceObject $stagingFiles -DifferenceObject $verifiedFiles
if ($fileDiff) {
    Stop-WithError "ZIP 解压文件清单与 staging 不一致。"
}

$manifestHash = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $packageRoot "manifest.json")
$verifiedManifestHash = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $verifiedPackageRoot "manifest.json")
if ($manifestHash.Hash -ne $verifiedManifestHash.Hash) {
    Stop-WithError "ZIP 解压后的 manifest.json 与 staging 不一致。"
}

Remove-Item -LiteralPath $verifyRoot -Recurse -Force

$zipItem = Get-Item -LiteralPath $zipPath
$zipHash = Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath

[pscustomobject]@{
    PackageDirectory = $packageRoot
    ZipPath = $zipPath
    Version = $version
    FileCount = $stagingFiles.Count
    ZipBytes = $zipItem.Length
    Sha256 = $zipHash.Hash
}
