#!/usr/bin/env python3
"""Normalize approved transparent watercolor derivatives into the runtime canvas."""

from __future__ import annotations

import argparse
from pathlib import Path
from statistics import median

from PIL import Image


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
CANVAS = (1024, 1536)
VISIBLE_ALPHA_THRESHOLD = 16
TARGET_MEDIAN_SUBJECT_HEIGHT = 1295
TARGET_FOOT_Y = 1420
APPROVAL_MASTER_BACKGROUND = (244, 242, 236, 255)


def runtime_filenames() -> list[str]:
    return [
        f"role-{role}-state-{state}-v01.png"
        for role in ROLES
        for state in STATES
    ]


def visible_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    mask = image.getchannel("A").point(
        lambda alpha: 255 if alpha > VISIBLE_ALPHA_THRESHOLD else 0,
    )
    bbox = mask.getbbox()
    if bbox is None:
        raise ValueError("transparent derivative has no visible subject")
    return bbox


def role_from_filename(filename: str) -> str:
    for role in ROLES:
        if filename.startswith(f"role-{role}-state-"):
            return role
    raise ValueError(f"cannot determine role from filename: {filename}")


def clean_transparent_pixels(image: Image.Image) -> Image.Image:
    cleaned = image.copy()
    cleaned.putalpha(
        cleaned.getchannel("A").point(
            lambda alpha: alpha if alpha > VISIBLE_ALPHA_THRESHOLD else 0,
        )
    )
    return cleaned


def normalize(
    image: Image.Image,
    bbox: tuple[int, int, int, int],
    scale: float,
    destination: Path,
) -> None:
    cleaned = clean_transparent_pixels(image)
    resized_size = (
        max(1, round(cleaned.width * scale)),
        max(1, round(cleaned.height * scale)),
    )
    resized = cleaned.convert("RGBa").resize(
        resized_size,
        Image.Resampling.LANCZOS,
    ).convert("RGBA")

    scaled_bottom = round(bbox[3] * scale)
    offset = (
        round((CANVAS[0] - resized.width) / 2),
        TARGET_FOOT_Y - scaled_bottom,
    )
    canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    canvas.alpha_composite(resized, offset)
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination, format="PNG", optimize=True)


def save_opaque_approval_master(image: Image.Image, destination: Path) -> None:
    background = Image.new("RGBA", image.size, APPROVAL_MASTER_BACKGROUND)
    background.alpha_composite(clean_transparent_pixels(image))
    destination.parent.mkdir(parents=True, exist_ok=True)
    background.convert("RGB").save(destination, format="PNG", optimize=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        type=Path,
        default=Path("tmp/imagegen/watercolor-runtime-keyed-v2"),
        help="Directory containing RGBA chroma-key removals.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("src/renderer/src/assets/watercolor-characters"),
        help="Runtime asset directory.",
    )
    parser.add_argument(
        "--approval-master-out",
        type=Path,
        help="Optional directory for opaque awaiting-approval masters from the same RGBA source.",
    )
    args = parser.parse_args()

    missing = []
    inputs: dict[str, tuple[Image.Image, tuple[int, int, int, int]]] = {}
    for filename in runtime_filenames():
        source = args.source / filename
        if not source.is_file():
            missing.append(filename)
            continue
        with Image.open(source) as opened:
            image = opened.convert("RGBA")
        inputs[filename] = (image, visible_bbox(image))

    if missing:
        print(f"missing transparent derivatives: {len(missing)}")
        for filename in missing:
            print(filename)
        return 1

    heights_by_role: dict[str, list[int]] = {role: [] for role in ROLES}
    for filename, (_, bbox) in inputs.items():
        heights_by_role[role_from_filename(filename)].append(bbox[3] - bbox[1])
    scale_by_role = {
        role: TARGET_MEDIAN_SUBJECT_HEIGHT / median(heights)
        for role, heights in heights_by_role.items()
    }

    for filename, (image, bbox) in inputs.items():
        role = role_from_filename(filename)
        normalize(image, bbox, scale_by_role[role], args.out / filename)
        if args.approval_master_out and "-state-awaiting-approval-" in filename:
            save_opaque_approval_master(
                image,
                args.approval_master_out / filename,
            )

    print(f"installed {len(runtime_filenames())} watercolor runtime assets to {args.out}")
    print(
        "role scales: "
        + ", ".join(f"{role}={scale_by_role[role]:.4f}" for role in ROLES)
    )
    print(
        f"visual contract: median subject height={TARGET_MEDIAN_SUBJECT_HEIGHT}px, "
        f"foot baseline y={TARGET_FOOT_Y}px, visible alpha>{VISIBLE_ALPHA_THRESHOLD}"
    )
    if args.approval_master_out:
        print(
            "synced 7 opaque awaiting-approval masters from the same RGBA source to "
            f"{args.approval_master_out}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
