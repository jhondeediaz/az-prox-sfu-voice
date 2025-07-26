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

const state = { self: null, players: [], nearby: [] }
// raw Audio elements fallback
const audioEls  = {}    // peerId → HTMLAudioElement
// WebAudio nodes (for spatial/gain control)
const audioNodes = {}   // peerId → { panner?: PannerNode, gain: GainNode }

const audioCtx = new AudioContext()

function log(...args) {
  if (DEBUG) console.log('[webrtc]', ...args)
}

// ── HELPERS ────────────────────────────────────────────────────────────────
function computeGain(dist) {
  const max = 100
  if (dist <= 0)   return 1
  if (dist >= max) return 0
  return 1 - dist / max
}
function computePan(dx, dy) {
  const angle = Math.atan2(dy, dx)
  return Math.cos(angle)
}

// ── PUBLIC API ─────────────────────────────────────────────────────────────
export function setGuid(id) {
  guid = id.toString()
  localStorage.setItem('guid', guid)
  log('GUID set to', guid)
}

export async function resumeAudio() {
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume()
    log('AudioContext resumed')
  }
}

export function getNearbyPlayers() {
  return state.nearby
}

export function toggleMute(shouldMute) {
  if (!localStream) return
  const ms = localStream.mediaStream || localStream.stream || localStream
  ms.getAudioTracks().forEach(t => t.enabled = !shouldMute)
  log(`Microphone ${shouldMute ? 'muted' : 'unmuted'}`)
}

// Completely silence mic + everything you hear
export function toggleDeafen(shouldDeafen) {
  toggleMute(shouldDeafen)

  // mute raw <audio> fallbacks
  Object.values(audioEls).forEach(a => { a.muted = shouldDeafen })
  // mute any WebAudio streams
  Object.values(audioNodes).forEach(({ gain }) => {
    gain.gain.setValueAtTime(shouldDeafen ? 0 : 1, audioCtx.currentTime)
  })

  log(`Deafen ${shouldDeafen ? 'on' : 'off'}`)
}

// ── PROXIMITY SOCKET ────────────────────────────────────────────────────────
export function connectProximitySocket() {
  if (!guid) return log('Cannot connect: GUID not set')
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

    // 1) find our own packet
    let selfPkt = null
    for (const arr of Object.values(maps)) {
      const f = arr.find(p => p.guid.toString() === guid)
      if (f) { selfPkt = f; break }
    }
    if (!selfPkt) return log('No self entry yet')

    // 2) update state.self & players
    state.self    = selfPkt
    const roomKey = selfPkt.map.toString()
    const all     = maps[roomKey] || []
    state.players = all.filter(p => p.guid.toString() !== guid)
    log(`players on map ${roomKey} →`, state.players)

    // 3) recompute nearby
    state.nearby = state.players
      .map(p => {
        const dx = p.x - selfPkt.x
        const dy = p.y - selfPkt.y
        const dz = (p.z||0) - (selfPkt.z||0)
        return { ...p,
          distance: Math.hypot(dx, dy, dz),
          dx, dy
        }
      })
      .filter(p => p.distance <= 60)
    log('state.nearby →', state.nearby)

    // 4) maybe join/publish new SFU room
    _maybeJoinRoom()

    // 5) update any live audioNodes or elements
    state.players.forEach(p => {
      const key   = p.guid.toString()
      const nodes = audioNodes[key]
      if (nodes) {
        nodes.panner?.pan.setValueAtTime(computePan(p.dx, p.dy), audioCtx.currentTime)
        nodes.gain.gain.setValueAtTime(computeGain(p.distance), audioCtx.currentTime)
      }
      const el = audioEls[key]
      if (el) {
        el.volume = computeGain(p.distance)
      }
    })
  }
}

export function reconnectSocket() {
  manuallyClosed = true
  proximitySocket?.close()
  manuallyClosed = false
  connectProximitySocket()
}

export async function disconnectProximity() {
  manuallyClosed = true
  proximitySocket?.close()
  proximitySocket = null
  currentRoom     = null

  if (client) {
    try {
      await client.close()
    } catch (e) {
      log('Error closing SFU client', e)
    }
    client = null
  }

  // immediately silence any remaining playback
  Object.values(audioEls).forEach(a => { a.muted = true })
  Object.values(audioNodes).forEach(({ gain }) => {
    gain.gain.setValueAtTime(0, audioCtx.currentTime)
  })

  log('Proximity disabled')
}

// ── SFU JOIN & PUBLISH ──────────────────────────────────────────────────────
async function _joinAndPublish(roomId) {
  // 1) tear down old client & audio graph
  if (client) {
    try {
      await client.close()
    } catch (e) {
      log('close client error', e)
    }
    client = null
  }

  // clean up old audio elements/nodes
  Object.values(audioEls).forEach(a => a.remove())
  Object.keys(audioEls).forEach(k => delete audioEls[k])
  Object.values(audioNodes).forEach(({ panner, gain }) => {
    panner.disconnect()
    gain.disconnect()
  })
  Object.keys(audioNodes).forEach(k => delete audioNodes[k])

  // 2) new SFU client
  signal = new IonSFUJSONRPCSignal(SFU_WS)
  client = new SFUClient(signal)

  signal.onopen = async () => {
    log('Signal open → joining SFU room:', roomId)

    client.ontrack = async (track, remoteStream) => {
      if (track.kind !== 'audio') return

      const peerId = (remoteStream.peerId || remoteStream.id).toString()
      log('ontrack for peer', peerId)

      // ensure AudioContext is unlocked
      if (audioCtx.state === 'suspended') {
        try { await audioCtx.resume() } catch {}
      }

      // ── RAW FALLBACK ────────────────────────
      const audio = new Audio()
      audio.dataset.proxPeer = peerId
      audio.srcObject        = remoteStream.mediaStream || remoteStream
      audio.autoplay         = true
      audio.controls         = false
      audio.style.display    = 'none'
      document.body.appendChild(audio)
      audioEls[peerId] = audio

      // ── WEB AUDIO SPATIAL ──────────────────
      const src   = audioCtx.createMediaStreamSource(remoteStream.mediaStream || remoteStream)
      const pan   = audioCtx.createStereoPanner()
      const gainN = audioCtx.createGain()
      src.connect(pan).connect(gainN).connect(audioCtx.destination)
      audioNodes[peerId] = { panner: pan, gain: gainN }
    }

    try {
      if (!localStream) {
        localStream = await LocalStream.getUserMedia({ audio: true, video: false })
      }
      await client.join(roomId, guid)
      log('✅ joined room', roomId, 'as GUID=', guid)
      await client.publish(localStream)
      log('🎤 published local stream')
    } catch (err) {
      console.error('[webrtc] SFU join/publish error:', err)
      // stop retry loops:
      currentRoom = roomId
    }
  }
}

// ── ROOM‐JOIN LOGIC ─────────────────────────────────────────────────────────
async function _maybeJoinRoom() {
  if (!state.self) return
  const room = `map-${state.self.map}`

  // if the map changed, always (re)join
  if (state.self.map !== lastSelfMapId) {
    lastSelfMapId = state.self.map
    log('Map changed → joining', room)
    await _joinAndPublish(room)
    currentRoom = room
    return
  }

  // if someone’s nearby & not already in room
  if (state.nearby.length > 0 && room !== currentRoom) {
    log('Players nearby → joining', room)
    await _joinAndPublish(room)
    currentRoom = room
  }
}

// ── AUTO‐BOOTSTRAP ─────────────────────────────────────────────────────────
const saved = localStorage.getItem('guid')
if (saved) {
  setGuid(saved)
  connectProximitySocket()
}