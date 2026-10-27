import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { useStore, phaseColor } from '../../store'
import { KINDS, type Graph, type GraphNode } from '../../lib/memory'

/**
 * The second brain, drawn.
 *
 * Every item is a point of light, coloured by what it is; folders and the
 * people and projects that tie items together are larger; lines are the
 * connections. Emrys sits at the centre. When he looks something up the items
 * he found light up and the camera flies to them, so the answer arrives with
 * its source already on screen.
 *
 * Built for smoothness first. The whole map is two draw calls — one for every
 * point, one for every line — with the glow done in the point shader rather
 * than a bloom pass, so a laptop renders it at full frame rate with the fans
 * quiet. Labels are HTML and only the handful that matter get one.
 */

const POS_KEY = 'emrys.layout.v1'

function sizeFor(n: GraphNode): number {
  switch (n.kind) {
    case 'core':
      return 26
    case 'hub':
      return n.depth === 1 ? 15 : 10
    case 'entity':
      return 7 + Math.min(6, Math.log2(1 + (n.weight ?? 1)) * 2)
    case 'profile':
      return 9
    case 'fact':
      return 6
    default:
      return 7
  }
}

/** Layout positions, computed in a worker, cached across visits by node id. */
function useLayout(graph: Graph | null) {
  const [positions, setPositions] = useState<Float32Array | null>(null)
  useEffect(() => {
    if (!graph) return
    let cache: Record<string, [number, number, number]> = {}
    try {
      cache = JSON.parse(localStorage.getItem(POS_KEY) ?? '{}')
    } catch {
      cache = {}
    }
    const worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<Float32Array>) => {
      const out = e.data
      setPositions(out)
      const next: Record<string, [number, number, number]> = {}
      graph.nodes.forEach((n, i) => {
        next[n.id] = [
          Math.round(out[i * 3] * 10) / 10,
          Math.round(out[i * 3 + 1] * 10) / 10,
          Math.round(out[i * 3 + 2] * 10) / 10,
        ]
      })
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(next))
      } catch {
        /* full or private — the layout is recomputed next time */
      }
      worker.terminate()
    }
    worker.postMessage({
      nodes: graph.nodes.map((n) => {
        const p = cache[n.id]
        return p
          ? { id: n.id, kind: n.kind, depth: n.depth, x: p[0], y: p[1], z: p[2] }
          : { id: n.id, kind: n.kind, depth: n.depth }
      }),
      links: graph.links,
    })
    return () => worker.terminate()
  }, [graph])
  return positions
}

