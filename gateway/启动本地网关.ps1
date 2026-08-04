param(
    [string]$ProjectRoot = ""
)

$ErrorActionPreference = "Stop"

function Write-Info {
    param([string]$Message)
    Write-Host $Message
}

function Stop-WithError {
    param([string]$Message)
    Write-Error $Message
    exit 1
}

function Get-EnvValues {
    param([string]$EnvPath)

    $values = @{}
    $lines = Get-Content -Encoding UTF8 -LiteralPath $EnvPath

    foreach ($line in $lines) {
        $trimmed = $line.Trim()

        if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#")) {
            continue
        }

        $separatorIndex = $trimmed.IndexOf("=")
        if ($separatorIndex -le 0) {
            continue
        }

        $key = $trimmed.Substring(0, $separatorIndex).Trim()
        $value = $trimmed.Substring($separatorIndex + 1).Trim()

        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        $values[$key] = $value
    }

    return $values
}

function Test-GatewayHealth {
    param([string]$HealthUrl)

    try {
        $response = Invoke-RestMethod -Uri $HealthUrl -Method Get -TimeoutSec 2

        if ($response.status -eq "ok" -and $response.service -eq "translator-gateway") {
            return "gateway"
        }

        return "other"
    }
    catch {
        return "none"
    }
}

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $gatewayDirectory = $PSScriptRoot
    $ProjectRoot = Split-Path -Parent $gatewayDirectory
}
else {
    $ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
    $gatewayDirectory = Join-Path $ProjectRoot "gateway"
}

$pythonExecutable = Join-Path $gatewayDirectory ".venv\Scripts\python.exe"
$environmentFile = Join-Path $gatewayDirectory ".env"
$localUrl = "http://127.0.0.1:8000"
$healthUrl = "$localUrl/health"
$docsUrl = "$localUrl/docs"

if (-not (Test-Path -LiteralPath $pythonExecutable)) {
    Stop-WithError "未找到 gateway/.venv，请先创建虚拟环境并安装 requirements.txt。"
}

if (-not (Test-Path -LiteralPath $environmentFile)) {
    Stop-WithError "未找到 gateway/.env，请先创建本地环境变量文件。"
}

$envValues = Get-EnvValues -EnvPath $environmentFile
$requiredVariables = @("BETA_ACCESS_TOKEN")

foreach ($name in $requiredVariables) {
    if (-not $envValues.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($envValues[$name])) {
        Stop-WithError "gateway/.env 缺少必需环境变量：$name"
    }
}

$upstreamProvider = if ($envValues.ContainsKey("GATEWAY_UPSTREAM_PROVIDER")) {
    $envValues["GATEWAY_UPSTREAM_PROVIDER"].Trim().ToLowerInvariant()
}
else {
    "gemini"
}

if ($upstreamProvider -notin @("gemini", "deepseek")) {
    Stop-WithError "GATEWAY_UPSTREAM_PROVIDER 只允许 gemini 或 deepseek。"
}

$providerKeyName = if ($upstreamProvider -eq "deepseek") { "DEEPSEEK_API_KEY" } else { "GEMINI_API_KEY" }
if (-not $envValues.ContainsKey($providerKeyName) -or [string]::IsNullOrWhiteSpace($envValues[$providerKeyName])) {
    Stop-WithError "当前上游为 $upstreamProvider，gateway/.env 缺少必需环境变量：$providerKeyName"
}

$healthState = Test-GatewayHealth -HealthUrl $healthUrl

if ($healthState -eq "gateway") {
    Write-Info "本地 Gateway 已经在运行：$localUrl"
    Write-Info "Health：$healthUrl"
    Write-Info "Docs：$docsUrl"
    exit 0
}

if ($healthState -eq "other") {
    Stop-WithError "127.0.0.1:8000 已被其他服务占用，请先手动确认该进程后再启动 Gateway。"
}

Write-Info "正在启动 Translator-plugin 本地 Gateway..."
Write-Info "当前上游：$upstreamProvider"
Write-Info "本地地址：$localUrl"
Write-Info "Health：$healthUrl"
Write-Info "Docs：$docsUrl"
Write-Info "按 Ctrl+C 停止服务。"

Push-Location $ProjectRoot

try {
    & $pythonExecutable `
        -m uvicorn gateway.app.main:app `
        --app-dir $ProjectRoot `
        --host 127.0.0.1 `
        --port 8000 `
        --env-file $environmentFile

    $processExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

if ($null -ne $processExitCode) {
    exit $processExitCode
}
