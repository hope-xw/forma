// Kiwi messages carry a binary type table. Interpret its field IDs as data.
import { figmaHeader, unsupportedFigma } from "./types";
import { Inflate } from "fflate";
import { Decompress } from "fzstd";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const invalid = (detail: string) => new Error("Figma 数据无效：" + detail);
class Cursor {
  offset = 0;
  view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  take(n: number) {
    if (this.offset + n > this.bytes.length) throw invalid("字段被截断");
    const start = this.offset;
    this.offset += n;
    return start;
  }
  byte() {
    return this.bytes[this.take(1)];
  }
  uint() {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const b = this.byte();
      if (shift === 28 && b > 15) break;
      value += (b & 127) * 2 ** shift;
      if (b < 128) return value;
    }
    throw invalid("整数超出范围");
  }
  signed() {
    const n = this.uint();
    return (n >>> 1) ^ -(n & 1);
  }
  text() {
    const end = this.bytes.indexOf(0, this.offset);
    if (end < 0 || end - this.offset > 2_000_000)
      throw invalid("字符串超限或未终止");
    const str = utf8.decode(this.bytes.subarray(this.offset, end));
    this.offset = end + 1;
    return str;
  }
}
type Field = { name: string; type: number; array: boolean; id: number };
type Definition = {
  name: string;
  kind: number;
  fields: Field[];
  byId: Map<number, Field>;
};
function readSchema(bytes: Uint8Array) {
  const input = new Cursor(bytes);
  const count = input.uint();
  if (count > 4096) throw invalid("类型表超限");
  const definitions: Definition[] = [];
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    const name = input.text(),
      kind = input.byte(),
      fields: Field[] = [],
      byId = new Map<number, Field>();
    if (kind > 2 || names.has(name)) throw invalid("类型定义无效");
    names.add(name);
    const length = input.uint();
    if (length > 8192) throw invalid("类型字段超限");
    for (let j = 0; j < length; j++) {
      const field = {
        name: input.text(),
        type: input.signed(),
        array: !!(input.byte() & 1),
        id: input.uint(),
      };
      if (
        field.type < -8 ||
        field.type >= count ||
        (kind !== 1 && byId.has(field.id))
      )
        throw invalid("字段定义无效");
      fields.push(field);
      byId.set(field.id, field);
    }
    definitions.push({ name, kind, fields, byId });
  }
  if (input.offset !== bytes.length) throw invalid("类型表长度不符");
  return definitions;
}

function decode(schema: Uint8Array, bytes: Uint8Array): unknown {
  const definitions = readSchema(schema);
  const input = new Cursor(bytes);
  const floatBits = new DataView(new ArrayBuffer(4));
  let work = 0;
  function value(type: number, depth: number): unknown {
    if (depth > 160 || ++work > 20_000_000) throw invalid("消息复杂度超限");
    switch (type) {
      case -1:
        return !!input.byte();
      case -2:
        return input.byte();
      case -3:
        return input.signed();
      case -4:
        return input.uint();
      case -5: {
        if (input.bytes[input.offset] === 0) {
          input.take(1);
          return 0;
        }
        const bits = input.view.getUint32(input.take(4), true);
        floatBits.setUint32(0, (bits << 23) | (bits >>> 9));
        return floatBits.getFloat32(0);
      }
      case -6:
        return input.text();
      case -7:
      case -8: {
        let n = 0n;
        for (let i = 0; i < 9; i++) {
          const b = input.byte();
          n |= BigInt(i === 8 ? b : b & 127) << BigInt(i * 7);
          if (b < 128 || i === 8) break;
        }
        return type === -7 ? (n >> 1n) ^ -(n & 1n) : n;
      }
    }
    const def = definitions[type];
    if (!def) throw invalid("未定义类型");
    if (def.kind === 0) {
      const id = input.uint();
      return def.byId.get(id)?.name ?? `UNKNOWN_ENUM_${id}`;
    }
    const result: Record<string, unknown> = Object.create(null);
    function read(field: Field) {
      if (!field.array) {
        result[field.name] = value(field.type, depth + 1);
        return;
      }
      const n = input.uint();
      if (field.type === -2) {
        const start = input.take(n);
        result[field.name] = bytes.subarray(start, start + n);
        return;
      }
      if (n > 1_000_000) throw invalid("数组超限");
      const values: unknown[] = [];
      for (let j = 0; j < n; j++) values.push(value(field.type, depth + 1));
      result[field.name] = values;
    }
    if (def.kind === 1) for (const field of def.fields) read(field);
    else
      for (let id = input.uint(); id !== 0; id = input.uint()) {
        const field = def.byId.get(id);
        if (!field || Object.hasOwn(result, field.name))
          throw invalid("未知或重复消息字段");
        read(field);
      }
    return result;
  }
  const root = definitions.findIndex(
    (d) => d.name === "Message" && d.kind === 2,
  );
  if (root < 0) throw invalid("缺少 Message");
  const message = value(root, 0);
  if (input.offset !== bytes.length) throw invalid("消息尾部长度不符");
  return message;
}

