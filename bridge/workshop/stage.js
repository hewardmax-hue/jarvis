/**
 * The stage. A dark studio, a kit of parts, and a runner for code a model wrote.
 *
 * Everything in here assumes it is sealed in: the frame has no network, no
 * storage and no origin of its own, and the only way in or out is a message.
 * The page that frames it sends parts — a name and the body of a function —
 * and this runs each one against the kit, `W`. What a part adds belongs to
 * that part; send the name again and the old pieces go first. A part that
 * throws is reported and dropped; it never takes the stage down with it.
 *
 * The subject is always scaled to a radius of about 1, so the lights, the
 * shadows, the floor and the camera never have to know how big the real thing
 * is. A watch movement and a jet engine sit on the same bench.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { Reflector } from 'three/addons/objects/Reflector.js'
import { STLExporter } from 'three/addons/exporters/STLExporter.js'
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { FontLoader } from 'three/addons/loaders/FontLoader.js'
import typeface from './vendor/font.js'

const post = (msg, transfer) => window.parent.postMessage({ from: 'jett-stage', ...msg }, '*', transfer ?? [])
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2)
const finite = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

const canvas = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' })
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap
// Tone mapping happens once, in the output pass at the end of the chain.
renderer.toneMapping = THREE.NeutralToneMapping
renderer.toneMappingExposure = 1

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 400)

const controls = new OrbitControls(camera, canvas)
controls.enableDamping = true
controls.dampingFactor = 0.08
controls.minDistance = 0.4
controls.maxDistance = 40
controls.maxPolarAngle = Math.PI * 0.497
controls.autoRotate = true
controls.autoRotateSpeed = 0.55
// The slow orbit is only for when nobody is driving.
controls.addEventListener('start', () => {
  controls.autoRotate = false
  flight = null
})

/** Everything a part adds lives under here, scaled so the subject's radius is 1. */
const root = new THREE.Group()
scene.add(root)

const LIGHTS = {
  studio: {
    inner: '#3a3e46', outer: '#08090b', floor: 0x08090b, room: 0x0a0c0f,
    box: 0xffffff, env: 1, key: 0xfff4e6, keyPower: 2.6, keyFrom: [3.2, 5.2, 3.6],
    rim: 0xcfe0ff, rimPower: 1.1, fill: 0.12, exposure: 1, wash: 0.42,
  },
  day: {
    inner: '#cfd6de', outer: '#7d8894', floor: 0x8a929c, room: 0x6c7684,
    box: 0xeaf2ff, env: 1.1, key: 0xfffaf0, keyPower: 2.9, keyFrom: [2.4, 6, 2.8],
    rim: 0xffffff, rimPower: 0.8, fill: 0.4, exposure: 1, wash: 0.3,
  },
  sunset: {
    inner: '#d9824a', outer: '#1d1226', floor: 0x130c14, room: 0x1c1118,
    box: 0xffc79a, env: 0.9, key: 0xff9a52, keyPower: 3.2, keyFrom: [5.5, 1.9, 2.2],
    rim: 0x9a8cff, rimPower: 0.7, fill: 0.14, exposure: 1, wash: 0.34,
  },
  night: {
    inner: '#141b2c', outer: '#020306', floor: 0x030406, room: 0x04060a,
    box: 0x9fb6ff, env: 0.5, key: 0xa9c0ff, keyPower: 1.25, keyFrom: [2.6, 5.4, 3.2],
    rim: 0x6f8cff, rimPower: 1, fill: 0.05, exposure: 0.95, wash: 0.3,
  },
}

// A few bright rectangles in a dark room — softboxes — are the whole
// environment. Metal has something clean to reflect and nothing else.
const pmrem = new THREE.PMREMGenerator(renderer)
const envCache = new Map()
function softboxes(tint, walls, wash) {
  const id = `${tint}:${walls}:${wash}`
  if (envCache.has(id)) return envCache.get(id)
  const room = new THREE.Scene()
  // Never quite black: a metal face turned away from every lamp still reads as metal.
  room.background = new THREE.Color(walls)
  const box = (w, h, at, power) => {
    const colour = new THREE.Color(tint).multiplyScalar(power)
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: colour, side: THREE.DoubleSide, toneMapped: false }),
    )
    mesh.position.set(...at)
    mesh.lookAt(0, 0, 0)
    room.add(mesh)
  }
  // A lit band right round the walls, from the bench up. Whichever way a metal
  // face is turned, and wherever the camera has drifted to, it has a soft grey
  // to mirror instead of a black room — so brass reads as brass, not as a hole.
  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(14, 14, 12.5, 48, 1, true),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(tint).multiplyScalar(wash), side: THREE.BackSide, toneMapped: false }),
  )
  band.position.y = 4.75
  room.add(band)
  // And the floor gives a little of it back. Seen from above, the upright side
  // of anything polished mirrors the floor: with none in the room, the rim of a
  // gear or the length of a shaft is a black stripe however bright the lamps.
  const bounce = new THREE.Mesh(
    new THREE.CircleGeometry(14, 48),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(tint).multiplyScalar(wash * 0.5), toneMapped: false }),
  )
  bounce.rotation.x = -Math.PI / 2
  bounce.position.y = -1.5
  room.add(bounce)
  // Kept low on purpose. A flat metal top looks straight up at the big one,
  // and anything much brighter than paper burns it to a white disc.
  box(8, 8, [0, 9, 0], 1.5) // the big one overhead
  box(3, 8, [-8, 3.5, 3], 3.6) // a tall strip on the key side
  box(5, 5, [8, 4, 1], 1.1) // a soft fill opposite
  box(8, 1.6, [0, 7.5, -9], 3.2) // a rim strip behind, above where a flat top mirrors it
  box(2.5, 2.5, [2, 1.5, 9], 0.8) // a kicker out front
  const texture = pmrem.fromScene(room, 0.03).texture
  room.traverse((o) => {
    o.geometry?.dispose()
    o.material?.dispose()
  })
  envCache.set(id, texture)
  return texture
}

// The backdrop: brighter behind the subject, falling to near black at the edges.
const backdropCanvas = document.createElement('canvas')
backdropCanvas.width = backdropCanvas.height = 512
const backdrop = new THREE.CanvasTexture(backdropCanvas)
backdrop.colorSpace = THREE.SRGBColorSpace
scene.background = backdrop
function paintBackdrop(inner, outer) {
  const g = backdropCanvas.getContext('2d')
  const grad = g.createRadialGradient(256, 236, 0, 256, 236, 380)
  grad.addColorStop(0, inner)
  grad.addColorStop(0.55, new THREE.Color(inner).lerp(new THREE.Color(outer), 0.72).getStyle())
  grad.addColorStop(1, outer)
  g.fillStyle = grad
  g.fillRect(0, 0, 512, 512)
  backdrop.needsUpdate = true
}

const key = new THREE.DirectionalLight(0xffffff, 2.6)
key.castShadow = true
key.shadow.mapSize.set(2048, 2048)
key.shadow.bias = -0.0004
key.shadow.normalBias = 0.012
key.shadow.radius = 3.5
scene.add(key, key.target)

// High and behind: it draws the outline that lifts the subject off the dark.
const rim = new THREE.DirectionalLight(0xcfe0ff, 1.1)
rim.position.set(-3, 7.5, -4)
scene.add(rim, rim.target)

