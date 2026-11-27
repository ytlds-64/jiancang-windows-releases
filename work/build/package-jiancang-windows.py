#!/usr/bin/env python3
"""Build the 见藏 Windows package and signed update manifest from a pinned Electron release."""

import argparse
import hashlib
import gzip
import json
import lzma
import os
from pathlib import Path, PurePosixPath
import shutil
import struct
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile


REPOSITORY = Path(__file__).resolve().parents[2]
OUTPUTS = REPOSITORY / "outputs"
APP = OUTPUTS / "JianCangWindows"
RUNTIMES = Path(__file__).resolve().parent / "jiancang-electron"
ELECTRON_VERSION = "45.3.4"
RUNTIME_NAME = f"electron-v{ELECTRON_VERSION}-win32-x64.zip"
# Electron's SHASUMS256.txt and GitHub release asset digest agree.
# https://github.com/electron/electron/releases/tag/v45.3.4
RUNTIME_SHA256 = "b177908b5c48dad990612d7861fc8f03f8c06be0ca3351383a83cc11dd8e9144"
RUNTIME_URL = f"https://github.com/electron/electron/releases/download/v{ELECTRON_VERSION}/{RUNTIME_NAME}"
ICON_TOOLS = Path(__file__).resolve().parent / "jiancang-icon-tools"
ICON_DEPENDENCIES = (
    ("pe-library", "2.0.3", "a0e56f1c62c6e813458923c8936e57e36f23a2075708e41c73e536448c428dd1"),
    ("resedit", "3.1.1", "11bbe2a8b75f7f57f15eaa18af4c0bcb124c60a1b9b7672d2d4255944a4bd15e"),
)
ICON_SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)
MEDIA_CACHE = Path(__file__).resolve().parent / "jiancang-ffmpeg"
MEDIA_RELEASE = "autobuild-2026-11-18-12-39"
MEDIA_BUILD = "ffmpeg-n8.1.3-36-ge22a4510c9-win64-lgpl-shared-8.1"
MEDIA_ARCHIVE_HASH = "13a795e5620236ca4c304b580f0155130bdcecd87bf5e9f66f84b59d98783668"
MEDIA_REVISION = "e22a4510c982b048945052bd6a503475014b7ba0"
MEDIA_TAR_HASH = "9dd295385c3bd48bc4ab3fff93bfb48937b216efd65e589e676ea2856c187332"
MEDIA_RECIPE_HASH = "58bc35fb7fe5cb7aad9b2e872d5aa7b583b0e6494b3d3e81711fcee830ec0082"
MEDIA_PREFIX = "resources/app/vendor/media"
UPDATE_MANIFEST = "jiancang-windows-x64-update.json"
INSTALL_SCRIPT = "Install-JianCang.ps1"
PORTABLE_INSTALLER = "Install-JianCang.exe"
INSTALL_FOOTPRINT = "JianCang/install-files.json"
APP_FILES = (
    "package.json",
    "main.cjs",
    "batch-export.cjs",
    "live-photo.cjs",
    "preload.cjs",
    "reference-preload.cjs",
    "windows-update.cjs",
    "windows-update-network.cjs",
    "windows-updater.cjs",
    "update-trust.json",
    "library-worker.cjs",
    "library-watcher.cjs",
    "local-library.cjs",
    "image-dimensions.cjs",
    "local-backup.cjs",
    "cloud-original-queue.cjs",
    "cloud-original-process.cjs",
    "cloud-original-worker.cjs",
    "local-import-queue.cjs",
    "dropped-image.cjs",
    "local-workflow.cjs",
    "thumbnail-cache.cjs",
    "library-registry.cjs",
    "eagle-library.cjs",
    "eagle-local-api.cjs",
    "sync-library.cjs",
    "sync-writer.cjs",
    "sync-upload.cjs",
    "original-file.cjs",
    "asset-suggestions.cjs",
    "natural-image-search.cjs",
    "browser-capture.cjs",
    "browser-extension/manifest.json",
    "browser-extension/background.js",
    "browser-extension/collector.js",
    "browser-extension/options.html",
    "browser-extension/options.js",
    "browser-extension/options.css",
    "browser-extension/icon.png",
    "browser-extension/capture-audio.html",
    "browser-extension/capture-audio.js",
    "browser-extension/capture-success.wav",
    "asset-clipboard.cjs",
    "text-preview.cjs",
    "board-export.cjs",
    "visual-index.cjs",
    "visual-ocr-worker.cjs",
    "duplicate-review.cjs",
    "tag-actions.cjs",
    "folder-inbox.cjs",
    "offline-web.cjs",
    "structured-export.cjs",
    "video-markers.cjs",
    "video-trim.cjs",
    "ui/index.html",
    "ui/styles.css",
    "ui/asset-context-menu.js",
    "ui/asset-context-menu.css",
    "ui/renderer.js",
    "ui/windows-update.js",
    "ui/collection-order.js",
    "ui/collection-finder.js",
    "ui/asset-search.js",
    "ui/collection-finder.css",
    "ui/continuous-gallery.js",
    "ui/browse-workspace.js",
    "ui/preview-transition.js",
    "ui/image-comparison.js",
    "ui/image-comparison.css",
    "ui/asset-filters.js",
    "ui/asset-filters.css",
    "ui/local-organize.js",
    "ui/local-organize.css",
    "ui/local-import.js",
    "ui/local-import.css",
    "ui/project-boards.js",
    "ui/project-boards.css",
    "ui/asset-suggestions.js",
    "ui/asset-suggestions.css",
    "ui/natural-image-search.js",
    "ui/browser-capture.js",
    "ui/browser-capture.css",
    "ui/library-diagnostics.js",
    "ui/library-diagnostics.css",
    "ui/smart-collections.js",
    "ui/smart-tools.css",
    "ui/visual-tools.js",
    "ui/image-decoder.html",
    "ui/image-decoder.js",
    "ui/asset-list.css",
    "ui/duplicate-review.js",
    "ui/duplicate-review.css",
    "ui/tag-manager.js",
    "ui/tag-manager.css",
    "ui/folder-inbox.js",
    "ui/folder-inbox.css",
    "ui/offline-web.js",
    "ui/offline-web.css",
    "ui/offline-web-extract.js",
    "ui/structured-export.js",
    "ui/structured-export.css",
    "ui/image-tools.js",
    "ui/image-tools.css",
    "ui/image-conversion.js",
    "ui/local-backup.js",
    "ui/local-backup.css",
    "ui/storage-management.js",
    "ui/storage-management.css",
    "ui/cloud-originals.js",
    "ui/cloud-originals.css",
    "ui/sync-conflicts.js",
    "ui/sync-conflicts.css",
    "ui/reference.html",
    "ui/reference.js",
    "ui/reference.css",
    "ui/pdf-preview.js",
    "ui/pdf-preview.css",
    "ui/text-preview.js",
    "ui/text-preview.css",
    "ui/video-player.js",
    "ui/video-player.css",
    "ui/audio-player.css",
    "ui/video-trim.js",
    "ui/video-trim.css",
    "ui/icon.png",
    "vendor/media/NOTICE.md",
)
RENAMED_RUNTIME_FILES = {"electron.exe": "见藏.exe", "electron_wer.dll": "见藏_wer.dll"}
RUNTIME_LOCALES = {"locales/en-US.pak", "locales/en-GB.pak", "locales/zh-CN.pak", "locales/zh-TW.pak"}
REQUIRED_RUNTIME_FILES = {
    "electron.exe", "ffmpeg.dll", "icudtl.dat", "LICENSE", "LICENSES.chromium.html", *RUNTIME_LOCALES
}
MIB = 1024 * 1024


