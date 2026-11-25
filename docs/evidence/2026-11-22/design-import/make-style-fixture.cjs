const {
  encodeBinarySchema,
  compileSchema,
  parseSchema,
} = require("kiwi-schema");
const { deflateRawSync } = require("node:zlib");
const { writeFileSync } = require("node:fs");
const schema = parseSchema(`
struct Guid { uint sessionID; uint localID; }
struct Parent { Guid guid; string position; }
struct Size { float x; float y; }
struct Color { float r; float g; float b; float a; }
struct Ref { Guid guid; }
message Paint { string type = 1; Color color = 2; bool visible = 3; float opacity = 4; }
message Node { Guid guid = 1; string type = 2; string name = 3; Parent parentIndex = 4; Size size = 5; bool internalOnly = 6; string styleType = 7; Ref styleIdForFill = 8; Ref styleIdForStrokeFill = 9; Paint[] fillPaints = 10; Paint[] strokePaints = 11; float strokeWeight = 12; }
message Message { Node[] nodeChanges = 1; }
`);
const g = (localID) => ({ sessionID: 1, localID });
const n = (i, type, name, p, pos, props) => ({
  guid: g(i),
  type,
  name,
  ...(p ? { parentIndex: { guid: g(p), position: pos } } : {}),
  ...props,
});
const paint = (r, g, b) => [
  { type: "SOLID", visible: true, opacity: 1, color: { r, g, b, a: 1 } },
];
const blue = paint(0, 0, 1);
const size = { x: 160, y: 160 };
const msg = {
  nodeChanges: [
    n(1, "DOCUMENT", "Paint links"),
    n(2, "CANVAS", "色板", 1, "!"),
    n(3, "CANVAS", "内部", 1, "~", { internalOnly: true }),
    n(4, "FRAME", "蓝底白卡", 2, "!", {
      size,
      styleIdForFill: { guid: g(6) },
      fillPaints: blue,
    }),
    n(5, "RECTANGLE", "边线", 4, "!", {
      size: { x: 96, y: 96 },
      strokePaints: blue,
      strokeWeight: 6,
      styleIdForStrokeFill: { guid: g(6) },
      fillPaints: paint(1, 1, 1),
    }),
    n(6, "RECTANGLE", "品牌蓝", 3, "!", {
      styleType: "FILL",
      fillPaints: blue,
      size,
    }),
  ],
};
const chunks = [
  encodeBinarySchema(schema),
  compileSchema(schema).encodeMessage(msg),
].map((x) => {
  const b = deflateRawSync(x),
    l = Buffer.alloc(4);
  l.writeUInt32LE(b.length);
  return Buffer.concat([l, b]);
});
const header = Buffer.from("fig-kiwi\0\0\0\0");
header.writeUInt32LE(101, 8);
writeFileSync(process.argv[2], Buffer.concat([header, ...chunks]));