const fill = new THREE.HemisphereLight(0xffffff, 0x20242c, 0.12)
scene.add(fill)

function shadowReach(r) {
  const c = key.shadow.camera
  c.left = c.bottom = -r
  c.right = c.top = r
  c.near = 0.5
  c.far = 30
  c.updateProjectionMatrix()
}
shadowReach(1.7)

// The floor is a dark mirror that fades out into the backdrop, with a second
// plane on top that takes nothing but the shadow.
const floor = new THREE.Group()
scene.add(floor)
const mirror = new Reflector(new THREE.CircleGeometry(60, 72), {
  textureWidth: 1024,
  textureHeight: 1024,
  clipBias: 0.002,
  multisample: 4,
  shader: {
    name: 'StageFloor',
    uniforms: {
      color: { value: null },
      tDiffuse: { value: null },
      textureMatrix: { value: null },
      uBase: { value: new THREE.Color(0x08090b) },
      uMirror: { value: 0.2 },
      uReach: { value: 11 },
      uOpacity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      uniform mat4 textureMatrix;
      varying vec4 vUv;
      varying vec3 vWorld;
      void main() {
        vUv = textureMatrix * vec4(position, 1.0);
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform vec3 uBase;
      uniform float uMirror;
      uniform float uReach;
      uniform float uOpacity;
      varying vec4 vUv;
      varying vec3 vWorld;
      void main() {
        vec3 seen = min(texture2DProj(tDiffuse, vUv).rgb, vec3(2.0));
        vec3 toEye = normalize(cameraPosition - vWorld);
        float graze = mix(0.3, 1.0, pow(1.0 - clamp(toEye.y, 0.0, 1.0), 3.0));
        float fade = 1.0 - smoothstep(uReach * 0.18, uReach, length(vWorld.xz));
        gl_FragColor = vec4(uBase + seen * uMirror * graze, fade * uOpacity);
      }`,
  },
})
mirror.rotation.x = -Math.PI / 2
mirror.material.transparent = true
mirror.material.depthWrite = false
const shadowCatcher = new THREE.Mesh(new THREE.CircleGeometry(60, 72), new THREE.ShadowMaterial({ opacity: 0.6 }))
shadowCatcher.rotation.x = -Math.PI / 2
shadowCatcher.position.y = 0.0008
shadowCatcher.receiveShadow = true
shadowCatcher.renderOrder = 1
floor.add(mirror, shadowCatcher)

let lightName = 'studio'
function setLight(name) {
  const look = LIGHTS[name]
  if (!look) return false
  lightName = name
  paintBackdrop(look.inner, look.outer)
  scene.environment = softboxes(look.box, look.room, look.wash)
  scene.environmentIntensity = look.env
  key.color.set(look.key)
  key.intensity = look.keyPower
  key.position.set(...look.keyFrom)
  rim.color.set(look.rim)
  rim.intensity = look.rimPower
  fill.intensity = look.fill
  mirror.material.uniforms.uBase.value.set(look.floor)
  renderer.toneMappingExposure = look.exposure
  return true
}
setLight('studio')

// ---------------------------------------------------------------------------
// The picture: render → guard → occlusion → bloom → output
// ---------------------------------------------------------------------------

const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 }),
)
composer.addPass(new RenderPass(scene, camera))

// One broken material can write a NaN, and bloom will smear a single NaN pixel
// into a black square the size of a fist. This pass sits straight after the
// render and makes every pixel a number, and no brighter than a lamp.
const guard = new ShaderPass({
  name: 'Guard',
  uniforms: { tDiffuse: { value: null }, uCap: { value: 24 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uCap;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      bool bad = isnan(c.r) || isnan(c.g) || isnan(c.b) || isinf(c.r) || isinf(c.g) || isinf(c.b);
      if (bad || !(c.r >= 0.0) || !(c.g >= 0.0) || !(c.b >= 0.0)) c = vec3(0.0);
      gl_FragColor = vec4(min(c, vec3(uCap)), 1.0);
    }`,
})
composer.addPass(guard)

const gtao = new GTAOPass(scene, camera, 4, 4)
gtao.updateGtaoMaterial({ radius: 0.22, distanceExponent: 1.4, thickness: 1.2, scale: 1.15, samples: 16 })
gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 })
gtao.blendIntensity = 1
composer.addPass(gtao)

// Glass, the mirror and anything else you can see through must not write into
// the occlusion pass, or a dome reads as a solid lump and darkens what is in it.
let seeThrough = []
if (typeof gtao._overrideVisibility === 'function') {
  const hide = gtao._overrideVisibility.bind(gtao)
  gtao._overrideVisibility = () => {
    hide()
    for (const o of [mirror, ...seeThrough]) {
      if (!o.visible) continue
      o.visible = false
      gtao._visibilityCache.push(o)
    }
  }
}

const bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.2, 0.6, 1.15)
composer.addPass(bloom)
composer.addPass(new OutputPass())

const labels = document.getElementById('labels')
const ink = labels.getContext('2d')
let width = 4
let height = 4
let sharpness = Math.min(window.devicePixelRatio || 1, 2)
function resize() {
  width = Math.max(4, window.innerWidth)
  height = Math.max(4, window.innerHeight)
  renderer.setPixelRatio(sharpness)
  renderer.setSize(width, height, false)
  composer.setPixelRatio(sharpness)
  composer.setSize(width, height)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  labels.width = Math.round(width * dpr)
  labels.height = Math.round(height * dpr)
  ink.setTransform(dpr, 0, 0, dpr, 0, 0)
}
window.addEventListener('resize', resize)
resize()

// ---------------------------------------------------------------------------
// The camera
// ---------------------------------------------------------------------------

/** A move in progress. Angles are eased, not positions, so "the other side"
 *  swings round the subject instead of flying through it. */
let flight = null
let touched = false
controls.addEventListener('start', () => (touched = true))

function pose() {
  const s = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target))
  return { r: s.radius, phi: s.phi, theta: s.theta, target: controls.target.clone() }
}

function place(p) {
  controls.target.copy(p.target)
  camera.position.setFromSpherical(new THREE.Spherical(p.r, p.phi, p.theta)).add(p.target)
  camera.lookAt(p.target)
}

function fly(to, ms = 900) {
  const from = pose()
  const goal = { ...from, ...to }
  const turn = goal.theta - from.theta
  goal.theta = from.theta + Math.atan2(Math.sin(turn), Math.cos(turn))
  goal.phi = clamp(goal.phi, 0.06, Math.PI * 0.49)
  goal.r = clamp(goal.r, controls.minDistance, controls.maxDistance)
  goal.target = (to.target ?? from.target).clone()
  if (!finite(goal.target) || !Number.isFinite(goal.r)) return
  flight = { at: performance.now(), ms, from, to: goal }
}

function stepFlight(now) {
  if (!flight) return
  const k = clamp((now - flight.at) / flight.ms, 0, 1)
  const e = ease(k)
  const { from, to } = flight
  place({
    r: from.r + (to.r - from.r) * e,
    phi: from.phi + (to.phi - from.phi) * e,
    theta: from.theta + (to.theta - from.theta) * e,
    target: from.target.clone().lerp(to.target, e),
  })
  if (k >= 1) flight = null
}

