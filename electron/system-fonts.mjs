// parseFontFamilies also runs in the renderer. Only host operations access Node builtins.
const MAX_RESPONSE_FONT_BYTES = 48 * 1024 * 1024;
const maxFileBytes = 64 * 1024 * 1024;
const maxCollectionBytes = 160 * 1024 * 1024;
const sans = [
  "SF Pro Text",
  "SF Pro Display",
  "SF Pro",
  "PingFang SC",
  "Hiragino Sans GB",
  "Helvetica Neue",
  "STHeiti",
  "Arial Unicode MS",
  "Arial",
  "Noto Sans CJK SC",
  "Segoe UI",
  "Microsoft YaHei",
  "DejaVu Sans",
];
const mono = [
  "SF Mono",
  "Menlo",
  "Monaco",
  "JetBrains Mono",
  "PingFang SC",
  "Courier New",
];
const generics = new Map([
  ...["system-ui", "-apple-system", "blinkmacsystemfont", "sans-serif"].map(
    (name) => [name, sans],
  ),
  [
    "serif",
    [
      "New York",
      "Songti SC",
      "STSong",
      "Times New Roman",
      "Georgia",
      "Noto Serif CJK SC",
    ],
  ],
  ["monospace", mono],
  ["ui-monospace", mono],
]);
const extensions = new Set([".ttf", ".otf", ".ttc", ".otc"]);
const metadataTags = new Set(["name", "OS/2", "head", "fvar", "cmap"]);
const utf16 = new TextDecoder("utf-16be");
const macEncodings = new Map([
  [0, "macintosh"],
  [1, "shift_jis"],
  [2, "big5"],
  [3, "euc-kr"],
  [25, "gb18030"],
]);

async function rootsForPlatform() {
  const path = process.getBuiltinModule("node:path");
  const { readdir } = process.getBuiltinModule("node:fs/promises");
  const home = process.getBuiltinModule("node:os").homedir();
  if (process.platform === "darwin") {
    const assets = "/System/Library/AssetsV2";
    const entries = await readdir(assets, { withFileTypes: true }).catch(
      () => [],
    );
    return [
      "/System/Library/Fonts",
      "/System/Library/Fonts/Supplemental",
      "/Library/Fonts",
      path.join(home, "Library/Fonts"),
      ...entries
        .filter(
          (e) =>
            e.isDirectory() && e.name.startsWith("com_apple_MobileAsset_Font"),
        )
        .map((e) => path.join(assets, e.name)),
    ];
  }
  if (process.platform === "win32") {
    return [
      path.join(process.env.WINDIR || "C:\\Windows", "Fonts"),
      ...(process.env.LOCALAPPDATA
        ? [path.join(process.env.LOCALAPPDATA, "Microsoft/Windows/Fonts")]
        : []),
    ];
  }
  return [
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    path.join(home, ".local/share/fonts"),
    path.join(home, ".fonts"),
  ];
}

function inside(roots, file) {
  const path = process.getBuiltinModule("node:path");
  return roots.some((root) => {
    const rel = path.relative(root, file);
    return (
      rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)
    );
  });
}

function fileFingerprint(info) {
  return info && [info.size, info.mtimeMs, info.ctimeMs, info.ino].join("/");
}

function checkIndexedFile(stat, face) {
  if (fileFingerprint(stat) !== face.fingerprint)
    throw resolveError("STALE_INDEX", "系统字体文件已更新");
}

async function openFont(file, roots, expected) {
  const path = process.getBuiltinModule("node:path");
  const { constants, open, realpath } =
    process.getBuiltinModule("node:fs/promises");
  const canonical = await realpath(file);
  if (
    !inside(roots, canonical) ||
    !extensions.has(path.extname(canonical).toLowerCase())
  )
    throw Error("字体路径无效");
  const handle = await open(
    canonical,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (expected) checkIndexedFile(stat, expected);
    const limit = /\.[to]tc$/i.test(canonical)
      ? maxCollectionBytes
      : maxFileBytes;
    if (!stat.isFile() || stat.size < 12 || stat.size > limit)
      throw Error("字体文件大小无效");
    return { handle, stat };
  } catch (e) {
    await handle.close();
    throw e;
  }
}

