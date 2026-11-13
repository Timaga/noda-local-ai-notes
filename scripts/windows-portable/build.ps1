[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()][string]$OutputDirectory,
    [switch]$StageOnly,
    [switch]$SourceOnly,
    [switch]$Installer
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if ($Installer -and $SourceOnly) { throw 'Choose either -Installer or -SourceOnly.' }
if (-not $OutputDirectory) {
    $kind = if ($Installer) { 'setup' } elseif ($SourceOnly) { 'source' } else { 'portable' }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $id = [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $OutputDirectory = Join-Path $root "output/noda-windows-$kind-$stamp-$id"
}
$output = [IO.Path]::GetFullPath($OutputDirectory)
$outputPrefix = $output.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
if ($PSScriptRoot.StartsWith($outputPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    $output -eq $root -or ($output -notmatch '[^\\/]:[\\/].+')) {
    throw 'Choose a dedicated, empty Windows release output folder.'
}
if ((Test-Path -LiteralPath $output) -and (Get-ChildItem -LiteralPath $output -Force | Select-Object -First 1)) {
    throw 'The release output folder already contains files. Choose a new folder.'
}

$frontend = Join-Path $root 'frontend'
$source = Join-Path $output $(if ($SourceOnly) { 'Noda-source' } else { 'noda-runtime' })
$builder = Join-Path $frontend 'node_modules/.bin/electron-builder.cmd'
$electron = Join-Path $frontend 'node_modules/electron/dist'
if (-not ($StageOnly -or $SourceOnly)) {
    if (-not (Test-Path -LiteralPath $builder -PathType Leaf)) {
        throw 'Install the frontend dependencies from its lockfile before building.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $electron 'electron.exe') -PathType Leaf)) {
        & node (Join-Path $frontend 'node_modules/electron/install.js')
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $electron 'electron.exe') -PathType Leaf)) {
            throw 'The Electron runtime could not be downloaded.'
        }
    }
}

function Get-ReleaseHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hasher.Dispose() }
}

function Copy-ReleaseSource([string]$RelativePath) {
    $file = Get-Item -LiteralPath (Join-Path $root $RelativePath)
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "The release input is not a regular file: $RelativePath"
    }
    $destination = Join-Path $source $RelativePath
    [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
    if (Test-Path -LiteralPath $destination) {
        if ((Get-ReleaseHash $file.FullName) -ne (Get-ReleaseHash $destination)) {
            throw "The staged file differs from its source: $RelativePath"
        }
        return
    }
    [IO.File]::Copy($file.FullName, $destination, $false)
}

function Copy-ReleaseTree([string]$RelativePath) {
    $directory = Get-Item -LiteralPath (Join-Path $root $RelativePath)
    if (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "The release directory is not a regular directory: $RelativePath"
    }
    foreach ($entry in (Get-ChildItem -LiteralPath $directory.FullName -Force)) {
        if ($entry.Name -in @('__pycache__', '.pytest_cache', '.benchmarks', '.mypy_cache', '.ruff_cache')) { continue }
        $relative = Join-Path $RelativePath $entry.Name
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "The release input is a reparse point: $relative"
        }
        if ($entry.PSIsContainer) { Copy-ReleaseTree $relative }
        else { Copy-ReleaseSource $relative }
    }
}

$backendDirectories = @('backend', 'backend/model_init_layers', 'backend/routes', 'backend/ru_pipeline',
    'backend/runtime_layers', 'backend/services')
foreach ($directory in $backendDirectories) {
    $path = Join-Path $root $directory
    if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "The release input directory is a reparse point: $directory"
    }
    foreach ($file in (Get-ChildItem -LiteralPath $path -File -Filter '*.py')) {
        Copy-ReleaseSource (Join-Path $directory $file.Name)
    }
}

foreach ($file in @(
    'backend/requirements.txt', 'backend/note_title_fewshot_lineage.json',
    'backend/ru_pipeline/assets/native-models.json', 'backend/ru_pipeline/assets/scorer_mmarco.json',
    'backend/ru_pipeline/assets/scorer_qwen.json', 'backend/ru_pipeline/assets/scorer_tev.json',
    'scripts/windows-portable/provision.ps1', 'scripts/windows-portable/cache-embedding.py',
    'scripts/windows-portable/embedding-profile.json',
    'scripts/windows-portable/runtime-assets.json', 'scripts/windows-portable/llama-cpu-assets.json',
    'scripts/windows-portable/requirements-win-x64.lock'
)) {
    Copy-ReleaseSource $file
}

$notices = @('LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'START_HERE.md', 'START_HERE.txt')
foreach ($required in @('LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'LICENSES/manifest.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $required) -PathType Leaf)) {
        throw "A required license input is missing: $required"
    }
}
foreach ($notice in $notices) {
    if (Test-Path -LiteralPath (Join-Path $root $notice) -PathType Leaf) { Copy-ReleaseSource $notice }
}
Copy-ReleaseTree 'LICENSES'
Copy-ReleaseSource 'scripts/check-licenses.py'
Copy-ReleaseTree 'docs/legal'
$licenseManifest = Get-Content -LiteralPath (Join-Path $source 'LICENSES/manifest.json') -Raw | ConvertFrom-Json
foreach ($record in $licenseManifest.files) {
    $protected = [IO.Path]::GetFullPath((Join-Path $source $record.path))
    if (-not $protected.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $protected -PathType Leaf) -or
        (Get-ReleaseHash $protected) -ne $record.sha256) {
        throw "The license bundle integrity check failed: $($record.path)"
    }
}

