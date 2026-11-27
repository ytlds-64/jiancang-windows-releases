param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [Parameter(Mandatory = $true)]
    [scriptblock]$CloseApplications
)

$ErrorActionPreference = 'Stop'
$versionPattern = '^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$'
if ($Version -notmatch $versionPattern) { throw '安装版本号无效。' }

$title = '见藏'
$shortcutNames = @("$title.lnk", "${title}（新版）.lnk")
$previousShortcutName = '见藏（WebView2）.lnk'
$receiptFile = 'backend/install-state.json'
$registryPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\JianCang.WebView2'
$local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if (![IO.Path]::IsPathRooted($local)) { throw '当前用户的安装目录不可用。' }
$programs = [IO.Path]::Combine($local, 'Programs')
$target = [IO.Path]::Combine($programs, 'JianCang-WebView2')
$source = [IO.Path]::Combine([Environment]::CurrentDirectory, 'production-payload')

function Get-PathAttributes([string]$Path) {
    try { return [IO.File]::GetAttributes($Path) }
    catch {
        $cause = $_.Exception.GetBaseException()
        if ($cause -is [IO.FileNotFoundException] -or $cause -is [IO.DirectoryNotFoundException]) { return $null }
        throw
    }
}

function Assert-Directory([string]$Path) {
    $attributes = Get-PathAttributes $Path
    if ($null -ne $attributes -and (!(($attributes -band [IO.FileAttributes]::Directory)) -or
        ($attributes -band [IO.FileAttributes]::ReparsePoint))) {
        throw '安装目录不可用或已重定向。'
    }
}

function Get-PayloadPath([string]$Root, [string]$Relative) {
    $path = $Root
    foreach ($segment in $Relative.Split('/')) {
        if (!$segment -or $segment -match '[<>:"\\|?*\x00-\x1f]' -or
            $segment.Trim() -ne $segment -or $segment.EndsWith('.')) {
            throw '安装清单中的文件名无效。'
        }
        $path = [IO.Path]::Combine($path, $segment)
        if ((Get-PathAttributes $path) -band [IO.FileAttributes]::ReparsePoint) { throw '安装文件已重定向。' }
    }
    return $path
}

function Read-PayloadJson([string]$Root, [string]$Relative, [long]$Limit) {
    $file = Get-PayloadPath $Root $Relative
    $info = [IO.FileInfo]::new($file)
    if (!$info.Exists -or $info.Length -lt 1 -or $info.Length -gt $Limit) { throw '找不到有效的见藏安装记录。' }
    return ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($file, [Text.Encoding]::UTF8))
}

function Read-InstalledPayload([string]$Root) {
    Assert-Directory $Root
    $mode = Read-PayloadJson $Root 'backend/release-mode.json' 4096
    $record = Read-PayloadJson $Root $receiptFile (1024 * 1024)
    if ($mode.production -isnot [bool] -or !$mode.production -or $record.format -ne 1 -or
        $record.version -isnot [string] -or $record.version -notmatch $versionPattern -or
        $record.files -isnot [array] -or $record.files.Length -gt 15000) {
        throw '无法确认这份见藏安装。'
    }
    $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($relative in $record.files) {
        if ($relative -isnot [string] -or $relative.Length -gt 4096 -or !$paths.Add($relative)) {
            throw '安装文件清单无效。'
        }
        [void](Get-PayloadPath $Root $relative)
    }
    foreach ($required in @('jiancang-tauri.exe', 'Uninstall.exe', 'backend/node.exe', 'backend/release-mode.json', $receiptFile)) {
        if (!$paths.Contains($required)) { throw '安装文件清单不完整。' }
    }
    return $record
}

function Commit-ProgramDirectory([string]$Stage, [string]$Target, [string]$Rollback) {
    $previousMoved = $false
    try {
        if ([IO.Directory]::Exists($Target)) {
            [IO.Directory]::Move($Target, $Rollback)
            $previousMoved = $true
        }
        [IO.Directory]::Move($Stage, $Target)
    } catch {
        if ($previousMoved) {
            try { [IO.Directory]::Move($Rollback, $Target) }
            catch { throw "旧版程序已保存在 $Rollback。请关闭正在运行的见藏后再恢复。" }
        }
        throw
    }
}

function Remove-PreviousProgram([string]$Directory, $Previous) {
    if (!$Previous -or ![IO.Directory]::Exists($Directory)) { return }
    $parents = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($relative in $Previous.files) {
        try {
            $file = Get-PayloadPath $Directory $relative
            $parent = [IO.Path]::GetDirectoryName($file)
            while ($parent -ne $Directory) { [void]$parents.Add($parent); $parent = [IO.Path]::GetDirectoryName($parent) }
            [IO.File]::Delete($file)
        } catch { }
    }
    foreach ($folder in ($parents | Sort-Object Length -Descending)) {
        try { [IO.Directory]::Delete($folder) } catch { }
    }
    try { [IO.Directory]::Delete($Directory) }
    catch { Write-Output "旧安装目录中的附加文件已保存在 $Directory。" }
}

function Test-LauncherShortcut($Shell, [string]$Link) {
    $attributes = Get-PathAttributes $Link
    if ($null -eq $attributes -or $attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Directory) -or
        [IO.FileInfo]::new($Link).Length -gt (1024 * 1024)) { return $false }
    try {
        $item = $Shell.CreateShortcut($Link)
        return [string]::Equals($item.TargetPath, $launcher, [StringComparison]::OrdinalIgnoreCase) -and !$item.Arguments
    } catch { return $false }
}

function Find-LauncherShortcut($Shell, [string]$Directory) {
    foreach ($name in $shortcutNames) {
        $link = [IO.Path]::Combine($Directory, $name)
        if ($null -eq (Get-PathAttributes $link) -or (Test-LauncherShortcut $Shell $link)) { return $link }
    }
}

