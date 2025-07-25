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
let currentRoom     = null
const audioEls      = {}
const state         = { self: null, players: [], nearby: [] }

function log(...args) {
  if (DEBUG) console.log('[webrtc]', ...args)
}

// ————— API for App.vue —————
export function setGuid(id) {
  guid = id.toString()
  localStorage.setItem('guid', guid)
  log('GUID set to', guid)
}

export function getNearbyPlayers() {
  return state.nearby
}

export function reconnectSocket() {
  manuallyClosed = true
  if (proximitySocket) proximitySocket.close()
  manuallyClosed = false
  connectProximitySocket()
}

// ————— Proximity socket + reconnection —————
export function connectProximitySocket() {
  if (!guid) {
    log('GUID not set; cannot open proximity socket.')
    return
  }

  if (
    proximitySocket &&
    (proximitySocket.readyState === WebSocket.OPEN ||
     proximitySocket.readyState === WebSocket.CONNECTING)
  ) {
    log('Proximity socket already open or connecting.')
    return
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
    let p
    try { p = JSON.parse(data) }
    catch (e) { return log('Bad proximity JSON', e) }

    if (p.guid.toString() === guid) {
      state.self = p
    } else {
      const idx = state.players.findIndex(x => x.guid === p.guid)
      if (idx >= 0) state.players[idx] = p
      else           state.players.push(p)
    }

    _updateNearby()
  }
}

// ————— Proximity → SFU logic —————
function _updateNearby() {
  const me = state.self
  if (!me) return

  const nearby = state.players
    .filter(p => p.map === me.map && p.guid !== guid)
    .map(p => {
      const dx = p.x - me.x
      const dy = p.y - me.y
      const dz = (p.z||0) - (me.z||0)
      return { ...p, distance: Math.hypot(dx, dy, dz) }
    })
    .filter(p => p.distance <= 60)

  state.nearby = nearby

  const room = `map-${me.map}`
  if (nearby.length && room !== currentRoom) {
    _joinAndPublish(room)
    currentRoom = room
  }
}

// ————— Join SFU & publish mic —————
async function _joinAndPublish(roomId) {
  log('Switching to room:', roomId)

  if (client) {
    try { await client.close() }
    catch (e) { log('Error closing old client', e) }
    client = null
  }

  signal = new IonSFUJSONRPCSignal(SFU_WS)
  client = new SFUClient(signal)

  signal.onopen = async () => {
    log('Signal open, joining SFU room:', roomId)

    // 1) get a LocalStream so publish() is available
    localStream = await LocalStream.getUserMedia({ audio: true, video: false })

    // 2) join with your GUID
    await client.join(roomId, guid)

    // 3) then publish your mic
    await client.publish(localStream)
    log('Published local stream')

    // 4) handle incoming audio + (initial) full volume
    client.ontrack = (track, stream) => {
      if (track.kind !== 'audio') return
      log('Received remote audio track:', stream.id)

      const audio = new Audio()
      audio.srcObject = stream
      audio.autoplay = true
      document.body.appendChild(audio)
      audioEls[stream.id] = audio

      // temporary full volume so you can confirm you hear them
      audio.volume = 1.0
    }
  }
}

// ————— Auto-bootstrap on load —————
const saved = localStorage.getItem('guid')
if (saved) {
  setGuid(saved)
  connectProximitySocket()
}
