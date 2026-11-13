[CmdletBinding()]
param(
    [ValidateSet('all', 'python', 'node')][string]$Suite = 'all',
    [string]$Python,
    [string]$ResultsDirectory
)

$ErrorActionPreference = 'Stop'

function Invoke-TestProcess {
    param([string]$Executable, [string[]]$Arguments, [string]$Log)
    $previousPreference = $ErrorActionPreference
    $previousExitCode = $global:LASTEXITCODE
    try {
        # Windows PowerShell treats native stderr as ErrorRecords. Preserve the
        # diagnostics in the log and decide success from the process exit code.
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = $null
        & $Executable @Arguments *> $Log
        $code = $global:LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
        $global:LASTEXITCODE = $previousExitCode
    }
    if ($null -eq $code) { throw "Could not start test executable: $Executable" }
    return $code
}

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Python) { $Python = Join-Path $root '.venv/Scripts/python.exe' }
$Python = [IO.Path]::GetFullPath($Python)
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
    throw 'Create .venv and install requirements-test.txt, or pass -Python with an installed test interpreter.'
}
if (-not $ResultsDirectory) {
    $ResultsDirectory = Join-Path ([IO.Path]::GetTempPath()) ('noda-tests-' + [Guid]::NewGuid().ToString('N'))
}
$results = [IO.Path]::GetFullPath($ResultsDirectory)
if ($results -eq $root -or $results.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Choose a results folder outside the source repository.'
}
[IO.Directory]::CreateDirectory($results) | Out-Null

$original = @{}
foreach ($name in @('PYTHONDONTWRITEBYTECODE', 'COVERAGE_FILE', 'NODA_TEST_PYTHON')) {
    $original[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$records = @()
Push-Location -LiteralPath $root
try {
    $env:PYTHONDONTWRITEBYTECODE = '1'
    $env:COVERAGE_FILE = Join-Path $results '.coverage'
    # The Node integration test invokes this same isolated Python interpreter.
    $env:NODA_TEST_PYTHON = $Python
    if ($Suite -in @('all', 'python')) {
        $manifest = Join-Path $root 'tests/runtime-tests.txt'
        $tests = @(Get-Content -LiteralPath $manifest | Where-Object { $_ -and -not $_.StartsWith('#') })
        if ($tests.Count -eq 0) { throw 'The runtime test manifest is empty.' }
        foreach ($test in $tests) {
            $resolved = [IO.Path]::GetFullPath((Join-Path $root $test))
            if (-not $resolved.StartsWith($root + '\tests\', [StringComparison]::OrdinalIgnoreCase) -or
                -not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
                throw "Invalid runtime test path: $test"
            }
        }
        $arguments = @('-I', '-B', '-m', 'pytest', '-c', (Join-Path $root 'pytest.ini'),
            '-o', 'addopts=', '-p', 'no:cacheprovider', '--cov=backend', '--cov-branch',
            ('--benchmark-storage=' + (Join-Path $results 'benchmarks')),
            '--cov-report=term-missing', ('--cov-report=json:' + (Join-Path $results 'coverage.json')),
            ('--junitxml=' + (Join-Path $results 'pytest.xml')), '-q') + $tests
        $log = Join-Path $results 'pytest.log'
        $code = Invoke-TestProcess -Executable $Python -Arguments $arguments -Log $log
        $records += @{ suite = 'python'; executable = $Python; arguments = $arguments; exitCode = $code; log = $log }
        Get-Content -LiteralPath $log -Tail 6
        if ($code -ne 0) { throw "Python tests failed with exit code $code. See $log" }
    }
    if ($Suite -in @('all', 'node')) {
        $node = (Get-Command node -ErrorAction Stop).Source
        $tests = @(Get-ChildItem -LiteralPath (Join-Path $root 'tests/frontend') -File -Filter '*.test.cjs' |
            ForEach-Object { $_.FullName })
        $tests += @(Get-ChildItem -LiteralPath (Join-Path $root 'tests') -File -Filter 'frontend_*.test.js' |
            ForEach-Object { $_.FullName })
        if ($tests.Count -eq 0) { throw 'No Node runtime tests were found.' }
        $arguments = @('--test') + $tests
        $log = Join-Path $results 'node.log'
        $code = Invoke-TestProcess -Executable $node -Arguments $arguments -Log $log
        $records += @{ suite = 'node'; executable = $node; arguments = $arguments; exitCode = $code; log = $log }
        Get-Content -LiteralPath $log -Tail 8
        if ($code -ne 0) { throw "Node tests failed with exit code $code. See $log" }
    }
    Write-Output "Test results: $results"
} finally {
    if ($records.Count) {
        $records | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $results 'commands.json') -Encoding utf8
    }
    foreach ($name in $original.Keys) {
        [Environment]::SetEnvironmentVariable($name, $original[$name], 'Process')
    }
    Pop-Location
}