async function slice(file, offset, length) {
  if (offset + length > file.stat.size) throw Error("字体目录越界");
  const data = Buffer.alloc(length);
  let n = 0;
  while (n < length) {
    const { bytesRead } = await file.handle.read(
      data,
      n,
      length - n,
      offset + n,
    );
    if (!bytesRead) throw Error("字体文件不完整");
    n += bytesRead;
  }
  return data;
}

function names(data) {
  const families = new Set(),
    aliases = new Set(),
    subfamilies = new Set();
  let family,
    score = -1;
  const count = data.readUInt16BE(2),
    storage = data.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const at = 6 + 12 * i,
      platform = data.readUInt16BE(at),
      id = data.readUInt16BE(at + 6);
    if (![1, 2, 4, 6, 16, 17].includes(id)) continue;
    const offset = storage + data.readUInt16BE(at + 10),
      end = offset + data.readUInt16BE(at + 8);
    if (end > data.length) continue;
    let decoder = utf16;
    if (platform === 1) {
      const label = macEncodings.get(data.readUInt16BE(at + 2));
      if (!label) continue;
      decoder = new TextDecoder(label);
    } else if (platform !== 0 && platform !== 3) continue;
    const name = decoder.decode(data.subarray(offset, end));
    if (!name.trim()) continue;
    if (id === 2 || id === 17) {
      subfamilies.add(name);
      continue;
    }
    aliases.add(name.toLowerCase());
    if (id !== 1 && id !== 16) continue;
    families.add(name);
    const lang = data.readUInt16BE(at + 4);
    const priority =
      (lang === 0x409 || (platform === 1 && lang === 0) ? 4 : 0) +
      (id === 16 ? 2 : 0) +
      (platform === 3 ? 1 : 0);
    if (priority > score) {
      family = name;
      score = priority;
    }
  }
  return { family, families, aliases, subfamilies };
}

// Keep sorted inclusive ranges, excluding glyph zero, including format 4's
// indirect mappings and holes. Shared TTC cmap tables share one coverage index.
function cmapRanges(table) {
  const ranges = [],
    visited = new Set();
  for (let i = 0; i < table.readUInt16BE(2); i++) {
    const rec = 4 + i * 8,
      platform = table.readUInt16BE(rec),
      encoding = table.readUInt16BE(rec + 2);
    if (platform !== 0 && !(platform === 3 && [1, 10].includes(encoding)))
      continue;
    const start = table.readUInt32BE(rec + 4);
    if (visited.has(start)) continue;
    visited.add(start);
    const format = table.readUInt16BE(start);
    if (format !== 4 && format !== 12) continue;
    const length =
      format === 4
        ? table.readUInt16BE(start + 2)
        : table.readUInt32BE(start + 4);
    if (start + length > table.length) throw Error("字符映射越界");
    const data = table.subarray(start, start + length);
    if (format === 12) {
      for (let j = 0; j < data.readUInt32BE(12); j++) {
        const at = 16 + j * 12,
          first =
            data.readUInt32BE(at) + (data.readUInt32BE(at + 8) === 0 ? 1 : 0),
          last = data.readUInt32BE(at + 4);
        if (first <= last && last <= 0x10ffff) ranges.push([first, last]);
      }
    } else {
      const n = data.readUInt16BE(6) / 2;
      let previous = -1;
      for (let j = 0; j < n; j++) {
        const first = data.readUInt16BE(16 + 2 * n + 2 * j),
          last = data.readUInt16BE(14 + 2 * j);
        if (first <= previous || first > last) throw Error("字符映射次序无效");
        previous = last;
        const delta = data.readUInt16BE(16 + 4 * n + 2 * j),
          at = 16 + 6 * n + 2 * j,
          offset = data.readUInt16BE(at);
        let run = first;
        for (let cp = first; cp <= last; cp++) {
          const raw = offset
            ? data.readUInt16BE(at + offset + (cp - first) * 2)
            : cp;
          if ((!offset || raw) && (raw + delta) & 0xffff) continue;
          if (run < cp) ranges.push([run, cp - 1]);
          run = cp + 1;
        }
        if (run <= last) ranges.push([run, last]);
      }
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [lo, hi] of ranges) {
    const end = merged.length - 1;
    if (end >= 0 && lo <= merged[end] + 1)
      merged[end] = Math.max(merged[end], hi);
    else merged.push(lo, hi);
  }
  return Uint32Array.from(merged);
}

function covers(face, cp) {
  const ranges = face.ranges;
  let lo = 0,
    hi = ranges.length / 2;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cp > ranges[mid * 2 + 1]) lo = mid + 1;
    else hi = mid;
  }
  return lo * 2 < ranges.length && cp >= ranges[lo * 2];
}