const VERT = /* glsl */ `
attribute float size;
attribute vec3 color;
attribute float lit;
uniform float uTime;
uniform float uPixel;
uniform float uBusy;
uniform float uFocus;
varying vec3 vColor;
varying float vLit;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float pulse = 1.0 + lit * 0.32 * sin(uTime * 3.6 + position.x * 0.05);
  float shimmer = 1.0 + uBusy * 0.22 * sin(uTime * 2.8 + position.y * 0.09 + position.z * 0.07);
  gl_PointSize = size * pulse * shimmer * uPixel * (480.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
  vColor = mix(color, vec3(1.0), lit * 0.3);
  vLit = lit;
  vAlpha = mix(1.0, 0.22 + 0.78 * lit, uFocus);
}
`

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vLit;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float core = smoothstep(0.2, 0.1, d);
  float glow = exp(-d * d * 16.0) * (0.42 + vLit * 0.7);
  float a = clamp(core + glow, 0.0, 1.0) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * (core * 1.15 + glow * 0.9), a);
}
`

type Fly = { fromT: THREE.Vector3; toT: THREE.Vector3; fromP: THREE.Vector3; toP: THREE.Vector3; t: number }

/**
 * Dust: a few hundred faint motes far behind the map, turning slowly, so the
 * brain sits in space rather than on a flat background. One draw call.
 */
function Dust() {
  const ref = useRef<THREE.Points>(null)
  const positions = useMemo(() => {
    const n = 700
    const out = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const r = 500 + Math.random() * 900
      const t = Math.random() * Math.PI * 2
      const p = Math.acos(2 * Math.random() - 1)
      out.set([r * Math.sin(p) * Math.cos(t), r * Math.sin(p) * Math.sin(t) * 0.6, r * Math.cos(p)], i * 3)
    }
    return out
  }, [])
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 0.006
  })
  return (
    <points ref={ref} frustumCulled={false} raycast={() => null}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#9fb4ff" size={1.6} sizeAttenuation={false} transparent opacity={0.35} depthWrite={false} />
    </points>
  )
}

function Galaxy({ graph, positions }: { graph: Graph; positions: Float32Array }) {
  const controls = useThree((s) => s.controls) as unknown as OrbitControlsImpl | null
  const camera = useThree((s) => s.camera)
  const pointsGeo = useRef<THREE.BufferGeometry>(null)
  const litLines = useRef<THREE.BufferGeometry>(null)
  const material = useRef<THREE.ShaderMaterial>(null)
  const fly = useRef<Fly | null>(null)
  const lastInput = useRef(0)

  const selected = useStore((s) => s.selected)
  const lit = useStore((s) => s.lit)
  const hovered = useStore((s) => s.hovered)
  const select = useStore((s) => s.select)
  const setHovered = useStore((s) => s.setHovered)
  const accent = useStore((s) => s.accent)

  const index = useMemo(() => new Map(graph.nodes.map((n, i) => [n.id, i])), [graph])
  const coreIndex = useMemo(() => graph.nodes.findIndex((n) => n.kind === 'core'), [graph])

  const { sizes, colors, edgePositions, edgeColors, radius } = useMemo(() => {
    const sizes = new Float32Array(graph.nodes.map(sizeFor))
    const colors = new Float32Array(graph.nodes.length * 3)
    const c = new THREE.Color()
    graph.nodes.forEach((n, i) => {
      c.set(KINDS[n.kind]?.color ?? '#ffffff')
      colors.set([c.r, c.g, c.b], i * 3)
    })
    const edgePositions = new Float32Array(graph.links.length * 6)
    const edgeColors = new Float32Array(graph.links.length * 6)
    graph.links.forEach(([a, b], k) => {
      edgePositions.set(positions.subarray(a * 3, a * 3 + 3), k * 6)
      edgePositions.set(positions.subarray(b * 3, b * 3 + 3), k * 6 + 3)
      edgeColors.set(colors.subarray(a * 3, a * 3 + 3).map((v) => v * 0.55), k * 6)
      edgeColors.set(colors.subarray(b * 3, b * 3 + 3).map((v) => v * 0.55), k * 6 + 3)
    })
    let radius = 60
    for (let i = 0; i < positions.length; i += 3) {
      radius = Math.max(radius, Math.hypot(positions[i], positions[i + 1], positions[i + 2]))
    }
    return { sizes, colors, edgePositions, edgeColors, radius }
  }, [graph, positions])

  const litTarget = useMemo(() => new Float32Array(graph.nodes.length), [graph])
  const litNow = useMemo(() => new Float32Array(graph.nodes.length), [graph])

  // What should glow: whatever Emrys lit, plus the selection and the hover.
  const glowing = useMemo(() => {
    const ids = new Set<string>(lit && Date.now() - lit.at < 60_000 ? lit.ids : [])
    if (selected) ids.add(selected)
    if (hovered) ids.add(hovered)
    return ids
  }, [lit, selected, hovered])

  useEffect(() => {
    litTarget.fill(0)
    for (const id of glowing) {
      const i = index.get(id)
      if (i !== undefined) litTarget[i] = 1
    }
    // The lines touching anything lit, drawn bright on top of the rest.
    const g = litLines.current
    if (!g) return
    const pts: number[] = []
    for (const [a, b] of graph.links) {
      if (litTarget[a] || litTarget[b]) {
        pts.push(...positions.subarray(a * 3, a * 3 + 3), ...positions.subarray(b * 3, b * 3 + 3))
      }
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    g.computeBoundingSphere()
  }, [glowing, graph, index, litTarget, positions])

  // Fly to what was lit or selected; back out to the whole map when cleared.
  useEffect(() => {
    if (!controls) return
    const ids = selected ? [selected] : lit && Date.now() - lit.at < 5000 ? lit.ids : []
    const pts = ids.map((id) => index.get(id)).filter((i): i is number => i !== undefined)
    const toT = new THREE.Vector3()
    let spread = 0
    if (pts.length) {
      for (const i of pts) toT.add(new THREE.Vector3().fromArray(positions, i * 3))
      toT.divideScalar(pts.length)
      for (const i of pts) spread = Math.max(spread, toT.distanceTo(new THREE.Vector3().fromArray(positions, i * 3)))
    }
    const dist = pts.length ? Math.max(80, spread * 2.4 + 60) : radius * 1.7
    const dir = camera.position.clone().sub(controls.target).normalize()
    fly.current = {
      fromT: controls.target.clone(),
      toT,
      fromP: camera.position.clone(),
      toP: toT.clone().add(dir.multiplyScalar(dist)),
      t: 0,
    }
  }, [selected, lit, controls, camera, index, positions, radius])

  useFrame((state, dt) => {
    const m = material.current
    const st = useStore.getState()
    if (m) {
      m.uniforms.uTime.value = state.clock.elapsedTime
      const busy = st.phase === 'thinking' || st.phase === 'tooling' ? 1 : 0
      m.uniforms.uBusy.value += (busy - m.uniforms.uBusy.value) * Math.min(1, dt * 3)
      const focus = glowing.size ? 1 : 0
      m.uniforms.uFocus.value += (focus - m.uniforms.uFocus.value) * Math.min(1, dt * 3)
    }

    const g = pointsGeo.current
    if (g) {
      const attr = g.getAttribute('lit') as THREE.BufferAttribute
      let moved = false
      for (let i = 0; i < litNow.length; i++) {
        const d = litTarget[i] - litNow[i]
        if (Math.abs(d) > 0.002) {
          litNow[i] += d * Math.min(1, dt * 5)
          moved = true
        }
      }
      if (moved) attr.needsUpdate = true
      // Emrys's own point breathes with his voice and with yours.
      if (coreIndex >= 0) {
        const size = g.getAttribute('size') as THREE.BufferAttribute
        size.setX(coreIndex, sizeFor(graph.nodes[coreIndex]) * (1 + st.level * 0.9))
        size.needsUpdate = true
      }
    }

    if (controls) {
      const f = fly.current
      if (f) {
        f.t = Math.min(1, f.t + dt / 1.2)
        const k = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2
        controls.target.lerpVectors(f.fromT, f.toT, k)
        camera.position.lerpVectors(f.fromP, f.toP, k)
        if (f.t >= 1) fly.current = null
      }
      // A slow drift when nobody is touching it, so the map is alive at rest.
      controls.autoRotate = !f && Date.now() - lastInput.current > 8000 && !st.hovered
      controls.update()
    }
  })

  const labelled = useMemo(() => {
    const ids = new Set<string>()
    graph.nodes.forEach((n) => {
      if (n.kind === 'core' || (n.kind === 'hub' && n.depth === 1)) ids.add(n.id)
    })
    let extra = 0
    for (const id of glowing) {
      if (extra++ > 12) break
      ids.add(id)
    }
    return [...ids].map((id) => index.get(id)).filter((i): i is number => i !== undefined)
  }, [graph, glowing, index])

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    lastInput.current = Date.now()
    if (e.index !== undefined) setHovered(graph.nodes[e.index]?.id ?? null)
  }

  return (
    <>
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        autoRotateSpeed={0.35}
        minDistance={20}
        maxDistance={radius * 5}
        onStart={() => {
          lastInput.current = Date.now()
          fly.current = null
        }}
      />
      <lineSegments frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[edgePositions, 3]} />
          <bufferAttribute attach="attributes-color" args={[edgeColors, 3]} />
        </bufferGeometry>
        <lineBasicMaterial vertexColors transparent opacity={0.4} depthWrite={false} blending={THREE.AdditiveBlending} />
      </lineSegments>
      <lineSegments frustumCulled={false}>
        <bufferGeometry ref={litLines} />
        <lineBasicMaterial
          color={accent ?? '#c3d0ff'}
          transparent
          opacity={0.75}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </lineSegments>
      <points
        frustumCulled={false}
        onPointerMove={onMove}
        onPointerOut={() => setHovered(null)}
        onClick={(e) => {
          e.stopPropagation()
          lastInput.current = Date.now()
          if (e.index !== undefined) select(graph.nodes[e.index]?.id ?? null)
        }}
      >
        <bufferGeometry ref={pointsGeo}>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[colors, 3]} />
          <bufferAttribute attach="attributes-size" args={[sizes, 1]} />
          <bufferAttribute attach="attributes-lit" args={[litNow, 1]} />
        </bufferGeometry>
        <shaderMaterial
          ref={material}
          vertexShader={VERT}
          fragmentShader={FRAG}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          uniforms={{
            uTime: { value: 0 },
            uPixel: { value: Math.min(window.devicePixelRatio, 2) },
            uBusy: { value: 0 },
            uFocus: { value: 0 },
          }}
        />
      </points>
      {labelled.map((i) => {
        const n = graph.nodes[i]
        return (
          <Html
            key={n.id}
            position={[positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]}
            center
            zIndexRange={[5, 0]}
            style={{ pointerEvents: 'none' }}
          >
            <div className={`map-label map-label-${n.kind}${glowing.has(n.id) ? ' is-lit' : ''}`}>
              {n.label.length > 42 ? n.label.slice(0, 40) + '…' : n.label}
            </div>
          </Html>
        )
      })}
    </>
  )
}

/** Clicking empty space deselects, so the map can always be returned to the whole. */
function Deselect() {
  const select = useStore((s) => s.select)
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    let down = { x: 0, y: 0 }
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY })
    const onUp = (e: PointerEvent) => {
      // A drag to orbit is not a click on nothing.
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4 && !useStore.getState().hovered) select(null)
    }
    gl.domElement.addEventListener('pointerdown', onDown)
    gl.domElement.addEventListener('pointerup', onUp)
    return () => {
      gl.domElement.removeEventListener('pointerdown', onDown)
      gl.domElement.removeEventListener('pointerup', onUp)
    }
  }, [gl, select])
  return null
}

export function BrainMap() {
  const graph = useStore((s) => s.graph)
  const positions = useLayout(graph)
  const phase = useStore((s) => s.phase)
  const ready = graph && positions && positions.length === graph.nodes.length * 3

  return (
    <div className="map" style={{ ['--phase' as string]: phaseColor[phase] }}>
      <Canvas
        className="map-canvas"
        camera={{ position: [0, 30, 260], fov: 50, near: 1, far: 5000 }}
        dpr={[1, 1.75]}
        gl={{ antialias: false, alpha: true, powerPreference: 'high-performance' }}
        raycaster={{ params: { Points: { threshold: 3.2 }, Line: { threshold: 1 } } as THREE.RaycasterParameters }}
      >
        <Dust />
        {ready && <Galaxy graph={graph} positions={positions} />}
        <Deselect />
      </Canvas>
      {!ready && <div className="map-empty">Building your second brain…</div>}
    </div>
  )
}
