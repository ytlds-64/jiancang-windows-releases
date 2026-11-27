#!/usr/bin/env python3
"""Build the compressed NSIS installer from the signed Windows ZIP."""

import argparse
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import struct
import subprocess
import tarfile
import tempfile
import zipfile


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("jiancang_windows_package", HERE / "package-jiancang-windows.py")
PACKAGER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGER)
SEVEN_ZIP_NAME = "7z2606-mac.tar.xz"
SEVEN_ZIP_SHA256 = "b6f17920b4240940461dac8ef4009891881ac44d2a5ead625ede2ec8472185dd"


def setup_verifier(configured, workspace):
    if configured:
        return Path(configured).resolve(strict=True)
    archive = PACKAGER.verified_download(HERE / "jiancang-7zip", SEVEN_ZIP_NAME,
        f"https://github.com/ip7z/7zip/releases/download/26.06/{SEVEN_ZIP_NAME}", SEVEN_ZIP_SHA256)
    executable = workspace / "7zz"
    with tarfile.open(archive, "r:xz") as package:
        member = package.getmember("7zz")
        if not member.isfile():
            raise SystemExit("Expected the 7-Zip verification executable.")
        with package.extractfile(member) as source, executable.open("xb") as target:
            shutil.copyfileobj(source, target)
    executable.chmod(0o700)
    return executable


def verify_payload(archive, manifest_path, workspace):
    verifier = workspace / "verify-release.cjs"
    verifier.write_text(
        """const fs = require('node:fs');
const path = require('node:path');
const [app, manifest] = process.argv.slice(2);
const { readManifest } = require(path.join(app, 'windows-update.cjs'));
const { publicKey } = require(path.join(app, 'update-trust.json'));
readManifest(fs.readFileSync(manifest, 'utf8'), publicKey);
""",
        encoding="utf-8",
    )
    PACKAGER.run_build_node(verifier, PACKAGER.APP, manifest_path)
    release = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (archive.name != release["file"] or archive.stat().st_size != release["bytes"]
            or PACKAGER.file_hash(archive) != release["sha256"]):
        raise SystemExit("The Windows ZIP does not match the signed release manifest.")
    payload = workspace / "payload"
    members = set()
    with zipfile.ZipFile(archive) as package:
        metadata = json.loads(package.read("JianCang/resources/app/package.json"))
        with package.open("JianCang/见藏.exe") as launcher:
            PACKAGER.verify_windows_executable(launcher)
        if metadata["version"] != release["version"] or metadata["name"] != "jiancang-windows":
            raise SystemExit("The release ZIP does not contain the expected Windows x64 app.")
        script = package.read(f"JianCang/{PACKAGER.INSTALL_SCRIPT}")
        if script != PACKAGER.installer_files()[f"JianCang/{PACKAGER.INSTALL_SCRIPT}"]:
            raise SystemExit("The release ZIP uses a different installer script.")
        for entry in package.infolist():
            if entry.is_dir() or not entry.filename.startswith("JianCang/"):
                continue
            relative = entry.filename.removeprefix("JianCang/")
            segments = PurePosixPath(relative).parts
            if (not segments or "/".join(segments) != relative or ".." in segments
                    or "\\" in relative or ":" in relative or relative.casefold() in members):
                raise SystemExit(f"Unexpected installation path in the signed ZIP: {relative}")
            members.add(relative.casefold())
            destination = payload.joinpath(*segments)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with package.open(entry) as source, destination.open("xb") as target:
                shutil.copyfileobj(source, target, PACKAGER.MIB)
    return release, script, payload


def verify_setup(setup, payload, verifier, workspace):
    with setup.open("rb") as executable:
        header = executable.read(64)
        if len(header) != 64 or header[:2] != b"MZ":
            raise SystemExit("MakeNSIS did not produce a Windows executable.")
        executable.seek(struct.unpack_from("<I", header, 0x3C)[0])
        if executable.read(4) != b"PE\0\0":
            raise SystemExit("The setup executable has an invalid PE header.")
    destination = workspace / "verified-setup"
    subprocess.run([str(verifier), "x", "-tNsis", "-bd", "-y", f"-o{destination}", str(setup)],
                   check=True, stdout=subprocess.DEVNULL)
    file_list = Path(PACKAGER.INSTALL_FOOTPRINT).name
    manifests = list(destination.rglob(file_list))
    if len(manifests) != 1:
        raise SystemExit("The setup executable has a missing or duplicate installation file list.")

    extracted = manifests[0].parent
    def contents(folder):
        return {name.relative_to(folder): PACKAGER.file_hash(name)
                for name in folder.rglob("*") if name.is_file()}
    if contents(extracted) != contents(payload):
        raise SystemExit("The setup executable does not preserve the signed ZIP's application files.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--makensis", default=shutil.which("makensis"),
                        help="Path to the NSIS MakeNSIS compiler, if it is not on PATH")
    parser.add_argument("--7zip", dest="seven_zip", default=shutil.which("7zz"),
                        help="Optional path to the 7-Zip command-line verifier")
    args = parser.parse_args()
    if not args.makensis:
        parser.error("MakeNSIS is required. Pass --makensis or install NSIS.")
    compiler = Path(args.makensis).resolve(strict=True)
    archive = args.archive.resolve(strict=True)
    manifest = archive.with_name(PACKAGER.UPDATE_MANIFEST)
    output = archive.with_name(archive.stem + "-Setup.exe")
    if output.exists():
        raise SystemExit(f"The installer already exists: {output}")
    with tempfile.TemporaryDirectory(prefix=".jiancang-setup-", dir=archive.parent) as directory:
        workspace = Path(directory)
        release, script, payload = verify_payload(archive, manifest, workspace)
        verifier = setup_verifier(args.seven_zip, workspace)
        PACKAGER.windows_icon(workspace)
        list_hash = PACKAGER.file_hash(payload / Path(PACKAGER.INSTALL_FOOTPRINT).name)
        PACKAGER.compile_installer(workspace, compiler, release["version"], script,
                                   INSTALL_LIST_SHA256=list_hash)
        setup = workspace / output.name
        verify_setup(setup, payload, verifier, workspace)
        os.link(setup, output)
    print(f"{PACKAGER.file_hash(output)}  {output}")


if __name__ == "__main__":
    main()
