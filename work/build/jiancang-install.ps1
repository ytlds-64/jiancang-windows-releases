param(
    [string]$Archive,
    [string]$SourceDirectory = $PSScriptRoot,
    [string]$ExpectedVersion,
    [string]$ExpectedSha256,
    [string]$ExpectedListSha256,
    [int]$WaitPid,
    [switch]$ShowCompletion,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'Programs\JianCang'
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs', 'Create')) '见藏.lnk'
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\JianCang'
$powershell = Join-Path $PSHOME 'powershell.exe'
$name = '见藏'
$desktopShortcutDescription = '见藏桌面快捷方式'
$versionPattern = '^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$'
$fileList = 'install-files.json'
$stage = $null
$lock = $null
$installedTarget = $null
$code = 0

function Get-InstalledFolders {
    Get-ChildItem -LiteralPath $root -Directory | Where-Object {
        $_.Name.StartsWith('app-') -and $_.Name.Substring(4) -match $versionPattern -and
            -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
    }
}

function Get-InstalledAppProcesses {
    $paths = @(Get-InstalledFolders | ForEach-Object { Join-Path $_.FullName '见藏.exe' })
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object {
        $_.SessionId -eq $session -and $paths -contains $_.Path
    }
}

function Ensure-AppClosed {
    $closing = [Diagnostics.Stopwatch]::StartNew()
    if ($WaitPid) {
        $previous = Get-Process -Id $WaitPid -ErrorAction SilentlyContinue
        if ($previous -and $previous.ProcessName -eq $name -and -not $previous.WaitForExit(45000)) {
            throw '见藏还在运行。请退出后重新安装。'
        }
    }
    if (!$Uninstall) {
        $installedApps = @(Get-InstalledAppProcesses)
        foreach ($process in $installedApps) {
            try { [void]$process.CloseMainWindow() }
            catch { if (!$process.HasExited) { throw '无法请求旧版见藏关闭，请先从见藏窗口退出后重试。' } }
        }
        foreach ($process in $installedApps) {
            $remaining = [Math]::Max(0, 45000 - [int]$closing.ElapsedMilliseconds)
            if (!$process.WaitForExit($remaining)) {
                throw '旧版见藏没有在等待时间内退出，请先处理旧窗口中的任务后重试。'
            }
        }
    }
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    if (Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session }) {
        throw '检测到见藏仍在运行，请关闭其余见藏窗口后重试。'
    }
}

function Get-PackagePath($directory, $relative) {
    $segments = $relative -split '/'
    $target = $directory
    foreach ($segment in $segments) {
        if ($segment -match '[:\\]' -or $segment.Trim() -ne $segment -or $segment.EndsWith('.') -or
            $segment.Length -eq 0) { throw '安装清单包含无效路径。' }
        $target = Join-Path $target $segment
        if (Test-Path -LiteralPath $target) {
            if ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw '安装文件经过重定向。'
            }
        }
    }
    return $target
}

function Read-FileList($directory) {
    $index = Get-PackagePath $directory $fileList
    return (Get-Content -LiteralPath $index -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Get-StreamSha256([IO.Stream]$stream) {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '') }
    finally { $sha256.Dispose() }
}

function Get-FileSha256([string]$path) {
    $stream = [IO.File]::OpenRead($path)
    try { return Get-StreamSha256 $stream }
    finally { $stream.Dispose() }
}

function Copy-ProgramFiles($source, $destination) {
    $contents = [IO.File]::ReadAllBytes((Get-PackagePath $source $fileList))
    if ($ExpectedListSha256) {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try { $digest = [BitConverter]::ToString($sha256.ComputeHash($contents)).Replace('-', '') }
        finally { $sha256.Dispose() }
        if ($digest -ne $ExpectedListSha256) { throw '安装文件清单校验失败。' }
    }
    $entries = [Text.Encoding]::UTF8.GetString($contents).TrimStart([char]0xFEFF) | ConvertFrom-Json
    foreach ($entry in $entries) {
        $file = Get-PackagePath $source $entry.file
        $target = Get-PackagePath $destination $entry.file
        New-Item -Path ([IO.Path]::GetDirectoryName($target)) -ItemType Directory -Force | Out-Null
        Copy-Item -LiteralPath $file -Destination $target
        if ((Get-Item -LiteralPath $target).Length -ne $entry.size -or
            (Get-FileSha256 $target) -ne $entry.sha256) {
            throw '安装文件与清单不一致，请重新解压安装包。'
        }
    }
    [IO.File]::WriteAllBytes((Join-Path $destination $fileList), $contents)
}