def verified_vendor_files(directory, feature):
    vendor = APP / 'vendor' / directory
    manifest = vendor / 'manifest.json'
    records = json.loads(manifest.read_text(encoding='utf-8'))['files']
    names = {'manifest.json'}
    for name, digest in records.items():
        relative = PurePosixPath(name)
        target = vendor / name
        if (relative.is_absolute() or relative.as_posix() != name or '..' in relative.parts or '\\' in name or ':' in name
                or name.casefold() in names or not target.is_file() or target.is_symlink()
                or not target.resolve().is_relative_to(vendor.resolve()) or file_hash(target) != digest):
            raise SystemExit(f'Invalid {feature} dependency: {name}.')
        names.add(name.casefold())
    return (f'vendor/{directory}/manifest.json', *(f'vendor/{directory}/{name}' for name in sorted(records)))


def app_files():
    return (*APP_FILES, *verified_vendor_files('ocr', 'offline OCR'), *verified_vendor_files('pdfjs', 'PDF preview'))


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(MIB), b""):
            digest.update(block)
    return digest.hexdigest()


def verified_runtime():
    RUNTIMES.mkdir(parents=True, exist_ok=True)
    archive = RUNTIMES / RUNTIME_NAME
    if not archive.exists():
        with tempfile.TemporaryDirectory(prefix="runtime-download-", dir=RUNTIMES) as workspace:
            candidate = Path(workspace) / RUNTIME_NAME
            with urllib.request.urlopen(RUNTIME_URL, timeout=90) as source, candidate.open("wb") as target:
                shutil.copyfileobj(source, target, MIB)
            if file_hash(candidate) != RUNTIME_SHA256:
                raise SystemExit(f"Unexpected SHA-256 for {RUNTIME_NAME}.")
            candidate.replace(archive)
        return archive
    if file_hash(archive) != RUNTIME_SHA256:
        raise SystemExit(f"The runtime archive at {archive} does not match its official SHA-256.")
    return archive


