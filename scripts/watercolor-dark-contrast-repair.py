#!/usr/bin/env python3
import argparse
import hashlib
import os
from pathlib import Path

from PIL import Image


SOURCE_DIGESTS = {
    "role-developer-state-tool-running-v01.png": "7f2da660e97f3489596ef2a9ff1894a155e2c0cbc5f121f2356f871aa02e030a",
    "role-developer-state-repairing-v01.png": "ef2579e108d32fe026d3c4c1e7b6fc6bc8918b741ac64fbe3482f4c9ffd9b16a",
    "role-developer-state-delivering-v01.png": "29ecc990701697dc93536cff9a39f5f07dfe90b83d6d5d7d1bb7a83384b89134",
}


def main() -> int:
    args = parse_args()
    asset_root = Path(args.asset_root).resolve()
    for filename, expected_digest in SOURCE_DIGESTS.items():
        repair(asset_root / filename, expected_digest)
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Repair dark-background contrast for three locked watercolor assets.")
    parser.add_argument(
        "--asset-root",
        default="src/renderer/src/assets/watercolor-characters",
        help="Directory containing the canonical watercolor runtime PNG files.",
    )
    return parser.parse_args()


def repair(path: Path, expected_digest: str) -> None:
    actual_digest = sha256(path)
    if actual_digest != expected_digest:
        raise ValueError(f"refusing to edit unexpected source {path.name}: {actual_digest}")
    with Image.open(path) as source:
        source.load()
        if source.mode != "RGBA" or source.size != (1024, 1536):
            raise ValueError(f"unexpected image contract for {path.name}: {source.mode} {source.size}")
        original_alpha = source.getchannel("A").tobytes()
        repaired = Image.new("RGBA", source.size)
        repaired.putdata([lift_pixel(pixel) for pixel in source.get_flattened_data()])
    if repaired.getchannel("A").tobytes() != original_alpha:
        raise ValueError(f"alpha channel changed for {path.name}")
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        repaired.save(temporary, format="PNG", optimize=True)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"repaired {path.name}: {actual_digest} -> {sha256(path)}")


def lift_pixel(pixel: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    red, green, blue, alpha = pixel
    if alpha <= 16:
        return pixel
    luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
    if luminance < 55:
        target = luminance + 16
    elif luminance < 112:
        target = luminance + (112 - luminance) * 0.85
    else:
        return pixel
    scale = target / max(luminance, 1)
    return (
        min(255, round(red * scale)),
        min(255, round(green * scale)),
        min(255, round(blue * scale)),
        alpha,
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
