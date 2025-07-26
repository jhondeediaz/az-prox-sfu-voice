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

// For spatial audio
const audioCtx   = new AudioContext()
const audioNodes = {}   // peerId → { panner: PannerNode }

// ── LOGGING ────────────────────────────────────────────────────────────────
function log(...args) {
  if (DEBUG) console.log('[webrtc]', ...args)
}

// ── HELPERS ────────────────────────────────────────────────────────────────
function computeNearbyPlayers(players, me) {
  return players
    .map(p => {
      const dx = p.x - me.x
      const dy = p.y - me.y
      const dz = (p.z || 0) - (me.z || 0)
      return { ...p, distance: Math.hypot(dx, dy, dz) }
    })
    .filter(p => p.distance <= 60)
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
  if (!localStream) return log('Mute: no local stream')
  const ms = localStream.mediaStream || localStream.stream || localStream
  ms.getAudioTracks().forEach(t => t.enabled = !shouldMute)
  log(`Microphone ${shouldMute ? 'muted' : 'unmuted'}`)
}

export function toggleDeafen(shouldDeafen) {
  // mute mic
  toggleMute(shouldDeafen)
  // mute all incoming spatial streams
  Object.values(audioNodes).forEach(({ panner }) => {
    panner.disconnect()
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
      log('Reconnecting in 2s…')
      setTimeout(connectProximitySocket, 2000)
    }
  }

  proximitySocket.onmessage = ({ data }) => {
    const maps = JSON.parse(data)
    // 1) find self
    let me = null
    for (const arr of Object.values(maps)) {
      const found = arr.find(p => p.guid.toString() === guid)
      if (found) { me = found; break }
    }
    if (!me) return log('No entry for my GUID yet')

    state.self    = me
    const roomKey = me.map.toString()
    const arr     = maps[roomKey] || []
    state.players = arr.filter(p => p.guid.toString() !== guid)

    // 2) compute nearby list
    state.nearby = computeNearbyPlayers(state.players, me)
    log('state.nearby →', state.nearby)

    // 3) update 3D positions
    update3DPositions()

    // 4) auto‐join/publish SFU room if needed
    _maybeJoinRoom()
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
    try { await client.close() } catch (e) { log('Error closing SFU client', e) }
    client = null
  }
  log('Proximity disabled')
}

// ── 3D POSITION UPDATE ─────────────────────────────────────────────────────
function update3DPositions() {
  if (!state.self) return
  const { x, y, z = 0 } = state.self

  // move listener to our avatar
  audioCtx.listener.positionX.setValueAtTime(x, audioCtx.currentTime)
  audioCtx.listener.positionY.setValueAtTime(y, audioCtx.currentTime)
  audioCtx.listener.positionZ.setValueAtTime(z, audioCtx.currentTime)

  // move each peer’s panner
  for (const p of state.players) {
    const nodes = audioNodes[p.guid.toString()]
    if (!nodes) continue
    nodes.panner.positionX.setValueAtTime(p.x, audioCtx.currentTime)
    nodes.panner.positionY.setValueAtTime(p.y, audioCtx.currentTime)
    nodes.panner.positionZ.setValueAtTime(p.z || 0, audioCtx.currentTime)
  }
}

// ── SFU JOIN & PUBLISH ──────────────────────────────────────────────────────
async function _joinAndPublish(roomId) {
  // tear down old
  if (client) {
    try { await client.close() } catch(e){ log('Error closing old client', e) }
    client = null
  }
  // clear audio nodes
  Object.values(audioNodes).forEach(({ panner }) => panner.disconnect())
  Object.keys(audioNodes).forEach(k => delete audioNodes[k])

  signal = new IonSFUJSONRPCSignal(SFU_WS)
  client = new SFUClient(signal)

  signal.onopen = async () => {
    log('Signal open → joining SFU room:', roomId)

    client.ontrack = async (track, remoteStream) => {
      if (track.kind !== 'audio') return
      const peerId = (remoteStream.peerId || remoteStream.id).toString()
      log('ontrack for peer', peerId)

      // unlock AudioContext if needed
      if (audioCtx.state === 'suspended') await audioCtx.resume()

      // create source → panner → destination
      const src     = audioCtx.createMediaStreamSource(remoteStream.mediaStream || remoteStream)
      const panner = audioCtx.createPanner()
      panner.panningModel  = 'HRTF'
      panner.distanceModel = 'inverse'
      panner.refDistance   = 1
      panner.maxDistance   = 100
      panner.rolloffFactor = 1

      src.connect(panner)
      panner.connect(audioCtx.destination)

      audioNodes[peerId] = { panner }
      // immediately position it
      update3DPositions()
    }

    try {
      // get mic if not yet
      if (!localStream) {
        localStream = await LocalStream.getUserMedia({ audio: true, video: false })
      }
      await client.join(roomId, guid)
      log('✅ joined room', roomId, 'as GUID=', guid)
      await client.publish(localStream)
      log('🎤 published local stream')
    } catch (err) {
      console.error('[webrtc] SFU join/publish error:', err)
      currentRoom = roomId
    }
  }
}

// ── ROOM‐JOIN LOGIC ─────────────────────────────────────────────────────────
async function _maybeJoinRoom() {
  if (!state.self) return
  const room = `map-${state.self.map}`

  // always re‐join when map changes
  if (state.self.map !== lastSelfMapId) {
    lastSelfMapId = state.self.map
    await _joinAndPublish(room)
    currentRoom = room
    return
  }

  // otherwise join when someone’s nearby
  if (state.nearby.length > 0 && room !== currentRoom) {
    await _joinAndPublish(room)
    currentRoom = room
  }
}

// ── AUTO‐BOOTSTRAP ON LOAD ─────────────────────────────────────────────────
const saved = localStorage.getItem('guid')
if (saved) {
  setGuid(saved)
  connectProximitySocket()
}