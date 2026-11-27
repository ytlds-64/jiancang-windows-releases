#!/usr/bin/env python3
"""Stage the same pinned LGPL engine, source and notices as the Electron package."""

import importlib.util
from pathlib import Path
import shutil
import sys
from zipfile import ZipFile


def main(destination):
    # Share dependency pins and archive verification with the existing Windows build.
    root = Path(__file__).resolve().parents[3]
    spec = importlib.util.spec_from_file_location(
        "windows_release_packager", root / "work" / "build" / "package-jiancang-windows.py"
    )
    release = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(release)

    runtime = release.media_archive()
    sources = release.media_sources()
    with ZipFile(runtime) as archive:
        for name, entry in release.media_entries(archive):
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
            if name in {"bin/ffmpeg.exe", "bin/ffprobe.exe"}:
                with target.open("rb") as tool:
                    release.verify_windows_executable(tool)

    source_directory = destination / "source"
    source_directory.mkdir()
    for source in sources:
        shutil.copyfile(source, source_directory / source.name)
    shutil.copyfile(release.APP / "vendor" / "media" / "NOTICE.md", destination / "NOTICE.md")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: Prepare-Media-FFmpeg.py <staging/vendor/media>")
    sys.dont_write_bytecode = True
    main(Path(sys.argv[1]))
