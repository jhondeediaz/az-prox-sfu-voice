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
let joinedOnce      = false
let currentRoom     = null

// track your avatar + peers
const state = { self: null, peers: [] }

// one hidden <audio> per peer GUID
const audioEls = {}

// ── LOGGER ────────────────────────────────────────────────────────────────
function log(...args) {
  if (DEBUG) console.log('[webrtc]', ...args)
}

// ── VOLUME CURVE ────────────────────────────────────────────────────────────
/** 1 yd → 1.0, 50 yd → 0.0, linear in between. */
function computeVolume(distance) {
  if (distance <=  1) return 1.0
  if (distance >= 50) return 0.0
  return (50 - distance) / 49
}

// ── PUBLIC API ─────────────────────────────────────────────────────────────
export function setGuid(id) {
  guid = id.toString()
  localStorage.setItem('guid', guid)
  log('GUID set to', guid)
}

export async function resumeAudio() {
  // no-op when using plain <audio> elements
}

export function getNearbyPlayers() {
  // for your debug panel
  return state.peers.map(p => ({ guid: p.guid, distance: p.distance }))
}

export function toggleMute(muted) {
  if (!localStream) return
  const ms = localStream.mediaStream || localStream.stream || localStream
  ms.getAudioTracks().forEach(t => t.enabled = !muted)
  log(`Microphone ${muted ? 'muted' : 'unmuted'}`)
}

export function toggleDeafen(deafened) {
  // mute incoming
  Object.values(audioEls).forEach(a => { a.muted = deafened })
  // mute outgoing
  toggleMute(deafened)
  log(`Deafen ${deafened ? 'on' : 'off'}`)
}

export async function disconnectProximity() {
  proximitySocket?.close()
  proximitySocket = null

  if (client) {
    try { await client.close() }
    catch(e){ log('SFU close error', e) }
    client = null
    currentRoom = null
    joinedOnce  = false
  }

  // mute any leftover audio
  Object.values(audioEls).forEach(a => { a.muted = true })
  log('Proximity disabled')
}

export function reconnectSocket() {
  proximitySocket?.close()
  connectProximitySocket()
}

export function connectProximitySocket() {
  if (!guid) {
    log('Cannot connect: GUID not set')
    return
  }
  if (proximitySocket &&
      (proximitySocket.readyState === WebSocket.OPEN ||
       proximitySocket.readyState === WebSocket.CONNECTING))
  {
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

  // 1) find self
  let me = null
  for (const arr of Object.values(maps)) {
    const found = arr.find(p => p.guid.toString() === guid)
    if (found) { me = found; break }
  }
  if (!me) return
  state.self = me

  const mapKey = me.map.toString()

  // 2) compute peers + distances
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

  // 3) join/publish SFU **once** (or on real map change)
  const newRoom = `map-${mapKey}`
  if (!joinedOnce) {
    await joinAndPublish(newRoom)
    joinedOnce = true
    currentRoom = newRoom
  } else if (currentRoom !== newRoom) {
    joinedOnce = false
    await joinAndPublish(newRoom)
    joinedOnce = true
    currentRoom = newRoom
  }

  // 4) adjust volume on each audio element
  Object.entries(audioEls).forEach(([peerGuid, audio]) => {
    const peer = peers.find(p => p.guid === peerGuid)
    const vol  = peer ? computeVolume(peer.distance) : 0
    audio.volume = vol
    audio.muted  = (vol === 0)
  })
}

// ── SFU JOIN & PUBLISH ──────────────────────────────────────────────────────
async function joinAndPublish(roomId) {
  // Only recreate the SFU client if we have no client or are joining a different room
  if (!client || currentRoom !== roomId) {
    // If a client exists, close it before creating a new one
    if (client) {
      try {
        await client.close()
      } catch (e) {
        log('SFU close error', e)
      }
      client = null
    }
    const signal = new IonSFUJSONRPCSignal(SFU_WS)
    client = new SFUClient(signal)

    signal.onopen = async () => {
      log('Joining SFU room', roomId)

      // track incoming audio
      client.ontrack = (track, remoteStream) => {
        if (track.kind !== 'audio') return

        const peerGuid = (remoteStream.peerId || remoteStream.id).toString()
        log('ontrack for peer', peerGuid)

        const a = new Audio()
        a.dataset.peer  = peerGuid
        a.srcObject     = remoteStream.mediaStream || remoteStream
        a.autoplay      = true
        a.controls      = false
        a.style.display = 'none'
        document.body.appendChild(a)

        // store & set initial volume
        audioEls[peerGuid] = a
        const peerState = state.peers.find(p => p.guid === peerGuid)
        a.volume = peerState ? computeVolume(peerState.distance) : 1.0
      }

      // get mic & join
      try {
        if (!localStream) {
          localStream = await LocalStream.getUserMedia({ audio: true, video: false })
        }
        await client.join(roomId, guid)
        await client.publish(localStream)
        log('✅ joined SFU room', roomId, 'and published mic')
      } catch (err) {
        console.error('[webrtc] SFU error:', err)
      }
    }
  }
}

// ── AUTO‐BOOTSTRAP ──────────────────────────────────────────────────────────
const saved = localStorage.getItem('guid')
if (saved) {
  setGuid(saved)
  connectProximitySocket()
}