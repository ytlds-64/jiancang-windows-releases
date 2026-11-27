#!/usr/bin/env python3
"""Stage the Windows app's offline OCR runtime from an npm install."""

import argparse
import hashlib
import json
import shutil
from tempfile import TemporaryDirectory
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
VENDOR = REPO / "outputs" / "JianCangWindows" / "vendor" / "ocr"
PACKAGES = {
    "bmp-js": ["index.js", "lib"],
    "is-url": ["index.js"],
    "node-fetch": ["lib"],
    "pngjs": ["lib"],
    "regenerator-runtime": ["runtime.js"],
    "tesseract.js": ["src"],
    "tr46": ["index.js", "lib"],
    "wasm-feature-detect": ["dist"],
    "webidl-conversions": ["lib"],
    "whatwg-url": ["lib"],
}
CORE_VARIANTS = ("-lstm", "-simd-lstm", "-relaxedsimd-lstm")


def fix_node_core_loader(target):
    source = target.read_text(encoding="utf-8")
    condition = "[OEM.DEFAULT, OEM.LSTM_ONLY].includes(oem)"
    if source.count(condition) != 3 or "module.exports = async (oem, _, res)" not in source:
        raise SystemExit("Check the LSTM-only loader when updating Tesseract.js.")
    # Tesseract.js passes a boolean from worker-script/index.js, not an OEM number.
    with_boolean = source.replace("const OEM = require('../../constants/OEM');\n", "").replace(
        "(oem, _, res)", "(lstmOnly, _, res)").replace(condition, "lstmOnly")
    target.write_text(with_boolean, encoding="utf-8")


def stage(installed, destination):
    def emit(source, relative):
        if not source.is_file() or source.is_symlink():
            raise SystemExit(f"Missing or unsafe OCR input: {source}")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)

    def files(module, paths):
        metadata = json.loads((module / "package.json").read_text())
        for name in paths:
            source = module / name
            selected = source.rglob("*") if source.is_dir() else [source]
            for file in selected:
                if file.is_dir():
                    continue
                emit(file, Path("node_modules") / metadata["name"] / file.relative_to(module))
        notices = [p for p in module.iterdir() if p.name.upper().startswith(("LICENSE", "NOTICE", "COPYING"))]
        if not notices:
            notices = [p for p in module.iterdir() if p.name.upper().startswith("README")]
        for source in [module / "package.json", *notices]:
            emit(source, Path("node_modules") / metadata["name"] / source.name)
        return metadata["version"]

    versions = {name: files(installed / name, paths) for name, paths in PACKAGES.items()}
    fix_node_core_loader(destination / "node_modules/tesseract.js/src/worker-script/node/getCore.js")
    core = installed / "tesseract.js-core"
    versions["tesseract.js-core"] = files(core, [])
    for variant in CORE_VARIANTS:
        stem = f"tesseract-core{variant}"
        emit(core / f"{stem}.wasm.js", Path("node_modules/tesseract.js-core") / f"{stem}.js")

    for language in ("eng", "chi_sim"):
        module = installed / "@tesseract.js-data" / language
        metadata = json.loads((module / "package.json").read_text())
        versions[metadata["name"]] = metadata["version"]
        model = f"{language}.traineddata.gz"
        emit(module / "4.0.0_best_int" / model, Path("languages") / model)
    emit(core / "LICENSE", Path("languages") / "LICENSE")

    manifest = {
        "versions": versions,
        "files": {
            p.relative_to(destination).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(destination.rglob("*")) if p.is_file()
        },
    }
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("npm_project", type=Path, help="folder containing the installed OCR node_modules")
    arguments = parser.parse_args()
    VENDOR.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=VENDOR.parent, prefix=".ocr-stage-") as work:
        pending = Path(work) / "next"
        stage(arguments.npm_project / "node_modules", pending)
        previous = Path(work) / "previous"
        if VENDOR.exists():
            VENDOR.rename(previous)
        try:
            pending.rename(VENDOR)
        except OSError:
            if previous.exists():
                previous.rename(VENDOR)
            raise


if __name__ == "__main__":
    main()