/** How far back the camera stands to hold a sphere of this radius. */
function distanceFor(radius) {
  const v = THREE.MathUtils.degToRad(camera.fov) / 2
  const h = Math.atan(Math.tan(v) * camera.aspect)
  return (radius / Math.sin(Math.min(v, h))) * 1.12
}

/** How far back to stand so the whole of it shows from any side at this tilt:
 *  closer than the sphere above allows, because few things are spheres. */
function standoff(m, phi) {
  const size = m.box.getSize(new THREE.Vector3()).divideScalar(R())
  const across = Math.hypot(size.x, size.z) / 2
  const tall = (size.y / 2) * Math.sin(phi) + across * Math.cos(phi)
  const v = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
  return (Math.max(tall / v, across / (v * camera.aspect)) + across * 0.6) * 1.16
}

const HOME = { phi: THREE.MathUtils.degToRad(69), theta: THREE.MathUtils.degToRad(34) }
place({ ...HOME, r: distanceFor(1.05), target: new THREE.Vector3(0, 0.62, 0) })

// ---------------------------------------------------------------------------
// The subject: how big it is and where it sits
// ---------------------------------------------------------------------------

/** `R` is the subject's radius in its own units; the root is scaled by 1/R. */
const subject = { R: null, declared: false, frame: null, settled: false }
const parts = new Map()
const pieces = () => [...parts.values()].flatMap((p) => p.pieces)
const R = () => subject.R ?? 100

function toStage(v) {
  return v.clone().multiplyScalar(root.scale.x).add(root.position)
}

/** The assembled thing, in its own units. */
function measure() {
  const box = new THREE.Box3()
  for (const piece of pieces()) if (!piece.box.isEmpty()) box.union(piece.box)
  if (box.isEmpty()) return null
  return { box, centre: box.getCenter(new THREE.Vector3()), radius: box.getSize(new THREE.Vector3()).length() / 2 }
}

function seat(m) {
  root.scale.setScalar(1 / R())
  // Nothing sits below the bench: if the model built downwards, lift it.
  root.position.set(0, Math.max(0, -m.box.min.y) / R(), 0)
  root.updateMatrixWorld(true)
}

/** Resize and re-aim after the subject changed. The camera only moves while a
 *  build is first going up, and never once someone has taken hold of it. */
function reframe(done = false) {
  const m = measure()
  if (!m) return
  if (subject.settled) {
    // A standing build keeps its size unless a change has plainly outgrown it:
    // repainting a door must not make the whole thing twitch.
    if (m.radius > R() * 1.2 || m.radius < R() * 0.6) {
      subject.R = Math.max(m.radius, 1e-6)
      seat(m)
      if (!blownTo) fit()
    } else seat(m)
    return
  }
  if (!subject.declared) subject.R = Math.max(m.radius, 1e-6)
  seat(m)
  if (touched || blownTo) return
  // While parts are still landing the camera holds the size the model said it
  // was building, so it does not creep with every piece. Once the build is up
  // it eases in on what is really there.
  const held = !done && (subject.frame ?? (subject.declared ? { centre: m.centre, radius: R() } : null))
  const target = toStage(held ? held.centre : m.centre)
  target.y = clamp(target.y, 0.05, 3)
  const r = held ? distanceFor(clamp(held.radius / R(), 0.3, 3) * 1.05) : standoff(m, pose().phi)
  fly({ target, r }, done ? 1100 : 700)
}

/** The build is up. If the model's own idea of its size was badly out, trust
 *  what is actually standing on the bench. */
function settle() {
  const m = measure()
  if (m) {
    if (subject.declared && (m.radius > R() * 1.3 || m.radius < R() * 0.5)) {
      subject.declared = false
      subject.frame = null
    }
    reframe(true)
  }
  subject.settled = true
}

// ---------------------------------------------------------------------------
// The kit
// ---------------------------------------------------------------------------

const vec = (a) => {
  const v = Array.isArray(a)
    ? new THREE.Vector3(Number(a[0]) || 0, Number(a[1]) || 0, Number(a[2]) || 0)
    : a && typeof a === 'object'
      ? new THREE.Vector3(Number(a.x) || 0, Number(a.y) || 0, Number(a.z) || 0)
      : new THREE.Vector3()
  return finite(v) ? v : new THREE.Vector3()
}

const METALS = {
  steel: [0xb9bdc4, 0.3],
  'brushed-steel': [0xb2b6bc, 0.48],
  aluminium: [0xd2d5da, 0.4],
  brass: [0xc9a24b, 0.28],
  bronze: [0xa9743a, 0.36],
  copper: [0xc47a52, 0.28],
  gold: [0xe6bd5c, 0.2],
  silver: [0xe4e5e8, 0.18],
  chrome: [0xe9ebef, 0.05],
  titanium: [0x8e8b87, 0.44],
  iron: [0x4a4c51, 0.62],
  gunmetal: [0x393c43, 0.36],
  black: [0x141518, 0.46],
}
METALS.aluminum = METALS.aluminium

const WOODS = { oak: ['#a67c4e', '#7b5631'], walnut: ['#5b3d28', '#38241a'], maple: ['#d2b182', '#b18d5c'], ebony: ['#231c18', '#0f0c0a'] }
const grain = new Map()
function woodGrain(kind) {
  if (grain.has(kind)) return grain.get(kind)
  const [light, dark] = WOODS[kind]
  const c = document.createElement('canvas')
  c.width = c.height = 512
  const g = c.getContext('2d')
  g.fillStyle = light
  g.fillRect(0, 0, 512, 512)
  // Long wavering lines, a few hundred of them: enough to read as grain.
  let seed = kind.length * 7919
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < 260; i++) {
    const x = rnd() * 512
    const sway = 4 + rnd() * 10
    g.strokeStyle = dark
    g.globalAlpha = 0.05 + rnd() * 0.22
    g.lineWidth = 0.6 + rnd() * 2.2
    g.beginPath()
    for (let y = 0; y <= 512; y += 16) g.lineTo(x + Math.sin(y / (40 + sway * 6) + i) * sway, y)
    g.stroke()
  }
  const texture = new THREE.CanvasTexture(c)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.userData.keep = true
  grain.set(kind, texture)
  return texture
}

const font = new FontLoader().parse(typeface)

/** Turn a flat outline — [[x, y], …] — into a THREE.Shape, with holes. */
function outlineOf(points, holes = []) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(Number(x) || 0, Number(y) || 0)))
  for (const hole of holes) {
    const path = new THREE.Path()
    if (Array.isArray(hole)) path.setFromPoints(hole.map(([x, y]) => new THREE.Vector2(Number(x) || 0, Number(y) || 0)))
    else path.absarc(Number(hole.x) || 0, Number(hole.y) || 0, Math.abs(Number(hole.r)) || 1, 0, Math.PI * 2, true)
    shape.holes.push(path)
  }
  return shape
}

/** Extrude along Z, centre it on its thickness, then turn it to face `axis`. */
function slab(shape, depth, axis, bevel = 0) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    curveSegments: 20,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
  })
  geo.translate(0, 0, -depth / 2)
  if (axis === 'y') geo.rotateX(-Math.PI / 2)
  else if (axis === 'x') geo.rotateY(Math.PI / 2)
  return geo
}

