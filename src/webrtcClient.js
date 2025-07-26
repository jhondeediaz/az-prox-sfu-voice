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

// track your avatar + everybody else
const state = { self: null, players: [], nearby: [] }

// fallback <audio> tags for raw playback
const audioEls = {}  // peerId → HTMLAudioElement

function log(...args) {
  if (DEBUG) console.log('[webrtc]', ...args)
}

/**
 * 1 yd → 1.0, 50 yd → 0.0, clamp outside.
 */
function computeVolumeByDistance(dist) {
  if (dist <= 1) return 1.0
  if (dist >= 50) return 0.0
  // linear ramp from 1→50 yards: map [1,50] to [1,0]
  return 1 - (dist - 1) / 49
}

// ── PUBLIC API ─────────────────────────────────────────────────────────────

export function setGuid(id) {
  guid = id.toString()
  localStorage.setItem('guid', guid)
  log('GUID set to', guid)
}

export async function resumeAudio() {
  // no-op when you use plain <audio> elements
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
  // mute incoming
  Object.values(audioEls).forEach(a => a.muted = shouldDeafen)
  // mute mic
  toggleMute(shouldDeafen)
  log(`Deafen ${shouldDeafen ? 'on' : 'off'}`)
}

// ── PROXIMITY SOCKET ───────────────────────────────────────────────────────

function connectProximitySocket() {
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
    log('Proximity socket closed — retry in 2s')
    setTimeout(connectProximitySocket, 2000)
  }
  proximitySocket.onmessage = handleProximity
}

export function reconnectSocket() {
  if (proximitySocket) proximitySocket.close()
  connectProximitySocket()
}

export async function disconnectProximity() {
  if (proximitySocket) proximitySocket.close()
  proximitySocket = null
  currentRoom     = null
  if (client) {
    await client.close().catch(e => log('SFU close error', e))
    client = null
  }
  // mute any remnants
  Object.values(audioEls).forEach(a => a.muted = true)
}

// ── PROXIMITY HANDLER ──────────────────────────────────────────────────────

async function handleProximity({ data }) {
  const maps = JSON.parse(data)
  log('got proximity update →', maps)

  // 1) find yourself
  let me = null
  for (const arr of Object.values(maps)) {
    const f = arr.find(p => p.guid.toString() === guid)
    if (f) { me = f; break }
  }
  if (!me) return

  state.self = me
  const roomKey = me.map.toString()
  const playersAll = maps[roomKey] || []
  state.players = playersAll.filter(p => p.guid.toString() !== guid)

  // 2) build nearby list (for debug/UI)
  state.nearby = state.players
    .map(p => {
      const dx = p.x - me.x, dy = p.y - me.y, dz = (p.z||0) - (me.z||0)
      return { ...p, distance: Math.hypot(dx, dy, dz) }
    })
    .filter(p => p.distance <= 60)

  // 3) maybe (re)join the SFU room
  await maybeJoinRoom()

  // 4) update every audioElt’s volume
  Object.entries(audioEls).forEach(([peerId, audio]) => {
    const found = state.players.find(x => x.guid.toString() === peerId)
    audio.volume = found
      ? computeVolumeByDistance(found.distance)
      : 0
  })
}

// ── SFU JOIN & PUBLISH ──────────────────────────────────────────────────────

async function _joinAndPublish(roomId) {
  // clean up any old client + tags
  if (client) {
    await client.close().catch(e => log('SFU close error', e))
    client = null
  }
  Object.values(audioEls).forEach(a => a.remove())
  Object.keys(audioEls).forEach(k => delete audioEls[k])

  // spin up a fresh SFU client
  const signal = new IonSFUJSONRPCSignal(SFU_WS)
  client = new SFUClient(signal)

  signal.onopen = () => {
    log('Signal open → joining SFU room:', roomId)

    client.ontrack = (track, remoteStream) => {
      if (track.kind !== 'audio') return
      const peerId = (remoteStream.peerId || remoteStream.id).toString()
      log('ontrack for peer', peerId)

      // create a hidden <audio> element
      const a = new Audio()
      a.dataset.proxPeer = peerId
      a.srcObject        = remoteStream.mediaStream || remoteStream
      a.autoplay         = true
      a.controls         = false
      a.style.display    = 'none'
      a.volume           = 1   // we'll clamp downstream
      document.body.appendChild(a)
      audioEls[peerId]    = a
    }

    // now join & publish
    ;(async () => {
      if (!localStream) {
        localStream = await LocalStream.getUserMedia({ audio: true, video: false })
      }
      await client.join(roomId, guid)
      log('✅ joined room', roomId, 'as GUID=', guid)
      await client.publish(localStream)
      log('🎤 published local stream')
    })().catch(err => {
      console.error('[webrtc] SFU error:', err)
      currentRoom = roomId // avoid endless retries
    })
  }
}

async function maybeJoinRoom() {
  if (!state.self) return
  const room = `map-${state.self.map}`

  // map change → always re-join
  if (state.self.map !== lastSelfMapId) {
    lastSelfMapId = state.self.map
    await _joinAndPublish(room)
    currentRoom = room
    return
  }

  // someone nearby → join if not already
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