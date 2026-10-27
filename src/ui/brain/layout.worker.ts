/**
 * Where everything sits on the map.
 *
 * A force layout in three dimensions — links pull, nodes push apart, and the
 * folders settle into constellations around Emrys at the centre. It runs here,
 * off the main thread, because a few hundred ticks over a few hundred nodes is
 * long enough to drop frames, and dropped frames are exactly what this
 * interface is not allowed to have.
 *
 * Positions from the last layout come in as a warm start, so a map that gained
 * one note relaxes around it instead of rearranging itself from scratch.
 */

import { forceSimulation, forceLink, forceManyBody, forceCenter } from 'd3-force-3d'

type In = {
  nodes: { id: string; kind: string; depth?: number; x?: number; y?: number; z?: number }[]
  links: [number, number][]
}

type SimNode = In['nodes'][number] & { index?: number; fx?: number; fy?: number; fz?: number }

self.onmessage = (e: MessageEvent<In>) => {
  const { nodes, links } = e.data
  const sim: SimNode[] = nodes.map((n) => ({ ...n }))
  const warm = sim.filter((n) => n.x !== undefined).length / Math.max(1, sim.length)

  // Emrys is the fixed centre everything orbits.
  const core = sim.find((n) => n.kind === 'core')
  if (core) {
    core.fx = 0
    core.fy = 0
    core.fz = 0
  }

  const linkData = links.map(([a, b]) => ({ source: a, target: b }))
  const kindOf = (i: number) => sim[i]?.kind
  const distance = (l: { source: { index: number }; target: { index: number } }) => {
    const a = kindOf(l.source.index)
    const b = kindOf(l.target.index)
    if (a === 'core' || b === 'core') return 90
    if (a === 'hub' && b === 'hub') return 46
    if (a === 'entity' || b === 'entity') return 34
    return 22
  }

  const simulation = forceSimulation(sim, 3)
    .force(
      'link',
      forceLink(linkData)
        .distance(distance)
        .strength((l: { source: { index: number }; target: { index: number } }) =>
          kindOf(l.source.index) === 'entity' || kindOf(l.target.index) === 'entity' ? 0.12 : 0.7,
        ),
    )
    .force(
      'charge',
      forceManyBody()
        .strength((n: SimNode) => (n.kind === 'hub' ? -140 : n.kind === 'core' ? -300 : n.kind === 'entity' ? -40 : -26))
        .distanceMax(260),
    )
    .force('center', forceCenter(0, 0, 0).strength(0.05))
    .alpha(warm > 0.8 ? 0.25 : 1)
    .stop()

  const ticks = warm > 0.8 ? 90 : 320
  for (let i = 0; i < ticks; i++) simulation.tick()

  const out = new Float32Array(sim.length * 3)
  sim.forEach((n, i) => {
    out[i * 3] = n.x ?? 0
    out[i * 3 + 1] = n.y ?? 0
    out[i * 3 + 2] = n.z ?? 0
  })
  ;(self as unknown as Worker).postMessage(out, [out.buffer])
}