const SHARED = {
  metal(kind = 'steel', opts = {}) {
    const [color, roughness] = METALS[String(kind).toLowerCase()] ?? METALS.steel
    return new THREE.MeshStandardMaterial({
      color: opts.color ?? color,
      metalness: 1,
      roughness: clamp(opts.roughness ?? roughness, 0.03, 1),
    })
  },
  glass(tint = 0xffffff, opts = {}) {
    return new THREE.MeshPhysicalMaterial({
      color: tint,
      metalness: 0,
      roughness: opts.frosted ? 0.45 : 0.03,
      transmission: 1,
      ior: 1.5,
      thickness: opts.thickness ?? R() * 0.03,
      envMapIntensity: 1.2,
    })
  },
  plastic(colour = 0x2a2c31, opts = {}) {
    const gloss = clamp(opts.gloss ?? 0.5, 0, 1)
    return new THREE.MeshPhysicalMaterial({
      color: colour,
      metalness: 0,
      roughness: 0.75 - gloss * 0.6,
      clearcoat: gloss > 0.7 ? 0.6 : 0,
      clearcoatRoughness: 0.2,
    })
  },
  paint(colour = 0xb3121a) {
    return new THREE.MeshPhysicalMaterial({ color: colour, metalness: 0.35, roughness: 0.42, clearcoat: 1, clearcoatRoughness: 0.06 })
  },
  rubber(colour = 0x101011) {
    return new THREE.MeshStandardMaterial({ color: colour, metalness: 0, roughness: 0.93 })
  },
  wood(kind = 'oak') {
    const name = WOODS[kind] ? kind : 'oak'
    return new THREE.MeshStandardMaterial({ map: woodGrain(name), metalness: 0, roughness: 0.62 })
  },
  glow(colour = 0xffffff, strength = 2) {
    return new THREE.MeshStandardMaterial({
      color: 0x050505,
      emissive: colour,
      emissiveIntensity: clamp(Number(strength) || 2, 0, 12),
      roughness: 0.5,
    })
  },
  text(word, opts = {}) {
    const size = Number(opts.size) || R() * 0.08
    const depth = Number(opts.depth) || size * 0.12
    const geo = new TextGeometry(String(word).slice(0, 60), { font, size, depth, curveSegments: 6, bevelEnabled: false })
    geo.center()
    return new THREE.Mesh(geo, opts.material ?? SHARED.metal('steel'))
  },
  gear(opts = {}) {
    const teeth = clamp(Math.round(Number(opts.teeth) || 24), 4, 400)
    const radius = Math.abs(Number(opts.radius)) || R() * 0.2
    const thickness = Math.abs(Number(opts.thickness)) || radius * 0.15
    const depth = clamp(Number(opts.toothDepth) || (radius * 2.2) / teeth + radius * 0.02, radius * 0.01, radius * 0.5)
    const foot = radius - depth
    const hole = clamp(Number(opts.hole) || 0, 0, foot * 0.8)
    const pitch = (Math.PI * 2) / teeth
    const rim = []
    for (let i = 0; i < teeth; i++) {
      const a = i * pitch
      for (const [at, r] of [[0, foot], [0.22, foot], [0.36, radius], [0.64, radius], [0.78, foot]])
        rim.push([Math.cos(a + at * pitch) * r, Math.sin(a + at * pitch) * r])
    }
    const holes = hole ? [{ x: 0, y: 0, r: hole }] : []
    // Spokes: windows cut between the hub and the rim, the way a real wheel is lightened.
    const spokes = clamp(Math.round(Number(opts.spokes) || 0), 0, 12)
    if (spokes >= 3) {
      const inner = Math.max(hole * 1.9, radius * 0.24)
      const outer = foot - radius * 0.13
      const bar = 0.16 * ((Math.PI * 2) / spokes) + radius * 0.02 / outer
      if (outer > inner * 1.25) {
        for (let i = 0; i < spokes; i++) {
          const a0 = (i * Math.PI * 2) / spokes + bar
          const a1 = ((i + 1) * Math.PI * 2) / spokes - bar
          const win = []
          for (let k = 0; k <= 10; k++) win.push([Math.cos(a0 + ((a1 - a0) * k) / 10) * outer, Math.sin(a0 + ((a1 - a0) * k) / 10) * outer])
          for (let k = 10; k >= 0; k--) win.push([Math.cos(a0 + ((a1 - a0) * k) / 10) * inner, Math.sin(a0 + ((a1 - a0) * k) / 10) * inner])
          holes.push(win)
        }
      }
    }
    return slab(outlineOf(rim, holes), thickness, opts.axis ?? 'y')
  },
  rounded(w, h, d, r) {
    const radius = Number(r) || Math.min(w, h, d) * 0.12
    return new RoundedBoxGeometry(w, h, d, 4, Math.min(radius, Math.min(w, h, d) / 2))
  },
  tube(points, radius, opts = {}) {
    const path = new THREE.CatmullRomCurve3(points.map(vec), !!opts.closed)
    return new THREE.TubeGeometry(path, clamp(points.length * 14, 16, 400), Math.abs(Number(radius)) || R() * 0.01, 14, !!opts.closed)
  },
  lathe(profile, segments = 64) {
    const line = profile.map(([r, y]) => new THREE.Vector2(Math.max(0, Number(r) || 0), Number(y) || 0))
    return new THREE.LatheGeometry(line, clamp(Math.round(segments), 8, 160))
  },
  extrude(outline, depth, opts = {}) {
    return slab(outlineOf(outline, opts.holes ?? []), Math.abs(Number(depth)) || 1, opts.axis ?? 'y', Number(opts.bevel) || 0)
  },
}

const trianglesIn = (object) => {
  let n = 0
  object.traverse((o) => {
    const geo = o.isMesh && o.geometry
    if (!geo?.attributes?.position) return
    n += ((geo.index ? geo.index.count : geo.attributes.position.count) / 3) * (o.isInstancedMesh ? o.count : 1)
  })
  return Math.round(n)
}

const materialsOf = (mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).filter(Boolean)
const isSeeThrough = (mesh) => materialsOf(mesh).some((m) => m.transparent || m.transmission > 0 || m.opacity < 1)

/** The kit one part gets. Everything it adds is tied to that part. */
function makeKit(part) {
  return {
    ...SHARED,
    add(object, opts = {}) {
      if (part.dead) return object
      if (!object?.isObject3D) throw new Error('W.add needs a THREE.Object3D — a Mesh or a Group')
      const holder = new THREE.Group()
      holder.add(object)
      const tris = trianglesIn(object)
      if (tris > 450000) throw new Error(`one piece has ${tris} triangles — the whole build has 600,000 to spend`)
      object.traverse((o) => {
        if (!o.isMesh) return
        // Anisotropy is the one material feature that reliably breaks the picture.
        for (const m of materialsOf(o)) if (m.anisotropy) m.anisotropy = 0
        o.castShadow = !isSeeThrough(o)
        o.receiveShadow = true
      })
      root.add(holder)
      holder.updateMatrixWorld(true)
      // Measured where it stands when assembled, in the subject's own units.
      const world = new THREE.Box3().setFromObject(object)
      const inverse = root.matrixWorld.clone().invert()
      const box = new THREE.Box3()
      if (!world.isEmpty() && finite(world.min) && finite(world.max)) box.copy(world).applyMatrix4(inverse)
      else {
        root.remove(holder)
        throw new Error('a piece has no size, or has NaN in its geometry')
      }
      const piece = {
        part,
        holder,
        object,
        box,
        tris,
        label: String(opts.label ?? '').trim().slice(0, 44),
        explode: opts.explode == null ? null : vec(opts.explode),
        dots: null,
      }
      part.pieces.push(piece)
      holder.position.copy(travel(piece)).multiplyScalar(blown)
      return object
    },
    onTick(fn) {
      if (!part.dead && typeof fn === 'function') part.ticks.push(fn)
    },
    scale(radius) {
      const r = Math.abs(Number(radius))
      if (!Number.isFinite(r) || r <= 0) return
      // Once a build is standing, its size is what was measured, not what a later part claims.
      if (subject.settled) return
      subject.R = r
      subject.declared = true
      root.scale.setScalar(1 / r)
      root.updateMatrixWorld(true)
    },
    frame(center, radius) {
      const r = Math.abs(Number(radius))
      if (subject.settled || !Number.isFinite(r) || r <= 0) return
      subject.frame = { centre: vec(center), radius: r }
    },
    get radius() {
      return R()
    },
  }
}

