# install.ps1: install Fleetify on Windows from its GitHub release, once the
# installer matches the release's SHA256SUMS.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Version X.Y.Z] [-DownloadOnly] [-Silent] [-BaseUrl URL]
#
# Run through Invoke-Expression, it takes no parameters: it reads
# FLEETIFY_VERSION and FLEETIFY_INSTALL_BASE instead, which a parameter
# overrides.
#
# It downloads SHA256SUMS and the release's installer, Fleetify_<version>_x64-setup.exe,
# from https://github.com/fleetifydev/fleetify/releases/download/v<version>/,
# or from <BaseUrl>/download/v<version>/, into $env:TEMP\fleetify-install.
# Without a version, the version is the latest release's, read from
# latest/download/latest.json there. The installer's SHA-256 must match its
# line in SHA256SUMS, in any letter case; if it doesn't, the download is
# deleted and nothing is installed. Then it runs the installer, which
# installs Fleetify for the current user, and waits for it: with -Silent,
# without its windows (/S). With -DownloadOnly, it stops before that and
# keeps the checked installer. Each step is printed, prefixed
# "fleetify-install:".
#
# It runs in Windows PowerShell 5.1 and in PowerShell 7. A failure prints
# "fleetify-install: error: ..." on stderr; run as a file, the script then
# exits 1, and run through Invoke-Expression or as a script block, it throws,
# which leaves the console open.
[CmdletBinding()]
param(
    [string]$Version,
    [switch]$DownloadOnly,
    [switch]$Silent,
    [string]$BaseUrl
)

function Install-Fleetify {
    param(
        [string]$Version,
        [bool]$DownloadOnly,
        [bool]$Silent,
        [string]$BaseUrl
    )
    Set-StrictMode -Version 3.0
    $ErrorActionPreference = 'Stop'
    # Windows PowerShell 5.1 downloads far slower while it draws a progress bar.
    $ProgressPreference = 'SilentlyContinue'

    function Write-Step([string]$Text) {
        Write-Host "fleetify-install: $Text"
    }

    function Get-Download([string]$Url, [string]$Path) {
        try {
            Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing
        } catch {
            throw "can't download ${Url}: $($_.Exception.Message)"
        }
    }

    $base = $BaseUrl
    if (-not $base) { $base = $env:FLEETIFY_INSTALL_BASE }
    if (-not $base) { $base = 'https://github.com/fleetifydev/fleetify/releases' }
    $base = $base.TrimEnd('/')
    if ($base -notmatch '^https?://') {
        throw "the release base must be an http or https URL, not $base"
    }

    if (-not $Version) { $Version = $env:FLEETIFY_VERSION }
    if ($Version) {
        $Version = $Version.Trim()
        if ($Version -match '^v[0-9]') { $Version = $Version.Substring(1) }
        if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\z') {
            throw "the version must be a release's, MAJOR.MINOR.PATCH, such as 0.2.0, not $Version"
        }
    }

    # $IsWindows is PowerShell 6's; Windows PowerShell runs only on Windows.
    $onWindows = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
    if (-not $onWindows -and -not $DownloadOnly) {
        throw 'install.ps1 installs Fleetify on Windows; on macOS and Linux, use install.sh, or pass -DownloadOnly'
    }
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'Fleetify needs 64-bit Windows'
    }

    # GitHub takes TLS 1.2 or later, which an older .NET doesn't offer by default.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $temp = $env:TEMP
    if (-not $temp) { $temp = [IO.Path]::GetTempPath() }
    $dir = Join-Path $temp 'fleetify-install'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    if (-not $Version) {
        $url = "$base/latest/download/latest.json"
        Write-Step "finding the latest release: $url"
        $manifest = Join-Path $dir 'latest.json'
        Get-Download $url $manifest
        $found = $null
        try {
            $json = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifest | ConvertFrom-Json
            $property = $json.PSObject.Properties['version']
            if ($null -ne $property) { $found = [string]$property.Value }
        } catch {
            $found = $null
        }
        if (-not $found -or $found -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\z') {
            throw "$url names no version"
        }
        $Version = $found
        Write-Step "the latest release is $Version"
    }

    $asset = "Fleetify_${Version}_x64-setup.exe"
    $release = "$base/download/v$Version"
    $installer = Join-Path $dir $asset
    $sums = Join-Path $dir 'SHA256SUMS'
    Write-Step "Fleetify ${Version}: $asset, from $release"
    Write-Step 'downloading SHA256SUMS'
    Get-Download "$release/SHA256SUMS" $sums
    Write-Step "downloading $asset"
    Get-Download "$release/$asset" $installer

    Write-Step "checking $asset against SHA256SUMS"
    $expected = @()
    foreach ($line in @(Get-Content -Encoding UTF8 -LiteralPath $sums)) {
        if ($line -match '^([0-9A-Fa-f]{64}) [ *](.+)$' -and $Matches[2] -ceq $asset) { $expected += $Matches[1] }
    }
    if ($expected.Count -ne 1) {
        Remove-Item -Force -LiteralPath $installer
        if ($expected.Count -eq 0) { throw "SHA256SUMS has no line for $asset; nothing was installed" }
        throw "SHA256SUMS has more than one line for $asset; nothing was installed"
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash
    if ($actual -ine $expected[0]) {
        Remove-Item -Force -LiteralPath $installer
        throw "checksum mismatch: $asset doesn't match its line in SHA256SUMS; it was deleted, and nothing was installed"
    }
    Write-Step "checksum OK: $($actual.ToLowerInvariant())"

    if ($DownloadOnly) {
        Write-Step "downloaded and checked $installer; nothing was installed"
        return
    }
    if ($Silent) {
        Write-Step "running the installer, without its windows: $installer /S"
        $process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
    } else {
        Write-Step "running the installer: $installer"
        $process = Start-Process -FilePath $installer -Wait -PassThru
    }
    if ($process.ExitCode -ne 0) {
        throw "the installer exited $($process.ExitCode)"
    }
    Write-Step "Fleetify $Version is installed"
}

# Empty when the script runs through Invoke-Expression or as a script block,
# where exit would close the console.
$runAsFile = [bool]$PSCommandPath
try {
    Install-Fleetify -Version $Version -DownloadOnly $DownloadOnly.IsPresent -Silent $Silent.IsPresent -BaseUrl $BaseUrl
} catch {
    [Console]::Error.WriteLine("fleetify-install: error: $($_.Exception.Message)")
    if ($runAsFile) { exit 1 }
    throw
}