$uiFiles = @('*.js', '*.css', '*.html', 'package.json', 'owned_note_profiles.json', 'assets/liquid-veins.mp4',
    'assets/noda-bot-signal.svg', 'assets/noda-icon.ico', 'assets/noda-icon.png', 'assets/noda-search-loop.mp4',
    'assets/noda-search-poster.png', 'assets/noda-tray.png', 'assets/noda-wave-core.png', 'assets/noda-wave-inner.png',
    'assets/noda-wave-middle.png', 'assets/noda-wave-node.png', 'assets/noda-wave-outer.png', 'assets/noda-wave-primary.png')
if ($SourceOnly) {
    foreach ($entry in $uiFiles) {
        if ($entry.StartsWith('*')) {
            foreach ($file in Get-ChildItem -LiteralPath $frontend -File -Filter $entry) {
                Copy-ReleaseSource ('frontend/' + $file.Name)
            }
        } else {
            Copy-ReleaseSource ('frontend/' + $entry)
        }
    }
    foreach ($file in @(
        'frontend/package-lock.json', 'scripts/windows-portable/build.ps1', 'scripts/windows-portable/installer.nsh', 'scripts/windows-portable/installer-repair.nsh', '.gitignore',
        'docs/note-library-storage.md', 'tests/test_windows_portable_packaging.py', 'tests/windows_installer_lifecycle.smoke.ps1',
        'tests/frontend_desktop_settings.test.js', 'tests/frontend_ui_languages.test.js',
        'tests/frontend/portable_runtime.test.cjs', 'tests/frontend/notes_note_actions.test.cjs',
        'tests/frontend/portable_runtime_cache.test.cjs', 'tests/frontend/portable_setup_progress.test.cjs',
        'tests/frontend/quick_capture_project.test.cjs'
    )) {
        Copy-ReleaseSource $file
    }
    foreach ($directory in @('docs', 'tests', '.github')) { Copy-ReleaseTree $directory }
    foreach ($file in @('AGENTS.md', 'AGENTS.project.md', '.gitattributes', 'CHANGELOG.md', 'CONTRIBUTING.md',
        'SECURITY.md', 'pytest.ini', 'requirements-test.txt', 'scripts/test.ps1')) {
        Copy-ReleaseSource $file
    }
    Write-Output "Staged buildable source at $source"
    return
}
$config = [ordered]@{
    appId = 'ai.buglai.noda'
    productName = 'Noda'
    directories = @{ output = (Join-Path $output 'dist') }
    npmRebuild = $false
    electronDist = $electron
    files = $uiFiles
    extraResources = @(@{ from = $source; to = 'noda-runtime' })
    win = @{ target = 'dir'; icon = 'assets/noda-icon.ico'; signExecutable = $false }
}
$configName = 'electron-builder.portable.json'
if ($Installer) {
    $configName = 'electron-builder.installer.json'
    $config.win.target = 'nsis'
    $config.nsis = [ordered]@{
        artifactName = 'Noda-Setup-${version}-x64.exe'
        oneClick = $false
        perMachine = $false
        allowElevation = $false
        # installer.nsh starts Noda from the success callback without a finish page.
        runAfterFinish = $false
        installerLanguages = @('en_US')
        include = Join-Path $root 'scripts/windows-portable/installer.nsh'
        deleteAppDataOnUninstall = $false
        packElevateHelper = $false
        differentialPackage = $false
    }
}
$configPath = Join-Path $output $configName
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
Write-Output "Staged application sources at $source"
if ($StageOnly) { return }

$buildArguments = @('--config', $configPath, '--win', '--x64', '--publish', 'never')
if (-not $Installer) { $buildArguments += '--dir' }
Push-Location -LiteralPath $frontend
try {
    & $builder @buildArguments
    if ($LASTEXITCODE -ne 0) { throw "The Windows Electron build exited with code $LASTEXITCODE." }
} finally {
    Pop-Location
}

if ($Installer) {
    $version = (Get-Content -LiteralPath (Join-Path $frontend 'package.json') -Raw | ConvertFrom-Json).version
    $setup = Join-Path $output ('dist/Noda-Setup-{0}-x64.exe' -f $version)
    if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) { throw 'The Windows installer was not produced.' }
    Write-Output $setup
    return
}

$app = Join-Path $output 'dist/win-unpacked/Noda.exe'
if (-not (Test-Path -LiteralPath $app -PathType Leaf)) { throw 'The portable executable was not produced.' }
foreach ($notice in $notices) {
    $staged = Join-Path $source $notice
    if (Test-Path -LiteralPath $staged -PathType Leaf) {
        Copy-Item -LiteralPath $staged -Destination (Split-Path -Parent $app)
    }
}
Write-Output $app