// ---------------------------------------------------------------------------
// Running parts
// ---------------------------------------------------------------------------

const AsyncFunction = (async () => {}).constructor

function scrap(part) {
  part.dead = true
  part.ticks.length = 0
  for (const piece of part.pieces) {
    root.remove(piece.holder)
    piece.holder.traverse((o) => {
      o.geometry?.dispose?.()
      for (const m of o.material ? materialsOf(o) : []) {
        for (const value of Object.values(m)) if (value?.isTexture && !value.userData?.keep) value.dispose()
        m.dispose?.()
      }
    })
  }
  part.pieces.length = 0
}

/** Say what went wrong in a way the builder can fix: the message, and the line. */
function describe(err, code) {
  const message = String(err?.message ?? err).slice(0, 300)
  const at = /<anonymous>:(\d+):\d+/.exec(String(err?.stack ?? ''))
  // Two lines of wrapper and one of "use strict" sit above the part's own first line.
  const line = at ? Number(at[1]) - 3 : 0
  const source = line > 0 && code ? code.split('\n')[line - 1] : null
  return source ? `${message} — line ${line}: ${source.trim().slice(0, 160)}` : message
}

let queue = Promise.resolve()

async function run(name, code) {
  const part = { name, pieces: [], ticks: [], dead: false, at: performance.now() / 1000 }
  let failure = null
  let timer = 0
  try {
    const body = new AsyncFunction('THREE', 'W', `"use strict";\n${code}`)
    await Promise.race([
      body(THREE, makeKit(part)),
      new Promise((_, no) => (timer = setTimeout(() => no(new Error('took longer than ten seconds to run')), 10000))),
    ])
    if (!part.pieces.length) throw new Error('ran but added nothing — a part must call W.add at least once')
  } catch (err) {
    failure = describe(err, code)
  }
  clearTimeout(timer)
  if (failure) {
    scrap(part)
    return post({ type: 'ran', name, ok: false, message: failure })
  }
  // The new pieces are standing before the old ones go, so a part that fails
  // to rebuild leaves the last good version where it was.
  const old = parts.get(name)
  if (old) scrap(old)
  parts.set(name, part)
  changed()
  post({ type: 'ran', name, ok: true, pieces: part.pieces.length, triangles: part.pieces.reduce((n, p) => n + p.tris, 0) })
}

function remove(name) {
  const part = parts.get(name)
  if (!part) return
  scrap(part)
  parts.delete(name)
  changed()
}

function clearStage() {
  for (const part of parts.values()) scrap(part)
  parts.clear()
  Object.assign(subject, { R: null, declared: false, frame: null, settled: false })
  touched = false
  flight = null
  blown = blownTo = 0
  blast = null
  home = null
  root.scale.setScalar(1)
  root.position.set(0, 0, 0)
  floor.position.y = 0
  controls.autoRotate = true
  place({ ...HOME, r: distanceFor(1.05), target: new THREE.Vector3(0, 0.62, 0) })
  changed()
}

/** Something on the stage is different: re-measure, and forget what was worked out. */
function changed() {
  seeThrough = []
  root.traverse((o) => {
    if (o.isMesh && isSeeThrough(o)) seeThrough.push(o)
  })
  reframe()
  layout = null
  if (blownTo) spread()
}

// ---------------------------------------------------------------------------
// Pulling it apart
// ---------------------------------------------------------------------------

/** How far apart it is right now (0 together, 1 apart), and where it is heading. */
let blown = 0
let blownTo = 0
let blast = null
/** Where the camera stood before the teardown, so reassembly can put it back. */
let home = null
/** What was worked out for the exploded view: the camera, the floor, the shadows. */
let apart = null

const UP = new THREE.Vector3(0, 1, 0)
const rad = THREE.MathUtils.degToRad
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))

/** Where one piece goes when the thing comes apart, in the subject's own units. */
function travel(piece, centre) {
  let v
  if (piece.explode) v = piece.explode.clone()
  else {
    // The part gave no direction: push it straight out from the middle.
    v = piece.box.getCenter(new THREE.Vector3()).sub(centre ?? measure()?.centre ?? new THREE.Vector3())
    if (v.length() < R() * 0.02) v.set(0, 1, 0)
    v.setLength(R() * 0.9)
  }
  return v.clampLength(0, R() * 4)
}

function corners(box, shift) {
  const out = []
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) out.push(toStage(new THREE.Vector3(x, y, z).add(shift)))
  return out
}

/** Work out the exploded layout: every piece's travel, and the view that shows it. */
function spread() {
  const all = pieces()
  const m = measure()
  if (!all.length || !m) return (apart = null)

  const raw = all.map((piece) => travel(piece, m.centre))
  // One timid or one wild vector should not decide how the whole teardown reads.
  const longest = raw.reduce((most, v) => Math.max(most, v.length()), 1e-9)
  const gain = longest < R() * 0.6 ? (R() * 0.6) / longest : longest > R() * 3.2 ? (R() * 3.2) / longest : 1
  all.forEach((piece, i) => (piece.away = raw[i].multiplyScalar(gain)))

  const lo = new THREE.Vector3(Infinity, Infinity, Infinity)
  const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  for (const piece of all) {
    lo.min(piece.away)
    hi.max(piece.away)
  }
  const range = hi.sub(lo)
  const axis = range.y >= range.x && range.y >= range.z ? 'y' : range.x >= range.z ? 'x' : 'z'

  // The camera picks its angle from the shape of the stack.
  const now = pose()
  let phi
  let theta = now.theta
  if (axis === 'y') {
    const size = new THREE.Vector3()
    const squat = all
      .map((piece) => {
        piece.box.getSize(size)
        return size.y / Math.max(size.x, size.z, 1e-9)
      })
      .sort((a, b) => a - b)
    // Thin plates stacked up are read from above; a few thick layers from low down.
    const thin = all.length >= 4 && squat[squat.length >> 1] < 0.3
    phi = rad(thin ? 38 : 76)
  } else {
    // Sideways travel: stand square to it, a little to one side.
    phi = rad(78)
    const square = axis === 'x' ? 0 : Math.PI / 2
    theta = [square + rad(14), square - rad(14), square + Math.PI + rad(14), square + Math.PI - rad(14)].sort(
      (a, b) => Math.abs(wrap(a - now.theta)) - Math.abs(wrap(b - now.theta)),
    )[0]
  }

  const points = []
  const box = new THREE.Box3()
  for (const piece of all) for (const p of corners(piece.box, piece.away)) points.push(p) && box.expandByPoint(p)
  const target = box.getCenter(new THREE.Vector3())

  // Stand back until the true screen extent of every piece fits, with room at
  // the sides for the names.
  const forward = new THREE.Vector3().setFromSphericalCoords(1, phi, theta).negate()
  const right = new THREE.Vector3().crossVectors(forward, UP).normalize()
  const up = new THREE.Vector3().crossVectors(right, forward)
  const tall = Math.tan(rad(camera.fov) / 2)
  const wide = tall * camera.aspect
  const room = clamp(1 - (2 * labelMargin()) / width, 0.4, 0.92)
  let r = 0
  const q = new THREE.Vector3()
  for (const p of points) {
    q.copy(p).sub(target)
    const depth = q.dot(forward)
    r = Math.max(r, Math.abs(q.dot(right)) / (wide * room) - depth, Math.abs(q.dot(up)) / (tall * 0.84) - depth)
  }

  apart = {
    view: { phi, theta, r: r * 1.03, target },
    // Nothing goes through the floor: the floor gets out of the way instead.
    drop: Math.min(0, box.min.y - 0.04),
    reach: points.reduce((most, p) => Math.max(most, p.length()), 1.7) * 1.06,
  }
  shadowReach(blownTo ? apart.reach : 1.7)
  setBlown(blown)
}

