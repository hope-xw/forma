"""Measure the backdrop dependency of an editable Sketch layer using its native renderer."""

import argparse
import copy
import hashlib
import io
import json
import shutil
import subprocess
import tempfile
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from zipfile import ZipFile, ZIP_STORED

from PIL import Image, ImageChops, ImageCms


def descendants(node):
    yield node
    for child in node.get("layers", []):
        yield from descendants(child)


def path_to(node, target):
    if node["do_objectID"] == target:
        return [node]
    for child in node.get("layers", []):
        path = path_to(child, target)
        if path:
            return [node, *path]
    return []


def difference(left, right):
    channels = ImageChops.difference(left, right).split()
    return ImageChops.lighter(channels[0], ImageChops.lighter(channels[1], channels[2]))


def count_above(diff, limit):
    return sum(diff.histogram()[limit + 1 :])


def render(tool, source, folder, ids, formats):
    subprocess.run(
        [
            str(tool), "export", "layers", str(source), "--items=" + ",".join(ids),
            "--trimmed=NO", "--scales=1", "--formats=" + formats,
            "--use-id-for-name", "--overwriting", "--output=" + str(folder),
        ],
        check=True, stdout=subprocess.DEVNULL,
    )


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path)
parser.add_argument("--sketchtool", type=Path, required=True)
parser.add_argument("--root", required=True, help="Absolute Sketch object ID of the reference frame")
parser.add_argument("--layer", required=True, help="Foreground material object ID")
parser.add_argument("--backdrop", required=True, help="Previously visible backdrop object ID in this frame")
parser.add_argument("--report", type=Path, required=True)
args = parser.parse_args()
source = args.source.resolve()
with source.open("rb") as original:
    digest = hashlib.file_digest(original, "sha256").hexdigest()
version = subprocess.check_output([str(args.sketchtool), "--version"], text=True).strip()
with tempfile.TemporaryDirectory(prefix="forma-native-material-") as temp:
    work = Path(temp)
    experiment = work / "experiment.sketch"
    ids = {"visible": args.root}
    with ZipFile(source) as archive:
        meta = json.loads(archive.read("meta.json"))
        if str(meta["build"]) not in version:
            raise ValueError(f"Expected Sketch build {meta['build']}, got {version}")
        for page_name in archive.namelist():
            if not page_name.startswith("pages/") or not page_name.endswith(".json"):
                continue
            page = json.loads(archive.read(page_name))
            root = next((n for n in page["layers"] if n.get("do_objectID") == args.root), None)
            if root:
                break
        else:
            raise ValueError("Root must be a top-level frame on a source page")
        by_id = {n["do_objectID"]: n for n in descendants(root)}
        layer, backdrop = by_id[args.layer], by_id[args.backdrop]
        if args.layer == args.backdrop or args.root in (args.layer, args.backdrop):
            raise ValueError("Select two distinct descendants of the source frame")
        if any(n.get("isVisible") is False for n in (layer, backdrop)):
            raise ValueError("Both source layers must be visible")
        for i, (name, hidden) in enumerate((
            ("hidden", [args.layer]), ("changedBackdrop", [args.backdrop]),
            ("bothHidden", [args.layer, args.backdrop]),
        ), 1):
            sample = copy.deepcopy(root)
            for node in descendants(sample):
                original_id = node["do_objectID"]
                if original_id in hidden:
                    node["isVisible"] = False
                node["do_objectID"] = str(uuid.uuid5(uuid.NAMESPACE_URL, name + original_id)).upper()
            # An integer translation preserves native device-pixel phase in each variant.
            sample["frame"]["x"] += i * (round(root["frame"]["width"]) + 200)
            ids[name] = sample["do_objectID"]
            page["layers"].append(sample)
        with ZipFile(experiment, "w", compression=ZIP_STORED, allowZip64=True) as out:
            for entry in archive.infolist():
                if entry.filename == page_name:
                    out.writestr(page_name, json.dumps(page, ensure_ascii=False).encode())
                else:
                    with archive.open(entry) as src, out.open(entry.filename, "w") as dst:
                        shutil.copyfileobj(src, dst)

    render(args.sketchtool, source, work / "source", [args.root], "png")
    render(args.sketchtool, source, work / "layer", [args.layer], "png,svg")
    render(args.sketchtool, experiment, work / "samples", list(ids.values()), "png")

    def rgba_image(folder, layer_id):
        with Image.open(work / folder / (layer_id + ".png")) as im:
            rgba = im.convert("RGBA")
            if profile := im.info.get("icc_profile"):
                rgba = ImageCms.profileToProfile(
                    rgba, ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                    ImageCms.createProfile("sRGB"), outputMode="RGBA",
                )
            return rgba

    def read(folder, layer_id):
        rgba = rgba_image(folder, layer_id)
        canvas = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(canvas, rgba).convert("RGB")

    reference = read("source", args.root)
    frames = {k: read("samples", v) for k, v in ids.items()}
    if difference(reference, frames["visible"]).getbbox() is not None:
        raise ValueError("The experiment changes the original frame's rendered pixels")
    native_change = difference(frames["visible"], frames["hidden"])
    affected = native_change.point(lambda n: 255 if n else 0)
    if not affected.getbbox():
        raise ValueError("This source layer has no visible contribution in its context")
    restored = Image.composite(frames["visible"], frames["hidden"], affected)
    stale = Image.composite(frames["visible"], frames["bothHidden"], affected)
    reuse_diff = difference(stale, frames["changedBackdrop"])
    svg = ET.parse(work / "layer" / (args.layer + ".svg"))
    isolated = rgba_image("layer", args.layer)
    path = path_to(root, args.layer)[1:]
    x = sum(n["frame"]["x"] for n in path)
    y = sum(n["frame"]["y"] for n in path)
    raw_overlay_diff = None
    if (
        all(not (n.get("rotation") or n.get("isFlippedHorizontal") or n.get("isFlippedVertical")) for n in path)
        and float(x).is_integer() and float(y).is_integer()
        and isolated.size == (layer["frame"]["width"], layer["frame"]["height"])
    ):
        pasted = frames["hidden"].convert("RGBA")
        pasted.alpha_composite(isolated, dest=(int(x), int(y)))
        raw_overlay_diff = count_above(difference(pasted.convert("RGB"), reference), 16)
    report = {
        "sourceSha256": digest, "nativeRenderer": version, "pageId": page["do_objectID"],
        "rootId": args.root, "foregroundId": args.layer, "backdropId": args.backdrop,
        "sourceLayerClass": layer["_class"], "editableLayerFields": sorted(layer.get("style", {})),
        "isolatedLayerPngSize": list(isolated.size),
        "isolatedLayerNormalAlphaCompositionPixelsOver16": raw_overlay_diff,
        "isolatedSvgTextElements": len(svg.findall(".//{*}text")),
        "isolatedSvgFilterElements": len(svg.findall(".//{*}filter")),
        "canvasSize": list(reference.size), "denominator": reference.width * reference.height,
        "metric": "1x sRGB channel values after compositing over white, max absolute RGB channel difference",
        "changedPixels": count_above(native_change, 0), "affectedBoundsLTRBExclusive": list(affected.getbbox()),
        "sameBackdropMaximumDifference": difference(restored, frames["visible"]).getextrema()[1],
        "changedBackdropStaleAppearancePixelsOver16": count_above(reuse_diff, 16),
    }

if report["sameBackdropMaximumDifference"] or not report["changedBackdropStaleAppearancePixelsOver16"]:
    raise ValueError("The selected material did not demonstrate backdrop dependence")
args.report.parent.mkdir(parents=True, exist_ok=True)
args.report.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