Assert-Directory $local
Assert-Directory $programs
Assert-Directory $target
$incoming = Read-InstalledPayload $source
if ($incoming.version -cne $Version) { throw '安装文件的版本与安装程序不一致。' }
$previous = if ([IO.Directory]::Exists($target)) { Read-InstalledPayload $target }
if ($previous -and [version]$previous.version -gt [version]$Version) { exit 4 }

$registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,
    [Microsoft.Win32.RegistryView]::Registry32)
$launcher = [IO.Path]::Combine($target, 'jiancang-tauri.exe')
$uninstall = [IO.Path]::Combine($target, 'Uninstall.exe')
$properties = @{ DisplayName = $title; DisplayVersion = $Version; DisplayIcon = $launcher; InstallLocation = $target;
    UninstallString = '"' + $uninstall + '"'; NoModify = 1; NoRepair = 1 }
$previousRegistry = @{}
$record = $registry.OpenSubKey($registryPath)
try {
    if ($record) {
        $existingLocation = $record.GetValue('InstallLocation')
        if ($existingLocation -isnot [string] -or ![string]::Equals($existingLocation, $target, [StringComparison]::OrdinalIgnoreCase)) {
            throw '现有见藏的安装记录指向其他目录。'
        }
        $existingVersion = $record.GetValue('DisplayVersion')
        if ($existingVersion -match $versionPattern -and [version]$existingVersion -gt [version]$Version) { exit 4 }
        foreach ($name in $properties.Keys) {
            if ($record.GetValueNames() -contains $name) {
                $previousRegistry[$name] = @{ Value = $record.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);
                    Kind = $record.GetValueKind($name) }
            }
        }
    }
} finally { if ($record) { $record.Dispose() } }
$hadRegistration = $null -ne $record

$shortcutDirectories = foreach ($folder in @([Environment+SpecialFolder]::Programs, [Environment+SpecialFolder]::DesktopDirectory)) {
    $directory = [Environment]::GetFolderPath($folder, [Environment+SpecialFolderOption]::Create)
    if (![IO.Path]::IsPathRooted($directory)) { throw '桌面或开始菜单目录不可用。' }
    $directory
}

$token = [Guid]::NewGuid().ToString('N')
$stage = [IO.Path]::Combine($programs, ".jc-stage-$token")
$rollback = [IO.Path]::Combine($programs, ".jc-previous-$token")
try {
    [void][IO.Directory]::CreateDirectory($stage)
    foreach ($relative in $incoming.files) {
        $inputFile = Get-PayloadPath $source $relative
        $outputFile = Get-PayloadPath $stage $relative
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($outputFile))
        [IO.File]::Copy($inputFile, $outputFile, $false)
    }
    & $CloseApplications $Version 'install' -Production

    $createdLinks = [Collections.Generic.List[string]]::new()
    $retiredLinks = [Collections.Generic.List[string]]::new()
    try {
        $key = $registry.CreateSubKey($registryPath)
        try {
            foreach ($name in $properties.Keys) { $key.SetValue($name, $properties[$name]) }
        } finally { $key.Dispose() }
        $shell = New-Object -ComObject WScript.Shell
        foreach ($directory in $shortcutDirectories) {
            $link = Find-LauncherShortcut $shell $directory
            if (!$link) {
                Write-Output '已有同名快捷方式，请从另一处快捷方式或安装位置启动见藏。'
                continue
            }
            if (!(Test-LauncherShortcut $shell $link)) {
                $stagedLink = [IO.Path]::Combine($directory, ".jc-shortcut-$token.lnk")
                try {
                    $item = $shell.CreateShortcut($stagedLink)
                    $item.TargetPath = $launcher
                    $item.WorkingDirectory = $target
                    $item.IconLocation = "$launcher,0"
                    $item.Save()
                    # File.Move does not replace a shortcut created by another installer in the meantime.
                    [IO.File]::Move($stagedLink, $link)
                    $createdLinks.Add($link)
                } finally {
                    try { [IO.File]::Delete($stagedLink) } catch { }
                }
            }
            foreach ($name in @($shortcutNames[1], $previousShortcutName)) {
                $retired = [IO.Path]::Combine($directory, $name)
                if ($retired -ne $link) { $retiredLinks.Add($retired) }
            }
        }
        Commit-ProgramDirectory $stage $target $rollback
    } catch {
        $failure = $_
        try {
            if (!$hadRegistration) { $registry.DeleteSubKeyTree($registryPath, $false) }
            else {
                $key = $registry.CreateSubKey($registryPath)
                try {
                    foreach ($name in $properties.Keys) {
                        if ($previousRegistry.ContainsKey($name)) {
                            $value = $previousRegistry[$name]
                            $key.SetValue($name, $value.Value, $value.Kind)
                        } else { $key.DeleteValue($name, $false) }
                    }
                } finally { $key.Dispose() }
            }
        } catch { Write-Output '无法恢复部分安装记录。' }
        foreach ($link in $createdLinks) {
            try {
                if (Test-LauncherShortcut $shell $link) { [IO.File]::Delete($link) }
            } catch { Write-Output '无法恢复部分快捷方式。' }
        }
        throw $failure
    }
    foreach ($link in $retiredLinks) {
        try {
            if (Test-LauncherShortcut $shell $link) { [IO.File]::Delete($link) }
        } catch { Write-Output '无法清理部分旧快捷方式。' }
    }
    Remove-PreviousProgram $rollback $previous
} finally {
    if ([IO.Directory]::Exists($stage)) { try { [IO.Directory]::Delete($stage, $true) } catch { } }
    $registry.Dispose()
}
