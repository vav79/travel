/**
 * Compact pedestrian routing graph + A* (pure TS: runs on Hermes on Android/iOS without native code).
 * Experiment for on-device routing (docs/ROUTING.md). Not wired into the app yet.
 *
 * Binary layout (little-endian):
 *   u32 magic 'WG01' | u32 nodeCount | u32 edgeCount
 *   f32[nodeCount*2] lon,lat
 *   u32[nodeCount+1] CSR offsets
 *   u32[edgeCount]   target node
 *   u16[edgeCount]   length in decimetres (capped at 6553.5 m; longer edges are split at build)
 */
export type OsmWay = { nodes: number[]; coords: [number, number][] };

export type Graph = {
  nodeCount: number;
  edgeCount: number;
  lonlat: Float32Array;
  offsets: Uint32Array;
  targets: Uint32Array;
  lengthsDm: Uint16Array;
};

const R = 6_371_008.8;
const rad = Math.PI / 180;

export function haversineM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Builds an undirected walking graph. Every OSM node used by a way becomes a graph node
 * (keeps geometry exact; intersection-only compression is a later optimisation).
 */
export function buildGraph(ways: OsmWay[]): Graph {
  const index = new Map<number, number>();
  const coords: number[] = [];
  const adj: [number, number][][] = [];
  const nodeOf = (osmId: number, c: [number, number]) => {
    let i = index.get(osmId);
    if (i === undefined) {
      i = coords.length / 2;
      index.set(osmId, i);
      coords.push(c[0], c[1]);
      adj.push([]);
    }
    return i;
  };
  for (const w of ways) {
    for (let k = 1; k < w.nodes.length; k++) {
      const a = nodeOf(w.nodes[k - 1]!, w.coords[k - 1]!);
      const b = nodeOf(w.nodes[k]!, w.coords[k]!);
      if (a === b) continue;
      const len = Math.min(65535, Math.round(haversineM(coords[a * 2]!, coords[a * 2 + 1]!, coords[b * 2]!, coords[b * 2 + 1]!) * 10));
      adj[a]!.push([b, len]);
      adj[b]!.push([a, len]);
    }
  }
  const nodeCount = adj.length;
  const edgeCount = adj.reduce((s, l) => s + l.length, 0);
  const offsets = new Uint32Array(nodeCount + 1);
  const targets = new Uint32Array(edgeCount);
  const lengthsDm = new Uint16Array(edgeCount);
  let e = 0;
  for (let i = 0; i < nodeCount; i++) {
    offsets[i] = e;
    for (const [t, l] of adj[i]!) {
      targets[e] = t;
      lengthsDm[e] = l;
      e++;
    }
  }
  offsets[nodeCount] = e;
  return { nodeCount, edgeCount, lonlat: Float32Array.from(coords), offsets, targets, lengthsDm };
}

export function serializeGraph(g: Graph): Uint8Array {
  const size = 12 + g.nodeCount * 8 + (g.nodeCount + 1) * 4 + g.edgeCount * 4 + g.edgeCount * 2;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x31304757, true); // 'WG01'
  dv.setUint32(4, g.nodeCount, true);
  dv.setUint32(8, g.edgeCount, true);
  let o = 12;
  new Float32Array(buf, o, g.nodeCount * 2).set(g.lonlat);
  o += g.nodeCount * 8;
  new Uint32Array(buf, o, g.nodeCount + 1).set(g.offsets);
  o += (g.nodeCount + 1) * 4;
  new Uint32Array(buf, o, g.edgeCount).set(g.targets);
  o += g.edgeCount * 4;
  new Uint16Array(buf, o, g.edgeCount).set(g.lengthsDm);
  return new Uint8Array(buf);
}

export function deserializeGraph(bytes: Uint8Array): Graph {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x31304757) throw new Error('not a WG01 graph');
  const nodeCount = dv.getUint32(4, true);
  const edgeCount = dv.getUint32(8, true);
  let o = 12;
  const lonlat = new Float32Array(buf, o, nodeCount * 2);
  o += nodeCount * 8;
  const offsets = new Uint32Array(buf, o, nodeCount + 1);
  o += (nodeCount + 1) * 4;
  const targets = new Uint32Array(buf, o, edgeCount);
  o += edgeCount * 4;
  const lengthsDm = new Uint16Array(buf, o, edgeCount);
  return { nodeCount, edgeCount, lonlat, offsets, targets, lengthsDm };
}