async function indexFont(filename, roots) {
  const { createHash } = process.getBuiltinModule("node:crypto");
  const file = await openFont(filename, roots);
  try {
    const header = await slice(file, 0, 12);
    const collection = header.toString("latin1", 0, 4) === "ttcf";
    const count = collection ? header.readUInt32BE(8) : 1;
    if (!count || count > 4096) return [];
    const offsets = collection && (await slice(file, 12, count * 4));
    const result = [],
      cache = new Map();
    for (let faceIndex = 0; faceIndex < count; faceIndex++) {
      const offset = offsets ? offsets.readUInt32BE(faceIndex * 4) : 0;
      const face = offsets ? await slice(file, offset, 12) : header;
      const signature = face.toString("latin1", 0, 4);
      if (
        face.readUInt32BE(0) !== 0x10000 &&
        !["OTTO", "true"].includes(signature)
      )
        continue;
      const directory = await slice(
        file,
        offset + 12,
        face.readUInt16BE(4) * 16,
      );
      const tables = new Map();
      for (let at = 0; at < directory.length; at += 16) {
        const tag = directory.toString("latin1", at, at + 4);
        if (!metadataTags.has(tag)) continue;
        const pos = directory.readUInt32BE(at + 8),
          size = directory.readUInt32BE(at + 12);
        const key = [tag, pos, size].join("/");
        if (!cache.has(key)) {
          if (size > 4 * 1024 * 1024) throw Error("字体元数据过大");
          const bytes = await slice(file, pos, size);
          cache.set(
            key,
            tag === "cmap"
              ? cmapRanges(bytes)
              : tag === "name"
                ? names(bytes)
                : bytes,
          );
        }
        tables.set(tag, cache.get(key));
      }
      const name = tables.get("name"),
        ranges = tables.get("cmap");
      if (!name?.family || !ranges?.length) continue;
      const os2 = tables.get("OS/2"),
        head = tables.get("head"),
        fvar = tables.get("fvar");
      const macStyle = head?.length >= 46 ? head.readUInt16BE(44) : 0;
      const weight =
        (os2?.length >= 6 && os2.readUInt16BE(4)) || (macStyle & 1 ? 700 : 400);
      const italic = !!(
        macStyle & 2 ||
        (os2?.length >= 64 && os2.readUInt16BE(62) & 1) ||
        [...name.subfamilies].some((s) => /italic|oblique/i.test(s))
      );
      let min = weight,
        max = weight;
      if (fvar?.length >= 16 && fvar.readUInt16BE(10) >= 20) {
        for (let j = 0; j < fvar.readUInt16BE(8); j++) {
          const at = fvar.readUInt16BE(4) + j * fvar.readUInt16BE(10);
          if (
            at + 20 <= fvar.length &&
            fvar.toString("latin1", at, at + 4) === "wght"
          ) {
            min = fvar.readInt32BE(at + 4) / 65536;
            max = fvar.readInt32BE(at + 12) / 65536;
            break;
          }
        }
      }
      result.push({
        ...name,
        min,
        max,
        weight,
        italic,
        ranges,
        filename,
        faceId: createHash("sha256")
          .update(filename + "/" + offset)
          .digest("hex"),
        directoryOffset: offset,
        collection,
        fingerprint: fileFingerprint(file.stat),
        format: signature === "OTTO" ? "otf" : "ttf",
      });
    }
    return result;
  } finally {
    await file.handle.close();
  }
}