function setBlown(f) {
  blown = f
  for (const piece of pieces()) if (piece.away) piece.holder.position.copy(piece.away).multiplyScalar(f)
  const sinks = apart && apart.drop < 0
  floor.position.y = (apart?.drop ?? 0) * f
  mirror.material.uniforms.uOpacity.value = 1 - f * (sinks ? 0.62 : 0.2)
  shadowCatcher.material.opacity = 0.6 - f * (sinks ? 0.42 : 0.15)
}

function pull(on) {
  if (!pieces().length || !!blownTo === !!on) return false
  if (on) {
    home = { ...(flight?.to ?? pose()), spin: controls.autoRotate }
    blownTo = 1
    spread()
    controls.autoRotate = false
    if (apart) fly(apart.view, 1000)
  } else {
    blownTo = 0
    if (home) {
      fly(home, 1000)
      controls.autoRotate = home.spin
      home = null
    }
  }
  blast = { at: performance.now(), ms: 1000, from: blown, to: blownTo }
  return true
}

function stepBlast(now) {
  if (!blast) return
  const k = clamp((now - blast.at) / blast.ms, 0, 1)
  setBlown(blast.from + (blast.to - blast.from) * ease(k))
  if (k < 1) return
  blast = null
  if (!blownTo) shadowReach(1.7)
}

function fit() {
  if (blownTo && apart) return fly(apart.view, 800)
  const m = measure()
  if (!m) return
  const target = toStage(m.centre)
  target.y = clamp(target.y, 0.05, 3)
  fly({ target, r: standoff(m, pose().phi) }, 800)
}

// ---------------------------------------------------------------------------
// Names: two columns, each with a line to a real point on its part
// ---------------------------------------------------------------------------

const LABEL_FONT = '600 12.5px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif'
const GAP = 22

/** What the names need between frames: the pieces that have one, in order. */
let layout = null
let frame = 0
window.addEventListener('resize', () => (layout = null))

/** One name per distinct label — four screws called "Screw" get one line, not four. */
function labelled() {
  if (layout) return layout.list
  const seen = new Set()
  const list = []
  for (const piece of pieces()) {
    if (!piece.label || seen.has(piece.label)) continue
    seen.add(piece.label)
    list.push(piece)
  }
  layout = { list, margin: 0, looked: false }
  layout.margin = labelMargin()
  return list
}

function labelMargin() {
  if (layout?.margin) return layout.margin
  ink.font = LABEL_FONT
  let longest = 0
  for (const piece of labelled()) longest = Math.max(longest, ink.measureText(piece.label).width)
  return clamp(longest + 34, 70, width * 0.3)
}

/** Up to a hundred of a piece's own vertices: the places a line may end. */
function sample(piece) {
  const meshes = []
  let total = 0
  piece.holder.traverse((o) => {
    const count = o.isMesh && o.geometry?.attributes?.position?.count
    if (!count) return
    meshes.push({ mesh: o, from: total, count })
    total += count
  })
  const dots = []
  const want = Math.min(100, total)
  const m4 = new THREE.Matrix4()
  for (let k = 0; k < want; k++) {
    // The golden ratio walks the vertex list evenly whatever order it was built in.
    const at = Math.floor(((k * 0.6180339887) % 1) * total)
    const entry = meshes.find((e) => at < e.from + e.count)
    const local = new THREE.Vector3().fromBufferAttribute(entry.mesh.geometry.attributes.position, at - entry.from)
    if (entry.mesh.isInstancedMesh && entry.mesh.count > 0) {
      entry.mesh.getMatrixAt(k % entry.mesh.count, m4)
      local.applyMatrix4(m4)
    }
    if (finite(local)) dots.push({ mesh: entry.mesh, local, was: null, moving: false, x: 0, y: 0 })
  }
  return dots
}

// Which piece owns each pixel. Drawn small, in flat colours, every few frames:
// a point is in view when the pixel under it carries its own piece's number.
const idTarget = new THREE.WebGLRenderTarget(4, 4)
idTarget.texture.minFilter = idTarget.texture.magFilter = THREE.NearestFilter
let idPixels = new Uint8Array(64)
let idW = 4
let idH = 4
const idMaterials = []
const flat = (id) =>
  new THREE.MeshBasicMaterial({
    color: new THREE.Color().setRGB((id & 255) / 255, (id >> 8) / 255, 0),
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  })
const nobody = flat(65535)
const ghost = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false })
const clearWas = new THREE.Color()

function paintIds(list) {
  const w = clamp(Math.round(width / 3), 64, 640)
  const h = clamp(Math.round(height / 3), 64, 640)
  if (w !== idW || h !== idH) {
    idTarget.setSize(w, h)
    idPixels = new Uint8Array(w * h * 4)
    idW = w
    idH = h
  }
  const number = new Map(list.map((piece, i) => [piece, i + 1]))
  const undo = []
  for (const piece of pieces()) {
    const id = number.get(piece)
    const paint = id ? (idMaterials[id] ??= flat(id)) : nobody
    piece.solid = false
    piece.holder.traverse((o) => {
      if (o.isMesh) {
        const clear = isSeeThrough(o)
        undo.push([o, 'material', o.material])
        o.material = clear ? ghost : paint
        if (!clear) piece.solid = true
      } else if ((o.isLine || o.isPoints || o.isSprite) && o.visible) {
        undo.push([o, 'visible', true])
        o.visible = false
      }
    })
  }
  const background = scene.background
  const shadows = renderer.shadowMap.autoUpdate
  const target = renderer.getRenderTarget()
  renderer.getClearColor(clearWas)
  const clearAlpha = renderer.getClearAlpha()
  scene.background = null
  floor.visible = false
  renderer.shadowMap.autoUpdate = false
  try {
    renderer.setClearColor(0x000000, 0)
    renderer.setRenderTarget(idTarget)
    renderer.clear()
    renderer.render(scene, camera)
    renderer.readRenderTargetPixels(idTarget, 0, 0, idW, idH, idPixels)
  } finally {
    renderer.setRenderTarget(target)
    renderer.setClearColor(clearWas, clearAlpha)
    renderer.shadowMap.autoUpdate = shadows
    floor.visible = true
    scene.background = background
    for (const [o, prop, value] of undo) o[prop] = value
  }
  return number
}