function Remove-ProgramFiles($directory) {
    $folders = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    try { $entries = @(Read-FileList $directory) }
    catch { return }
    foreach ($entry in $entries) {
        try {
            $file = Get-PackagePath $directory $entry.file
            $parent = [IO.Path]::GetDirectoryName($file)
            while ($parent -ne $directory) { [void]$folders.Add($parent); $parent = [IO.Path]::GetDirectoryName($parent) }
            if (Test-Path -LiteralPath $file -PathType Leaf) {
                $item = Get-Item -LiteralPath $file -Force
                if ($item.Length -eq $entry.size -and (Get-FileSha256 $file) -eq $entry.sha256) {
                    Remove-Item -LiteralPath $file -Force
                }
            }
        } catch {}
    }
    foreach ($folder in ($folders | Sort-Object Length -Descending)) {
        if ([IO.Directory]::Exists($folder) -and [IO.Directory]::GetFileSystemEntries($folder).Length -eq 0) {
            [IO.Directory]::Delete($folder)
        }
    }
    if ([IO.Directory]::GetFileSystemEntries($directory).Length -eq 1 -and
        (Test-Path -LiteralPath (Join-Path $directory $fileList) -PathType Leaf)) {
        Remove-Item -LiteralPath (Join-Path $directory $fileList) -Force
        [IO.Directory]::Delete($directory)
    }
}

function Write-UninstallEntry($target, $version) {
    $executable = Join-Path $target '见藏.exe'
    $script = Join-Path $target 'Install-JianCang.ps1'
    $command = '"{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}" -Uninstall' -f $powershell, $script
    New-Item -Path $registry -Force | Out-Null
    foreach ($entry in @{DisplayName=$name; DisplayVersion=$version; DisplayIcon=$executable;
                        InstallLocation=$target; UninstallString=$command}.GetEnumerator()) {
        New-ItemProperty -Path $registry -Name $entry.Key -Value $entry.Value -PropertyType String -Force | Out-Null
    }
    foreach ($entry in 'NoModify','NoRepair') {
        New-ItemProperty -Path $registry -Name $entry -Value 1 -PropertyType DWord -Force | Out-Null
    }
}

function Set-ShortcutTarget($link, $target) {
    $link.TargetPath = Join-Path $target '见藏.exe'
    $link.WorkingDirectory = $target
    $link.IconLocation = $link.TargetPath
    $link.Save()
}

function Write-StartShortcut($target) {
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
    Set-ShortcutTarget $link $target
}

function Test-DesktopShortcutOwner($link) {
    if ($link.Description -ne $desktopShortcutDescription -or
        [IO.Path]::GetFileName($link.TargetPath) -ne '见藏.exe') { return $false }
    $directory = [IO.Path]::GetDirectoryName($link.TargetPath)
    if (-not $directory -or [IO.Path]::GetDirectoryName($directory) -ne $root) { return $false }
    $folder = [IO.Path]::GetFileName($directory)
    return $folder.StartsWith('app-') -and $folder.Substring(4) -match $versionPattern
}