// A directory keeps its cached entry count while its stat metadata is stable.
// If the signature changes, reuse the fresh listing for the ensuing rescan.
async function directorySnapshot(dir, previous) {
  const { readdir, stat } = process.getBuiltinModule("node:fs/promises");
  const info = await stat(dir).catch(() => undefined);
  const stamp = fileFingerprint(info) ?? "missing";
  if (previous?.stamp === stamp) return previous;
  const entries = info
    ? await readdir(dir, { withFileTypes: true }).catch(() => [])
    : [];
  return { stamp, fingerprint: stamp + "/" + entries.length, entries };
}
async function scan(roots, changedDir, previousFiles) {
  const path = process.getBuiltinModule("node:path");
  const { realpath } = process.getBuiltinModule("node:fs/promises");
  const files = new Set(),
    directories = new Map();
  async function visit(dir, depth) {
    if (directories.has(dir) || !inside(roots, dir)) return;
    const { entries, stamp, fingerprint } =
      changedDir?.dir === dir
        ? changedDir.snapshot
        : await directorySnapshot(dir);
    directories.set(dir, { stamp, fingerprint });
    for (const e of entries) {
      const filename = path.join(dir, e.name);
      if (e.isDirectory() && depth < 5) await visit(filename, depth + 1);
      else if (
        (e.isFile() || e.isSymbolicLink()) &&
        extensions.has(path.extname(e.name).toLowerCase())
      ) {
        const resolved = await realpath(filename).catch(() => null);
        if (resolved && inside(roots, resolved)) files.add(resolved);
      }
    }
  }
  for (const root of roots) {
    const canonical = await realpath(root).catch(() => null);
    if (canonical) await visit(canonical, 0);
    else directories.set(root, await directorySnapshot(root));
  }
  const indexedFiles = await readIndexedFiles(
    roots,
    [...files].sort(),
    previousFiles,
  );
  return familyIndex(roots, directories, indexedFiles);
}

async function readIndexedFiles(roots, filenames, previous) {
  const { stat } = process.getBuiltinModule("node:fs/promises");
  const indexed = new Map();
  // Bound simultaneous stats and open fonts, including on a negative lookup.
  for (let i = 0; i < filenames.length; i += 8) {
    const batch = await Promise.all(
      filenames.slice(i, i + 8).map(async (filename) => {
        const info = await stat(filename).catch(() => undefined);
        const old = previous?.get(filename);
        const fingerprint = fileFingerprint(info);
        if (old && old.fingerprint === fingerprint) return [filename, old];
        const faces = info
          ? await indexFont(filename, roots).catch(() => [])
          : [];
        return [
          filename,
          { fingerprint: faces[0]?.fingerprint ?? fingerprint, faces },
        ];
      }),
    );
    for (const [filename, entry] of batch) indexed.set(filename, entry);
  }
  return indexed;
}

function familyIndex(roots, directories, files) {
  const faces = [...files.values()].flatMap((entry) => entry.faces);
  // The alias index is also a negative cache: absence is authoritative for
  // this directory generation, without allocating a key for every user query.
  const byFamily = new Map();
  for (const face of faces) {
    for (const alias of face.aliases) {
      if (!byFamily.has(alias)) byFamily.set(alias, []);
      byFamily.get(alias).push(face);
    }
  }
  return { roots, faces, directories, files, byFamily };
}