def verified_download(directory, name, url, digest):
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / name
    if not destination.exists():
        with tempfile.TemporaryDirectory(prefix="asset-download-", dir=directory) as workspace:
            candidate = Path(workspace) / name
            request = urllib.request.Request(url, headers={"User-Agent": "JianCang portable package builder"})
            with urllib.request.urlopen(request, timeout=120) as source, candidate.open("wb") as target:
                shutil.copyfileobj(source, target, MIB)
            if file_hash(candidate) != digest:
                raise SystemExit(f"Unexpected SHA-256 for {name}.")
            candidate.replace(destination)
    if file_hash(destination) != digest:
        raise SystemExit(f"The file at {destination} does not match its pinned SHA-256.")
    return destination


def media_archive():
    filename = f"{MEDIA_BUILD}.zip"
    return verified_download(MEDIA_CACHE, filename,
        f"https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/{MEDIA_RELEASE}/{filename}", MEDIA_ARCHIVE_HASH)


def verify_media_source(source):
    digest = hashlib.sha256()
    open_archive = lzma.open if source.suffix == ".xz" else gzip.open
    with open_archive(source, "rb") as archive:
        for block in iter(lambda: archive.read(MIB), b""):
            digest.update(block)
    if digest.hexdigest() != MEDIA_TAR_HASH:
        raise SystemExit("The FFmpeg source archive does not match the pinned source revision.")


def media_gzip_source(source):
    if not source.exists():
        with tempfile.TemporaryDirectory(prefix="media-source-", dir=MEDIA_CACHE) as workspace:
            checkout = Path(workspace) / "repo"
            subprocess.run(["git", "init", "-q", str(checkout)], check=True)
            subprocess.run(["git", "-C", str(checkout), "fetch", "--depth=1",
                "https://github.com/FFmpeg/FFmpeg.git", MEDIA_REVISION], check=True)
            candidate = Path(workspace) / source.name
            with candidate.open("wb") as archive:
                subprocess.run(["git", "-C", str(checkout), "archive", "--format=tar.gz",
                    f"--prefix=FFmpeg-{MEDIA_REVISION}/", MEDIA_REVISION], stdout=archive, check=True)
            verify_media_source(candidate)
            candidate.replace(source)
    verify_media_source(source)
    return source


