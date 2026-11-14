[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputDirectory, [string]$Makensis, [string]$ExistingApplication)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$out = [IO.Path]::GetFullPath($OutputDirectory)
if ($out -eq $repo -or $out.StartsWith($repo + '\', [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $out)) { throw 'Use a new absolute output folder outside source.' }
if (-not $Makensis) { $Makensis = Join-Path $env:LOCALAPPDATA 'electron-builder/Cache/nsis/nsis-3.0.4.1/makensis.exe' }
if (-not (Test-Path -LiteralPath $Makensis -PathType Leaf)) { throw 'Build Setup first, or pass its trusted makensis.exe.' }
$id = [Guid]::NewGuid().ToString('N')
$name = 'NodaSmoke-' + $id.Substring(0,8)
$payload = Join-Path $out 'payload'
$target = Join-Path $out 'installed app'
$data = Join-Path $out 'user-data'
New-Item -ItemType Directory -Path (Join-Path $payload 'resources'),$data -Force | Out-Null
$before = if ($ExistingApplication) { (Get-FileHash -LiteralPath $ExistingApplication).Hash } else { $null }
$checks = @()
function Compile-Payload([string]$destination, [int]$code) {
  $script = @'
Unicode true
Name "Noda isolated installer fixture"
OutFile "DESTINATION"
SilentInstall silent
RequestExecutionLevel user
Section
  SetErrorLevel EXIT_CODE
SectionEnd
'@
  $source = $destination + '.nsi'
  $script.Replace('DESTINATION',$destination).Replace('EXIT_CODE',[string]$code) | Set-Content -LiteralPath $source -Encoding UTF8
  & $Makensis /V2 $source
  if ($LASTEXITCODE -ne 0) { throw 'Fixture compilation failed.' }
}
function Run-Fixture([string]$file, [string[]]$arguments, [int]$expected=0) {
  $process = Start-Process -FilePath $file -ArgumentList $arguments -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(20000)) { Stop-Process -Id $process.Id -Force; throw 'Isolated installer timed out.' }
  if ($process.ExitCode -ne $expected) { throw ('Unexpected isolated installer exit: ' + $process.ExitCode) }
}
try {
  Compile-Payload (Join-Path $payload ($name + '.exe')) 0
  'Synthetic ASAR fixture.' | Set-Content -LiteralPath (Join-Path $payload 'resources/app.asar') -Encoding ASCII
  $config = @{ appId=('ai.buglai.noda.smoke.'+$id);productName=$name;directories=@{output=(Join-Path $out 'dist')};win=@{target='nsis';signExecutable=$false};
    nsis=@{artifactName='Noda-isolated-smoke.exe';oneClick=$false;perMachine=$false;allowElevation=$false;runAfterFinish=$false;installerLanguages=@('en_US');
      include=(Join-Path $repo 'scripts/windows-portable/installer.nsh');deleteAppDataOnUninstall=$false;packElevateHelper=$false;
      differentialPackage=$false;createDesktopShortcut=$false;createStartMenuShortcut=$false} }
  $configPath = Join-Path $out 'config.json'
  $config | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $configPath -Encoding UTF8
  Push-Location -LiteralPath (Join-Path $repo 'frontend')
  try { & './node_modules/.bin/electron-builder.cmd' --config $configPath --prepackaged $payload --win nsis --x64 --publish never
    if ($LASTEXITCODE -ne 0) { throw 'Fixture installer build failed.' }
  } finally { Pop-Location }
  $setup = Join-Path $out 'dist/Noda-isolated-smoke.exe'
  $installArguments = @('/S',('/D=' + $target))
  Run-Fixture $setup $installArguments
  $asar = Join-Path $target 'resources/app.asar'
  if (-not (Test-Path -LiteralPath $asar -PathType Leaf)) { throw 'Fresh installation missing.' }
  $checks += 'fresh installation with a distinct application ID'
  'Synthetic note kept outside application files.' | Set-Content -LiteralPath (Join-Path $data 'note.md') -Encoding UTF8
  $noteHash = (Get-FileHash -LiteralPath (Join-Path $data 'note.md')).Hash
  'obsolete synthetic file' | Set-Content -LiteralPath (Join-Path $target 'obsolete.txt') -Encoding ASCII
  Run-Fixture $setup $installArguments
  if (Test-Path -LiteralPath (Join-Path $target 'obsolete.txt')) { throw 'Upgrade did not remove obsolete files.' }
  $checks += 'upgrade replaces files instead of leaving an old installation'
  $uninstallers = @(Get-ChildItem -LiteralPath $target -File -Filter 'Uninstall*.exe')
  if ($uninstallers.Count -ne 1) { throw 'Unexpected fixture uninstaller.' }
  $uninstaller = $uninstallers[0].FullName
  $bad = Join-Path $out 'broken-uninstaller.exe'
  Compile-Payload $bad 2
  Run-Fixture $bad @('/S') 2
  Copy-Item -LiteralPath $bad -Destination $uninstaller -Force
  Run-Fixture $setup $installArguments
  if ((Get-FileHash -LiteralPath $bad).Hash -eq (Get-FileHash -LiteralPath $uninstaller).Hash) { throw 'Broken uninstaller was not replaced.' }
  $checks += 'upgrade recovers from a previous uninstaller returning exit 2'
  $asarHash = (Get-FileHash -LiteralPath $asar).Hash
  $uninstallerHash = (Get-FileHash -LiteralPath $uninstaller).Hash
  $lock = [IO.File]::Open((Join-Path $target ($name + '.exe')), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try { Run-Fixture $setup $installArguments 2 } finally { $lock.Dispose() }
  if ((Get-FileHash -LiteralPath $asar).Hash -ne $asarHash -or (Get-FileHash -LiteralPath $uninstaller).Hash -ne $uninstallerHash) { throw 'Locked application was modified.' }
  $checks += 'files in use fail before the installed files or uninstaller are changed'
  Move-Item -LiteralPath $uninstaller -Destination (Join-Path $out 'saved-uninstaller.exe')
  New-Item -ItemType Junction -Path $uninstaller -Target $data | Out-Null
  try { Run-Fixture $setup $installArguments 2 } finally {
    # Non-recursive deletion removes only the fixture junction; target data stays.
    if (-not $uninstaller.StartsWith($out + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture cleanup path.' }
    [IO.Directory]::Delete($uninstaller)
    Move-Item -LiteralPath (Join-Path $out 'saved-uninstaller.exe') -Destination $uninstaller
  }
  if ((Get-FileHash -LiteralPath (Join-Path $data 'note.md')).Hash -ne $noteHash) { throw 'Fixture user data changed.' }
  $checks += 'uninstaller directory/reparse redirection is rejected and data is retained'
  Run-Fixture $uninstaller @('/S','/KEEP_APP_DATA','/currentuser')
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ((Test-Path -LiteralPath $asar) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
  if (Test-Path -LiteralPath $asar) { throw 'Fixture uninstallation did not finish.' }
  if ((Get-FileHash -LiteralPath (Join-Path $data 'note.md')).Hash -ne $noteHash) { throw 'Uninstall removed fixture user data.' }
  $checks += 'uninstall removes application files and retains external notes'
  if ($ExistingApplication -and (Get-FileHash -LiteralPath $ExistingApplication).Hash -ne $before) { throw 'The existing real application changed.' }
  @{status='pass';checks=$checks;applicationId=$config.appId;existingApplicationUnchanged=[bool]$ExistingApplication} | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath (Join-Path $out 'result.json') -Encoding UTF8
  Write-Output ('Native installer checks passed: ' + $checks.Count)
} catch {
  @{status='fail';checksCompleted=$checks;error=$_.Exception.Message} | ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath (Join-Path $out 'result.json') -Encoding UTF8
  throw
}