function resolveError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Only the trusted host chooses roots and limits. IPC and HTTP accept font queries.
export function createSystemFontResolver(
  getRoots = rootsForPlatform,
  byteLimit = MAX_RESPONSE_FONT_BYTES,
) {
  let index,
    checking,
    checkedAt = -Infinity,
    filesCheckedAt = -Infinity,
    inFlight = 0;
  async function installed(staleIndex, needsFileCheck) {
    if (checking) {
      await checking;
      return installed(staleIndex, needsFileCheck);
    }
    // A concurrent reader may already have replaced the stale generation.
    if (index && staleIndex && staleIndex !== index) return index;
    const checkDirs = Date.now() - checkedAt >= 2000;
    const checkFiles =
      index && Date.now() - filesCheckedAt >= 2000 && needsFileCheck?.(index);
    if (index && !staleIndex && !checkDirs && !checkFiles) return index;
    checking = (async () => {
      let changedDir;
      if (index && !staleIndex) {
        if (checkDirs)
          for (const [dir, previous] of index.directories) {
            const snapshot = await directorySnapshot(dir, previous);
            if (snapshot.fingerprint !== previous.fingerprint) {
              changedDir = { dir, snapshot };
              break;
            }
          }
        if (!changedDir) {
          if (checkFiles) {
            const files = await readIndexedFiles(
              index.roots,
              [...index.files.keys()],
              index.files,
            );
            if (
              [...files].some(
                ([name, entry]) => entry !== index.files.get(name),
              )
            )
              index = familyIndex(index.roots, index.directories, files);
            filesCheckedAt = Date.now();
          }
          return index;
        }
      }
      index = await scan(await getRoots(), changedDir, index?.files);
      filesCheckedAt = Date.now();
      return index;
    })().finally(() => {
      checking = undefined;
      if (checkDirs || staleIndex) checkedAt = Date.now();
    });
    return checking;
  }
  return {
    async listSystemFontFamilies() {
      const { faces } = await installed();
      return [...new Set(faces.flatMap((f) => [...f.families]))].sort((a, b) =>
        a.localeCompare(b),
      );
    },
    async resolveSystemFonts(req) {
      validateSystemFontRequest(req);
      if (inFlight >= 2)
        throw resolveError("BUSY", "系统字体解析繁忙，请稍后重试");
      inFlight++;
      try {
        return await resolveFaces(req, installed, byteLimit);
      } finally {
        inFlight--;
      }
    },
  };
}
export const { listSystemFontFamilies, resolveSystemFonts } =
  /* @__PURE__ */ createSystemFontResolver();

function validateSystemFontRequest(req) {
  if (
    !req ||
    typeof req.fontFamily !== "string" ||
    req.fontFamily.length > 512 ||
    !Number.isFinite(req.fontWeight) ||
    req.fontWeight < 1 ||
    req.fontWeight > 1000 ||
    !["normal", "italic"].includes(req.fontStyle) ||
    typeof req.text !== "string" ||
    req.text.length > 50000 ||
    (req.declaredOnly !== undefined && typeof req.declaredOnly !== "boolean") ||
    (req.excludeFaces !== undefined &&
      (!Array.isArray(req.excludeFaces) ||
        req.excludeFaces.length > 24 ||
        req.excludeFaces.some(
          (f) => typeof f !== "string" || f.length > 512,
        ))) ||
    (req.maxFaces !== undefined &&
      (!Number.isInteger(req.maxFaces) || req.maxFaces < 1 || req.maxFaces > 6))
  )
    throw new TypeError("系统字体请求参数无效");
}

// opentype.js 2 reads cmap records backwards and accepts Mac Roman before
// checking its format. Keep the Unicode maps and UVS data at their original
// offsets, omitting obsolete Mac Roman records only when a Unicode map exists.
function normalizeCollectionCmap(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(2);
  if (count > 256 || 4 + count * 8 > bytes.length)
    throw Error("字符映射目录无效");
  let unicode = false;
  const keep = [];
  for (let i = 0; i < count; i++) {
    const at = 4 + i * 8,
      platform = view.getUint16(at),
      encoding = view.getUint16(at + 2);
    const format = view.getUint16(view.getUint32(at + 4));
    if (
      (platform === 0 || (platform === 3 && [1, 10].includes(encoding))) &&
      (format === 4 || format === 12)
    )
      unicode = true;
    if (platform !== 1 || encoding !== 0) keep.push(at);
  }
  if (!unicode || keep.length === count) return;
  keep.forEach((at, i) => bytes.copyWithin(4 + 8 * i, at, at + 8));
  view.setUint16(2, keep.length);
}

