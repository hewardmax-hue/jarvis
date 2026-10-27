/**
 * Sharing the screen with Emrys.
 *
 * The browser only allows a screen capture to start from a click — it cannot
 * be opened by a tool call on its own — so the user starts sharing with the
 * Share button and the stream stays open until they stop it, either here or
 * from the browser's own "Stop sharing" bar. While it is open, `look_at_screen`
 * takes a frame from it; when it is not, the tool says so and Emrys asks.
 */

let stream: MediaStream | null = null
let video: HTMLVideoElement | null = null
let onChange: ((on: boolean) => void) | null = null

export function watchScreen(fn: (on: boolean) => void) {
  onChange = fn
}

export const sharing = () => Boolean(stream && video)

export async function startScreenShare(): Promise<void> {
  if (stream) return
  const s = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 2, width: { ideal: 1920 } },
    audio: false,
  })
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.srcObject = s
  await v.play()
  stream = s
  video = v
  // The browser's own "Stop sharing" ends the track; follow it.
  s.getVideoTracks()[0]?.addEventListener('ended', () => stopScreenShare())
  onChange?.(true)
}

export function stopScreenShare() {
  stream?.getTracks().forEach((t) => t.stop())
  if (video) video.srcObject = null
  stream = null
  video = null
  onChange?.(false)
}

/** One frame of the shared screen, as JPEG, scaled to a width a model reads well. */
export function grabScreen(): { data: string; mimeType: string } {
  if (!video?.videoWidth) throw new Error('not sharing')
  const scale = Math.min(1, 1600 / video.videoWidth)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(video.videoWidth * scale)
  canvas.height = Math.round(video.videoHeight * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('could not read the screen')
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  const url = canvas.toDataURL('image/jpeg', 0.8)
  return { data: url.slice(url.indexOf(',') + 1), mimeType: 'image/jpeg' }
}
