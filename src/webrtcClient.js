// webrtcClient.js

import { IonSFUJSONRPCSignal } from 'ion-sdk-js/lib/signal/json-rpc-impl'
import SFUClient               from 'ion-sdk-js/lib/client'
import { LocalStream }         from 'ion-sdk-js'

const PROXIMITY_WS = import.meta.env.VITE_PROXIMITY_WS
const SFU_WS       = import.meta.env.VITE_SFU_WS
export const DEBUG = true

let guid            = null
let proximitySocket = null
let manuallyClosed  = false
let signal          = null
let client          = null
let localStream     = null

// track which room & map we're currently in
let currentRoom     = null    // e.g. "map-1"
let lastSelfMapId   = null    // e.g. 1, 509, etc.

const audioEls      = {}      // stream.id → HTMLAudioElement
const state         = { self: null, players: [], nearby: [] }

// callback hook for UI
let onNearbyUpdate  = null

function log(...args) {
  if (DEBUG) console.log('[webrtc]', ...args)
}

// ─── Public API for App.vue ────────────────────────────────────────────────

/** Set your GUID (string or number) */
export function setGuid(id) {
  guid = id.toString()
  localStorage.setItem('guid', guid)
  log('GUID set to', guid)
}

/** Register a callback: cb(nearbyArray) */
export function onNearby(cb) {
  onNearbyUpdate = cb
}

/** Imperative pull of the latest nearby list */
export function getNearbyPlayers() {
  return state.nearby
}

/** Mute or unmute your *microphone* */
export function toggleMute(shouldMute) {
  if (!localStream) return log('Cannot mute: no localStream')
  // find the real MediaStream
  let ms = localStream.mediaStream || localStream.stream || 
           (localStream instanceof MediaStream ? localStream : null)
  if (!ms) return log('Cannot mute: no MediaStream found')
  ms.getAudioTracks().forEach(track => track.enabled = !shouldMute)
  log(`Microphone ${shouldMute ? 'muted' : 'unmuted'}`)
}

/** Deafen or undeafen: mic + speakers */
export function toggleDeafen(shouldDeafen) {
  // 1) Mute/unmute incoming
  Object.values(audioEls).forEach(audio => audio.muted = shouldDeafen)
  // 2) Mute/unmute mic
  if (localStream) {
    let ms = localStream.mediaStream || localStream.stream ||
             (localStream instanceof MediaStream ? localStream : null)
    if (ms) ms.getAudioTracks().forEach(track => track.enabled = !shouldDeafen)
  }
  log(`Deafen ${shouldDeafen ? 'on' : 'off'}`)
}

// ─── Proximity Socket Management ───────────────────────────────────────────

/** (Re)open the proximity WebSocket */
export function connectProximitySocket() {
  if (!guid) {
    return log('Cannot open proximity socket: GUID not set')
  }
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

    // 1) find self
    let selfPacket = null
    for (const players of Object.values(maps)) {
      const f = players.find(p => p.guid.toString() === guid)
      if (f) { selfPacket = f; break }
    }
    if (!selfPacket) {
      return log('onmessage → no entry for my GUID yet')
    }

    // 2) update state.self + state.players
    state.self = selfPacket
    const mk = selfPacket.map.toString()
    const arr = maps[mk] || []
    state.players = arr.filter(p => p.guid.toString() !== guid)
    log(`players on map ${mk} →`, state.players)

    // 3) recompute nearby + maybe join room
    _updateNearby()
  }
}

/** Force a manual reconnect */
export function reconnectSocket() {
  manuallyClosed = true
  if (proximitySocket) proximitySocket.close()
  manuallyClosed = false
  connectProximitySocket()
}

/** Cleanly disable proximity + leave SFU room */
export function disconnectProximity() {
  manuallyClosed = true
  if (proximitySocket) proximitySocket.close()
  proximitySocket = null
  currentRoom      = null
  if (client) {
    client.close().catch(()=>{})
    client = null
  }
  log('Proximity disabled')
}

// ─── Proximity → SFU Logic ────────────────────────────────────────────────

/** Recompute `state.nearby` and notify UI */
function _updateNearby() {
  if (!state.self) return

  // compute distances
  const nearby = state.players
    .map(p => ({
      ...p,
      distance: Math.hypot(
        p.x - state.self.x,
        p.y - state.self.y,
        (p.z||0) - (state.self.z||0)
      )
    }))
    .filter(p => p.distance <= 60)

  state.nearby = nearby
  log('state.nearby →', nearby)
  if (onNearbyUpdate) onNearbyUpdate(nearby)

  // handle SFU room join
  _maybeJoinRoom()
}

/** Decide when to join/publish to the SFU room */
async function _maybeJoinRoom() {
  const me = state.self
  if (!me) return

  const room  = `map-${me.map}`

  // 1) if map changed, join immediately
  if (me.map !== lastSelfMapId) {
    lastSelfMapId = me.map
    log('Map changed → joining room', room)
    await _joinAndPublish(room)
    currentRoom = room
    return
  }

  // 2) if someone is nearby and not in room yet
  if (state.nearby.length > 0 && room !== currentRoom) {
    log('Someone nearby → joining room', room)
    await _joinAndPublish(room)
    currentRoom = room
  }
}

/** Join SFU via Ion + publish your mic */
async function _joinAndPublish(roomId) {
  // cleanup old client
  if (client) {
    try { await client.close() } catch(e){ log('close error',e) }
    client = null
  }

  signal = new IonSFUJSONRPCSignal(SFU_WS)
  client = new SFUClient(signal)

  signal.onopen = async () => {
    log('Signal open, joining SFU room:', roomId)

    // prepare remote track handler
	  client.ontrack = (track, stream) => {
  if (track.kind !== 'audio') return;

  // 1) create an AudioContext graph for this stream
  const audioCtx = new AudioContext();
  const src      = audioCtx.createMediaStreamSource(stream);
  const gainNode = audioCtx.createGain();
  src.connect(gainNode).connect(audioCtx.destination);

  // 2) store the gainNode so you can adjust it later
  audioEls[stream.id] = { stream, gainNode };

  // 3) kick off periodic attenuation based on distance
  setInterval(() => {
    if (!state.self) {
      gainNode.gain.value = 0;
      return;
    }

    // find the peer in your players list by stream.id
    const peer = state.players.find(p => p.streamId === stream.id);
    if (!peer) {
      gainNode.gain.value = 0;
      return;
    }

    // compute 3D distance
    const dx = peer.x - state.self.x;
    const dy = peer.y - state.self.y;
    const dz = (peer.z||0) - (state.self.z||0);
    const dist = Math.hypot(dx, dy, dz);

    // set gain based on your 100-yard curve
    gainNode.gain.value = dist <= 20  ? 1.0
                            : dist <= 40  ? 0.8
                            : dist <= 60  ? 0.6
                            : dist <= 80  ? 0.4
                            : dist <= 100 ? 0.2
                            : 0;
  }, 250);
};

    // get mic & join+publish
    localStream = await LocalStream.getUserMedia({ audio: true, video: false })
    await client.join(roomId, guid)
    await client.publish(localStream)
    log('Published local stream')
  }
}

// ─── Auto‐bootstrap on load if GUID saved ──────────────────────────────────
const saved = localStorage.getItem('guid')
if (saved) {
  setGuid(saved)
  connectProximitySocket()
}
