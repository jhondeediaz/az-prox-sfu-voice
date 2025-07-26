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

// tracks “nearby” distances for Vue
const state = { nearby: [] }

// ── LOGGING ───────────────────────────────────────────────────────────────
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
  // no-op for plain <audio> elements
}

export function getNearbyPlayers() {
  return state.nearby
}

export function toggleMute(muted) {
  if (!localStream) return
  const ms = localStream.mediaStream || localStream.stream || localStream
  ms.getAudioTracks().forEach(t => t.enabled = !muted)
  log(`Microphone ${muted ? 'muted' : 'unmuted'}`)
}

export function toggleDeafen(deafened) {
  // mute all incoming <audio> tags
  document
    .querySelectorAll('audio[data-guid]')
    .forEach(a => { a.muted = deafened })
  // mute outgoing too
  toggleMute(deafened)
  log(`Deafen ${deafened ? 'on' : 'off'}`)
}

export function reconnectSocket() {
  if (proximitySocket) proximitySocket.close()
  connectProximitySocket()
}

// ── PROXIMITY SOCKET ───────────────────────────────────────────────────────
function connectProximitySocket() {
  if (!guid) {
    log('Cannot connect: GUID not set')
    return
  }
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

export async function disconnectProximity() {
  proximitySocket?.close()
  proximitySocket = null
  if (client) {
    await client.close().catch(()=>{})
    client = null
  }
  // mute all incoming
  document
    .querySelectorAll('audio[data-guid]')
    .forEach(a => { a.muted = true })
  log('Proximity disabled')
}

// ── HANDLE PROXIMITY UPDATES ──────────────────────────────────────────────
async function handleProximity({ data }) {
  const maps = JSON.parse(data)

  // 1) find yourself
  let me = null
  for (const arr of Object.values(maps)) {
    const f = arr.find(p => p.guid.toString() === guid)
    if (f) { me = f; break }
  }
  if (!me) return

  const roomKey = me.map.toString()
  // 2) build “nearby” array
  state.nearby = (maps[roomKey] || [])
    .filter(p => p.guid.toString() !== guid)
    .map(p => ({
      guid:     p.guid.toString(),
      distance: Math.hypot(p.x - me.x, p.y - me.y, (p.z||0) - (me.z||0))
    }))

  // 3) if map changed, (re)join SFU
  if (roomKey !== lastMapId) {
    lastMapId = roomKey
    await joinAndPublish(`map-${roomKey}`)
  }
}

// ── SFU JOIN & PUBLISH ─────────────────────────────────────────────────────
async function joinAndPublish(roomId) {
  // tear down old SFU client + tags
  if (client) {
    await client.close().catch(e => log('SFU close error', e))
    client = null
  }
  document
    .querySelectorAll('audio[data-guid]')
    .forEach(a => a.remove())

  // new SFU client
  const signal = new IonSFUJSONRPCSignal(SFU_WS)
  client = new SFUClient(signal)

  signal.onopen = () => {
    log('Joining SFU room', roomId)

    client.ontrack = (track, remoteStream) => {
      if (track.kind !== 'audio') return
      const peerGuid = (remoteStream.peerId || remoteStream.id).toString()
      log('ontrack for peer', peerGuid)

      // create a hidden <audio> element for this peer
      const audio = new Audio()
      audio.dataset.guid   = peerGuid
      audio.srcObject      = remoteStream.mediaStream || remoteStream
      audio.autoplay       = true
      audio.controls       = false
      audio.style.display  = 'none'
      document.body.appendChild(audio)
    }
  }

  try {
    if (!localStream) {
      localStream = await LocalStream.getUserMedia({ audio: true, video: false })
    }
    await client.join(roomId, guid)
    log('✅ joined', roomId, 'as GUID=', guid)
    await client.publish(localStream)
    log('🎤 published local stream')
  } catch (err) {
    console.error('[webrtc] SFU error:', err)
  }
}

// ── AUTO‐BOOTSTRAP ─────────────────────────────────────────────────────────
const saved = localStorage.getItem('guid')
if (saved) {
  setGuid(saved)
  connectProximitySocket()
}