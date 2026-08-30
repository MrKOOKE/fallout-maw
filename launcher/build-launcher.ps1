[CmdletBinding()]
param(
    [string]$ManifestUrl = "",
    [string]$PublicKeyPath = "",
    [string]$OutputDirectory = "",
    [ValidateSet("win-x64")]
    [string]$Runtime = "win-x64",
    [string]$SigningCertificateThumbprint = "",
    [string]$TimestampServer = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$launcherRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$systemRoot = Split-Path -Parent $launcherRoot
$dataRoot = [System.IO.Path]::GetFullPath((Join-Path $systemRoot "..\.."))
$projectPath = Join-Path $launcherRoot "FalloutMaW.Launcher\FalloutMaW.Launcher.csproj"
$defaultKeyPath = Join-Path $dataRoot "release-keys\fallout-maw\public-key.pem"
$publisherLocalPath = Join-Path $systemRoot "release\publisher.local.json"

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $dataRoot "outputs\fallout-ttg-launcher"
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)

if ([string]::IsNullOrWhiteSpace($PublicKeyPath)) {
    $PublicKeyPath = $defaultKeyPath
}
$PublicKeyPath = [System.IO.Path]::GetFullPath($PublicKeyPath)
if (-not (Test-Path -LiteralPath $PublicKeyPath -PathType Leaf)) {
    throw "Public release key is missing: $PublicKeyPath`nRun: npm run release:keygen"
}

if ([string]::IsNullOrWhiteSpace($ManifestUrl) -and (Test-Path -LiteralPath $publisherLocalPath -PathType Leaf)) {
    $publisher = Get-Content -LiteralPath $publisherLocalPath -Raw | ConvertFrom-Json
    if ($publisher.PSObject.Properties.Name -contains "manifestUrl" -and -not [string]::IsNullOrWhiteSpace([string]$publisher.manifestUrl)) {
        $ManifestUrl = [string]$publisher.manifestUrl
    }
    elseif ($publisher.PSObject.Properties.Name -contains "publicBaseUrl" -and -not [string]::IsNullOrWhiteSpace([string]$publisher.publicBaseUrl)) {
        $ManifestUrl = ([string]$publisher.publicBaseUrl).TrimEnd('/') + "/channels/stable.json"
    }
}
if (-not [string]::IsNullOrWhiteSpace($ManifestUrl)) {
    $uri = $null
    if (-not [System.Uri]::TryCreate($ManifestUrl, [System.UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @("http", "https")) {
        throw "ManifestUrl must be an absolute HTTP(S) URL."
    }
}

function Find-DotNetSdk {
    $candidates = [System.Collections.Generic.List[string]]::new()
    $command = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($null -ne $command) { $candidates.Add($command.Source) }
    $localSdk = Join-Path $dataRoot "_codex\dotnet-sdk\dotnet.exe"
    if (Test-Path -LiteralPath $localSdk -PathType Leaf) { $candidates.Add($localSdk) }

    foreach ($candidate in $candidates | Select-Object -Unique) {
        $sdks = & $candidate --list-sdks 2>$null
        if ($LASTEXITCODE -eq 0 -and $sdks) { return $candidate }
    }
    throw ".NET 8 SDK is required. Install it or place a local SDK in Data\_codex\dotnet-sdk."
}

$dotnet = Find-DotNetSdk
$manifestBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ManifestUrl))
$publicKeyPem = Get-Content -LiteralPath $PublicKeyPath -Raw
$publicKeyBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($publicKeyPem))

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$publishDirectory = Join-Path $OutputDirectory ".publish-$Runtime"
if (Test-Path -LiteralPath $publishDirectory) {
    $resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\') + '\'
    $resolvedPublish = [System.IO.Path]::GetFullPath($publishDirectory)
    if (-not $resolvedPublish.StartsWith($resolvedOutput, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a publish path outside the output directory."
    }
    Remove-Item -LiteralPath $publishDirectory -Recurse -Force
}

$publishArguments = @(
    "publish", $projectPath,
    "-c", "Release",
    "-r", $Runtime,
    "--self-contained", "true",
    "-o", $publishDirectory,
    "-p:PublishSingleFile=true",
    "-p:IncludeNativeLibrariesForSelfExtract=true",
    "-p:PublisherManifestUrlBase64=$manifestBase64",
    "-p:PublisherPublicKeyBase64=$publicKeyBase64"
)
& $dotnet @publishArguments
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }

$publishedExecutable = Join-Path $publishDirectory "Fallout-TTG-Launcher.exe"
if (-not (Test-Path -LiteralPath $publishedExecutable -PathType Leaf)) {
    throw "Published executable was not found: $publishedExecutable"
}
$finalExecutable = Join-Path $OutputDirectory "Fallout-TTG-Launcher.exe"
Copy-Item -LiteralPath $publishedExecutable -Destination $finalExecutable -Force

if (-not [string]::IsNullOrWhiteSpace($SigningCertificateThumbprint)) {
    $certificatePath = "Cert:\CurrentUser\My\$SigningCertificateThumbprint"
    $certificate = Get-Item -LiteralPath $certificatePath -ErrorAction Stop
    $signature = Set-AuthenticodeSignature -LiteralPath $finalExecutable -Certificate $certificate -TimestampServer $TimestampServer -HashAlgorithm SHA256
    if ($signature.Status -ne "Valid") { throw "Authenticode signing failed: $($signature.StatusMessage)" }
}

$readmePath = Join-Path $OutputDirectory "README.txt"
$readme = @"
Fallout TTG Launcher 1.0.0
==========================

1. Установите лицензионную копию Foundry VTT.
2. Полностью закройте Foundry VTT.
3. Запустите Fallout-TTG-Launcher.exe.
4. Проверьте путь FoundryVTT\Data и нажмите «Проверить обновления».
5. При первой установке будет загружен полный пакет; далее лаунчер выбирает меньшие патчи.

Лаунчер проверяет ECDSA-подпись канала, размер и SHA-256 каждого архива, сохраняет storage,
использует staging-каталог и оставляет предыдущую версию для кнопки «Откатить».

Сам Foundry VTT в этот дистрибутив не входит и не распространяется лаунчером.
"@
[System.IO.File]::WriteAllText($readmePath, $readme, [Text.UTF8Encoding]::new($true))

$sha256 = [System.Security.Cryptography.SHA256]::Create()
$executableStream = [System.IO.File]::OpenRead($finalExecutable)
try {
    $hashBytes = $sha256.ComputeHash($executableStream)
}
finally {
    $executableStream.Dispose()
    $sha256.Dispose()
}
$hash = [BitConverter]::ToString($hashBytes).Replace("-", "")
$hashPath = Join-Path $OutputDirectory "SHA256SUMS.txt"
[System.IO.File]::WriteAllText($hashPath, "$hash  Fallout-TTG-Launcher.exe`r`n", [Text.UTF8Encoding]::new($false))

$buildInfo = [ordered]@{
    schemaVersion = 1
    launcherVersion = "1.0.0"
    runtime = $Runtime
    selfContained = $true
    manifestUrl = $ManifestUrl
    publicKey = [System.IO.Path]::GetFileName($PublicKeyPath)
    executableSha256 = $hash.ToLowerInvariant()
    builtAt = [DateTimeOffset]::UtcNow.ToString("O")
    authenticode = -not [string]::IsNullOrWhiteSpace($SigningCertificateThumbprint)
}
$buildInfoPath = Join-Path $OutputDirectory "launcher-build.json"
[System.IO.File]::WriteAllText($buildInfoPath, ($buildInfo | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))

$archivePath = Join-Path $OutputDirectory "Fallout-TTG-Launcher-$Runtime.zip"
if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
& tar.exe -a -cf $archivePath -C $OutputDirectory "Fallout-TTG-Launcher.exe" "README.txt" "SHA256SUMS.txt" "launcher-build.json"
if ($LASTEXITCODE -ne 0) { throw "Could not create launcher distribution archive." }

Remove-Item -LiteralPath $publishDirectory -Recurse -Force
Write-Host "Launcher executable: $finalExecutable"
Write-Host "Distribution ZIP:    $archivePath"
if ([string]::IsNullOrWhiteSpace($ManifestUrl)) {
    Write-Warning "Manifest URL is not embedded yet. Users can paste it in the launcher; rebuild after cloud setup for a zero-configuration client."
}