function Update-DesktopShortcut($target) {
    try {
        $option = if ($target) { 'Create' } else { 'None' }
        $desktop = [Environment]::GetFolderPath('DesktopDirectory', $option)
        if (-not $desktop) {
            if ($target) { Write-Warning '未找到桌面文件夹，无法创建快捷方式。' }
            return
        }
        $shell = New-Object -ComObject WScript.Shell
        $freePath = $null
        foreach ($filename in '见藏.lnk', '见藏（Windows）.lnk') {
            $candidate = Join-Path $desktop $filename
            $item = Get-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
            if (-not $item) {
                if (-not $freePath) { $freePath = $candidate }
                continue
            }
            if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
            try {
                $link = $shell.CreateShortcut($candidate)
                if (-not (Test-DesktopShortcutOwner $link)) { continue }
            } catch { continue }
            if ($target) {
                Set-ShortcutTarget $link $target
                return
            }
            Remove-Item -LiteralPath $candidate -Force
        }
        if (-not $target) { return }
        if (-not $freePath) {
            Write-Warning '桌面已存在同名项目，无法创建见藏快捷方式。'
            return
        }
        $link = $shell.CreateShortcut($freePath)
        $link.Description = $desktopShortcutDescription
        Set-ShortcutTarget $link $target
    } catch {
        Write-Warning '无法更新见藏桌面快捷方式。'
    }
}

function Show-InstallComplete($target) {
    Add-Type -AssemblyName System.Windows.Forms
    $form = New-Object Windows.Forms.Form -Property @{
        Text = '见藏安装'; ClientSize = [Drawing.Size]::new(380, 135)
        StartPosition = 'CenterScreen'; FormBorderStyle = 'FixedDialog'
        AutoScaleMode = 'Dpi'; MaximizeBox = $false; MinimizeBox = $false; TopMost = $true
    }
    try {
        $message = New-Object Windows.Forms.Label -Property @{
            Text = '见藏已安装。'; Location = [Drawing.Point]::new(20, 20); AutoSize = $true
        }
        $launch = New-Object Windows.Forms.CheckBox -Property @{
            Text = '启动见藏'; Location = [Drawing.Point]::new(20, 51); AutoSize = $true; Checked = $true
        }
        $finish = New-Object Windows.Forms.Button -Property @{
            Text = '完成'; Location = [Drawing.Point]::new(280, 86)
            Size = [Drawing.Size]::new(80, 28); DialogResult = 'OK'
        }
        $form.Controls.AddRange(@($message, $launch, $finish))
        $form.AcceptButton = $finish
        if ($form.ShowDialog() -eq [Windows.Forms.DialogResult]::OK -and $launch.Checked) {
            $application = New-Object -ComObject Shell.Application
            $application.ShellExecute((Join-Path $target '见藏.exe'), '', $target, 'open', 1)
        }
    } finally { $form.Dispose() }
}

