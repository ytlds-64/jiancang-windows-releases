param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [Parameter(Mandatory = $true)]
    [ValidateSet('install', 'uninstall', 'remove-shortcuts')]
    [string]$Operation,
    [switch]$Production
)

$ErrorActionPreference = 'Stop'
$versionPattern = '[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}'
if ($Version -notmatch "^$versionPattern$") { throw 'Invalid candidate installation version.' }

$local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if (![IO.Path]::IsPathRooted($local)) { throw 'The user program directory is unavailable.' }
$programs = [IO.Path]::Combine($local, 'Programs')
$target = if ($Production) { [IO.Path]::Combine($programs, 'JianCang-WebView2') }
    else { [IO.Path]::Combine($programs, "JianCang-Tauri-Candidate-$Version") }
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
$registryPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall'
$prefix = 'JianCang.Tauri.Candidate.'
$applications = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$legacyApplications = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$sidecars = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$requested = [Collections.Generic.HashSet[string]]::new()

function Get-Attributes([string]$Path) {
    try { return [IO.File]::GetAttributes($Path) }
    catch {
        $cause = $_.Exception.GetBaseException()
        if ($cause -is [IO.FileNotFoundException] -or $cause -is [IO.DirectoryNotFoundException]) { return $null }
        throw
    }
}

function Assert-OrdinaryDirectory([string]$Path) {
    $attributes = Get-Attributes $Path
    if ($null -ne $attributes -and (!(($attributes -band [IO.FileAttributes]::Directory)) -or
        ($attributes -band [IO.FileAttributes]::ReparsePoint))) {
        throw 'The candidate program directory is redirected or is not a directory.'
    }
}

function Assert-InstallTree {
    Assert-OrdinaryDirectory $local
    Assert-OrdinaryDirectory $programs
    Assert-OrdinaryDirectory $target
    if (![IO.Directory]::Exists($target)) { return }
    $directories = [Collections.Generic.Stack[string]]::new()
    $directories.Push($target)
    while ($directories.Count -gt 0) {
        foreach ($file in [IO.Directory]::EnumerateFileSystemEntries($directories.Pop())) {
            $attributes = Get-Attributes $file
            if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'A file in the candidate program directory is redirected.'
            }
            if ($attributes -band [IO.FileAttributes]::Directory) { $directories.Push($file) }
        }
    }
}

function Add-Candidate([string]$Directory) {
    $attributes = Get-Attributes $Directory
    if (!(($attributes -band [IO.FileAttributes]::Directory)) -or
        ($attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
    $exe = [IO.Path]::Combine($Directory, 'jiancang-tauri.exe')
    $attributes = Get-Attributes $exe
    if ($null -eq $attributes -or ($attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Directory))) { return }
    [void]$applications.Add($exe)
    $backend = [IO.Path]::Combine($Directory, 'backend')
    $attributes = Get-Attributes $backend
    if (!(($attributes -band [IO.FileAttributes]::Directory)) -or
        ($attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
    $node = [IO.Path]::Combine($backend, 'node.exe')
    $attributes = Get-Attributes $node
    if ($null -ne $attributes -and !(($attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Directory)))) {
        [void]$sidecars.Add($node)
    }
}

function Add-InstalledCandidates {
    $user = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,
        [Microsoft.Win32.RegistryView]::Registry32)
    try {
        $versions = $user.OpenSubKey($registryPath)
        if ($null -eq $versions) { return }
        try {
            foreach ($name in $versions.GetSubKeyNames()) {
                if ($name -notmatch "^$([Regex]::Escape($prefix))($versionPattern)$") { continue }
                $tag = $Matches[1]
                $folder = [IO.Path]::Combine($programs, "JianCang-Tauri-Candidate-$tag")
                $record = $versions.OpenSubKey($name)
                if ($null -eq $record) { continue }
                try {
                    $installed = $record.GetValue('InstallLocation')
                    if ($record.GetValue('DisplayVersion') -eq $tag -and $installed -is [string] -and
                        [string]::Equals($installed, $folder, [StringComparison]::OrdinalIgnoreCase)) {
                        Add-Candidate $folder
                    }
                } finally { $record.Dispose() }
            }
        } finally { $versions.Dispose() }
    } finally { $user.Dispose() }
}

function Test-OrdinaryFile([string]$Path) {
    $attributes = Get-Attributes $Path
    return $null -ne $attributes -and -not ($attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Directory))
}

function Add-InstalledLegacyApplications {
    $legacyRoot = [IO.Path]::Combine($programs, 'JianCang')
    try { Assert-OrdinaryDirectory $legacyRoot } catch { return }
    if (![IO.Directory]::Exists($legacyRoot)) { return }
    foreach ($folder in [IO.Directory]::EnumerateDirectories($legacyRoot, 'app-*')) {
        $name = [IO.Path]::GetFileName($folder)
        if ($name -notmatch "^app-$versionPattern$") { continue }
        try { Assert-OrdinaryDirectory $folder } catch { continue }
        $launcher = [IO.Path]::Combine($folder, '见藏.exe')
        if ((Test-OrdinaryFile $launcher) -and (Test-OrdinaryFile ([IO.Path]::Combine($folder, 'install-files.json'))) -and
            (Test-OrdinaryFile ([IO.Path]::Combine($folder, 'Install-JianCang.ps1')))) {
            [void]$legacyApplications.Add($launcher)
        }
    }
}

