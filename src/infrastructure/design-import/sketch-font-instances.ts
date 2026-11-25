/** Resolve an embedded PostScript face such as a named variable-font instance to
 * its design coordinates. CoreText's named "Medium" is not necessarily wght=500. */
export function sketchFontInstances(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map<string, DataView>();
  const out = new Map<string, Record<string, number>>();
  if (view.byteLength < 12) return out;
  const tag = (v: DataView, p: number) =>
    String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset + p, 4));
  for (let i = 0; i < view.getUint16(4); i++) {
    const p = 12 + i * 16;
    if (p + 16 > view.byteLength) return out;
    const name = tag(view, p),
      start = view.getUint32(p + 8),
      len = view.getUint32(p + 12);
    if ((name === "name" || name === "fvar") && start + len <= view.byteLength)
      tables.set(
        name,
        new DataView(bytes.buffer, bytes.byteOffset + start, len),
      );
  }
  const names = tables.get("name"),
    fvar = tables.get("fvar");
  if (!names || !fvar || names.byteLength < 6 || fvar.byteLength < 16)
    return out;
  const strings = new Map<number, string>(),
    offset = names.getUint16(4);
  const decode = new TextDecoder("utf-16be");
  for (let i = 0; i < names.getUint16(2); i++) {
    const p = 6 + i * 12;
    if (p + 12 > names.byteLength) return out;
    const platform = names.getUint16(p),
      id = names.getUint16(p + 6),
      len = names.getUint16(p + 8),
      at = offset + names.getUint16(p + 10);
    if (
      (platform === 0 || platform === 3) &&
      at + len <= names.byteLength &&
      len < 512 &&
      !strings.has(id)
    )
      strings.set(
        id,
        decode.decode(new Uint8Array(names.buffer, names.byteOffset + at, len)),
      );
  }
  const first = fvar.getUint16(4),
    count = fvar.getUint16(8),
    axisSize = fvar.getUint16(10),
    numInstances = fvar.getUint16(12),
    stride = fvar.getUint16(14);
  const start = first + count * axisSize;
  if (
    count > 64 ||
    axisSize < 20 ||
    stride < 6 + 4 * count ||
    start + numInstances * stride > fvar.byteLength
  )
    return out;
  const axes = Array.from({ length: count }, (_, i) =>
    tag(fvar, first + i * axisSize),
  );
  if (axes.some((axis) => !/^[a-zA-Z0-9 ]{4}$/.test(axis))) return out;
  for (let i = 0; i < numInstances; i++) {
    const pos = start + i * stride,
      name = strings.get(fvar.getUint16(pos + 4 + 4 * count));
    if (name)
      out.set(
        name,
        Object.fromEntries(
          axes.map((axis, j) => [axis, fvar.getInt32(pos + 4 + 4 * j) / 65536]),
        ),
      );
  }
  return out;
}