def media_sources():
    source = MEDIA_CACHE / f"ffmpeg-{MEDIA_REVISION}-source.tar.xz"
    if not source.exists():
        original = media_gzip_source(source.with_suffix(".gz"))
        with tempfile.TemporaryDirectory(prefix="media-xz-", dir=MEDIA_CACHE) as workspace:
            candidate = Path(workspace) / source.name
            with gzip.open(original, "rb") as archive, lzma.open(candidate, "wb") as compressed:
                shutil.copyfileobj(archive, compressed, MIB)
            verify_media_source(candidate)
            candidate.replace(source)
    else:
        verify_media_source(source)
    recipe = verified_download(MEDIA_CACHE, "ffmpeg-builds-2026-11-18.tar.gz",
        f"https://codeload.github.com/FFmpeg-Builds/FFmpeg-Builds/tar.gz/refs/tags/{MEDIA_RELEASE}", MEDIA_RECIPE_HASH)
    return source, recipe


def media_entries(archive):
    files = {}
    for entry in archive.infolist():
        if entry.is_dir():
            continue
        full = PurePosixPath(entry.filename)
        if (full.is_absolute() or full.as_posix() != entry.filename or len(full.parts) < 2
                or ".." in full.parts or "\\" in entry.filename or ":" in entry.filename):
            raise SystemExit(f"Unexpected path in video engine archive: {entry.filename}.")
        relative = PurePosixPath(*full.parts[1:])
        name = relative.name
        if (relative.parent.as_posix() == "bin" and
                (name in {"ffmpeg.exe", "ffprobe.exe"} or name.lower().endswith(".dll"))):
            target = relative.as_posix()
        elif any("license" in part.lower() or "copying" in part.lower() for part in relative.parts):
            target = f"notices/{relative.as_posix()}"
        else:
            continue
        key = target.casefold()
        if key in files:
            raise SystemExit(f"Conflicting paths in video engine archive: {target}.")
        files[key] = (target, entry)
    required = {"bin/ffmpeg.exe", "bin/ffprobe.exe"}
    if not required.issubset(files) or not any(name.endswith(".dll") for name in files):
        raise SystemExit("The video engine archive is missing its executables or shared libraries.")
    return tuple(files.values())


def write_media(runtime, sources, output):
    for target, entry in media_entries(runtime):
        with runtime.open(entry) as source:
            write_stream(output, f"{MEDIA_PREFIX}/{target}", source, size=entry.file_size)
    for file in sources:
        with file.open("rb") as source:
            write_stream(output, f"{MEDIA_PREFIX}/source/{file.name}", source, size=file.stat().st_size)


def verify_windows_executable(executable):
    header = executable.read(64)
    if len(header) < 64 or header[:2] != b"MZ":
        raise SystemExit("Expected a Windows executable.")
    executable.seek(struct.unpack_from("<I", header, 0x3C)[0])
    if executable.read(6) != b"PE\x00\x00\x64\x86":
        raise SystemExit("Expected an x64 Windows executable.")


def verify_media(package, runtime, sources):
    for target, entry in media_entries(runtime):
        packaged = portable_entry(f"{MEDIA_PREFIX}/{target}")
        expected = package.getinfo(packaged)
        if (expected.CRC, expected.file_size) != (entry.CRC, entry.file_size):
            raise SystemExit(f"The package did not preserve {target}.")
        if target.startswith("bin/"):
            with package.open(packaged) as executable:
                verify_windows_executable(executable)
    for file in sources:
        with package.open(portable_entry(f"{MEDIA_PREFIX}/source/{file.name}")) as source:
            digest = hashlib.sha256()
            for block in iter(lambda: source.read(MIB), b""):
                digest.update(block)
            if digest.hexdigest() != file_hash(file):
                raise SystemExit(f"The package did not preserve {file.name}.")


def portable_entry(path):
    return f"JianCang/{path}"


def write_stream(output, path, source, *, size):
    info = zipfile.ZipInfo(portable_entry(path))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.file_size = size
    with output.open(info, "w") as target:
        shutil.copyfileobj(source, target, MIB)


