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

// tracks self + everybody on same map
const state = { self: null, players: [] }
// one hidden <audio> per peer
const audioEls = {}  // peerGuid → HTMLAudioElement

function log(...args) {
  if (DEBUG) console.log('[webrtc]', ...args)
}

/**
 * 1 yd → 1.0, 50 yd → 0.0, linear in between
 */
function computeVolume(dist) {
  if (dist <= 1)  return 1
  if (dist >= 50) return 0
  return 1 - (dist - 1) / 49
}

// ── PUBLIC API ─────────────────────────────────────────────────────────────
export function setGuid(id) {
  guid = id.toString()
  localStorage.setItem('guid', guid)
  log('GUID set to', guid)
}

export async function resumeAudio() {
  // no-op for <audio>
}

export function getNearbyPlayers() {
  return state.players.map(p => ({ guid: p.guid, distance: p.distance }))
}

export function toggleMute(muted) {
  if (!localStream) return
  const ms = localStream.mediaStream || localStream.stream || localStream
  ms.getAudioTracks().forEach(t => t.enabled = !muted)
  log(`Microphone ${muted ? 'muted' : 'unmuted'}`)
}

export function toggleDeafen(deafened) {
  toggleMute(deafened)
  Object.values(audioEls).forEach(a => a.muted = deafened)
  log(`Deafen ${deafened ? 'on' : 'off'}`)
}

// ── PROXIMITY ───────────────────────────────────────────────────────────────
function connectProximitySocket() {
  if (!guid) return log('GUID not set')
  if (proximitySocket &&
     (proximitySocket.readyState === WebSocket.OPEN ||
      proximitySocket.readyState === WebSocket.CONNECTING)) {
    return
  }
  proximitySocket = new WebSocket(PROXIMITY_WS)
  proximitySocket.onopen    = () => log('Proximity connected')
  proximitySocket.onerror   = e => log('Proximity error', e)
  proximitySocket.onmessage = handleProximity
  proximitySocket.onclose   = () => {
    log('Proximity closed, retrying in 2s')
    setTimeout(connectProximitySocket, 2000)
  }
}

export function reconnectSocket() {
  proximitySocket?.close()
  connectProximitySocket()
}

export async function disconnectProximity() {
  proximitySocket?.close()
  proximitySocket = null
  client?.close().catch(()=>{})
  client = null
  Object.values(audioEls).forEach(a => a.muted = true)
}

// update on each proximity message
async function handleProximity({ data }) {
  const maps = JSON.parse(data)

  // 1) locate self
  let me = null
  for (const arr of Object.values(maps)) {
    const found = arr.find(p => p.guid.toString() === guid)
    if (found) { me = found; break }
  }
  if (!me) return

  state.self = me
  const mapId = me.map.toString()

  // 2) list all others on same map + compute distance
  const others = (maps[mapId] || [])
    .filter(p => p.guid.toString() !== guid)
    .map(p => {
      const dx = p.x - me.x
      const dy = p.y - me.y
      const dz = (p.z||0) - (me.z||0)
      return { guid: p.guid.toString(),
               distance: Math.hypot(dx,dy,dz) }
    })

  state.players = others

  // 3) if map changed, join once
  if (mapId !== lastMapId) {
    lastMapId = mapId
    await joinAndPublish(`map-${mapId}`)
  }

  // 4) adjust volume of every peer, but never drop out of the room
  others.forEach(p => {
    const audio = audioEls[p.guid]
    if (audio) {
      audio.volume = computeVolume(p.distance)
    }
  })
}

// ── SFU JOIN & PUBLISH ──────────────────────────────────────────────────────
async function joinAndPublish(roomId) {
  // tear down old
  if (client) {
    await client.close().catch(e => log('SFU close error', e))
    client = null
  }
  Object.values(audioEls).forEach(a => a.remove())
  Object.keys(audioEls).forEach(k => delete audioEls[k])

  // new SFU client
  const signal = new IonSFUJSONRPCSignal(SFU_WS)
  client = new SFUClient(signal)

  signal.onopen = async () => {
    log('Joining SFU', roomId)

    client.ontrack = (track, remoteStream) => {
      if (track.kind !== 'audio') return
      const peerId = (remoteStream.peerId||remoteStream.id).toString()
      log('ontrack for', peerId)
      const a = new Audio()
      a.dataset.peer = peerId
      a.srcObject    = remoteStream.mediaStream||remoteStream
      a.autoplay     = true
      a.controls     = false
      a.style.display= 'none'
      a.volume       = 1
      document.body.appendChild(a)
      audioEls[peerId] = a
    }

    try {
      if (!localStream) {
        localStream = await LocalStream.getUserMedia({ audio: true, video: false })
      }
      await client.join(roomId, guid)
      await client.publish(localStream)
      log('Published mic to', roomId)
    } catch (err) {
      console.error('SFU error', err)
      lastMapId = roomId // stop retry loops
    }
  }
}

// ── AUTO‐BOOTSTRAP ─────────────────────────────────────────────────────────
const saved = localStorage.getItem('guid')
if (saved) {
  setGuid(saved)
  reconnectSocket()
}