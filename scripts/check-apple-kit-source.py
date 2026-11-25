"""Read the licensed source locally; keep its images and layer labels in output/."""

import argparse
import hashlib
import json
import subprocess
from collections import Counter
from pathlib import Path
from zipfile import ZipFile

TARGETS = {
    "cover": "74C0D863-BCC3-493B-A6B3-1C0BCA50C124",
    "alert": "882FF902-BC06-4B27-B3E0-0F2AACA07039",
    "button": "D3BBDD64-2CF9-4025-9E94-68E3917DB5D3",
    "keyboard": "8186ACD4-BF89-40A7-A2F9-FF2D8564F4E9",
    "picker": "F01E4A31-B2B4-47A3-A1B4-02DCE1F5CF29",
    "toggle": "3110AB65-4DCE-4E0F-812A-B6680573C3BF",
}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("file", type=Path)
parser.add_argument("--sketchtool", type=Path)
parser.add_argument("--output", type=Path, default=Path("output/playwright/apple-kit"))
args = parser.parse_args()
root = args.output
root.mkdir(parents=True, exist_ok=True)
with args.file.open("rb") as stream:
    sha = hashlib.file_digest(stream, "sha256").hexdigest()
assert sha == "839ecf260025264db9000a4ce23ef2804c33c8d62642a6373ed310858ca64171", (
    "Unexpected Apple kit revision"
)
with ZipFile(args.file) as archive:

    def read(name):
        return json.loads(archive.read(name).decode("utf-8", errors="strict"))

    document = read("document.json")
    meta = read("meta.json")
    pages, sample, ids, masters, instances, items = [], {}, set(), set(), [], []
    types, overrides = Counter(), Counter()

    def walk(node, parent, page, layer_types):
        page_id = page["do_objectID"]
        node_id = node["do_objectID"]
        assert node_id not in ids
        ids.add(node_id)
        kind = node["_class"]
        if kind == "symbolMaster":
            assert node["symbolID"] not in masters
            masters.add(node["symbolID"])
        if kind == "symbolInstance":
            instances.append(node["symbolID"])
        for attr in node.get("overrideValues", []):
            overrides[attr["overrideName"].rsplit("_", 1)[-1]] += 1
        layer_types[kind] += 1
        text = node.get("attributedString", {}).get("string")
        items.append(
            [
                page_id,
                node_id,
                parent,
                kind,
                node["name"],
                node.get("symbolID"),
                text,
            ]
        )
        if node_id in TARGETS.values():
            tag = next(k for k, v in TARGETS.items() if v == node_id)
            sample[tag] = {
                "id": node_id,
                "pageId": page_id,
                "page": page["name"],
                "name": node["name"],
                "size": [node["frame"]["width"], node["frame"]["height"]],
            }
        for child in node.get("layers", []):
            walk(child, node_id, page, layer_types)

    for ref in document["pages"]:
        page = read(ref["_ref"] + ".json")
        page_id = page["do_objectID"]
        layer_types = Counter()

        for node in page["layers"]:
            walk(node, None, page, layer_types)
        types.update(layer_types)
        pages.append(
            {
                "id": page_id,
                "name": page["name"],
                "roots": len(page["layers"]),
                "nodes": layer_types.total(),
            }
        )
    foreign = {
        s["symbolMaster"]["symbolID"]
        for s in document.get("foreignSymbols", [])
        if "symbolMaster" in s
    }
    image_entries = [
        e
        for e in archive.infolist()
        if e.filename.startswith("images/") and not e.is_dir()
    ]
    source_styles = [
        [s["do_objectID"], s["name"], kind]
        for kind, local, external in [
            ("text", "layerTextStyles", "foreignTextStyles"),
            ("paint", "layerStyles", "foreignLayerStyles"),
        ]
        for s in [
            *document[local]["objects"],
            *(x["localSharedStyle"] for x in document[external]),
        ]
    ]
    colors = [
        [
            s["do_objectID"],
            s["name"],
            "#"
            + "".join(
                f"{int(s['value'][ch] * 255 + 0.5):02x}"
                for ch in ("red", "green", "blue")
            ),
        ]
        for s in [
            *document["sharedSwatches"]["objects"],
            *(x["localSwatch"] for x in document["foreignSwatches"]),
        ]
    ]
    fonts = sorted(
        {
            hashlib.sha256(archive.read(x["fontData"]["_ref"])).hexdigest()
            for x in document["fontReferences"]
            if x.get("fontData", {}).get("_ref")
        }
    )
    source_pngs = []
    source_pdfs = 0
    for entry in image_entries:
        data = archive.read(entry)
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            source_pngs.append(hashlib.sha256(data).hexdigest())
        elif data.startswith(b"%PDF"):
            source_pdfs += 1
    (root / "source-styles.json").write_text(
        json.dumps(
            {
                "styles": source_styles,
                "colors": colors,
                "fonts": fonts,
                "pngs": source_pngs,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    report = {
        "sha256": sha,
        "bytes": args.file.stat().st_size,
        "sourceAppVersion": meta["appVersion"],
        "build": meta["build"],
        "format": meta["version"],
        "archiveEntries": len(archive.infolist()),
        "uncompressedBytes": sum(e.file_size for e in archive.infolist()),
        "pages": pages,
        "layerClasses": dict(types),
        "nodes": types.total(),
        "masters": len(masters),
        "foreignMasters": len(foreign),
        "instances": len(instances),
        "instancesMissingDefinitions": sum(
            i not in (masters | foreign) for i in instances
        ),
        "overrideFields": dict(overrides),
        "assetCount": len(image_entries),
        "sharedLayerStyles": len(document["layerStyles"]["objects"]),
        "sharedTextStyles": len(document["layerTextStyles"]["objects"]),
        "colorVariables": len(document["sharedSwatches"]["objects"]),
        "privateUseLayerNames": sum(
            any(0xF0000 <= ord(c) <= 0x10FFFD for c in item[4]) for item in items
        ),
        "foreignTextStyles": len(document["foreignTextStyles"]),
        "foreignSwatches": len(document["foreignSwatches"]),
        "embeddedFontFiles": len(fonts),
        "pngImages": len(source_pngs),
        "pdfImages": source_pdfs,
        "samples": sample,
    }
    assert set(sample) == set(TARGETS)
    (root / "source-nodes.json").write_text(
        json.dumps(items, ensure_ascii=False), encoding="utf-8"
    )
if args.sketchtool:
    version = subprocess.check_output(
        [str(args.sketchtool), "--version"], text=True
    ).strip()
    assert str(meta["build"]) in version, (
        "Use the original Sketch build to render the oracle"
    )
    destination = root / "source"
    destination.mkdir(exist_ok=True)
    subprocess.run(
        [
            str(args.sketchtool),
            "export",
            "layers",
            str(args.file),
            "--items=" + ",".join(TARGETS.values()),
            "--trimmed=NO",
            "--use-id-for-name",
            "--overwriting",
            "--formats=png",
            "--scales=1",
            "--output=" + str(destination),
        ],
        check=True,
    )
    report["renderer"] = version
    for item in sample.values():
        data = (destination / (item["id"] + ".png")).read_bytes()
        assert data[:8] == b"\x89PNG\r\n\x1a\n"
        assert [int.from_bytes(data[n : n + 4], "big") for n in [16, 20]] == item[
            "size"
        ]
        item["pngSha256"] = hashlib.sha256(data).hexdigest()
(root / "source-manifest.json").write_text(
    json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)
print(
    json.dumps(
        {
            k: report[k]
            for k in ("nodes", "masters", "instances", "assetCount", "overrideFields")
        },
        ensure_ascii=False,
    )
)
