import { IonSFUJSONRPCSignal } from 'ion-sdk-js/lib/signal/json-rpc-impl'
import SFUClient from 'ion-sdk-js/lib/client'

const PROXIMITY_WS = import.meta.env.VITE_PROXIMITY_WS
const SFU_WS = import.meta.env.VITE_SFU_WS

export const DEBUG = true

let guid = null
let signal = null
let client = null
let proximitySocket = null
let localStream = null
let currentRoom = null
let audioElements = {}

const state = {
  players: [],
  nearby: [],
  self: null
}

function log(...args) {
  if (DEBUG) console.log('[WebRTC]', ...args)
}

export function setGuid(newGuid) {
  guid = Number(newGuid)
  localStorage.setItem('guid', guid)
  log('Set GUID:', guid)
}

export function reconnectSocket() {
  connectProximitySocket()
}

export function initWebRTC() {
  connectProximitySocket()
}

function connectProximitySocket() {
  if (proximitySocket) proximitySocket.close()

  proximitySocket = new WebSocket(PROXIMITY_WS)

  proximitySocket.addEventListener('open', () => {
    log('Connected to proximity server.')
  })

  proximitySocket.addEventListener('message', (event) => {
    try {
      const player = JSON.parse(event.data)
      if (!player?.guid) return

      const isSelf = player.guid === guid
      if (isSelf) {
        state.self = player
      } else {
        const existing = state.players.find(p => p.guid === player.guid)
        if (existing) Object.assign(existing, player)
        else state.players.push(player)
      }

      updateNearbyPlayers()
    } catch (err) {
      log('Error parsing player data:', err)
    }
  })

  proximitySocket.addEventListener('close', () => {
    log('Proximity socket closed. Reconnecting...')
    setTimeout(connectProximitySocket, 2000)
  })

  proximitySocket.addEventListener('error', err => {
    log('Proximity socket error:', err)
  })
}

function updateNearbyPlayers() {
  const self = state.self
  if (!self) return

  const nearby = state.players
    .filter(p => p.guid !== guid && p.map === self.map)
    .map(p => {
      const dx = p.x - self.x
      const dy = p.y - self.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      return { ...p, distance: dist }
    })
    .filter(p => p.distance <= 60)

  state.nearby = nearby

  if (getRoomName(self.map) !== currentRoom) {
    joinRoom(getRoomName(self.map))
  }
}

function getRoomName(mapId) {
  return `map-${mapId}`
}

export async function joinRoom(roomId) {
  if (roomId === currentRoom) return;
  currentRoom = roomId;
  log(`Switching to room: ${roomId}`);

  if (client) {
    try { await client.close() }
    catch (e) { log('close error', e) }
    client = null;
  }

  signal = new IonSFUJSONRPCSignal(SFU_WS);
  client = new SFUClient(signal);

  signal.onopen = async () => {
    log('Signal connected. Joining SFU room:', roomId);

    // 1) get your mic
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    // 2) join with GUID *as a string* in the correct spot
    await client.join(roomId, guid.toString(), localStream);

    client.ontrack = (track, stream) => {
      if (track.kind === 'audio') {
        const audio = new Audio();
        audio.srcObject = stream;
        audio.autoplay = true;
        document.body.appendChild(audio);
        audioElements[stream.id] = audio;
        log('Playing remote audio');
      }
    };
  };
}

export function getNearbyPlayers() {
  return state.nearby;
}
