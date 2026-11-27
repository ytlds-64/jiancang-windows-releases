# 见藏 Windows

当前正式版为 **0.36.43**。

- [最新正式版和更新记录](https://github.com/ytlds-64/jiancang-windows-releases/releases/latest)
- [下载 Windows x64 安装包](https://github.com/ytlds-64/jiancang-windows-releases/releases/download/tauri-windows-x64/JianCang-Windows-0.36.43-x64-Setup.exe)
- [下载 0.36.43 源码 ZIP](https://github.com/ytlds-64/jiancang-windows-releases/releases/download/tauri-windows-x64/JianCang-Windows-0.36.43-Source.zip)

## 0.36.43 源码

此归档包含 Windows x64 WebView2 版的 Tauri 2 桌面端、共用界面和 Node.js 素材服务、Edge / Chrome 采集插件 1.4.0、构建与安装打包脚本和自动化测试。

- 桌面端和共用模块位于 `outputs/JianCangWindows/`。
- Tauri 构建说明见 [`outputs/JianCangWindows/tauri/README.md`](outputs/JianCangWindows/tauri/README.md)。版本号取自 `tauri/src-tauri/tauri.conf.json`。同级 `package.json` 记录 Electron 构建版本。
- 浏览器插件源码位于 `outputs/JianCangWindows/browser-extension/`，可在 Edge 或 Chrome 的扩展管理页加载此目录。
- 解压时保留目录结构。构建脚本从 `work/build/` 读取 FFmpeg 依赖定义和更新签名工具。归档带有通过清单核验的离线 OCR 与 PDF 预览依赖，以及随附许可证。首次构建需要获取 Node.js Windows x64 运行时、依赖和构建工具。发布签名需要由维护者另行提供项目 Ed25519 私钥。

## Windows x64 构建

安装 Rust MSVC 工具链、Visual Studio C++ Build Tools、Node.js 24、Python 3 和 Git，下载 Node.js 官方 `node-v24.22.3-win-x64.zip`。安装版还需要 NSIS。

```powershell
Set-Location .\outputs\JianCangWindows\tauri
.\Build-Windows.ps1 -Production -NodeArchive C:\Downloads\node-v24.22.3-win-x64.zip -MakeNsis 'C:\Program Files (x86)\NSIS\makensis.exe'
```

从 `outputs/JianCangWindows/` 使用 Node.js 24 运行回归测试。

```powershell
node --test tests/*.test.cjs tauri/backend/*.test.cjs
```