// Collection directories use absolute file offsets, even for shared tables.
async function standaloneFace(file, face, reserve) {
  if (!face.collection) {
    reserve(file.stat.size);
    return slice(file, 0, file.stat.size);
  }
  const header = await slice(file, face.directoryOffset, 12);
  const count = header.readUInt16BE(4);
  if (!count || count > 4095) throw Error("字体表数量无效");
  const directory = await slice(file, face.directoryOffset + 12, count * 16);
  let size = 12 + directory.length;
  const tables = [];
  for (let i = 0; i < count; i++) {
    const at = i * 16;
    const offset = directory.readUInt32BE(at + 8);
    const length = directory.readUInt32BE(at + 12);
    if (offset + length > file.stat.size) throw Error("字体目录越界");
    tables.push({ at, offset, length, dest: size });
    size += Math.ceil(length / 4) * 4;
  }
  reserve(size);
  const result = Buffer.alloc(size);
  const exponent = Math.floor(Math.log2(count));
  header.writeUInt32BE(face.format === "otf" ? 0x4f54544f : 0x10000);
  header.writeUInt16BE(16 * 2 ** exponent, 6);
  header.writeUInt16BE(exponent, 8);
  header.writeUInt16BE(16 * (count - 2 ** exponent), 10);
  header.copy(result);
  let adjustment;
  function checksum(start, end) {
    let sum = 0;
    for (let i = start; i < end; i += 4)
      sum = (sum + result.readUInt32BE(i)) >>> 0;
    return sum;
  }
  for (const { at, offset, length, dest } of tables) {
    (await slice(file, offset, length)).copy(result, dest);
    const tag = directory.toString("latin1", at, at + 4);
    if (tag === "cmap")
      normalizeCollectionCmap(result.subarray(dest, dest + length));
    if (tag === "head") {
      if (length < 12) throw Error("字体 head 表无效");
      adjustment = dest + 8;
      result.writeUInt32BE(0, adjustment);
    }
    directory.writeUInt32BE(dest, at + 8);
    directory.writeUInt32BE(checksum(dest, dest + length), at + 4);
  }
  if (adjustment === undefined) throw Error("字体缺少 head 表");
  directory.copy(result, 12);
  result.writeUInt32BE((0xb1b0afba - checksum(0, size)) >>> 0, adjustment);
  return result;
}

export function parseFontFamilies(css) {
  // Consume strings and escapes intact. A comment separates CSS identifier
  // tokens and, without a closing marker, consumes the rest of the input.
  if (css.includes("/*"))
    css = css.replace(
      /\\[\s\S]|"(?:[^"\\]|\\[\s\S])*"?|'(?:[^'\\]|\\[\s\S])*'?|\/\*[\s\S]*?(?:\*\/|$)/gu,
      (token) => (token.startsWith("/*") ? " " : token),
    );
  const families = [];
  let start = 0,
    name = "",
    quote = "",
    quoted = false,
    space = false;
  function finish(end) {
    if (name)
      families.push({
        name,
        quoted,
        css: css.slice(start, end).replace(/^[ \t\n\r\f]+/, ""),
      });
    start = end + 1;
    name = "";
    quote = "";
    quoted = space = false;
  }
  // Consume a complete escape before interpreting commas, quotes or whitespace.
  for (const match of css.matchAll(
    /\\(?:[\da-fA-F]{1,6}(?:\r\n|[ \t\r\n\f])?|\r\n|[\s\S]|$)|[ \t\r\n\f]+|[^\\"', \t\r\n\f]+|["',]/gu,
  )) {
    const token = match[0];
    if (!quote && token === ",") {
      finish(match.index);
    } else if (token === quote) {
      quote = "";
    } else if (!quote && (token === "'" || token === '"')) {
      quote = token;
      quoted = true;
    } else if (!quote && /^[ \t\r\n\f]/.test(token)) {
      space = !!name;
    } else {
      let value = token;
      if (token[0] === "\\") {
        const escaped = token.slice(1);
        if (/^[\r\n\f]/.test(escaped)) continue;
        if (/^[\da-fA-F]/.test(escaped)) {
          const cp = parseInt(escaped, 16);
          value =
            cp && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
              ? String.fromCodePoint(cp)
              : "\ufffd";
        } else value = escaped || "\ufffd";
      }
      name += (space ? " " : "") + value;
      space = false;
    }
  }
  finish(css.length);
  return families;
}