const NEAR = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]
function owns(id, x, y) {
  const px = Math.floor((x / width) * idW)
  const py = Math.floor((1 - y / height) * idH)
  for (const [dx, dy] of NEAR) {
    const qx = px + dx
    const qy = py + dy
    if (qx < 0 || qy < 0 || qx >= idW || qy >= idH) continue
    const at = (qy * idW + qx) * 4
    if (idPixels[at] + idPixels[at + 1] * 256 === id) return true
  }
  return false
}

const P = new THREE.Vector3()
const H = new THREE.Vector3()

function onScreen(v) {
  v.project(camera)
  return { x: (v.x * 0.5 + 0.5) * width, y: (-v.y * 0.5 + 0.5) * height, ok: v.z < 1 && Math.abs(v.x) < 0.99 && Math.abs(v.y) < 0.97 }
}

/** Choose where each line ends: the nearest point of the part that is not hidden. */
function look(list) {
  const number = paintIds(list)
  const taken = []
  for (const piece of list) {
    piece.dots ??= sample(piece)
    piece.holder.getWorldPosition(H)
    const id = number.get(piece)
    const edge = piece.side < 0 ? layout.margin : width - layout.margin
    let best = null
    let least = Infinity
    for (const dot of piece.dots) {
      P.copy(dot.local).applyMatrix4(dot.mesh.matrixWorld)
      // A point that travels — a tooth on a turning gear — makes a poor anchor.
      const rel = P.clone().sub(H)
      dot.moving = !!dot.was && dot.was.distanceTo(rel) > 0.004
      dot.was = rel
      const at = onScreen(P)
      dot.x = at.x
      dot.y = at.y
      if (!at.ok || (piece.solid && !owns(id, at.x, at.y))) continue
      let cost = Math.abs(at.x - edge) + Math.abs(at.y - (piece.ly ?? at.y)) * 0.35
      if (dot.moving) cost += 140
      // Two lines never end on the same spot.
      for (const other of taken) if (Math.hypot(at.x - other.x, at.y - other.y) < 12) cost += 220
      // Stay put unless somewhere else is clearly better.
      if (dot === piece.dot) cost -= 26
      if (cost < least) {
        least = cost
        best = dot
      }
    }
    if (best) piece.dot = best
    if (piece.dot) taken.push(piece.dot)
  }
  layout.looked = true
}

/** Left or right. A piece keeps its side until it has plainly crossed over. */
function sides(list) {
  const mid = list.reduce((sum, piece) => sum + piece.cx, 0) / list.length
  const slack = Math.max(18, width * 0.03)
  for (const piece of list) {
    const dx = piece.cx - mid
    if (!piece.side) piece.side = Math.abs(dx) > slack ? Math.sign(dx) : 0
    else if (dx * piece.side < -slack * 2) piece.side = Math.sign(dx)
  }
  // A straight stack has no left or right: deal the names out down the stack.
  let left = list.filter((piece) => piece.side < 0).length
  let right = list.filter((piece) => piece.side > 0).length
  for (const piece of list.filter((p) => !p.side).sort((a, b) => a.cy - b.cy)) {
    piece.side = left <= right ? -1 : 1
    if (piece.side < 0) left++
    else right++
  }
  // And neither column takes more names than it has room for.
  const fits = Math.max(1, Math.floor((height - 36) / GAP))
  for (const [from, count, other] of [[-1, left, right], [1, right, left]]) {
    let over = count - fits
    let space = fits - other
    if (over <= 0 || space <= 0) continue
    for (const piece of list.filter((p) => p.side === from).sort((a, b) => (a.cx - b.cx) * from)) {
      if (over-- <= 0 || space-- <= 0) break
      piece.side = -from
    }
  }
}

/** Level with its part, then pushed apart; names trade places before lines cross. */
function stack(column) {
  column.sort((a, b) => (a.order ?? a.sy) - (b.order ?? b.sy))
  for (let pass = 0; pass < column.length; pass++) {
    let swapped = false
    for (let i = 0; i + 1 < column.length; i++) {
      if (column[i].sy <= column[i + 1].sy + 8) continue
      ;[column[i], column[i + 1]] = [column[i + 1], column[i]]
      swapped = true
    }
    if (!swapped) break
  }
  const top = 18
  const bottom = height - 18
  const ys = column.map((piece) => clamp(piece.sy, top, bottom))
  for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + GAP)
  if (ys.length && ys[ys.length - 1] > bottom) {
    ys[ys.length - 1] = bottom
    for (let i = ys.length - 2; i >= 0; i--) ys[i] = Math.min(ys[i], ys[i + 1] - GAP)
  }
  column.forEach((piece, i) => {
    piece.order = i
    piece.ly = piece.ly == null ? ys[i] : piece.ly + (ys[i] - piece.ly) * 0.3
  })
}