/** Nearest graph node to a point (linear scan; a grid index is a later optimisation). */
export function nearestNode(g: Graph, lon: number, lat: number): number {
  let best = -1;
  let bestD = Infinity;
  const k = Math.cos(lat * rad);
  for (let i = 0; i < g.nodeCount; i++) {
    const dx = (g.lonlat[i * 2]! - lon) * k;
    const dy = g.lonlat[i * 2 + 1]! - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Binary min-heap keyed by f-score. */
class Heap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, key: number) {
    let i = this.ids.length;
    this.ids.push(id);
    this.keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p]! <= key) break;
      this.ids[i] = this.ids[p]!;
      this.keys[i] = this.keys[p]!;
      i = p;
    }
    this.ids[i] = id;
    this.keys[i] = key;
  }
  pop(): number {
    const top = this.ids[0]!;
    const lastId = this.ids.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.ids.length) {
      let i = 0;
      const n = this.ids.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && this.keys[c + 1]! < this.keys[c]!) c++;
        if (this.keys[c]! >= lastKey) break;
        this.ids[i] = this.ids[c]!;
        this.keys[i] = this.keys[c]!;
        i = c;
      }
      this.ids[i] = lastId;
      this.keys[i] = lastKey;
    }
    return top;
  }
}

/** Connected-component label per node (iterative BFS) and the label of the largest component. */
export function components(g: Graph): { label: Int32Array; sizes: number[]; largest: number } {
  const label = new Int32Array(g.nodeCount).fill(-1);
  const sizes: number[] = [];
  const queue = new Int32Array(g.nodeCount);
  for (let s = 0; s < g.nodeCount; s++) {
    if (label[s] !== -1) continue;
    const c = sizes.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    label[s] = c;
    while (head < tail) {
      const u = queue[head++]!;
      for (let e = g.offsets[u]!; e < g.offsets[u + 1]!; e++) {
        const v = g.targets[e]!;
        if (label[v] === -1) {
          label[v] = c;
          queue[tail++] = v;
        }
      }
    }
    sizes.push(tail);
  }
  let largest = 0;
  for (let c = 1; c < sizes.length; c++) if (sizes[c]! > sizes[largest]!) largest = c;
  return { label, sizes, largest };
}

/** Keeps only the nodes for which `keep(i)` is true (edges between kept nodes survive); renumbers nodes. */
export function subgraph(g: Graph, keep: (i: number) => boolean): Graph {
  const map = new Int32Array(g.nodeCount).fill(-1);
  let n = 0;
  for (let i = 0; i < g.nodeCount; i++) if (keep(i)) map[i] = n++;
  const lonlat = new Float32Array(n * 2);
  const offsets = new Uint32Array(n + 1);
  const targets: number[] = [];
  const lengths: number[] = [];
  for (let i = 0; i < g.nodeCount; i++) {
    const j = map[i]!;
    if (j === -1) continue;
    lonlat[j * 2] = g.lonlat[i * 2]!;
    lonlat[j * 2 + 1] = g.lonlat[i * 2 + 1]!;
    offsets[j] = targets.length;
    for (let e = g.offsets[i]!; e < g.offsets[i + 1]!; e++) {
      const t = map[g.targets[e]!]!;
      if (t === -1) continue;
      targets.push(t);
      lengths.push(g.lengthsDm[e]!);
    }
  }
  offsets[n] = targets.length;
  return { nodeCount: n, edgeCount: targets.length, lonlat, offsets, targets: Uint32Array.from(targets), lengthsDm: Uint16Array.from(lengths) };
}

/** Nearest node and its distance in metres. */
export function nearestNodeWithDistance(g: Graph, lon: number, lat: number): { node: number; distanceM: number } | null {
  if (!g.nodeCount) return null;
  const node = nearestNode(g, lon, lat);
  return { node, distanceM: haversineM(lon, lat, g.lonlat[node * 2]!, g.lonlat[node * 2 + 1]!) };
}

