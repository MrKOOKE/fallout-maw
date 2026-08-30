[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$launcherRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$systemRoot = Split-Path -Parent $launcherRoot
$dataRoot = [System.IO.Path]::GetFullPath((Join-Path $systemRoot "..\.."))
$appProject = Join-Path $launcherRoot "FalloutMaW.Launcher\FalloutMaW.Launcher.csproj"
$testsProject = Join-Path $launcherRoot "FalloutMaW.Launcher.SmokeTests\FalloutMaW.Launcher.SmokeTests.csproj"

$candidates = [System.Collections.Generic.List[string]]::new()
$command = Get-Command dotnet -ErrorAction SilentlyContinue
if ($null -ne $command) { $candidates.Add($command.Source) }
$localSdk = Join-Path $dataRoot "_codex\dotnet-sdk\dotnet.exe"
if (Test-Path -LiteralPath $localSdk -PathType Leaf) { $candidates.Add($localSdk) }

$dotnet = $null
foreach ($candidate in $candidates | Select-Object -Unique) {
    $sdks = & $candidate --list-sdks 2>$null
    if ($LASTEXITCODE -eq 0 -and $sdks) {
        $dotnet = $candidate
        break
    }
}
if ($null -eq $dotnet) { throw ".NET 8 SDK is required to test the launcher." }

$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"
& $dotnet build $appProject -c Release
if ($LASTEXITCODE -ne 0) { throw "Launcher build failed." }
& $dotnet run --project $testsProject -c Release
if ($LASTEXITCODE -ne 0) { throw "Launcher smoke tests failed." }

$compatibilityDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("fallout-maw-signature-" + [Guid]::NewGuid().ToString("N"))
try {
    & node (Join-Path $launcherRoot "create-signature-fixture.mjs") $compatibilityDirectory
    if ($LASTEXITCODE -ne 0) { throw "Could not create Node signature fixture." }
    & $dotnet run --project $testsProject -c Release -- `
        --verify-channel `
        (Join-Path $compatibilityDirectory "stable.json") `
        (Join-Path $compatibilityDirectory "public-key.pem")
    if ($LASTEXITCODE -ne 0) { throw "Node/.NET signature compatibility test failed." }
}
finally {
    if (Test-Path -LiteralPath $compatibilityDirectory) {
        Remove-Item -LiteralPath $compatibilityDirectory -Recurse -Force
    }
}