try {
    if (-not [Environment]::Is64BitOperatingSystem) { throw '此安装包需要 64 位 Windows。' }
    New-Item -Path $root -ItemType Directory -Force | Out-Null
    if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw '安装目录是一个重定向位置，无法确认覆盖范围。'
    }
    $lock = [IO.File]::Open((Join-Path $root 'install.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    if ($Uninstall) {
        Ensure-AppClosed
        [Environment]::CurrentDirectory = [IO.Path]::GetTempPath()
        if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force }
        Update-DesktopShortcut
        foreach ($folder in (Get-InstalledFolders)) { Remove-ProgramFiles $folder.FullName }
        if (Test-Path -LiteralPath $registry) { Remove-Item -LiteralPath $registry -Force }
    } else {
        $stage = Join-Path $root ('.install-' + [guid]::NewGuid().ToString('N'))
        New-Item -Path $stage -ItemType Directory | Out-Null
        $payload = Join-Path $stage 'JianCang'
        if ($Archive) {
            if ($ExpectedVersion -notmatch $versionPattern -or $ExpectedSha256 -notmatch '^[0-9a-f]{64}$') {
                throw '更新包缺少校验信息。'
            }
            Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
            $file = [IO.File]::Open($Archive, 'Open', 'Read', 'Read')
            try {
                if ((Get-StreamSha256 $file) -ne $ExpectedSha256) {
                    throw '更新包在安装前校验失败。'
                }
                $file.Position = 0
                $zip = [IO.Compression.ZipArchive]::new($file, [IO.Compression.ZipArchiveMode]::Read, $true)
                try { [IO.Compression.ZipFileExtensions]::ExtractToDirectory($zip, $stage) }
                finally { $zip.Dispose() }
            } finally { $file.Dispose() }
        } else {
            Copy-ProgramFiles $SourceDirectory $payload
        }
        $metadata = Get-Content -LiteralPath (Join-Path $payload 'resources\app\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $version = $metadata.version
        if ($metadata.name -ne 'jiancang-windows' -or $version -notmatch $versionPattern -or
            ($ExpectedVersion -and $version -ne $ExpectedVersion) -or
            -not (Test-Path -LiteralPath (Join-Path $payload '见藏.exe') -PathType Leaf) -or
            -not (Test-Path -LiteralPath (Join-Path $payload 'Install-JianCang.ps1') -PathType Leaf)) {
            throw '此文件夹缺少有效的见藏安装文件。'
        }
        $record = Get-ItemProperty -LiteralPath $registry -ErrorAction SilentlyContinue
        $installed = $record.DisplayVersion
        if ($installed -match $versionPattern -and ([version]$installed) -gt ([version]$version)) {
            throw 'Windows 已安装较新的见藏版本。'
        }
        Ensure-AppClosed
        $target = Join-Path $root ('app-' + $version)
        if (Test-Path -LiteralPath $target) {
            $launcher = Get-PackagePath $root ('app-' + $version + '/见藏.exe')
            $known = @(Read-FileList $payload)
            $expectedLauncher = @($known | Where-Object { $_.file -eq '见藏.exe' })
            $currentMetadata = Get-PackagePath $root ('app-' + $version + '/resources/app/package.json')
            $expectedMetadata = @($known | Where-Object { $_.file -eq 'resources/app/package.json' })
            if (-not (Test-Path -LiteralPath $launcher -PathType Leaf) -or $expectedLauncher.Count -ne 1 -or
                (Get-FileSha256 $launcher) -ne $expectedLauncher[0].sha256 -or
                -not (Test-Path -LiteralPath $currentMetadata -PathType Leaf) -or $expectedMetadata.Count -ne 1 -or
                (Get-FileSha256 $currentMetadata) -ne $expectedMetadata[0].sha256) {
                throw '目标目录已存在，但无法确认其中的见藏版本。请选择较新的安装包。'
            }
        } else { [IO.Directory]::Move($payload, $target) }
        Write-UninstallEntry $target $version
        Write-StartShortcut $target
        Update-DesktopShortcut $target
        $installedTarget = $target
        $pendingCleanup = Get-InstalledFolders | Where-Object { $_.Name -ne ('app-' + $version) } |
            Sort-Object { [version]$_.Name.Substring(4) } -Descending | Select-Object -Skip 1
        foreach ($folder in $pendingCleanup) {
            try { Remove-ProgramFiles $folder.FullName } catch {}
        }
    }
} catch {
    $code = 1
    $message = $_.Exception.Message
    Write-Host $message
    try { (New-Object -ComObject WScript.Shell).Popup($message, 0, '见藏安装', 16) | Out-Null } catch {}
} finally {
    if ($stage -and (Test-Path -LiteralPath $stage)) {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($lock) { $lock.Dispose() }
    if ($Archive -and $ExpectedVersion) {
        # The updater stages archives under the app profile for this process only.
        $downloadRoot = Join-Path $env:APPDATA '见藏\windows-updates'
        $expectedLeaf = 'JianCang-Windows-' + $ExpectedVersion + '-x64.zip'
        if ([IO.Path]::GetFileName($Archive) -eq $expectedLeaf -and
            [IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($Archive)) -eq $downloadRoot) {
            Remove-Item -LiteralPath $Archive -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath ([IO.Path]::GetDirectoryName($Archive)) -Force -ErrorAction SilentlyContinue
        }
    }
}
if ($code -eq 0 -and $ShowCompletion -and $installedTarget) {
    try { Show-InstallComplete $installedTarget }
    catch {
        try {
            (New-Object -ComObject WScript.Shell).Popup('见藏已安装。请从桌面快捷方式或开始菜单打开。', 0, '见藏安装', 48) | Out-Null
        } catch {}
    }
}
exit $code
