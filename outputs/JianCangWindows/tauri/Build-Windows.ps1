[CmdletBinding()]
param(
    [string]$NodeArchive = (Join-Path $PSScriptRoot '..\..\..\work\build\tauri-node\node-v24.22.3-win-x64.zip'),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist'),
    [string]$MakeNsis,
    [string]$Python = 'python',
    [switch]$Production
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') {
    throw 'Use Windows with the Rust MSVC target, Visual Studio C++ Build Tools, Node.js, and Python 3.'
}

function Confirm-CommandSucceeded([string]$Step) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE."
    }
}

$archive = (Resolve-Path -LiteralPath $NodeArchive).ProviderPath
$output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
$packaging = @('--output', $output)
if ($Production) { $packaging += '--production' }
if ($MakeNsis) {
    $packaging += @('--makensis', (Resolve-Path -LiteralPath $MakeNsis).ProviderPath)
}

$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$cargo = (Get-Command cargo.exe -CommandType Application | Select-Object -First 1).Source
$pythonCommand = (Get-Command $Python -CommandType Application | Select-Object -First 1).Source
$target = 'x86_64-pc-windows-msvc'

$previousPython = $env:JIANCANG_BUILD_PYTHON
Push-Location $PSScriptRoot
try {
    $targetDir = if ($env:CARGO_TARGET_DIR) {
        $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:CARGO_TARGET_DIR)
    } else {
        Join-Path $PSScriptRoot 'src-tauri\target'
    }

    $env:JIANCANG_BUILD_PYTHON = $pythonCommand
    & $node .\Prepare.mjs $archive
    Confirm-CommandSucceeded 'Preparing Tauri application files'

    & $cargo build --locked --release --target $target --target-dir $targetDir --manifest-path src-tauri/Cargo.toml
    Confirm-CommandSucceeded 'Building the x64 Tauri application'

    $exe = Join-Path $targetDir "$target\release\jiancang-tauri.exe"
    & $pythonCommand .\Package-Windows.py --exe $exe @packaging
    Confirm-CommandSucceeded 'Packaging JianCang Windows'
} finally {
    $env:JIANCANG_BUILD_PYTHON = $previousPython
    Pop-Location
}
