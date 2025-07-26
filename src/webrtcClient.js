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
let manuallyClosed  = false
let signal          = null
let client          = null
let localStream     = null
let lastSelfMapId   = null
let currentRoom     = null

const state    = { self: null, players: [], nearby: [] }
const audioEls = {}   // peerId → { panner: PannerNode }
const audioCtx = new AudioContext()

let onNearbyUpdate   = null

// ── AUDIO CONTEXT ─────────────────────────────────────────────────────────
// Removed duplicate audioCtx declaration here

function log(...args) {
  if (DEBUG) console.log('[webrtc]', ...args)
}

// ── HELPERS ────────────────────────────────────────────────────────────────
/** Linear fade: 0 yd → 100% … 100 yd → 0% */
function computeVolume(dist) {
  if (dist <= 0)   return 1.0
  if (dist >= 100) return 0.0
  return 1 - dist / 100
}

/** Update listener + panner positions in 3D space */
function update3DPositions() {
  if (!state.self) return

  // listener = local player
  audioCtx.listener.positionX.setValueAtTime(state.self.x, audioCtx.currentTime)
  audioCtx.listener.positionY.setValueAtTime(state.self.y, audioCtx.currentTime)
  audioCtx.listener.positionZ.setValueAtTime(state.self.z || 0, audioCtx.currentTime)

  // each remote peer
  for (const peer of state.players) {
    const entry = audioEls[peer.guid.toString()]
    if (!entry || !entry.panner) continue
    entry.panner.positionX.setValueAtTime(peer.x, audioCtx.currentTime)
    entry.panner.positionY.setValueAtTime(peer.y, audioCtx.currentTime)
    entry.panner.positionZ.setValueAtTime(peer.z || 0, audioCtx.currentTime)
  }
}

// ── PUBLIC API ─────────────────────────────────────────────────────────────
export function setGuid(id) {
  guid = id.toString()
  localStorage.setItem('guid', guid)
  log('GUID set to', guid)
}

export function onNearby(cb) {
  onNearbyUpdate = cb
}

export function getNearbyPlayers() {
  return state.nearby
}

export function toggleMute(shouldMute) {
  if (!localStream) return log('Cannot mute: no localStream')
  const ms = localStream.mediaStream || localStream.stream
  if (!ms) return log('Cannot mute: no MediaStream')
  ms.getAudioTracks().forEach(t => t.enabled = !shouldMute)
  log(`Microphone ${shouldMute ? 'muted' : 'unmuted'}`)
}

export function toggleDeafen(shouldDeafen) {
  // mute/unmute incoming
  Object.values(audioEls).forEach(e => e.panner && (e.panner.disconnect(), e.panner.connect(audioCtx.destination)))
  // Object.values(audioEls).forEach(e => e audioEls and we can't mute the panner. Actually deafen we should mute the destination)
  // simpler: just mute the destination gain
  // but for now, reuse toggleMute for mic
  toggleMute(shouldDeafen)
  log(`Deafen ${shouldDeafen ? 'on' : 'off'}`)
}

