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
let lastMapId       = null

// track your own pos and peer list
const state = { self: null, peers: [] }

// one hidden <audio> element per peer
const audioEls = {}   // peerGuid → HTMLAudioElement

function log(...args) {
  if (DEBUG) console.log('[webrtc]', ...args)
}

/**
 * Compute volume:
 *   dist ≤ 1 yd  → 1.0
 *   dist ≥ 50 yd → 0.0
 *   otherwise    → linear ramp between.
 */
function computeVolume(dist) {
  if (dist <= 1)  return 1.0
  if (dist >= 50) return 0.0
  return 1 - (dist - 1) / 49
}

// ── PUBLIC API ─────────────────────────────────────────────────────────────

export function setGuid(id) {
  guid = id.toString()
  localStorage.setItem('guid', guid)
  log('GUID set to', guid)
}

export async function resumeAudio() {
  // no-op when using plain <audio>
}

export function getNearbyPlayers() {
  return state.peers.map(p => ({ guid: p.guid, distance: p.distance }))
}

export function toggleMute(muted) {
  if (!localStream) return
  const ms = localStream.mediaStream || localStream.stream || localStream
  ms.getAudioTracks().forEach(t => t.enabled = !muted)
  log(`Microphone ${muted ? 'muted' : 'unmuted'}`)
}

export function toggleDeafen(deafened) {
  // mute all incoming audio
  Object.values(audioEls).forEach(a => a.muted = deafened)
  // also mute mic
  toggleMute(deafened)
  log(`Deafen ${deafened ? 'on' : 'off'}`)
}

// ── PROXIMITY SOCKET ───────────────────────────────────────────────────────

export function connectProximitySocket() {
  if (!guid) return log('Cannot connect: GUID not set')
  if (proximitySocket &&
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

export function reconnectSocket() {
  proximitySocket?.close()
  connectProximitySocket()
}

export async function disconnectProximity() {
  proximitySocket?.close()
  proximitySocket = null
  if (client) {
    await client.close().catch(() => {})
    client = null
  }
  // silence leftovers
  Object.values(audioEls).forEach(a => a.muted = true)
  log('Proximity disabled')
}

// ── PROXIMITY HANDLER ──────────────────────────────────────────────────────

async function handleProximity({ data }) {
  const maps = JSON.parse(data)

  // 1) find our own packet
  let me = null
  for (const arr of Object.values(maps)) {
    const f = arr.find(p => p.guid.toString() === guid)
    if (f) { me = f; break }
  }
  if (!me) return

  state.self = me
  const mapId = me.map.toString()

  // 2) build peer list with computed distances
  const peers = (maps[mapId] || [])
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

  // 3) if map changed, (re)join SFU once
  if (mapId !== lastMapId) {
    lastMapId = mapId
    await joinAndPublish(`map-${mapId}`)
  }

  // 4) update every peer’s <audio> volume
  peers.forEach(p => {
    const a = audioEls[p.guid]
    if (a) a.volume = computeVolume(p.distance)
  })
}

// ── SFU JOIN & PUBLISH ──────────────────────────────────────────────────────

async function joinAndPublish(roomId) {
  // teardown old client
  if (client) {
    await client.close().catch(e => log('SFU close error', e))
    client = null
  }

  // new SFU client
  const signal = new IonSFUJSONRPCSignal(SFU_WS)
  client = new SFUClient(signal)

  signal.onopen = () => {
    log('Joining SFU room', roomId)

    client.ontrack = (track, remoteStream) => {
      if (track.kind !== 'audio') return

      const peerGuid = (remoteStream.peerId || remoteStream.id).toString()
      log('ontrack for peer', peerGuid)

      // wrap single track in its own MediaStream
      const ms = new MediaStream([track])
      const a  = new Audio()
      a.dataset.peer  = peerGuid
      a.srcObject     = ms
      a.autoplay      = true
      a.controls      = false
      a.style.display = 'none'
      // initial volume from current state
      const peer = state.peers.find(x => x.guid === peerGuid)
      a.volume = peer ? computeVolume(peer.distance) : 0

      document.body.appendChild(a)
      audioEls[peerGuid] = a
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
      lastMapId = roomId // prevent retry loops
    })
  }
}

// ── AUTO-BOOTSTRAP ─────────────────────────────────────────────────────────

const saved = localStorage.getItem('guid')
if (saved) {
  setGuid(saved)
  resumeAudio().then(connectProximitySocket)
}