async function resolveFaces(req, installed, byteLimit, staleIndex) {
  const { fontFamily, fontWeight, fontStyle, text, maxFaces = 6 } = req;
  const missing = new Set(
    Array.from(text)
      .filter((c) => !/^\s$/u.test(c))
      .map((c) => c.codePointAt(0)),
  );
  if (!missing.size) return [];
  const order = new Map();
  const explicitRanks = new Set();
  for (const { name, quoted } of parseFontFamilies(fontFamily)) {
    const family = name.toLowerCase();
    const generic = !quoted && generics.get(family);
    for (const expanded of generic || [family]) {
      const key = expanded.toLowerCase();
      if (!order.has(key)) order.set(key, order.size);
      if (!generic) explicitRanks.add(order.get(key));
    }
  }
  const excluded = new Set(req.excludeFaces ?? []);
  const index = await installed(staleIndex, ({ byFamily }) => {
    // Any fallback can mask a newly matching indexed file, including a
    // later member of a generic family or a different style of the first.
    const firstFamily = order.keys().next().value;
    const exact = (byFamily.get(firstFamily) ?? []).filter(
      (face) =>
        !excluded.has(face.faceId) &&
        face.weight === fontWeight &&
        face.italic === (fontStyle === "italic"),
    );
    for (const cp of missing)
      if (!exact.some((face) => covers(face, cp))) return true;
    return false;
  });
  const { roots, byFamily } = index;
  const faces = req.declaredOnly
    ? [
        ...new Set(
          [...order.keys()].flatMap((family) => byFamily.get(family) ?? []),
        ),
      ]
    : index.faces;
  const ranked = faces
    .filter((f) => !excluded.has(f.faceId))
    .map((face) => {
      let rank = order.size;
      for (const alias of face.aliases)
        rank = Math.min(rank, order.get(alias) ?? order.size);
      return {
        face,
        rank,
        style: Number(face.italic !== (fontStyle === "italic")),
        distance: Math.max(face.min - fontWeight, fontWeight - face.max, 0),
      };
    })
    .filter((c) => !req.declaredOnly || c.rank < order.size)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.style - b.style ||
        a.distance - b.distance ||
        Math.abs(a.face.weight - fontWeight) -
          Math.abs(b.face.weight - fontWeight),
    );
  const result = [];
  let remaining = byteLimit;
  while (ranked.length && missing.size && result.length < maxFaces) {
    const points = [...missing];
    let best = -1,
      covered = [];
    for (const [i, candidate] of ranked.entries()) {
      const hits = points.filter((cp) => covers(candidate.face, cp));
      if (
        candidate.rank < order.size &&
        (hits.length ||
          (!excluded.size &&
            !result.length &&
            explicitRanks.has(candidate.rank) &&
            maxFaces > 1))
      ) {
        best = i;
        covered = hits;
        break;
      }
      if (hits.length > covered.length) {
        best = i;
        covered = hits;
        if (hits.length === points.length) break;
      }
    }
    if (best < 0) break;
    const [{ face, rank }] = ranked.splice(best, 1);
    try {
      const file = await openFont(face.filename, roots, face);
      try {
        const bytes = await standaloneFace(file, face, (size) => {
          if (size > remaining)
            throw resolveError("BUDGET_EXCEEDED", "系统字体响应超过字节预算");
          remaining -= size;
        });
        checkIndexedFile(await file.handle.stat(), face);
        result.push({
          family: face.family,
          faceId: face.faceId,
          declaredMatch: rank < order.size,
          familyRank: rank,
          faceIndex: 0,
          format: face.format,
          data: bytes.toString("base64"),
        });
      } finally {
        await file.handle.close();
      }
    } catch (error) {
      if (
        !staleIndex &&
        ["STALE_INDEX", "ENOENT", "ENOTDIR"].includes(error.code)
      ) {
        // Retry the entire selection once: the new bytes may have a different
        // family, face index, style, or cmap. Never reuse partial old results.
        return resolveFaces(req, installed, byteLimit, index);
      }
      if (error.code === "BUDGET_EXCEEDED") {
        if (!result.length) throw error;
        break;
      }
      continue;
    }
    for (const cp of covered) missing.delete(cp);
  }
  return result;
}