// ── PROXIMITY SOCKET ────────────────────────────────────────────────────────
export function connectProximitySocket() {
  if (!guid) return log('Cannot open proximity socket: GUID not set')
  if (proximitySocket &&
      (proximitySocket.readyState === WebSocket.OPEN ||
       proximitySocket.readyState === WebSocket.CONNECTING)
  ) {
    return log('Proximity socket already open/connecting')
  }

  proximitySocket = new WebSocket(PROXIMITY_WS)
  proximitySocket.onopen  = () => log('Connected to proximity server')
  proximitySocket.onerror = e  => log('Proximity socket error', e)
  proximitySocket.onclose = () => {
    log('Proximity socket closed')
    if (!manuallyClosed) {
      log('Reconnecting in 2s…')
      setTimeout(connectProximitySocket, 2000)
    }
  }

  proximitySocket.onmessage = ({ data }) => {
    const maps = JSON.parse(data)
    log('got maps payload →', maps)

    // 1) find self packet
    let selfPacket = null
    for (const players of Object.values(maps)) {
      const f = players.find(p => p.guid.toString() === guid)
      if (f) { selfPacket = f; break }
    }
    if (!selfPacket) return log('onmessage → no entry for my GUID yet')

    // 2) update state.self + state.players
    state.self    = selfPacket
    const key     = selfPacket.map.toString()
    const all     = maps[key] || []
    state.players = all.filter(p => p.guid.toString() !== guid)
    log(`players on map ${key} →`, state.players)

    // 3) update panner positions
    update3DPositions()

    // 4) recompute nearby
    state.nearby = state.players
      .map(p => ({ ...p,
        distance: Math.hypot(
          p.x - state.self.x,
          p.y - state.self.y,
          (p.z||0) - (state.self.z||0)
        )
      }))
      .filter(p => p.distance <= 60)
    log('state.nearby →', state.nearby)
    if (onNearbyUpdate) onNearbyUpdate(state.nearby)

    // 5) auto-join SFU if needed
    _maybeJoinRoom()
  }
}

export function reconnectSocket() {
  manuallyClosed = true
  if (proximitySocket) proximitySocket.close()
  manuallyClosed = false
  connectProximitySocket()
}

export function disconnectProximity() {
  manuallyClosed = true
  if (proximitySocket) proximitySocket.close()
  proximitySocket = null
  currentRoom     = null
  if (client) {
    client.close().catch(()=>{})
    client = null
  }
  log('Proximity disabled')
}

// ── SFU JOIN & PUBLISH ──────────────────────────────────────────────────────
async function _joinAndPublish(roomId) {
  if (client) {
    await client.close().catch(e => log('close client error', e))
    client = null
  }

  signal = new IonSFUJSONRPCSignal(SFU_WS)
  client = new SFUClient(signal)

  signal.onopen = async () => {
    log('Signal open, joining SFU room:', roomId)

    // attach ontrack handler BEFORE join/publish
    client.ontrack = (track, remoteStream) => {
      if (track.kind !== 'audio') return

      const peerId = (remoteStream.peerId || remoteStream.id).toString()
      log('🔊 ontrack for peer', peerId)

      // wrap in PannerNode
      const ms     = remoteStream.mediaStream || remoteStream
      const source = audioCtx.createMediaStreamSource(ms)
      const panner = audioCtx.createPanner()
      panner.panningModel  = 'HRTF'
      panner.distanceModel = 'inverse'
      panner.refDistance   = 1
      panner.maxDistance   = 100
      panner.rolloffFactor = 1
      source.connect(panner).connect(audioCtx.destination)

      // store for updates
      audioEls[peerId] = { panner }
    }

    try {
      localStream = await LocalStream.getUserMedia({ audio: true, video: false })
      await client.join(roomId, guid)
      log('✅ join() succeeded for', roomId, 'as GUID=', guid)
      await client.publish(localStream)
      log('🎤 publish() succeeded')
    } catch (err) {
      console.error('[webrtc] 🚨 SFU join/publish error:', err)
      currentRoom = roomId  // prevent infinite retry
    }
  }
}

function _maybeJoinRoom() {
  if (!state.self) return
  const room = `map-${state.self.map}`

  if (state.self.map !== lastSelfMapId) {
    lastSelfMapId = state.self.map
    log('Map change → joining', room)
    _joinAndPublish(room).then(() => (currentRoom = room))
    return
  }

  if (state.nearby.length > 0 && room !== currentRoom) {
    log('Someone nearby → joining', room)
    _joinAndPublish(room).then(() => (currentRoom = room))
  }
}

// ── AUTO-BOOTSTRAP ─────────────────────────────────────────────────────────
const saved = localStorage.getItem('guid')
if (saved) {
  setGuid(saved)
  connectProximitySocket()
}