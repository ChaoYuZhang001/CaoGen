#!/usr/bin/env python3
"""Build deterministic light, dark, and small-scale QC sheets for watercolor assets."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


ROLES = (
    "researcher",
    "planner",
    "writer",
    "designer",
    "developer",
    "review-test",
    "operations",
)
STATES = (
    "idle",
    "thinking",
    "tool-running",
    "awaiting-approval",
    "blocked",
    "repairing",
    "delivering",
)
EXPECTED_SIZE = (1024, 1536)
SHEET_NAMES = {
    "light": "runtime-watercolor-light-contact-sheet.png",
    "dark": "runtime-watercolor-dark-contact-sheet.png",
    "gray96": "runtime-watercolor-96px-grayscale-contact-sheet.png",
    "gray48": "runtime-watercolor-48px-grayscale-contact-sheet.png",
}


def main() -> int:
    args = parse_args()
    repo_root = Path.cwd().resolve()
    source_dir = resolve_path(repo_root, args.source)
    output_dir = resolve_path(repo_root, args.out_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    expected = [filename(role, state) for state in STATES for role in ROLES]
    records = [inspect_asset(source_dir, name) for name in expected]
    missing = [record["filename"] for record in records if not record["present"]]
    invalid = [record["filename"] for record in records if record["violations"]]
    outputs = {
        "light": render_labeled_sheet(records, source_dir, output_dir / SHEET_NAMES["light"], (245, 243, 238, 255), args.force),
        "dark": render_labeled_sheet(records, source_dir, output_dir / SHEET_NAMES["dark"], (31, 36, 39, 255), args.force),
        "gray96": render_small_sheet(records, source_dir, output_dir / SHEET_NAMES["gray96"], 96, args.force),
        "gray48": render_small_sheet(records, source_dir, output_dir / SHEET_NAMES["gray48"], 48, args.force),
    }

    report = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "sourceDir": relative(repo_root, source_dir),
        "outputDir": relative(repo_root, output_dir),
        "required": args.required,
        "status": "pass" if not missing and not invalid else "incomplete" if not invalid else "fail",
        "contract": {
            "roles": list(ROLES),
            "states": list(STATES),
            "expected": len(expected),
            "expectedSize": {"width": EXPECTED_SIZE[0], "height": EXPECTED_SIZE[1]},
            "reviewBoundary": "Contact sheets support manual light/dark, identity, state, and small-scale review; they do not approve assets.",
        },
        "counts": {
            "expected": len(expected),
            "present": len(expected) - len(missing),
            "missing": len(missing),
            "invalid": len(invalid),
        },
        "missing": missing,
        "invalid": invalid,
        "files": records,
        "outputs": outputs,
    }
    report_path = output_dir / "runtime-watercolor-contact-sheets-report.json"
    write_json_atomic(report_path, report, args.force)
    print(
        "watercolor QC contact sheets: "
        f"{report['status']} ({report['counts']['present']}/{report['counts']['expected']} present, "
        f"{report['counts']['invalid']} invalid)"
    )
    print(f"watercolor QC report: {report_path}")
    if invalid or (args.required and missing):
        return 1
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate deterministic watercolor runtime QC contact sheets.")
    parser.add_argument(
        "--source",
        default="src/renderer/src/assets/watercolor-characters",
        help="Directory containing canonical 7x7 runtime PNG files.",
    )
    parser.add_argument(
        "--out-dir",
        default="output/imagegen/caogen-watercolor-v1/qc",
        help="Directory for contact sheets and the digest report.",
    )
    parser.add_argument("--required", action="store_true", help="Fail unless all 49 assets are present and valid.")
    parser.add_argument("--force", action="store_true", help="Replace existing generated QC outputs.")
    return parser.parse_args()


def resolve_path(repo_root: Path, value: str) -> Path:
    path = Path(value)
    return path.resolve() if path.is_absolute() else (repo_root / path).resolve()


def filename(role: str, state: str) -> str:
    return f"role-{role}-state-{state}-v01.png"


def inspect_asset(source_dir: Path, name: str) -> dict[str, object]:
    path = source_dir / name
    if not path.is_file():
        return {"filename": name, "present": False, "violations": []}
    violations: list[str] = []
    try:
        with Image.open(path) as image:
            image.load()
            size = image.size
            mode = image.mode
            if size != EXPECTED_SIZE:
                violations.append(f"dimensions must be 1024x1536, got {size[0]}x{size[1]}")
            if mode != "RGBA":
                violations.append(f"mode must be RGBA, got {mode}")
    except Exception as error:  # Pillow raises format-specific exceptions.
        return {"filename": name, "present": True, "violations": [f"cannot decode PNG: {error}"]}
    return {
        "filename": name,
        "present": True,
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
        "width": size[0],
        "height": size[1],
        "mode": mode,
        "violations": violations,
    }


def render_labeled_sheet(
    records: list[dict[str, object]],
    source_dir: Path,
    output_path: Path,
    background: tuple[int, int, int, int],
    force: bool,
) -> dict[str, object]:
    cell_width = 220
    cell_height = 350
    label_height = 38
    image_box = (cell_width - 20, cell_height - label_height - 16)
    canvas = Image.new("RGBA", (cell_width * len(ROLES), cell_height * len(STATES)), background)
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default()
    for index, record in enumerate(records):
        row, column = divmod(index, len(ROLES))
        x0 = column * cell_width
        y0 = row * cell_height
        draw.rectangle((x0, y0, x0 + cell_width - 1, y0 + cell_height - 1), outline=(112, 118, 118, 255), width=1)
        draw.text((x0 + 8, y0 + 8), f"{ROLES[column]} / {STATES[row]}", fill=label_color(background), font=font)
        if not record["present"] or record["violations"]:
            draw.line((x0 + 30, y0 + 70, x0 + cell_width - 30, y0 + cell_height - 30), fill=(190, 70, 60, 255), width=3)
            draw.line((x0 + cell_width - 30, y0 + 70, x0 + 30, y0 + cell_height - 30), fill=(190, 70, 60, 255), width=3)
            draw.text((x0 + 8, y0 + label_height), "MISSING" if not record["present"] else "INVALID", fill=(210, 75, 65, 255), font=font)
            continue
        with Image.open(source_dir / str(record["filename"])) as image:
            rgba = image.convert("RGBA")
            preview = ImageOps.contain(rgba, image_box, Image.Resampling.LANCZOS)
        px = x0 + (cell_width - preview.width) // 2
        py = y0 + label_height + (cell_height - label_height - preview.height) // 2
        canvas.alpha_composite(preview, (px, py))
    write_png_atomic(output_path, canvas, force)
    return file_record(output_path)


def render_small_sheet(
    records: list[dict[str, object]],
    source_dir: Path,
    output_path: Path,
    subject_height: int,
    force: bool,
) -> dict[str, object]:
    cell_width = max(64, subject_height + 20)
    cell_height = subject_height + 20
    canvas = Image.new("L", (cell_width * len(ROLES), cell_height * len(STATES)), 242)
    for index, record in enumerate(records):
        row, column = divmod(index, len(ROLES))
        if not record["present"] or record["violations"]:
            continue
        with Image.open(source_dir / str(record["filename"])) as image:
            rgba = image.convert("RGBA")
            backdrop = Image.new("RGBA", rgba.size, (242, 242, 242, 255))
            backdrop.alpha_composite(rgba)
            gray = ImageOps.grayscale(backdrop)
            preview = ImageOps.contain(gray, (cell_width - 8, subject_height), Image.Resampling.LANCZOS)
        px = column * cell_width + (cell_width - preview.width) // 2
        py = row * cell_height + (cell_height - preview.height) // 2
        canvas.paste(preview, (px, py))
    write_png_atomic(output_path, canvas, force)
    return file_record(output_path)


def label_color(background: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    return (235, 235, 232, 255) if sum(background[:3]) < 384 else (35, 38, 37, 255)


def write_png_atomic(path: Path, image: Image.Image, force: bool) -> None:
    ensure_output_available(path, force)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        image.save(temporary, format="PNG", optimize=True)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def write_json_atomic(path: Path, value: dict[str, object], force: bool) -> None:
    ensure_output_available(path, force)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def ensure_output_available(path: Path, force: bool) -> None:
    if path.exists() and not force:
        raise FileExistsError(f"refusing to overwrite existing output without --force: {path}")


def file_record(path: Path) -> dict[str, object]:
    with Image.open(path) as image:
        width, height = image.size
        mode = image.mode
    return {
        "path": path.as_posix(),
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
        "width": width,
        "height": height,
        "mode": mode,
    }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def relative(repo_root: Path, path: Path) -> str:
    try:
        return path.relative_to(repo_root).as_posix()
    except ValueError:
        return path.as_posix()


if __name__ == "__main__":
    raise SystemExit(main())
