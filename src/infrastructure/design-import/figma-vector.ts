// Figma stores the stroke's centerline in normalized network coordinates.
// Follow each connected chain so caps, joins and editable Bézier handles survive.
function readNetwork(bytes: unknown, sx: number, sy: number) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 12 ||
    !Number.isFinite(sx + sy)
  )
    return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u = (offset: number) => view.getUint32(offset, true);
  const f = (offset: number) => view.getFloat32(offset, true);
  const vertices = u(0),
    segments = u(4),
    start = 12 + vertices * 12;
  if (
    !segments ||
    segments > 8192 ||
    vertices > 8192 ||
    start + segments * 28 > bytes.length
  )
    return;
  const links = Array.from({ length: vertices }, () => [] as number[]);
  const point = (index: number, dx = 0, dy = 0) => {
    const x = (f(16 + index * 12) + dx) * sx,
      y = (f(20 + index * 12) + dy) * sy;
    return Number(x.toFixed(5)) + " " + Number(y.toFixed(5));
  };
  const edges = Array.from({ length: segments }, (_, i) => {
    const off = start + i * 28;
    return {
      a: u(off + 4),
      ax: f(off + 8),
      ay: f(off + 12),
      b: u(off + 16),
      bx: f(off + 20),
      by: f(off + 24),
    };
  });
  for (const [i, e] of edges.entries()) {
    if (!links[e.a] || !links[e.b]) return;
    links[e.a].push(i);
    links[e.b].push(i);
  }
  function segment(at: number, index: number) {
    const e = edges[index];
    if (!e || (e.a !== at && e.b !== at)) return;
    const forward = e.a === at,
      next = forward ? e.b : e.a;
    const command =
      e.ax || e.ay || e.bx || e.by
        ? "C" +
          point(at, forward ? e.ax : e.bx, forward ? e.ay : e.by) +
          " " +
          point(next, forward ? e.bx : e.ax, forward ? e.by : e.ay) +
          " " +
          point(next)
        : "L" + point(next);
    return { next, command };
  }
  return {
    segments,
    start: start + segments * 28,
    regions: u(8),
    u,
    point,
    edges,
    links,
    segment,
    bytes: bytes.length,
  };
}
export function networkStroke(
  bytes: unknown,
  sx: number,
  sy: number,
): string | undefined {
  const net = readNetwork(bytes, sx, sy);
  if (!net) return;
  const { segments, links, point, edges, segment } = net;
  const used = new Uint8Array(segments),
    commands: string[] = [];
  function chain(first: number, startEdge: number) {
    let at = first,
      index: number | undefined = startEdge;
    commands.push("M" + point(at));
    while (index !== undefined && !used[index]) {
      used[index] = 1;
      const step = segment(at, index)!;
      commands.push(step.command);
      at = step.next;
      if (at === first) {
        commands.push("Z");
        break;
      }
      index =
        links[at].length === 2 ? links[at].find((i) => !used[i]) : undefined;
    }
  }
  for (const [i, list] of links.entries())
    if (list.length !== 2)
      for (const edge of list) if (!used[edge]) chain(i, edge);
  for (const [i, e] of edges.entries()) if (!used[i]) chain(e.a, i);
  const d = commands.join(" ");
  return d.length <= 100000 && !/NaN|Infinity/.test(d) ? d : undefined;
}

// Unlike stroke centerlines, filled regions have explicit loop membership and
// winding. Shared edges may run in opposite directions in neighbouring regions.
export function networkRegions(bytes: unknown, sx: number, sy: number) {
  const n = readNetwork(bytes, sx, sy);
  if (!n || n.regions > 100) return;
  let off = n.start;
  const paths: {
    d: string;
    fillRule: "nonzero" | "evenodd";
    styleID: number;
  }[] = [];
  for (let r = 0; r < n.regions; r++) {
    if (off + 8 > n.bytes) return;
    const packed = n.u(off),
      loops = n.u(off + 4),
      commands: string[] = [];
    if (loops > 8192) return;
    off += 8;
    for (let l = 0; l < loops; l++) {
      if (off + 4 > n.bytes) return;
      const count = n.u(off);
      off += 4;
      if (!count || count > 8192 || off + 4 * count > n.bytes) return;
      const indices = Array.from({ length: count }, (_, i) => n.u(off + 4 * i));
      off += 4 * count;
      const first = n.edges[indices[0]],
        second = count > 1 ? n.edges[indices[1]] : first;
      if (!first || !second) return;
      const start =
        second.a === first.b || second.b === first.b ? first.a : first.b;
      let at = start;
      commands.push("M" + n.point(at));
      for (const id of indices) {
        const step = n.segment(at, id);
        if (!step) return;
        commands.push(step.command);
        at = step.next;
      }
      if (at !== start) return;
      commands.push("Z");
    }
    const d = commands.join(" ");
    if (d.length > 100000 || /NaN|Infinity/.test(d)) return;
    if (d)
      paths.push({
        d,
        fillRule: packed & 1 ? "nonzero" : "evenodd",
        styleID: packed >>> 1,
      });
  }
  return paths;
}
