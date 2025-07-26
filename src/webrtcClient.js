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
const audioEls = {}   // peerId → PannerNode wrapper

// ── AUDIO CONTEXT ─────────────────────────────────────────────────────────
const audioCtx = new AudioContext()

function log(...args) {
  if (DEBUG) console.log('[webrtc]', ...args)
}

// ── HELPERS ────────────────────────────────────────────────────────────────
function computeVolume(dist) {
  if (dist <= 0)   return 1.0
  if (dist >= 100) return 0.0
  return 1 - dist / 100
}

function update3DPositions() {
  if (!state.self) return
  // Update listener position
  audioCtx.listener.positionX.setValueAtTime(state.self.x, audioCtx.currentTime)
  audioCtx.listener.positionY.setValueAtTime(state.self.y, audioCtx.currentTime)
  audioCtx.listener.positionZ.setValueAtTime(state.self.z || 0, audioCtx.currentTime)

  // Update each peer’s panner
  for (const p of state.players) {
    const entry = audioEls[p.guid.toString()]
    if (!entry) continue
    entry.panner.positionX.setValueAtTime(p.x, audioCtx.currentTime)
    entry.panner.positionY.setValueAtTime(p.y, audioCtx.currentTime)
    entry.panner.positionZ.setValueAtTime(p.z || 0, audioCtx.currentTime)
  }
}

// ── PUBLIC API ─────────────────────────────────────────────────────────────
export function setGuid(id) {
  guid = id.toString()
  localStorage.setItem('guid', guid)
  log('GUID set to', guid)
}

export function resumeAudio() {
  audioCtx.resume()
    .then(() => log('AudioContext resumed'))
    .catch(err => log('Audio resume error', err))
}

export function getNearbyPlayers() {
  return state.nearby
}

// Mute/unmute mic
export function toggleMute(shouldMute) {
  if (!localStream) return log('Cannot mute: no localStream')
  const ms = localStream.mediaStream || localStream.stream || localStream
  if (!ms) return log('Cannot mute: no MediaStream')
  ms.getAudioTracks().forEach(t => (t.enabled = !shouldMute))
  log(`Microphone ${shouldMute ? 'muted' : 'unmuted'}`)
}

// Deafen = mute mic + incoming
export function toggleDeafen(shouldDeafen) {
  // Mute outgoing
  toggleMute(shouldDeafen)
  // Mute all incoming
  Object.values(audioEls).forEach(e => {
    if (e.panner) {
      // simplest: reduce volume to 0 via panner refDistance hack
      e.panner.refDistance = shouldDeafen ? Infinity : 1
    }
  })
  log(`Deafen ${shouldDeafen ? 'on' : 'off'}`)
}

// ── PROXIMITY SOCKET ────────────────────────────────────────────────────────
export function connectProximitySocket() {
  if (!guid) return log('Cannot connect: GUID not set')
  if (proximitySocket &&
      (proximitySocket.readyState === WebSocket.OPEN ||
       proximitySocket.readyState === WebSocket.CONNECTING)) {
    return log('Proximity socket already open/connecting')
  }

  proximitySocket = new WebSocket(PROXIMITY_WS)
  proximitySocket.onopen  = () => log('Connected to proximity server')
  proximitySocket.onerror = e  => log('Proximity socket error', e)
  proximitySocket.onclose = () => {
    log('Proximity socket closed')
    if (!manuallyClosed) {
      setTimeout(connectProximitySocket, 2000)
      log('Reconnecting in 2s…')
    }
  }

  proximitySocket.onmessage = ({ data }) => {
    const maps = JSON.parse(data)
    log('got maps payload →', maps)

    // Find self
    let selfPkt = null
    for (const arr of Object.values(maps)) {
      const f = arr.find(p => p.guid.toString() === guid)
      if (f) { selfPkt = f; break }
    }
    if (!selfPkt) return log('No self entry yet')

    // Update state.self + players
    state.self    = selfPkt
    const roomKey = selfPkt.map.toString()
    const arr     = maps[roomKey] || []
    state.players = arr.filter(p => p.guid.toString() !== guid)
    log(`players on map ${roomKey} →`, state.players)

    // Move listener & panners in 3D
    update3DPositions()

    // Recompute nearby list
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

    // Auto-join SFU room
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
  if (client) { client.close().catch(()=>{}); client = null }
  log('Proximity disabled')
}

// ── SFU JOIN & PUBLISH ──────────────────────────────────────────────────────
async function _joinAndPublish(roomId) {
  if (client) {
    await client.close().catch(e => log('close error', e))
    client = null
  }

  signal = new IonSFUJSONRPCSignal(SFU_WS)
  client = new SFUClient(signal)

  signal.onopen = async () => {
    log('Signal open → joining SFU room:', roomId)

    // Raw fallback handler (uncomment to test raw <audio>):
    // client.ontrack = (track, remoteStream) => {
    //   if (track.kind !== 'audio') return
    //   console.log('[webrtc] raw ontrack')
    //   const a = new Audio()
    //   a.srcObject = remoteStream.mediaStream || remoteStream
    //   a.autoplay = true
    //   a.controls = true
    //   document.body.appendChild(a)
    // }

    // PannerNode handler
    client.ontrack = (track, remoteStream) => {
      if (track.kind !== 'audio') return
      const peerId = (remoteStream.peerId || remoteStream.id).toString()
      log('🔊 ontrack for peer', peerId)

      const ms     = remoteStream.mediaStream || remoteStream
      const src    = audioCtx.createMediaStreamSource(ms)
      const pan    = audioCtx.createPanner()
      pan.panningModel  = 'HRTF'
      pan.distanceModel = 'inverse'
      pan.refDistance   = 1
      pan.maxDistance   = 100
      pan.rolloffFactor = 1
      src.connect(pan).connect(audioCtx.destination)

      audioEls[peerId] = { panner: pan }
    }

    try {
      localStream = await LocalStream.getUserMedia({ audio: true, video: false })
      await client.join(roomId, guid)
      log('✅ joined SFU room', roomId, 'as GUID=', guid)
      await client.publish(localStream)
      log('🎤 published local stream')
    } catch (err) {
      console.error('[webrtc] SFU join/publish error:', err)
      currentRoom = roomId
    }
  }
}

function _maybeJoinRoom() {
  if (!state.self) return
  const room = `map-${state.self.map}`

  if (state.self.map !== lastSelfMapId) {
    lastSelfMapId = state.self.map
    _joinAndPublish(room).then(() => (currentRoom = room))
    return
  }
  if (state.players.some(p => p.distance <= 60) && room !== currentRoom) {
    _joinAndPublish(room).then(() => (currentRoom = room))
  }
}

// ── AUTO-BOOTSTRAP ─────────────────────────────────────────────────────────
const saved = localStorage.getItem('guid')
if (saved) {
  setGuid(saved)
  connectProximitySocket()
}