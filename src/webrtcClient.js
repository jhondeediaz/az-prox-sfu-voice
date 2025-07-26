// src/webrtcClient.js

import { IonSFUJSONRPCSignal } from 'ion-sdk-js/lib/signal/json-rpc-impl'
import SFUClient               from 'ion-sdk-js/lib/client'
import { LocalStream }         from 'ion-sdk-js'

// ── CONFIG ────────────────────────────────────────────────────────────────
const PROXIMITY_WS = import.meta.env.VITE_PROXIMITY_WS
const SFU_WS       = import.meta.env.VITE_SFU_WS
export const DEBUG = true

// ── STATE ─────────────────────────────────────────────────────────────────
let guid            = null
let proximitySocket = null
let client          = null
let localStream     = null
let joinedOnce      = false     // ensure we only join once per session
let lastMapKey      = null

// keep track of our own position + each peer’s distance
const state = { self: null, peers: [] }

// one hidden <audio> per peer GUID
const audioEls = {}  // peerGuid → HTMLAudioElement

function log(...args) {
  if (DEBUG) console.log('[webrtc]', ...args)
}

/**
 * 1 yd → 1.0, 50 yd → 0.0, linear ramp in between.
 */
function computeVolume(dist) {
  if (dist <= 1)  return 1.0
  if (dist >= 50) return 0.0
  return 1 - (dist - 1) / 49
}

// ── PUBLIC API ─────────────────────────────────────────────────────────────

/** Set your GUID and persist it */
export function setGuid(id) {
  guid = id.toString()
  localStorage.setItem('guid', guid)
  log('GUID set to', guid)
}

/** No-op; provided so you can await `resumeAudio()` uniformly */
export async function resumeAudio() {}

/** Return the list of peers currently in range */
export function getNearbyPlayers() {
  return state.peers.map(p => ({ guid: p.guid, distance: p.distance }))
}

/** Mute/unmute your mic */
export function toggleMute(muted) {
  if (!localStream) return
  const ms = localStream.mediaStream || localStream.stream || localStream
  ms.getAudioTracks().forEach(t => t.enabled = !muted)
  log(`Microphone ${muted ? 'muted' : 'unmuted'}`)
}

/** Mute/unmute mic + all incoming audio */
export function toggleDeafen(deafened) {
  // incoming
  Object.values(audioEls).forEach(a => { a.muted = deafened })
  // outgoing
  toggleMute(deafened)
  log(`Deafen ${deafened ? 'on' : 'off'}`)
}

/** Tear down proximity + SFU */
export async function disconnectProximity() {
  proximitySocket?.close()
  proximitySocket = null
  if (client) {
    await client.close().catch(()=>{})
    client = null
  }
  Object.values(audioEls).forEach(a => a.muted = true)
  log('Proximity disabled')
}

/** Force a reconnect of the proximity socket */
export function reconnectSocket() {
  proximitySocket?.close()
  connectProximitySocket()
}

/** Open proximity WebSocket, start receiving position updates */
export function connectProximitySocket() {
  if (!guid) {
    log('Cannot connect: GUID not set')
    return
  }
  if (
    proximitySocket &&
    (proximitySocket.readyState === WebSocket.OPEN ||
     proximitySocket.readyState === WebSocket.CONNECTING)
  ) {
    return log('Proximity socket already open/connecting')
  }

  proximitySocket = new WebSocket(PROXIMITY_WS)
  proximitySocket.onopen    = () => log('Proximity connected')
  proximitySocket.onerror   = e => log('Proximity error', e)
  proximitySocket.onclose   = () => {
    log('Proximity closed — retry in 2s')
    setTimeout(connectProximitySocket, 2000)
  }
  proximitySocket.onmessage = handleProximity
}

// ── PROXIMITY HANDLER ──────────────────────────────────────────────────────

async function handleProximity({ data }) {
  const maps = JSON.parse(data)

  // 1) find our own position packet
  let me = null
  for (const arr of Object.values(maps)) {
    const found = arr.find(p => p.guid.toString() === guid)
    if (found) { me = found; break }
  }
  if (!me) return

  state.self = me
  const mapKey = me.map.toString()

  // 2) compute each peer’s distance
  const peers = (maps[mapKey] || [])
    .filter(p => p.guid.toString() !== guid)
    .map(p => {
      const dx = p.x - me.x
      const dy = p.y - me.y
      const dz = (p.z||0) - (me.z||0)
      return {
        guid:     p.guid.toString(),
        distance: Math.hypot(dx, dy, dz)
      }
    })
  state.peers = peers

  // 3) on first ever proximity event (or map change), join SFU
  if (!joinedOnce || lastMapKey !== mapKey) {
    joinedOnce = true
    lastMapKey = mapKey
    await joinAndPublish(`map-${mapKey}`)
  }

  // 4) adjust volume on every hidden <audio> element
  peers.forEach(p => {
    const elt = audioEls[p.guid]
    if (elt) {
      elt.volume = computeVolume(p.distance)
      elt.muted  = false
    }
  })
}

// ── SFU JOIN & PUBLISH ──────────────────────────────────────────────────────

async function joinAndPublish(roomId) {
  // tear down any previous client + audio tags
  if (client) {
    await client.close().catch(e => log('SFU close error', e))
    client = null
  }
  Object.values(audioEls).forEach(a => a.remove())
  Object.keys(audioEls).forEach(k => delete audioEls[k])

  // create new SFU client
  const signal = new IonSFUJSONRPCSignal(SFU_WS)
  client = new SFUClient(signal)

  signal.onopen = () => {
    log('Joining SFU room', roomId)

    client.ontrack = (track, remoteStream) => {
      if (track.kind !== 'audio') return

      const peerGuid = (remoteStream.peerId || remoteStream.id).toString()
      log('ontrack for peer', peerGuid)

      // **unwrap the actual MediaStream**:
      const ms = remoteStream.mediaStream
              || remoteStream.stream
              || remoteStream

      const audio = new Audio()
      audio.dataset.peer = peerGuid
      audio.srcObject    = ms
      audio.autoplay     = true
      audio.controls     = false
      audio.style.display= 'none'
      // start at full volume; will be clamped by proximity
      audio.volume       = 1
      document.body.appendChild(audio)
      audioEls[peerGuid] = audio

      // ensure playback
      audio.play().catch(()=>{})
    }

    ;(async () => {
      if (!localStream) {
        localStream = await LocalStream.getUserMedia({ audio: true, video: false })
      }
      await client.join(roomId, guid)
      log('✅ joined', roomId, 'as', guid)
      await client.publish(localStream)
      log('🎤 published local stream')
    })().catch(err => {
      console.error('[webrtc] SFU error:', err)
    })
  }
}

// ── AUTO-BOOTSTRAP ──────────────────────────────────────────────────────────

const saved = localStorage.getItem('guid')
if (saved) {
  setGuid(saved)
  connectProximitySocket()
}