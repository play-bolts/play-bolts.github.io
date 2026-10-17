#!/usr/bin/env python3
"""Inspect shipped image/model source assets without changing them.

Run from the repository root: python3 scripts/performance-asset-audit.py
Requires Pillow. Reports source-file bytes, not HTTP transfer or live GPU usage.
"""
import hashlib
import io
import json
from pathlib import Path
import struct

from PIL import Image


def rgba8_mips(width, height):
    total = 0
    while True:
        total += width * height * 4
        if width == height == 1:
            return total
        width, height = max(1, width // 2), max(1, height // 2)


def inspect_image(data):
    with Image.open(io.BytesIO(data)) as image:
        return {
            "width": image.width,
            "height": image.height,
            "format": image.format,
            "mode": image.mode,
            "encoded_bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "rgba8_mips": rgba8_mips(image.width, image.height),
        }


def inspect_glb(data):
    magic, version, total = struct.unpack_from("<III", data)
    assert magic == 0x46546C67 and version == 2 and total == len(data)
    offset, document, binary = 12, None, b""
    while offset < total:
        length, kind = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8:offset + 8 + length]
        if kind == 0x4E4F534A:
            document = json.loads(chunk)
        elif kind == 0x004E4942:
            binary = chunk
        offset += 8 + length
    assert document is not None
    images = []
    for image in document.get("images", []):
        view = document["bufferViews"][image["bufferView"]]
        start = view.get("byteOffset", 0)
        images.append(inspect_image(binary[start:start + view["byteLength"]]))
    vertices, triangles, primitives = 0, 0, 0
    for mesh in document.get("meshes", []):
        for primitive in mesh["primitives"]:
            primitives += 1
            count = document["accessors"][primitive["attributes"]["POSITION"]]["count"]
            vertices += count
            assert primitive.get("mode", 4) == 4, "Non-triangle primitive"
            triangles += (document["accessors"][primitive["indices"]]["count"]
                          if "indices" in primitive else count) // 3
    return {
        "kind": "glb", "images": images, "vertices": vertices,
        "triangles": triangles, "meshes": len(document.get("meshes", [])),
        "primitives": primitives, "extensions": document.get("extensionsUsed", []),
    }


rows = []
for path in sorted(Path("public").rglob("*")):
    if not path.is_file():
        continue
    row = {"path": str(path), "bytes": path.stat().st_size}
    if path.suffix.lower() in {".jpg", ".png", ".webp"}:
        row.update(kind="image", **inspect_image(path.read_bytes()))
    elif path.suffix == ".glb":
        row.update(inspect_glb(path.read_bytes()))
    rows.append(row)

# Successful imported-model paths bypass these legacy assets. Canvas and walnut
# remain required for the world and first-person sleeves.
legacy = [row for row in rows if row["path"] in {
    "public/assets/makehuman/human-head.glb",
    "public/assets/details/model-details.glb",
} or row["path"].endswith(".jpg") and any(
    f"/{family}/" in row["path"] for family in ["fabric", "soldier", "steel"])]
startup = sum(row["bytes"] for row in rows
              if row.get("kind") == "glb" or row["path"].endswith(".jpg"))
compressed_keys = ["stone/basecolor", "stone/roughness", "dirt/basecolor",
                   "dirt/roughness", "walnut/basecolor", "walnut/roughness"]
compressed_delta = sum(
    Path(f"public/assets/materials/{key}.ktx2").stat().st_size
    - Path(f"public/assets/materials/{key}.jpg").stat().st_size
    for key in compressed_keys)
basis = sum(Path(f"public/assets/basis/{name}").stat().st_size
            for name in ["basis_transcoder.js", "basis_transcoder.wasm"])
summary = {
    "method": "Static shipped source files; no HTTP compression/cache or live device residency measurement. RGBA8 mip arithmetic assumes all image levels resident and excludes driver overhead. Imported image inventory includes images discarded by application assembly. Texture clones can share GPU allocations in Three r180.",
    "public_bytes": sum(row["bytes"] for row in rows),
    "startup_unique_model_image_bytes_jpeg": startup,
    "startup_unique_model_image_bytes_ktx_with_basis": startup + compressed_delta + basis,
    "legacy_preload_bytes": sum(row["bytes"] for row in legacy),
    "legacy_preload_paths": [row["path"] for row in legacy],
    "legacy_image_rgba8_base_bytes": sum(
        row.get("width", 0) * row.get("height", 0) * 4
        + sum(image["width"] * image["height"] * 4 for image in row.get("images", []))
        for row in legacy),
    "all_embedded_image_rgba8_mips": sum(
        sum(image["rgba8_mips"] for image in row.get("images", [])) for row in rows),
}
destination = Path("temp/performance-audit")
destination.mkdir(parents=True, exist_ok=True)
(destination / "asset-inventory.json").write_text(json.dumps(rows, indent=2) + "\n")
(destination / "asset-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
