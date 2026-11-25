// A smooth corner joins each straight edge tangentially to a circular arc.
// The two transition lengths are independent when neighboring corners compete
// for space (particularly on capsules and mixed-radius rectangles).
type Point = readonly [number, number];
type Command = { corner: number; op: "M" | "L" | "C"; points: Point[] };
const compact = (n: number) => Number(n.toFixed(4));
export function smoothCorners(
  w: number,
  h: number,
  requested: number[],
  smoothing: number,
  inset = 0,
  symmetric = false,
) {
  const width = Math.max(0, w - 2 * inset);
  const height = Math.max(0, h - 2 * inset);
  const side = [width, height, width, height];
  const radius = requested.map((r, i) => {
    const prev = (i + 3) % 4;
    const next = (i + 1) % 4;
    return Math.max(
      0,
      Math.min(
        r,
        Math.max(side[i] / 2, side[i] - requested[next]),
        Math.max(side[prev] / 2, side[prev] - requested[prev]),
      ),
    );
  });
  const commands: Command[] = [];
  for (let i = 0; i < 4; i++) {
    const r = radius[i],
      prev = (i + 3) % 4,
      next = (i + 1) % 4;
    let entry =
      r +
      Math.max(0, Math.min(r * smoothing, (side[prev] - r - radius[prev]) / 2));
    let exit =
      r +
      Math.max(0, Math.min(r * smoothing, (side[i] - r - radius[next]) / 2));
    // Figma shares a single smoothing budget between the two incident edges.
    if (symmetric) entry = exit = Math.min(entry, exit);
    // Local corner is at (0,0), with the incoming edge along positive x
    // and the outgoing edge along positive y (the top-right orientation).
    const point = (x: number, y: number): Point => {
      const pairs: Point[] = [
        [y, -x],
        [width + x, y],
        [width - y, height + x],
        [-x, height - y],
      ];
      return [compact(pairs[i][0] + inset), compact(pairs[i][1] + inset)];
    };
    const add = (op: Command["op"], ...points: Point[]) =>
      commands.push({ corner: i, op, points });
    add(i ? "L" : "M", point(-entry, 0));
    if (!r) continue;
    const a = ((entry / r - 1) * Math.PI) / 4,
      b = ((exit / r - 1) * Math.PI) / 4;
    const start: Point = [-r + r * Math.sin(a), r - r * Math.cos(a)];
    const end: Point = [-r + r * Math.cos(b), r - r * Math.sin(b)];
    const tangentIn = -r + r * Math.tan(a / 2);
    const tangentOut = r - r * Math.tan(b / 2);
    if (entry > r)
      add(
        "C",
        point((-entry + 2 * tangentIn) / 3, 0),
        point(tangentIn, 0),
        point(...start),
      );
    const control = (4 / 3) * r * Math.tan((Math.PI / 2 - a - b) / 4);
    if (control > 1e-9)
      add(
        "C",
        point(
          start[0] + control * Math.cos(a),
          start[1] + control * Math.sin(a),
        ),
        point(end[0] - control * Math.sin(b), end[1] - control * Math.cos(b)),
        point(...end),
      );
    if (exit > r)
      add(
        "C",
        point(0, tangentOut),
        point(0, (exit + 2 * tangentOut) / 3),
        point(0, exit),
      );
  }
  return commands;
}
export function svgCornerPath(commands: Command[]) {
  return (
    commands
      .map(({ op, points }) => op + points.map((p) => p.join(" ")).join(" "))
      .join("") + "Z"
  );
}
// Anchor control points to their corner so padding or additional space
// in a flex/grid frame leaves the shape of each corner intact.
export function cssCornerShape(
  commands: Command[],
  w: number,
  h: number,
  fluid: boolean,
) {
  if (!fluid) return "path('" + svgCornerPath(commands) + "') border-box";
  // Share an edge between its two corners. CSS recalculates the available
  // percentage on resize; a long straight side preserves the authored radius.
  const insetFromEdge = (n: number, size: number, end: boolean) =>
    compact(end ? size - n : n);
  const ends = [
    [false, false],
    [true, false],
    [true, true],
    [false, true],
  ];
  const size = [w, h];
  const extents = ends.map(() => [0, 0]);
  for (const { corner, points } of commands)
    for (const p of points)
      for (const axis of [0, 1])
        extents[corner][axis] = Math.max(
          extents[corner][axis],
          insetFromEdge(p[axis], size[axis], ends[corner][axis]),
        );
  const coordinate = (corner: number, axis: number, n: number) => {
    const end = ends[corner][axis];
    const distance = insetFromEdge(n, size[axis], end);
    if (!distance) return end ? "100%" : "0px";
    const neighbor = corner ^ (axis === 0 ? 1 : 3);
    const combined = extents[corner][axis] + extents[neighbor][axis];
    const offset =
      "min(" + distance + "px, " + compact((100 * distance) / combined) + "%)";
    return end ? "calc(100% - " + offset + ")" : offset;
  };
  const pair = (corner: number, p: Point) =>
    coordinate(corner, 0, p[0]) + " " + coordinate(corner, 1, p[1]);
  return (
    "shape(" +
    commands
      .map(({ corner, op, points }) =>
        op === "C"
          ? "curve to " +
            pair(corner, points[2]) +
            " with " +
            pair(corner, points[0]) +
            " / " +
            pair(corner, points[1])
          : (op === "M" ? "from " : "line to ") + pair(corner, points[0]),
      )
      .join(", ") +
    ", close) border-box"
  );
}
