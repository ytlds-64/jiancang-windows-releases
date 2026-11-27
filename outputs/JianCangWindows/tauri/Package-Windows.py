#!/usr/bin/env python3
"""Package built Windows x64 Tauri files as preview or WebView2 production."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile


SOURCE = Path(__file__).resolve().parent
APP = "jiancang-tauri.exe"
INSTALLER = "Local-Setup.exe"
APP_ID = "com.jiancang.desktop.tauri"
MSVC_X64 = 0x8664
PE32_PLUS = 0x20B
WINDOWS_GUI = 2
WINDOWS_CONSOLE = 3


def pe_info(path):
    with path.open("rb") as handle:
        dos = handle.read(64)
        if len(dos) != 64 or dos[:2] != b"MZ":
            raise ValueError(f"Expected a Windows executable: {path}")
        handle.seek(struct.unpack_from("<I", dos, 60)[0])
        header = handle.read(94)
    if len(header) != 94 or header[:4] != b"PE\0\0":
        raise ValueError(f"Missing Windows PE headers: {path}")
    machine = struct.unpack_from("<H", header, 4)[0]
    magic = struct.unpack_from("<H", header, 24)[0]
    subsystem = struct.unpack_from("<H", header, 92)[0]
    return machine, magic, subsystem


def copy_backend(source, dest):
    if source.is_symlink() or not source.is_dir():
        raise ValueError(f"Expected the generated backend directory: {source}")
    seen = set()
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        key = relative.as_posix().casefold()
        if path.is_symlink() or key in seen:
            raise ValueError(f"Unsupported backend entry: {relative}")
        if any(re.search(r'[<>:"/\\|?*\x00-\x1f]', part) or part.endswith((" ", ".")) for part in relative.parts):
            raise ValueError(f"Invalid Windows filename: {relative}")
        seen.add(key)
        target = dest / relative
        if path.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        elif path.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
        else:
            raise ValueError(f"Unsupported backend entry: {relative}")


def compile_setup(compiler, directory, payload, version, production=False):
    shutil.copyfile(SOURCE / "Candidate-Setup.nsi", directory / "installer.nsi")
    shutil.copyfile(SOURCE / "src-tauri" / "icons" / "icon.ico", directory / "installer.ico")
    close_script = directory / "Close-Candidate.ps1"
    shutil.copyfile(SOURCE / close_script.name, close_script)
    install_script = directory / "Install-Production.ps1"
    if production:
        shutil.copyfile(SOURCE / install_script.name, install_script)
        receipt = payload / "backend" / "install-state.json"
        files = [file.relative_to(payload).as_posix() for file in sorted(payload.rglob("*")) if file.is_file()]
        files.extend(["Uninstall.exe", receipt.relative_to(payload).as_posix()])
        receipt.write_text(json.dumps({"format": 1, "version": version, "files": files}, ensure_ascii=False) + "\n", encoding="utf-8")
    # Use exact file names when uninstalling, leaving any extra files in place.
    uninstall = []
    for path in sorted(payload.rglob("*"), reverse=True):
        relative = str(path.relative_to(payload)).replace("/", "\\").replace("$", "$$")
        command = "RMDir" if path.is_dir() else "Delete"
        uninstall.append(f'  {command} "$INSTDIR\\{relative}"')
    (directory / "remove-payload.nsh").write_text("\n".join(uninstall) + "\n", encoding="utf-8")

    env = os.environ.copy()
    shared = compiler.parent.parent / "share" / "nsis"
    if (shared / "Stubs").is_dir():
        env["NSISDIR"] = str(shared)
    flag = "/" if os.name == "nt" else "-"
    command = [
        str(compiler), f"{flag}V3", f"{flag}WX", f"{flag}INPUTCHARSET", "UTF8",
        f"{flag}DRELEASE_VERSION={version}", f"{flag}DCLOSE_SCRIPT_SHA256={sha256(close_script)}",
    ]
    if production:
        command.extend([f"{flag}DPRODUCTION", f"{flag}DINSTALL_SCRIPT_SHA256={sha256(install_script)}"])
    subprocess.run([*command, "installer.nsi"], cwd=directory, env=env, check=True)
    setup = directory / INSTALLER
    if pe_info(setup)[2] != WINDOWS_GUI:
        raise ValueError("The local setup is not a Windows GUI executable.")
    return setup


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exe", type=Path, required=True, help="Built jiancang-tauri.exe")
    parser.add_argument("--output", type=Path, default=SOURCE / "dist")
    parser.add_argument("--makensis", type=Path, help="Optional MakeNSIS for unsigned local setup")
    parser.add_argument("--production", action="store_true", help="Package the WebView2 production channel")
    args = parser.parse_args()

    config = json.loads((SOURCE / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    version = config["version"]
    if config["identifier"] != APP_ID or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Expected the isolated Tauri candidate identifier and a numeric version.")
    if pe_info(args.exe) != (MSVC_X64, PE32_PLUS, WINDOWS_GUI):
        raise ValueError("Expected a Windows x64 release GUI executable.")

    backend = SOURCE / "generated" / "backend"
    if pe_info(backend / "node.exe") != (MSVC_X64, PE32_PLUS, WINDOWS_CONSOLE):
        raise ValueError("Expected official Node.js for Windows x64.")
    for relative in ("LICENSE.node.txt", "tauri/backend/server.cjs"):
        path = backend / relative
        if not path.is_file() or not path.stat().st_size:
            raise ValueError(f"Missing {relative} in the generated backend. Run Prepare.mjs first.")

    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    artifact = f"JianCang-Windows-{version}-x64" if args.production else f"JianCang-Windows-{version}-Tauri-Candidate-x64"
    with tempfile.TemporaryDirectory(prefix=".tauri-package-", dir=output) as temporary:
        directory = Path(temporary)
        payload = directory / "payload"
        payload.mkdir()
        shutil.copyfile(args.exe, payload / APP)
        packaged_backend = payload / "backend"
        copy_backend(backend, packaged_backend)
        for metadata in ("release-mode.json", "install-state.json"):
            (packaged_backend / metadata).unlink(missing_ok=True)
        if args.production:
            (packaged_backend / "release-mode.json").write_text('{"production": true}\n', encoding="utf-8")

        portable = directory / f"{artifact}.zip"
        with ZipFile(portable, "w", compression=ZIP_DEFLATED, compresslevel=6) as archive:
            for path in sorted(payload.rglob("*")):
                if path.is_file():
                    archive.write(path, path.relative_to(payload).as_posix())
        artifacts = [(portable, portable.name)]

        if args.makensis:
            setup = compile_setup(args.makensis.resolve(strict=True), directory, payload, version, production=args.production)
            setup_name = "Setup.exe" if args.production else INSTALLER
            artifacts.append((setup, f"{artifact}-{setup_name}"))

        for source, name in artifacts:
            dest = output / name
            source.replace(dest)
            print(f"{sha256(dest)}  {dest.stat().st_size:>10} B  {dest}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f"Tauri package error: {exc}") from exc
