// Local-only comparison of the licensed originals and actual editor/project output.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { compareApplePixels, assertPixelLimit } from "./apple-kit-pixels.mjs";
import { launchQaBrowser } from "./qa-browser.mjs";

const [sketch, figma, out] = process.argv.slice(2).map((p) => path.resolve(p));
const langs = {
  cover: "封面",
  button: "按钮",
  alert: "警告框",
  "alert-button": "警告框操作按钮",
  toggle: "关态开关",
  "toggle-on": "开态开关",
  "toggle-off": "关态开关",
  picker: "色板",
  keyboard: "键盘",
};
const formats = [
  {
    name: "Sketch",
    root: sketch,
    file: "result.json",
    preview: "forma",
    project: "react-screens",
    tags: ["cover", "alert", "button", "picker", "keyboard", "toggle"],
  },
  {
    name: "Figma",
    root: figma,
    file: "figma-acceptance.json",
    preview: "preview",
    project: "react",
    tags: [
      "cover",
      "button",
      "toggle-on",
      "toggle-off",
      "alert-button",
      "alert",
    ],
  },
];
const url = (f) =>
  path.relative(out, f).split(path.sep).map(encodeURIComponent).join("/");
const image = (file, label) =>
  '<figure><a href="' +
  url(file) +
  '"><img loading="lazy" src="' +
  url(file) +
  '" alt="' +
  label +
  '"></a><figcaption>' +
  label +
  "</figcaption></figure>";
const browser = await launchQaBrowser("chromium");
try {
  const page = await browser.newPage();
  await mkdir(out, { recursive: true });
  const sections = [];
  for (const fmt of formats) {
    const read = async (f) =>
      JSON.parse(await readFile(path.join(fmt.root, f), "utf8"));
    const source = await read(fmt.file);
    const report =
      fmt.name === "Sketch"
        ? source.samples
        : (await read("figma-visuals.json")).preview;
    const rows = [],
      measures = { preview: [], project: [] };
    for (const tag of fmt.tags) {
      const r = report.find((row) => row.tag === tag);
      assert.ok(r);
      const original = path.join(
        fmt.root,
        "source",
        (fmt.name === "Sketch" ? r.id : tag) + ".png",
      );
      const reference = await readFile(original),
        figures = [image(original, "源工具原图")];
      const scores = [];
      for (const kind of ["preview", "project"]) {
        const actual = path.join(fmt.root, fmt[kind], tag + ".png");
        const score = await compareApplePixels(
          page,
          reference,
          await readFile(actual),
          kind === "preview",
        );
        assert.equal(score.dimensionMismatch, undefined);
        const { diffPng, ...pixels } = score;
        measures[kind].push({ tag, pixels, sourceSize: r.sourceSize });
        figures.push(
          image(actual, kind === "preview" ? "Forma 预览" : "独立 React 工程"),
        );
        scores.push(
          (kind === "preview" ? "预览 " : "React ") +
            pixels.over16.toLocaleString("zh-CN") +
            " 像素（" +
            pixels.pct.toFixed(3) +
            "%）",
        );
        if (diffPng)
          await writeFile(
            path.join(out, fmt.name + "-" + tag + "-diff.png"),
            Buffer.from(diffPng, "base64"),
          );
      }
      figures.push(
        image(
          path.join(out, fmt.name + "-" + tag + "-diff.png"),
          "预览超差位置",
        ),
      );
      rows.push(
        "<article><h3>" +
          langs[tag] +
          "</h3><p>" +
          r.sourceSize.join(" × ") +
          " px　·　" +
          scores.join("　·　") +
          '</p><div class="samples">' +
          figures.join("") +
          "</div></article>",
      );
    }
    for (const samples of Object.values(measures))
      assertPixelLimit(samples, fmt.tags);
    sections.push(
      '<section id="' +
        fmt.name +
        '"><h2>' +
        fmt.name +
        "</h2>" +
        rows.join("") +
        "</section>",
    );
  }
  await writeFile(
    path.join(out, "index.html"),
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Apple 原稿导入 · 1× 视觉复验</title><style>html{font-family:system-ui,sans-serif;color:#20242a;background:#fafafa}body{max-width:1440px;margin:auto;padding:24px}h1,h2,h3{letter-spacing:-.025em}nav a{margin-right:1.5em}a{color:#216299}section{margin:3rem 0}article{background:white;border:1px solid #dfe1e5;border-radius:12px;padding:16px 20px;margin:14px 0}p,figcaption{color:#4a5057}h3{margin:0}article p{margin:.4rem 0 1rem}.samples{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}figure{margin:0}figure a{min-height:88px;display:flex;align-items:center;justify-content:center;border:1px solid #e5e5e5;background:white}img{max-width:100%;height:auto;object-fit:contain}figcaption{font-size:13px;margin:.4rem 0}@media(max-width:720px){.samples{grid-template-columns:repeat(2,1fr)}body{padding:12px}}</style><h1>Apple 原稿导入的逐图复验</h1><p>两份原稿各六个对象。在 sRGB 白底、1× 比较源图与输出。任一 RGB 通道相差超过 16 即计为超差，单图上限为 0.5%。红色标出预览中所有超差像素。点击图像可查看原始尺寸。</p><nav><a href="#Sketch">Sketch 六图</a><a href="#Figma">Figma 六图</a></nav>' +
      sections.join("") +
      "</html>",
  );
} finally {
  await browser.close();
}