function drawLabels() {
  ink.clearRect(0, 0, width, height)
  const alpha = clamp((blown - 0.45) / 0.35, 0, 1)
  if (alpha <= 0) return
  const list = labelled()
  if (!list.length) return

  for (const piece of list) {
    piece.centre ??= piece.box.getCenter(new THREE.Vector3())
    P.copy(piece.centre)
    if (piece.away) P.addScaledVector(piece.away, blown)
    const at = onScreen(toStage(P))
    piece.cx = at.x
    piece.cy = at.y
  }
  sides(list)
  if (!layout.looked || frame % 6 === 0) look(list)

  const shown = []
  for (const piece of list) {
    if (!piece.dot) continue
    const at = onScreen(P.copy(piece.dot.local).applyMatrix4(piece.dot.mesh.matrixWorld))
    if (P.z >= 1) continue
    piece.sx = at.x
    piece.sy = at.y
    shown.push(piece)
  }
  stack(shown.filter((piece) => piece.side < 0))
  stack(shown.filter((piece) => piece.side > 0))

  const m = layout.margin
  ink.globalAlpha = alpha
  ink.lineCap = ink.lineJoin = 'round'
  ink.font = LABEL_FONT
  ink.textBaseline = 'middle'
  const line = (piece) => {
    const x0 = piece.side < 0 ? m - 8 : width - m + 8
    ink.beginPath()
    ink.moveTo(x0, piece.ly)
    ink.lineTo(x0 - piece.side * 12, piece.ly)
    ink.lineTo(piece.sx, piece.sy)
    ink.stroke()
  }
  // Dark underneath, white on top: the lines read against steel and against black.
  ink.strokeStyle = 'rgba(6, 7, 9, 0.82)'
  ink.lineWidth = 4.6
  shown.forEach(line)
  ink.strokeStyle = 'rgba(255, 255, 255, 0.96)'
  ink.lineWidth = 2.4
  shown.forEach(line)
  for (const piece of shown) {
    ink.beginPath()
    ink.arc(piece.sx, piece.sy, 3.6, 0, Math.PI * 2)
    ink.fillStyle = '#ffffff'
    ink.fill()
    ink.lineWidth = 1.6
    ink.strokeStyle = 'rgba(6, 7, 9, 0.9)'
    ink.stroke()
  }
  for (const piece of shown) {
    ink.textAlign = piece.side < 0 ? 'right' : 'left'
    const x = piece.side < 0 ? m - 14 : width - m + 14
    ink.lineWidth = 3.4
    ink.strokeStyle = 'rgba(6, 7, 9, 0.86)'
    ink.strokeText(piece.label, x, piece.ly)
    ink.fillStyle = '#ffffff'
    ink.fillText(piece.label, x, piece.ly)
  }
  ink.globalAlpha = 1
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

const slug = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'piece'

/** Every piece as its own file, where it sits when assembled, in millimetres, Z up. */
function printFiles() {
  const all = pieces()
  const was = { scale: root.scale.clone(), position: root.position.clone(), rotation: root.rotation.clone() }
  const spots = all.map((piece) => piece.holder.position.clone())
  root.scale.setScalar(1)
  root.position.set(0, 0, 0)
  // The stage is Y up; printers and slicers are Z up.
  root.rotation.set(Math.PI / 2, 0, 0)
  for (const piece of all) piece.holder.position.set(0, 0, 0)
  root.updateMatrixWorld(true)

  const files = []
  const names = new Set()
  const exporter = new STLExporter()
  for (const piece of all) {
    try {
      const data = exporter.parse(piece.holder, { binary: true })
      if (data.byteLength <= 84) continue
      let name = slug(piece.label || piece.part.name)
      for (let n = 2; names.has(name); n++) name = `${slug(piece.label || piece.part.name)}-${n}`
      names.add(name)
      files.push({ name: `${String(files.length + 1).padStart(2, '0')}-${name}.stl`, bytes: data.buffer })
    } catch {
      // One piece that will not export does not stop the rest.
    }
  }

  root.scale.copy(was.scale)
  root.position.copy(was.position)
  root.rotation.copy(was.rotation)
  all.forEach((piece, i) => piece.holder.position.copy(spots[i]))
  root.updateMatrixWorld(true)
  post({ type: 'stl', files }, files.map((file) => file.bytes))
}

// ---------------------------------------------------------------------------
// The seal
// ---------------------------------------------------------------------------

/** Try every way out. Each one should come back 'blocked'. */
async function probe() {
  const attempt = async (fn) => {
    try {
      return (await fn()) === false ? 'blocked' : 'open'
    } catch {
      return 'blocked'
    }
  }
  const report = {
    home: await attempt(() => fetch('/health', { mode: 'no-cors' })),
    outside: await attempt(() => fetch('https://example.com/', { mode: 'no-cors' })),
    socket: await attempt(
      () =>
        new Promise((yes, no) => {
          const ws = new WebSocket(`ws://${location.host}`)
          ws.onopen = () => (ws.close(), yes(true))
          ws.onerror = () => no(new Error('refused'))
          setTimeout(() => no(new Error('no answer')), 2500)
        }),
    ),
    picture: await attempt(
      () =>
        new Promise((yes, no) => {
          const img = new Image()
          img.onload = () => yes(true)
          img.onerror = () => no(new Error('refused'))
          img.src = `/workshop/pixel.gif?probe=${Date.now()}`
          setTimeout(() => no(new Error('no answer')), 2500)
        }),
    ),
    storage: await attempt(() => (window.localStorage.setItem('probe', '1'), true)),
    cookie: await attempt(() => ((document.cookie = 'probe=1'), document.cookie.includes('probe'))),
    parent: await attempt(() => !!window.parent.document.body),
  }
  post({ type: 'seal', report, sealed: Object.values(report).every((v) => v === 'blocked') })
}

// ---------------------------------------------------------------------------
// Keeping up
// ---------------------------------------------------------------------------

// If frames stay slow, give up sharpness first and occlusion second. It never
// climbs back: a picture that keeps changing quality is worse than a soft one.
let slow = 0
function govern(dt) {
  if (document.hidden || dt > 0.25) return
  slow = dt > 1 / 34 ? slow + 1 : Math.max(0, slow - 2)
  if (slow < 90) return
  slow = 0
  if (sharpness > 1) {
    sharpness = Math.max(1, sharpness - 0.25)
    resize()
  } else if (gtao.enabled) gtao.enabled = false
}

// ---------------------------------------------------------------------------
// Messages in
// ---------------------------------------------------------------------------

/** One thing at a time, in the order it was asked for; a failure never jams the line. */
const next = (job) => (queue = queue.then(job).catch((err) => post({ type: 'fault', message: String(err?.message ?? err).slice(0, 300) })))

const VIEWS = {
  top: () => ({ phi: 0.06 }),
  front: () => ({ theta: 0, phi: rad(80) }),
  back: () => ({ theta: Math.PI, phi: rad(80) }),
  side: () => ({ theta: Math.PI / 2, phi: rad(80) }),
  flip: () => ({ theta: pose().theta + Math.PI }),
  in: () => ({ r: pose().r * 0.68 }),
  out: () => ({ r: pose().r * 1.45 }),
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return
  const m = event.data
  if (!m || typeof m !== 'object') return
  switch (m.op) {
    case 'ping':
      return post({ type: 'pong' })
    case 'reset':
      return next(clearStage)
    case 'part':
      return next(() => run(String(m.name).slice(0, 80), String(m.code ?? '')))
    case 'remove':
      return next(() => remove(String(m.name)))
    case 'built':
      return next(() => {
        settle()
        post({
          type: 'built',
          parts: parts.size,
          pieces: pieces().length,
          triangles: pieces().reduce((n, piece) => n + piece.tris, 0),
          radius: R(),
        })
      })
    case 'camera': {
      if (m.to === 'stop') return (controls.autoRotate = false)
      if (m.to === 'spin') return (controls.autoRotate = true)
      touched = true
      if (m.to === 'fit') return fit()
      const view = VIEWS[m.to]
      return view && fly(view(), 800)
    }
    case 'light':
      return setLight(String(m.to))
    case 'explode':
      return next(() => post({ type: 'apart', on: !!m.on, moved: pull(!!m.on) }))
    case 'stl':
      return next(printFiles)
    case 'probe':
      return probe()
  }
})

canvas.addEventListener('webglcontextlost', () => post({ type: 'lost' }))

// ---------------------------------------------------------------------------
// Every frame
// ---------------------------------------------------------------------------

let last = performance.now()
function tick(now) {
  requestAnimationFrame(tick)
  const dt = (now - last) / 1000
  last = now
  frame++
  const t = now / 1000
  for (const part of parts.values()) {
    for (let i = part.ticks.length - 1; i >= 0; i--) {
      try {
        part.ticks[i](t - part.at, Math.min(dt, 0.1))
      } catch (err) {
        // A tick that throws is taken off; the pieces it was moving stay where they are.
        part.ticks.splice(i, 1)
        post({ type: 'ran', name: part.name, ok: false, late: true, message: `in W.onTick: ${String(err?.message ?? err).slice(0, 240)}` })
      }
    }
  }
  stepBlast(now)
  stepFlight(now)
  controls.update()
  composer.render(Math.min(dt, 0.1))
  drawLabels()
  govern(dt)
}
requestAnimationFrame(tick)

post({ type: 'ready', three: THREE.REVISION })
