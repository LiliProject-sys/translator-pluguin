# SPDX-License-Identifier: AGPL-3.0-only
param(
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [Parameter(Mandatory=$true)][string]$DownloadDirectory,
    [string]$DotnetDirectory = 'C:/Program Files/dotnet'
)
$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path $PSScriptRoot -Parent
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $outputRoot) { throw 'Output must be a new directory; existing files are never overwritten.' }
$downloadRoot = (Resolve-Path -LiteralPath $DownloadDirectory).Path
$wheel = Join-Path $downloadRoot 'pymupdf-1.28.2-cp310-abi3-win_amd64.whl'
$pythonArchive = Join-Path $downloadRoot 'python-3.10.11-embed-amd64.zip'
if ((Get-FileHash -LiteralPath $wheel -Algorithm SHA256).Hash -ne 'ebd244918798502d7b4504c90410d1711a4d7675a32584ca30f1bab419ecbffe') { throw 'PyMuPDF wheel checksum mismatch' }
# Published by python.org for this exact Windows x64 embed distribution.
if ((Get-FileHash -LiteralPath $pythonArchive -Algorithm MD5).Hash -ne 'f1c0538b060e03cbb697ab3581cb73bc' -or
    (Get-FileHash -LiteralPath $pythonArchive -Algorithm SHA256).Hash -ne '608619f8619075629c9c69f361352a0da6ed7e62f83a0e19c63e0ea32eb7629d') { throw 'Python archive checksum mismatch' }
$runtimeRoot = Join-Path $outputRoot 'runtime'
$pythonRoot = Join-Path $runtimeRoot 'python'
$dotnetRoot = Join-Path $runtimeRoot 'dotnet'
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
Expand-Archive -LiteralPath $pythonArchive -DestinationPath $pythonRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'python310._pth') -Destination $pythonRoot
$site = Join-Path $pythonRoot 'Lib/site-packages'
New-Item -ItemType Directory -Path $site -Force | Out-Null
[IO.Compression.ZipFile]::ExtractToDirectory($wheel, $site)
# No SDK, ASP.NET, WindowsDesktop, global tools or developer Python environment.
foreach ($path in @('dotnet.exe','LICENSE.txt','ThirdPartyNotices.txt','host/fxr/8.0.7','shared/Microsoft.NETCore.App/8.0.7')) {
    $source = Join-Path $DotnetDirectory $path
    if (!(Test-Path -LiteralPath $source)) { throw "Required .NET runtime component absent: $path" }
    $target = Join-Path $dotnetRoot $path
    New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Recurse
}
$workerRoot = Join-Path $outputRoot 'python'
New-Item -ItemType Directory -Path $workerRoot | Out-Null
foreach ($name in @('worker.py','resolver.py','candidate_v2.py')) {
    Copy-Item -LiteralPath (Join-Path $desktopRoot "helpers/wps-pdf/python/$name") -Destination $workerRoot
}
Copy-Item -LiteralPath (Join-Path $desktopRoot 'LICENSE.txt') -Destination (Join-Path $outputRoot 'AGPL-3.0.txt')
& dotnet build (Join-Path $desktopRoot 'helpers/wps-pdf/WpsPdfHelper.csproj') -c Release --no-restore -o $outputRoot
if ($LASTEXITCODE -ne 0) { throw 'Helper build failed' }
& (Join-Path $dotnetRoot 'dotnet.exe') (Join-Path $outputRoot 'WpsPdfHelper.dll') --self-test
if ($LASTEXITCODE -ne 0) { throw 'Helper self-test failed' }
& (Join-Path $pythonRoot 'python.exe') -E -s -c 'import pymupdf,sys; assert pymupdf.VersionBind == "1.28.2"; assert sys.flags.isolated; print("Isolated bundled Python/PyMuPDF import OK")'
if ($LASTEXITCODE -ne 0) { throw 'Bundled Python smoke failed' }
Write-Output 'WPS runtime prepared; distribution/source and final relocation audits are still required.'
