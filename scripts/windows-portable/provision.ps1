[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InstallRoot,
    [Parameter(Mandatory)][string]$SourceRoot,
    [switch]$IncludeEmbedding,
    [switch]$InstallVcRuntime
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$phase = 'validation'
$lease = $null
$scratch = $null

function Send-Status([string]$Name, [string]$Status) {
    [Console]::Out.WriteLine((@{ phase = $Name; status = $Status } | ConvertTo-Json -Compress))
}

function Invoke-Native([string]$Executable, [string[]]$Arguments) {
    $start = [Diagnostics.ProcessStartInfo]::new($Executable)
    # Windows PowerShell uses .NET Framework, which has no ArgumentList.
    $start.Arguments = ($Arguments | ForEach-Object {
        '"' + (($_ -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
    }) -join ' '
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $process = [Diagnostics.Process]::Start($start)
    try {
        while ($null -ne ($line = $process.StandardOutput.ReadLine())) {
            [Console]::Error.WriteLine($line)
        }
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            throw ('{0} exited with code {1}.' -f (Split-Path -Leaf $Executable), $process.ExitCode)
        }
    } finally {
        $process.Dispose()
    }
}

function Initialize-PythonEnvironment([string]$Python, [string]$Venv) {
    # Run ensurepip through pythonw so its own Python child is windowless too.
    Invoke-Native $Python @('-I', '-m', 'venv', '--without-pip', $Venv)
    Invoke-Native (Join-Path $Venv 'Scripts/pythonw.exe') @('-I', '-m', 'ensurepip', '--upgrade', '--default-pip')
}

function Assert-OwnedPath([string]$Path) {
    $candidate = [IO.Path]::GetFullPath($Path)
    if (-not $candidate.StartsWith($ownedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'A runtime path escaped the Noda installation directory.'
    }
}

function Move-OwnedDirectory([string]$From, [string]$To) {
    Assert-OwnedPath $From
    Assert-OwnedPath $To
    [IO.Directory]::Move($From, $To)
}

function Install-Directory([string]$From, [string]$To) {
    $previous = Join-Path $scratch ([guid]::NewGuid().ToString('N'))
    $exists = Test-Path -LiteralPath $To -PathType Container
    if ($exists) { Move-OwnedDirectory $To $previous }
    try {
        Move-OwnedDirectory $From $To
    } catch {
        if ($exists) { Move-OwnedDirectory $previous $To }
        throw
    }
}

function Get-PinnedArchive($Asset, [string]$Filename) {
    $destination = Join-Path $scratch $Filename
    Invoke-Native $curl @('--disable', '--fail', '--location', '--silent', '--show-error', '--proto', '=https',
        '--proto-redir', '=https', '--retry', '2', '--retry-max-time', '120', '--connect-timeout', '15',
        '--max-time', '180', '--output', $destination, $Asset.url)
    if ((Get-Item -LiteralPath $destination).Length -ne $Asset.bytes -or
        (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $Asset.sha256) {
        throw "The $phase archive did not match its pinned size and SHA-256."
    }
    return $destination
}

function Test-LlamaFiles([string]$Directory) {
    foreach ($asset in $llamaFiles.files) {
        $item = Join-Path $Directory $asset.path
        if (-not (Test-Path -LiteralPath $item -PathType Leaf) -or
            (Get-Item -LiteralPath $item).Length -ne $asset.bytes -or
            (Get-FileHash -LiteralPath $item -Algorithm SHA256).Hash -ne $asset.sha256) {
            return $false
        }
    }
    return $true
}

function Test-VcRuntime {
    foreach ($dll in @('msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll')) {
        if (-not (Test-Path -LiteralPath (Join-Path $env:SystemRoot "System32/$dll") -PathType Leaf)) {
            return $false
        }
    }
    return $true
}

function Install-VcRuntime {
    $installer = Get-PinnedArchive $assets.vcRuntime 'vc_redist.x64.exe'
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $assets.vcRuntime.signerThumbprint) {
        throw 'The Microsoft Visual C++ installer did not match its pinned Authenticode signature.'
    }
    $process = Start-Process -FilePath $installer -ArgumentList '/install', '/passive', '/norestart' -Wait -PassThru
    return $process.ExitCode
}

function Write-CoreReceipt {
    $receipt = Join-Path $scratch 'core-ready.json'
    $profile | ConvertTo-Json -Compress | Set-Content -LiteralPath $receipt -Encoding ascii
    if (Test-Path -LiteralPath $readyMarker -PathType Leaf) {
        [IO.File]::Replace($receipt, $readyMarker, (Join-Path $scratch 'previous-core-ready.json'))
    } else {
        [IO.File]::Move($receipt, $readyMarker)
    }
}

try {
    if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'The portable runtime requires Windows x64.' }
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\', '/')
    $SourceRoot = [IO.Path]::GetFullPath($SourceRoot)
    if ($InstallRoot.Length -le 3 -or $InstallRoot -eq $SourceRoot.TrimEnd('\', '/')) {
        throw 'Choose a dedicated writable Noda runtime directory.'
    }
    $ownedPrefix = $InstallRoot + [IO.Path]::DirectorySeparatorChar
    $curl = Join-Path $env:SystemRoot 'System32/curl.exe'
    $tar = Join-Path $env:SystemRoot 'System32/tar.exe'
    $scripts = Join-Path $SourceRoot 'scripts/windows-portable'
    $assetsPath = Join-Path $scripts 'runtime-assets.json'
    $llamaManifest = Join-Path $scripts 'llama-cpu-assets.json'
    $wheelLock = Join-Path $scripts 'requirements-win-x64.lock'
    $assets = Get-Content -LiteralPath $assetsPath -Raw | ConvertFrom-Json
    $llamaFiles = Get-Content -LiteralPath $llamaManifest -Raw | ConvertFrom-Json
    if ($assets.schema -ne 'noda-windows-runtime-v1' -or $llamaFiles.schema -ne 'noda-portable-llama-cpu-v1' -or
        $llamaFiles.tag -ne $assets.llama.version -or $llamaFiles.files.Count -lt 3 -or
        @($llamaFiles.files | Where-Object path -NotMatch '^[A-Za-z0-9_.-]+$').Count -ne 0) {
        throw 'The packaged Windows runtime manifests are invalid.'
    }
    $profile = [ordered]@{
        schema = 'noda-windows-runtime-v1'
        assets = (Get-FileHash -LiteralPath $assetsPath -Algorithm SHA256).Hash
        llama = (Get-FileHash -LiteralPath $llamaManifest -Algorithm SHA256).Hash
        wheels = (Get-FileHash -LiteralPath $wheelLock -Algorithm SHA256).Hash
    }

    [IO.Directory]::CreateDirectory($InstallRoot) | Out-Null
    $lockPath = Join-Path $InstallRoot '.provision.lock'
    try {
        $lease = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
    } catch [IO.IOException] {
        throw 'Another Noda runtime setup is running. Wait for it and retry.'
    }
    $readyMarker = Join-Path $InstallRoot 'core-ready.json'
    $bin = Join-Path $InstallRoot 'bin'
    $pythonHome = Join-Path $InstallRoot ('python-' + $assets.python.version)
    $python = Join-Path $pythonHome 'python.exe'
    $pythonw = Join-Path $pythonHome 'pythonw.exe'
    $venv = Join-Path $InstallRoot '.venv'
    $venvPython = Join-Path $venv 'Scripts/python.exe'
    $venvPythonw = Join-Path $venv 'Scripts/pythonw.exe'
    $qdrant = Join-Path $bin 'qdrant.exe'
    $llama = Join-Path $bin 'llama'
    $current = $null
    if (Test-Path -LiteralPath $readyMarker -PathType Leaf) {
        try { $current = Get-Content -LiteralPath $readyMarker -Raw | ConvertFrom-Json } catch { $current = $null }
    }
    $rebuild = $null -eq $current -or $current.schema -ne $profile.schema -or $current.wheels -ne $profile.wheels
    $scratch = Join-Path $InstallRoot ('.setup-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($scratch) | Out-Null
    [IO.Directory]::CreateDirectory($bin) | Out-Null

    $phase = 'prerequisite'
    if (-not (Test-VcRuntime)) {
        if (-not $InstallVcRuntime) { throw 'Microsoft Visual C++ Redistributable x64 is required. Approve installation and retry.' }
        Send-Status $phase 'started'
        $installerExit = Install-VcRuntime
        if ($installerExit -in 1641, 3010) {
            Send-Status $phase 'restart_required'
            exit 1
        }
        if ($installerExit -ne 0 -or -not (Test-VcRuntime)) {
            throw "Microsoft Visual C++ installation did not complete (exit $installerExit)."
        }
        Send-Status $phase 'complete'
    } else {
        Send-Status $phase 'cached'
    }

    $phase = 'python'
    $refreshPython = -not (Test-Path -LiteralPath $python -PathType Leaf) -or
        -not (Test-Path -LiteralPath $pythonw -PathType Leaf) -or
        (Get-FileHash -LiteralPath $python -Algorithm SHA256).Hash -ne $assets.python.executableSha256
    if ($refreshPython) {
        Send-Status $phase 'started'
        $archive = Get-PinnedArchive $assets.python 'python.tar.gz'
        Invoke-Native $tar @('-xf', $archive, '-C', $scratch)
        $stagedPython = Join-Path $scratch 'python'
        Invoke-Native (Join-Path $stagedPython 'python.exe') @('--version')
        Install-Directory $stagedPython $pythonHome
        Send-Status $phase 'complete'
    } else {
        Send-Status $phase 'cached'
    }

    $phase = 'qdrant'
    if (-not (Test-Path -LiteralPath $qdrant -PathType Leaf) -or
        (Get-FileHash -LiteralPath $qdrant -Algorithm SHA256).Hash -ne $assets.qdrant.executableSha256) {
        Send-Status $phase 'started'
        $archive = Get-PinnedArchive $assets.qdrant 'qdrant.zip'
        Invoke-Native $tar @('-xf', $archive, '-C', $scratch, 'qdrant.exe')
        $stagedQdrant = Join-Path $scratch 'qdrant.exe'
        Invoke-Native $stagedQdrant @('--version')
        if (Test-Path -LiteralPath $qdrant -PathType Leaf) {
            [IO.File]::Replace($stagedQdrant, $qdrant, (Join-Path $scratch 'previous-qdrant.exe'))
        } else {
            [IO.File]::Move($stagedQdrant, $qdrant)
        }
        Send-Status $phase 'complete'
    } else {
        Send-Status $phase 'cached'
    }

    $phase = 'llama'
    if (-not (Test-LlamaFiles $llama)) {
        Send-Status $phase 'started'
        $archive = Get-PinnedArchive $assets.llama 'llama.zip'
        $stagedLlama = Join-Path $scratch 'llama'
        [IO.Directory]::CreateDirectory($stagedLlama) | Out-Null
        Invoke-Native $tar (@('-xf', $archive, '-C', $stagedLlama) + @($llamaFiles.files.path))
        if (-not (Test-LlamaFiles $stagedLlama)) { throw 'The extracted llama.cpp files failed integrity verification.' }
        Invoke-Native (Join-Path $stagedLlama $llamaFiles.executable) @('--version')
        Install-Directory $stagedLlama $llama
        Send-Status $phase 'complete'
    } else {
        Send-Status $phase 'cached'
    }

    $phase = 'dependencies'
    if ($rebuild -or $refreshPython -or -not (Test-Path -LiteralPath $venvPython -PathType Leaf) -or
        -not (Test-Path -LiteralPath $venvPythonw -PathType Leaf)) {
        Send-Status $phase 'started'
        Initialize-PythonEnvironment $python $venv
        Invoke-Native $venvPythonw @('-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', 'install',
            '--index-url', 'https://pypi.org/simple', '--require-hashes', '--only-binary=:all:', '--force-reinstall',
            '--no-input', '--no-cache-dir', '--retries', '2', '--timeout', '30', '--progress-bar', 'off', '-r', $wheelLock)
        Invoke-Native $venvPythonw @('-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', 'check')
        Invoke-Native $venvPythonw @('-I', '-c', 'import flask, llama_cpp, onnxruntime, qdrant_client, sentencepiece, sentence_transformers, torch, watchdog')
        Send-Status $phase 'complete'
    } else {
        Send-Status $phase 'cached'
    }
    if ($rebuild -or $current.assets -ne $profile.assets -or $current.llama -ne $profile.llama) {
        Write-CoreReceipt
    }

    if ($IncludeEmbedding) {
        $phase = 'embedding'
        Send-Status $phase 'started'
        $env:HF_HOME = Join-Path $InstallRoot 'huggingface'
        $env:HF_HUB_CACHE = Join-Path $env:HF_HOME 'hub'
        $env:HF_HUB_DISABLE_TELEMETRY = '1'
        $env:HF_HUB_DISABLE_XET = '1'
        Invoke-Native $venvPythonw @('-I', (Join-Path $scripts 'cache-embedding.py'), $env:HF_HUB_CACHE)
        Send-Status $phase 'complete'
    }

    Send-Status 'ready' 'complete'
} catch {
    Send-Status $phase 'failed'
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($scratch -and (Test-Path -LiteralPath $scratch -PathType Container)) {
        Assert-OwnedPath $scratch
        Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($lease) { $lease.Dispose() }
}