def windows_icon(workspace):
    resize = shutil.which("sips")
    if not resize:
        raise SystemExit("The icon builder requires macOS sips to resize ui/icon.png.")
    directory = [struct.pack("<HHH", 0, 1, len(ICON_SIZES))]
    frames = []
    offset = 6 + 16 * len(ICON_SIZES)
    for size in ICON_SIZES:
        frame = workspace / f"icon-{size}.png"
        subprocess.run([resize, "-z", str(size), str(size), str(APP / "ui/icon.png"),
                        "--out", str(frame)], check=True, stdout=subprocess.DEVNULL)
        data = frame.read_bytes()
        if data[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" or struct.unpack_from(">II", data, 16) != (size, size):
            raise SystemExit(f"Invalid {size} px icon frame.")
        dimension = size % 256
        directory.append(struct.pack("<BBBBHHII", dimension, dimension, 0, 0, 1, 32, len(data), offset))
        frames.append(data)
        offset += len(data)
    icon = workspace / "jiancang.ico"
    icon.write_bytes(b"".join(directory + frames))
    return icon


def unpack_icon_dependencies(workspace):
    for package, version, digest in ICON_DEPENDENCIES:
        filename = f"{package}-{version}.tgz"
        archive = verified_download(ICON_TOOLS, filename, f"https://registry.npmjs.org/{package}/-/{filename}", digest)
        with tarfile.open(archive, "r:gz") as source:
            for entry in source.getmembers():
                if entry.isdir():
                    continue
                relative = PurePosixPath(entry.name)
                if (not entry.isfile() or relative.parts[:1] != ("package",) or len(relative.parts) < 2
                        or ".." in relative.parts or "\\" in entry.name or ":" in entry.name):
                    raise SystemExit(f"Unexpected member in the icon dependency {filename}.")
                destination = workspace / "node_modules" / package / Path(*relative.parts[1:])
                destination.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(entry) as contents, destination.open("xb") as output:
                    shutil.copyfileobj(contents, output)


def run_build_node(script, *args):
    node = shutil.which("node")
    environment = os.environ.copy()
    if not node:
        electron = RUNTIMES / "darwin-arm64/Electron.app/Contents/MacOS/Electron"
        if not electron.is_file():
            raise SystemExit("Node.js or the local Electron host runtime is needed to build the Windows package.")
        node = str(electron)
        environment["ELECTRON_RUN_AS_NODE"] = "1"
    subprocess.run([node, str(script), *(str(arg) for arg in args)], check=True, env=environment)


def brand_launcher(runtime_path, workspace):
    icon = windows_icon(workspace)
    unpack_icon_dependencies(workspace)
    source_exe = workspace / "electron.exe"
    with zipfile.ZipFile(runtime_path) as runtime, runtime.open("electron.exe") as original, source_exe.open("xb") as output:
        shutil.copyfileobj(original, output, MIB)
    script = workspace / "brand-jiancang-executable.mjs"
    shutil.copyfile(Path(__file__).with_name(script.name), script)
    branded_exe = workspace / "见藏.exe"
    run_build_node(script, source_exe, icon, branded_exe)
    return branded_exe


def packaged_runtime_entry(entry):
    name = entry.filename
    return (not entry.is_dir() and name != "resources/default_app.asar" and
            (not name.startswith("locales/") or name in RUNTIME_LOCALES))


def copy_runtime(runtime, output, branded_exe):
    runtime_names = set(runtime.namelist())
    if not REQUIRED_RUNTIME_FILES.issubset(runtime_names):
        raise SystemExit("The runtime archive is missing required files.")
    written = set()
    for entry in sorted(runtime.infolist(), key=lambda item: item.filename):
        if not packaged_runtime_entry(entry):
            continue
        name = RENAMED_RUNTIME_FILES.get(entry.filename, entry.filename)
        parts = PurePosixPath(name).parts
        if (not parts or name.startswith("/") or ".." in parts or "\\" in name or ":" in name
                or name.casefold() in written or parts[:2] == ("resources", "app")):
            raise SystemExit(f"Unexpected path in Electron archive: {entry.filename}.")
        written.add(name.casefold())
        if entry.filename == "electron.exe":
            with branded_exe.open("rb") as source:
                write_stream(output, name, source, size=branded_exe.stat().st_size)
            continue
        with runtime.open(entry) as source:
            write_stream(output, name, source, size=entry.file_size)


def write_app(output, files):
    for name in files:
        path = APP / name
        with path.open("rb") as source:
            write_stream(output, f"resources/app/{name}", source, size=path.stat().st_size)
    readme = APP / "README.md"
    with readme.open("rb") as source:
        write_stream(output, "README.md", source, size=readme.stat().st_size)


def installer_files():
    script = Path(__file__).with_name("jiancang-install.ps1").read_text(encoding="utf-8")
    script = script.replace("\n", "\r\n").encode("utf-8-sig")
    return {f"JianCang/{INSTALL_SCRIPT}": script}


def compile_installer(workspace, compiler, version, script, **defines):
    shutil.copyfile(Path(__file__).with_name("jiancang-setup.nsi"), workspace / "installer.nsi")
    env = os.environ.copy()
    nsis_share = compiler.parent.parent / "share/nsis"
    if (nsis_share / "Stubs").is_dir():
        env.setdefault("NSISDIR", str(nsis_share))
    subprocess.run([
        str(compiler), "-V3", "-WX", "-INPUTCHARSET", "UTF8", f"-DRELEASE_VERSION={version}",
        f"-DSCRIPT_SHA256={hashlib.sha256(script).hexdigest()}",
        *(f"-D{name}={value}" for name, value in defines.items()), "installer.nsi",
    ], cwd=workspace, env=env, check=True)


def portable_installer(workspace, compiler, version, script):
    compile_installer(workspace, compiler, version, script, PORTABLE_LAUNCHER=1)
    binary = (workspace / PORTABLE_INSTALLER).read_bytes()
    offset, = struct.unpack_from("<I", binary, 0x3C)
    subsystem, = struct.unpack_from("<H", binary, offset + 92)
    if binary[:2] != b"MZ" or binary[offset:offset + 4] != b"PE\0\0" or subsystem != 2:
        raise SystemExit("The ZIP installation launcher is not a Windows GUI executable.")
    return binary


def write_install_footprint(archive):
    with zipfile.ZipFile(archive, "a") as package:
        contents = []
        for entry in package.infolist():
            if entry.is_dir() or not entry.filename.startswith("JianCang/"):
                continue
            digest = hashlib.sha256()
            with package.open(entry) as source:
                for part in iter(lambda: source.read(MIB), b""):
                    digest.update(part)
            contents.append({"file": entry.filename.removeprefix("JianCang/"),
                             "size": entry.file_size, "sha256": digest.hexdigest()})
        package.writestr(INSTALL_FOOTPRINT, json.dumps(contents), compress_type=zipfile.ZIP_DEFLATED)


def check_portable_archive(archive, version, runtime_path, branded_exe, media, sources, files, setup_files):
    with zipfile.ZipFile(archive) as package, zipfile.ZipFile(runtime_path) as runtime, zipfile.ZipFile(media) as media_runtime:
        broken = package.testzip()
        if broken:
            raise SystemExit(f"The package failed ZIP integrity verification at {broken}.")
        launcher = portable_entry("见藏.exe")
        with package.open(launcher) as executable:
            launcher_hash = hashlib.sha256()
            for block in iter(lambda: executable.read(MIB), b""):
                launcher_hash.update(block)
            if launcher_hash.hexdigest() != file_hash(branded_exe):
                raise SystemExit("The package did not preserve the verified branded Windows executable.")
        for entry in runtime.infolist():
            if not packaged_runtime_entry(entry) or entry.filename == "electron.exe":
                continue
            name = RENAMED_RUNTIME_FILES.get(entry.filename, entry.filename)
            packed = package.getinfo(portable_entry(name))
            if (packed.file_size, packed.CRC) != (entry.file_size, entry.CRC):
                raise SystemExit(f"The package did not preserve Electron runtime file {name}.")
        locales = {name for name in package.namelist() if name.startswith(portable_entry("locales/"))}
        if locales != {portable_entry(name) for name in RUNTIME_LOCALES}:
            raise SystemExit("The package does not have the expected Chromium UI languages.")
        with package.open(launcher) as executable:
            verify_windows_executable(executable)
        verify_media(package, media_runtime, sources)
        for name in files:
            target = portable_entry(f"resources/app/{name}")
            if package.read(target) != (APP / name).read_bytes():
                raise SystemExit(f"The package did not preserve {name}.")
        for name, contents in setup_files.items():
            if package.read(name) != contents:
                raise SystemExit(f"The package did not preserve {name}.")
        footprint = json.loads(package.read(INSTALL_FOOTPRINT))
        if ({f"JianCang/{item['file']}" for item in footprint} !=
                {name for name in package.namelist() if name.startswith("JianCang/") and name != INSTALL_FOOTPRINT}):
            raise SystemExit("The package contains an incomplete installation file list.")
        metadata = json.loads(package.read(portable_entry("resources/app/package.json")))
        if metadata.get("version") != version or metadata.get("main") != "main.cjs":
            raise SystemExit("Unexpected packaged application version or entry point.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--makensis", default=shutil.which("makensis"),
                        help="Path to the NSIS MakeNSIS compiler, if it is not on PATH")
    parser.add_argument("--output-dir", type=Path, default=OUTPUTS,
                        help="Directory for the package and its signed manifest")
    args = parser.parse_args()
    if not args.makensis:
        parser.error("MakeNSIS is required. Pass --makensis or install NSIS.")
    compiler = Path(args.makensis).resolve(strict=True)
    metadata = json.loads((APP / "package.json").read_text(encoding="utf-8"))
    version = metadata["version"]
    if not isinstance(version, str) or len(version.split(".")) != 3 or not all(
        part.isascii() and part.isdecimal() for part in version.split(".")
    ):
        raise SystemExit("The Windows app version must be in major.minor.patch format.")
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / f"JianCang-Windows-{version}-x64.zip"
    if destination.exists():
        raise SystemExit(f"The release package already exists: {destination}.")
    signer = Path(__file__).with_name("jiancang-sign-update.cjs")
    run_build_node(signer)
    files = app_files()
    for name in (*files, "README.md"):
        path = APP / name
        if not path.is_file() or path.is_symlink():
            raise SystemExit(f"Missing or invalid app resource: {path}.")
    runtime_path = verified_runtime()
    media = media_archive()
    sources = media_sources()
    with tempfile.TemporaryDirectory(prefix=".jiancang-windows-", dir=output_dir) as workspace:
        workspace = Path(workspace)
        candidate = workspace / destination.name
        branded_exe = brand_launcher(runtime_path, workspace)
        setup_files = installer_files()
        setup_files[PORTABLE_INSTALLER] = portable_installer(workspace, compiler, version,
                                                            setup_files[f"JianCang/{INSTALL_SCRIPT}"])
        with zipfile.ZipFile(runtime_path) as source, zipfile.ZipFile(candidate, "x") as output:
            copy_runtime(source, output, branded_exe)
            write_app(output, files)
            with zipfile.ZipFile(media) as media_runtime:
                write_media(media_runtime, sources, output)
            for name, contents in setup_files.items():
                output.writestr(name, contents, compress_type=zipfile.ZIP_DEFLATED)
        write_install_footprint(candidate)
        check_portable_archive(candidate, version, runtime_path, branded_exe, media, sources, files, setup_files)
        run_build_node(signer, candidate, workspace)
        os.link(candidate, destination)
        os.replace(workspace / UPDATE_MANIFEST, output_dir / UPDATE_MANIFEST)
    print(f"{file_hash(destination)}  {destination}")


if __name__ == "__main__":
    main()
