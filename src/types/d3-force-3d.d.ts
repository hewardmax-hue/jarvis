// d3-force-3d ships no types. The map uses a handful of its builders and
// chains them loosely, so they are declared loosely.
declare module 'd3-force-3d' {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  export function forceSimulation(nodes?: any[], numDimensions?: number): any
  export function forceLink(links?: any[]): any
  export function forceManyBody(): any
  export function forceCenter(x?: number, y?: number, z?: number): any
  export function forceRadial(radius: number, x?: number, y?: number, z?: number): any
}