export type WalkPlan =
  | { kind: 'route'; coords: [number, number][]; lengthM: number; snapFromM: number; snapToM: number }
  | {
      kind: 'straight';
      /** Why there is no walking route — shown to the user in plain words. */
      reason: 'no_graph' | 'outside_graph' | 'far_from_paths' | 'not_connected';
      distanceM: number;
      bearingDeg: number;
    };

/** How far a point may be from the nearest mapped path before we stop pretending the route starts there. */
export const MAX_SNAP_M = 250;

function initialBearing(a: [number, number], b: [number, number]): number {
  const φ1 = a[1] * rad;
  const φ2 = b[1] * rad;
  const Δλ = (b[0] - a[0]) * rad;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) / rad) % 360 + 360) % 360;
}

function bboxOf(g: Graph): [number, number, number, number] {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (let i = 0; i < g.nodeCount; i++) {
    const x = g.lonlat[i * 2]!;
    const y = g.lonlat[i * 2 + 1]!;
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

/**
 * Walking route between two points on the packaged graph, or an honest straight-line fallback
 * (distance + bearing) with the reason. Never throws for "no route".
 */
export function planWalk(g: Graph | null, from: [number, number], to: [number, number], maxSnapM = MAX_SNAP_M): WalkPlan {
  const straight = (reason: Extract<WalkPlan, { kind: 'straight' }>['reason']): WalkPlan => ({
    kind: 'straight',
    reason,
    distanceM: haversineM(from[0], from[1], to[0], to[1]),
    bearingDeg: initialBearing(from, to),
  });
  if (!g || !g.nodeCount) return straight('no_graph');
  const [w, s, e, n] = bboxOf(g);
  // The graph area plus the snap radius (coordinates are float32, so exact corners would otherwise fall outside).
  const mLat = maxSnapM / 111_320;
  const mLon = mLat / Math.max(0.1, Math.cos(((s + n) / 2) * rad));
  const inside = (p: [number, number]) => p[0] >= w - mLon && p[0] <= e + mLon && p[1] >= s - mLat && p[1] <= n + mLat;
  if (!inside(from) || !inside(to)) return straight('outside_graph');
  const a = nearestNodeWithDistance(g, from[0], from[1])!;
  const b = nearestNodeWithDistance(g, to[0], to[1])!;
  if (a.distanceM > maxSnapM || b.distanceM > maxSnapM) return straight('far_from_paths');
  const r = routeAStar(g, a.node, b.node);
  if (!r) return straight('not_connected');
  const coords = r.nodes.map((i) => [g.lonlat[i * 2]!, g.lonlat[i * 2 + 1]!] as [number, number]);
  return { kind: 'route', coords: [from, ...coords, to], lengthM: r.lengthM + a.distanceM + b.distanceM, snapFromM: a.distanceM, snapToM: b.distanceM };
}

/** A* on the walking graph. Returns node path and length in metres, or null if unreachable. */
export function routeAStar(g: Graph, from: number, to: number): { nodes: number[]; lengthM: number } | null {
  const n = g.nodeCount;
  const gScore = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const tx = g.lonlat[to * 2]!;
  const ty = g.lonlat[to * 2 + 1]!;
  const h = (i: number) => haversineM(g.lonlat[i * 2]!, g.lonlat[i * 2 + 1]!, tx, ty);
  const heap = new Heap();
  gScore[from] = 0;
  heap.push(from, h(from));
  while (heap.size) {
    const u = heap.pop();
    if (closed[u]) continue;
    if (u === to) break;
    closed[u] = 1;
    for (let e = g.offsets[u]!; e < g.offsets[u + 1]!; e++) {
      const v = g.targets[e]!;
      if (closed[v]) continue;
      const cand = gScore[u]! + g.lengthsDm[e]! / 10;
      if (cand < gScore[v]!) {
        gScore[v] = cand;
        prev[v] = u;
        heap.push(v, cand + h(v));
      }
    }
  }
  if (!Number.isFinite(gScore[to]!)) return null;
  const nodes: number[] = [];
  for (let c = to; c !== -1; c = prev[c]!) nodes.push(c);
  nodes.reverse();
  return { nodes, lengthM: gScore[to]! };
}