function Assert-ProductionRegistration {
    $user = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,
        [Microsoft.Win32.RegistryView]::Registry32)
    try {
        $record = $user.OpenSubKey("$registryPath\JianCang.WebView2")
        if ($null -eq $record) { throw '找不到见藏安装记录。' }
        try {
            $registered = $record.GetValue('InstallLocation')
            if ($record.GetValue('DisplayVersion') -ne $Version -or $registered -isnot [string] -or
                ![string]::Equals($registered, $target, [StringComparison]::OrdinalIgnoreCase)) {
                throw '卸载程序与当前见藏的安装记录不一致。'
            }
        } finally { $record.Dispose() }
    } finally { $user.Dispose() }
}

function Assert-ProductionUninstaller {
    Assert-ProductionRegistration
    $mode = [IO.Path]::Combine($target, 'backend', 'release-mode.json')
    if (!(Test-OrdinaryFile $mode) -or (Get-Item -LiteralPath $mode).Length -gt 4096 -or
        ([IO.File]::ReadAllText($mode, [Text.Encoding]::UTF8) | ConvertFrom-Json).production -cne $true) {
        throw '找不到有效的见藏安装标记。'
    }
}

function Remove-ProductionShortcuts {
    $launcher = [IO.Path]::Combine($target, 'jiancang-tauri.exe')
    $shell = New-Object -ComObject WScript.Shell
    foreach ($folder in @([Environment+SpecialFolder]::Programs, [Environment+SpecialFolder]::DesktopDirectory)) {
        $directory = [Environment]::GetFolderPath($folder)
        if (![IO.Path]::IsPathRooted($directory)) { continue }
        foreach ($name in @('见藏.lnk', '见藏（新版）.lnk', '见藏（WebView2）.lnk')) {
            $link = [IO.Path]::Combine($directory, $name)
            try {
                if (!(Test-OrdinaryFile $link) -or [IO.FileInfo]::new($link).Length -gt (1024 * 1024)) { continue }
                $item = $shell.CreateShortcut($link)
                if ([string]::Equals($item.TargetPath, $launcher, [StringComparison]::OrdinalIgnoreCase) -and !$item.Arguments) {
                    [IO.File]::Delete($link)
                }
            } catch { Write-Output '无法清理一个见藏快捷方式。' }
        }
    }
}

function Test-RunningCandidates([string]$Name, $Paths, [bool]$CloseWindow) {
    if ($Paths.Count -eq 0) { return $false }
    $running = $false
    foreach ($candidate in [Diagnostics.Process]::GetProcessesByName($Name)) {
        try {
            if ($candidate.SessionId -ne $session) { continue }
            $module = $candidate.MainModule
            if (!$Paths.Contains($module.FileName)) { continue }
            $running = $true
            if ($CloseWindow) {
                $start = "$($candidate.Id):$($candidate.StartTime.ToUniversalTime().Ticks)"
                if ($requested.Contains($start)) { continue }
                $versionInfo = $module.FileVersionInfo
                $runningVersion = [version]::new($versionInfo.FileMajorPart, $versionInfo.FileMinorPart, $versionInfo.FileBuildPart)
                if ($Name -eq 'jiancang-tauri' -and $runningVersion -ge [version]'0.36.38') {
                    # A tray-hidden app has no accessible MainWindowHandle.
                    # The matching executable forwards this explicit installer request to its live instance.
                    Start-Process -FilePath $module.FileName -ArgumentList '--jiancang-installation-exit'
                    [void]$requested.Add($start)
                } elseif ($candidate.CloseMainWindow()) {
                    [void]$requested.Add($start)
                }
            }
        } catch {
            # A process can exit during enumeration. Without its path, it must be left alone.
        } finally { $candidate.Dispose() }
    }
    return $running
}

Assert-InstallTree
if ($Operation -eq 'remove-shortcuts') {
    if (!$Production) { throw '快捷方式清理需要正式安装记录。' }
    Assert-ProductionRegistration
    Remove-ProductionShortcuts
    return
}
if ($Production -and $Operation -eq 'uninstall') { Assert-ProductionUninstaller }
Add-Candidate $target
if ($Operation -eq 'install') {
    Add-InstalledCandidates
    if ($Production) { Add-InstalledLegacyApplications }
}
$deadline = [Diagnostics.Stopwatch]::StartNew()
do {
    $windowRunning = Test-RunningCandidates 'jiancang-tauri' $applications $true
    $legacyRunning = Test-RunningCandidates '见藏' $legacyApplications $true
    $sidecarRunning = Test-RunningCandidates 'node' $sidecars $false
    if (!$windowRunning -and !$legacyRunning -and !$sidecarRunning) {
        Assert-InstallTree
        return
    }
    [Threading.Thread]::Sleep(200)
} while ($deadline.ElapsedMilliseconds -lt 35000)
throw 'The candidate did not close within 35 seconds.'
