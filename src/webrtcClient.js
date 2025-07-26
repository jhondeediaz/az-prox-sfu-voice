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
const audioEls = {}   // peerId → HTMLAudioElement

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

  // update listener at our own coords
  const { x, y, z = 0 } = state.self
  audioCtx.listener.positionX.setValueAtTime(x, audioCtx.currentTime)
  audioCtx.listener.positionY.setValueAtTime(y, audioCtx.currentTime)
  audioCtx.listener.positionZ.setValueAtTime(z, audioCtx.currentTime)
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

export async function requestMic() {
  if (!localStream) {
    localStream = await LocalStream.getUserMedia({ audio: true, video: false })
    log('Microphone granted')
  }
}

export function getNearbyPlayers() {
  return state.nearby
}

export function toggleMute(shouldMute) {
  if (!localStream) return log('Cannot mute: no localStream')
  const ms = localStream.mediaStream || localStream.stream || localStream
  if (!ms) return log('Cannot mute: no MediaStream')
  ms.getAudioTracks().forEach(t => t.enabled = !shouldMute)
  log(`Microphone ${shouldMute ? 'muted' : 'unmuted'}`)
}

export function toggleDeafen(shouldDeafen) {
  // mute outgoing
  toggleMute(shouldDeafen)
  // hide incoming by removing elements
  Object.values(audioEls).forEach(a => { a.muted = shouldDeafen })
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

    // find our own packet
    let selfPkt = null
    for (const arr of Object.values(maps)) {
      const f = arr.find(p => p.guid.toString() === guid)
      if (f) { selfPkt = f; break }
    }
    if (!selfPkt) return log('No self entry yet')

    // update state
    state.self    = selfPkt
    const roomKey = selfPkt.map.toString()
    const players = (maps[roomKey] || []).filter(p => p.guid.toString() !== guid)
    state.players = players
    log(`players on map ${roomKey} →`, players)

    // reposition listener & build 3D if you re-implement it
    update3DPositions()

    // compute nearby
    state.nearby = players
      .map(p => ({
        ...p,
        distance: Math.hypot(
          p.x - selfPkt.x,
          p.y - selfPkt.y,
          (p.z||0) - (selfPkt.z||0)
        )
      }))
      .filter(p => p.distance <= 60)
    log('state.nearby →', state.nearby)

    _maybeJoinRoom()
  }
}

export function reconnectSocket() {
  manuallyClosed = true
  if (proximitySocket) proximitySocket.close()
  manuallyClosed = false
  connectProximitySocket()
}

// ── PROXIMITY DISCONNECT ────────────────────────────────────────────────────
export async function disconnectProximity() {
  manuallyClosed = true;
  if (proximitySocket) proximitySocket.close();
  proximitySocket = null;
  currentRoom     = null;
  if (client) {
    try {
      await client.close();
    } catch (err) {
      log('Error closing SFU client during disconnect:', err);
    }
    client = null;
  }
  log('Proximity disabled');
}

// ── SFU JOIN & PUBLISH ──────────────────────────────────────────────────────
async function _joinAndPublish(roomId) {
  // 1) Clean up any existing client
  if (client) {
    try {
      await client.close();
    } catch (err) {
      log('Error closing previous client:', err);
    }
    client = null;
  }

  // remove any old <audio> tags
  document.querySelectorAll('audio[data-prox-peer]').forEach(a => a.remove());
  Object.keys(audioEls).forEach(k => delete audioEls[k]);

  // 2) Create new Signal + Client
  signal = new IonSFUJSONRPCSignal(SFU_WS);
  client = new SFUClient(signal);

  signal.onopen = async () => {
    log('Signal open → joining SFU room:', roomId);

    // raw fallback handler
    client.ontrack = (track, remoteStream) => {
      if (track.kind !== 'audio') return;
      const peerId = (remoteStream.peerId || remoteStream.id).toString();
      log('🔊 raw ontrack for peer', peerId);

      const audio = new Audio();
      audio.dataset.proxPeer = peerId;
      audio.srcObject = remoteStream.mediaStream || remoteStream;
      audio.autoplay   = true;
      audio.controls   = false;
      audio.style.display = 'none';
      document.body.appendChild(audio);

      audioEls[peerId] = audio;
    };

    try {
      // ensure mic
      if (!localStream) {
        localStream = await LocalStream.getUserMedia({ audio: true, video: false });
      }

      // join & publish
      await client.join(roomId, guid);
      log('✅ joined room', roomId, 'as GUID=', guid);

      await client.publish(localStream);
      log('🎤 published local stream');
    } catch (err) {
      console.error('[webrtc] SFU join/publish error:', err);
      // prevent endless retry loops
      currentRoom = roomId;
    }
  };
}

async function _maybeJoinRoom() {
  if (!state.self) return;
  const newRoom = `map-${state.self.map}`;

  // 1) if map changed, always re-join
  if (state.self.map !== lastSelfMapId) {
    lastSelfMapId = state.self.map;
    log('Map changed → joining', newRoom);
    await _joinAndPublish(newRoom);
    currentRoom = newRoom;
    return;
  }

  // 2) if someone’s nearby & not in room yet
  if (state.nearby.length > 0 && newRoom !== currentRoom) {
    log('Players nearby → joining', newRoom);
    await _joinAndPublish(newRoom);
    currentRoom = newRoom;
  }
}

// ── AUTO-BOOTSTRAP ─────────────────────────────────────────────────────────
const saved = localStorage.getItem('guid')
if (saved) {
  setGuid(saved)
  connectProximitySocket()
}