// Validate the zstd window and the boundary of the single frame before fzstd allocates.
function validateZstd(data: Uint8Array, limit: number) {
  const c = new Cursor(data);
  c.take(4);
  const flags = c.byte(),
    single = !!(flags & 32);
  if (flags & 8) throw invalid("Zstd 帧描述符");
  if (!single) {
    const d = c.byte(),
      base = 2 ** (10 + (d >> 3));
    if (base * (1 + (d & 7) / 8) > limit) throw invalid("Zstd 窗口超限");
  }
  c.take([0, 1, 2, 4][flags & 3]);
  const flag = flags >> 6,
    sizeBytes = flag ? 2 ** flag : Number(single);
  let size = flag === 1 ? 256 : 0;
  for (let i = 0; i < sizeBytes; i++) size += c.byte() * 2 ** (8 * i);
  if (size > limit) throw invalid("Zstd 内容超限");
  let last = false;
  while (!last) {
    const block = c.byte() | (c.byte() << 8) | (c.byte() << 16);
    last = !!(block & 1);
    const type = (block >> 1) & 3;
    if (type === 3) throw invalid("Zstd 块类型");
    c.take(type === 1 ? 1 : block >>> 3);
  }
  if (flags & 4) c.take(4);
  if (c.offset !== data.length) throw invalid("Zstd 尾部长度不符");
}
function unpack(data: Uint8Array, limit: number) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const chunk = (out: Uint8Array) => {
    length += out.length;
    if (length > limit) throw invalid("解压数据超限");
    chunks.push(out.slice());
  };
  const zstd =
    data[0] === 40 && data[1] === 181 && data[2] === 47 && data[3] === 253;
  if (zstd) validateZstd(data, limit);
  const stream = zstd ? new Decompress(chunk) : new Inflate(chunk);
  for (let i = 0; i < data.length; i += 8192)
    stream.push(data.subarray(i, i + 8192), i + 8192 >= data.length);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of chunks) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
export function readFigmaCanvas(data: Uint8Array) {
  const header = figmaHeader(data);
  if (header === "unsupported") throw Error(unsupportedFigma);
  if (data.length > 256 * 1024 * 1024 || header !== "design")
    throw invalid("需要 Figma Design 的 fig-kiwi 文件");
  const c = new Cursor(data);
  c.take(8);
  const version = c.view.getUint32(c.take(4), true);
  const part = () => {
    const length = c.view.getUint32(c.take(4), true);
    const start = c.take(length);
    return data.subarray(start, start + length);
  };
  const schema = unpack(part(), 2 * 1024 * 1024),
    message = unpack(part(), 128 * 1024 * 1024);
  const extra = c.offset < data.length;
  return { version, extra, message: decode(schema, message) };
}
