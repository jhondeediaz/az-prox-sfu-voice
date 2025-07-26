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
let lastSelfMapId   = null
let currentRoom     = null

const state = { self: null, players: [], nearby: [] }

// fallback <audio> elements
const audioEls = {}  // peerId → HTMLAudioElement

function log(...args) {
  if (DEBUG) console.log('[webrtc]', ...args)
}

// ── PUBLIC API ─────────────────────────────────────────────────────────────
export function setGuid(id) {
  guid = id.toString()
  localStorage.setItem('guid', guid)
  log('GUID set to', guid)
}

export async function resumeAudio() {
  // No-op here since we're using plain Audio elements
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

export function toggleDeafen(shouldDeafen) {
  // mute raw <audio> elements
  Object.values(audioEls).forEach(a => { a.muted = shouldDeafen })
  // also mute our mic
  toggleMute(shouldDeafen)
  log(`Deafen ${shouldDeafen ? 'on' : 'off'}`)
}

// ── PROXIMITY SOCKET ────────────────────────────────────────────────────────
function connectProximitySocket() {
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
    // silence any remaining playback
    Object.values(audioEls).forEach(a => { a.muted = true })
    // try to reconnect
    setTimeout(connectProximitySocket, 2000)
  }
  proximitySocket.onmessage = async ({ data }) => {
    const maps = JSON.parse(data)
    log('got proximity update →', maps)

    // find our own packet
    let me = null
    for (const arr of Object.values(maps)) {
      const f = arr.find(p => p.guid.toString() === guid)
      if (f) { me = f; break }
    }
    if (!me) return

    state.self = me
    const roomKey  = me.map.toString()
    const players  = (maps[roomKey] || []).filter(p => p.guid.toString() !== guid)
    state.players = players

    // compute nearby list
    state.nearby = players
      .map(p => {
        const dx = p.x - me.x, dy = p.y - me.y, dz = (p.z||0) - (me.z||0)
        return { ...p, distance: Math.hypot(dx, dy, dz) }
      })
      .filter(p => p.distance <= 60)

    // join/publish if needed
    await maybeJoinRoom()
  }
}

export function reconnectSocket() {
  if (proximitySocket) proximitySocket.close()
  connectProximitySocket()
}

// ── SFU JOIN & PUBLISH ──────────────────────────────────────────────────────
async function _joinAndPublish(roomId) {
  // clean up old
  if (client) {
    await client.close().catch(e => log('SFU close error', e))
    client = null
  }
  // remove old audio elements
  Object.values(audioEls).forEach(a => a.remove())
  Object.keys(audioEls).forEach(k => delete audioEls[k])

  // new SFU client
  const signal = new IonSFUJSONRPCSignal(SFU_WS)
  client = new SFUClient(signal)

  signal.onopen = async () => {
    log('Signal open → joining SFU room:', roomId)

    client.ontrack = async (track, remoteStream) => {
      if (track.kind !== 'audio') return
      const peerId = (remoteStream.peerId || remoteStream.id).toString()
      log('ontrack for peer', peerId)

      // basic raw <audio> fallback
      const a = new Audio()
      a.dataset.proxPeer = peerId
      a.srcObject       = remoteStream.mediaStream || remoteStream
      a.autoplay        = true
      a.controls        = false
      a.style.display   = 'none'
      document.body.appendChild(a)
      audioEls[peerId] = a
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
      console.error('[webrtc] SFU error:', err)
      currentRoom = roomId // prevent retry loops
    }
  }
}

async function maybeJoinRoom() {
  if (!state.self) return
  const room = `map-${state.self.map}`

  // on map change always re-join
  if (state.self.map !== lastSelfMapId) {
    lastSelfMapId = state.self.map
    await _joinAndPublish(room)
    currentRoom = room
    return
  }

  // if someone is nearby and not in room yet
  if (state.nearby.length > 0 && room !== currentRoom) {
    await _joinAndPublish(room)
    currentRoom = room
  }
}

// ── AUTO-BOOTSTRAP ─────────────────────────────────────────────────────────
const saved = localStorage.getItem('guid')
if (saved) {
  setGuid(saved)
  connectProximitySocket()
}