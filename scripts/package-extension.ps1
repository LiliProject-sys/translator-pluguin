param(
  [string]$OutputDirectory = "release"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $projectRoot "manifest.json"
$manifest = Get-Content -Raw -Encoding UTF8 -Path $manifestPath | ConvertFrom-Json
$version = $manifest.version

if (-not $version) {
  throw "manifest.json does not contain a version."
}

$packageFiles = @(
  "manifest.json",
  "background.js",
  "content.js",
  "translation-provider.js",
  "baidu-translation-provider.js",
  "gemini-context-provider.js",
  "deepseek-context-provider.js",
  "ai-context-skill.js",
  "sentence-translation-skill.js",
  "md5.js",
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
  "icons/128_128.png",
  "README.md",
  "PRIVACY.md",
  "SECURITY.md"
)

$missingFiles = @()
foreach ($relativePath in $packageFiles) {
  $absolutePath = Join-Path $projectRoot $relativePath
  if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
    $missingFiles += $relativePath
  }
}

if ($missingFiles.Count -gt 0) {
  throw "Missing package files: $($missingFiles -join ', ')"
}

$outputRoot = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
  $OutputDirectory
} else {
  Join-Path $projectRoot $OutputDirectory
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

$zipPath = Join-Path $outputRoot "Orange翻译-v$version-chromium.zip"
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

$stagingRoot = Join-Path $outputRoot "package-staging"
if (Test-Path -LiteralPath $stagingRoot) {
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null

foreach ($relativePath in $packageFiles) {
  $sourcePath = Join-Path $projectRoot $relativePath
  $destinationPath = Join-Path $stagingRoot $relativePath
  $destinationDirectory = Split-Path -Parent $destinationPath
  if (-not (Test-Path -LiteralPath $destinationDirectory)) {
    New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
  }
  Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
}

Compress-Archive -Path (Join-Path $stagingRoot "*") -DestinationPath $zipPath -CompressionLevel Optimal
Remove-Item -LiteralPath $stagingRoot -Recurse -Force

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $entries = $archive.Entries | ForEach-Object { $_.FullName }
  if ($entries -notcontains "manifest.json") {
    throw "Package does not contain root manifest.json."
  }

  $forbiddenPattern = '(^|/)(\.git|\.agents|\.codex|tests|report_log|重要记录|release|node_modules|dist|build)(/|$)|\.(zip|docx|pdf|crx|xpi)$|(^|/)(?!icons/(16_16|32_32|128_128)\.png$).+\.png$'
  $forbiddenEntries = $entries | Where-Object { $_ -match $forbiddenPattern }
  if ($forbiddenEntries.Count -gt 0) {
    throw "Package contains forbidden entries: $($forbiddenEntries -join ', ')"
  }
} finally {
  $archive.Dispose()
}

$hash = Get-FileHash -Algorithm SHA256 -Path $zipPath
[PSCustomObject]@{
  ZipPath = $zipPath
  Version = $version
  EntryCount = $entries.Count
  Sha256 = $hash.Hash
}
