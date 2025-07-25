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
  // Parse the incoming JSON array
  const list = JSON.parse(data);  // e.g. [ {guid:2207,…}, {guid:2324,…} ]

  // Find your own entry
  const me = list.find(p => p.guid.toString() === guid);
  if (me) state.self = me;

  // Everybody else becomes your 'players' array
  state.players = list.filter(p => p.guid.toString() !== guid);

  // Now run your existing proximity logic to rebuild state.nearby and join rooms
  _updateNearby();
};
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
  log('Switching to room:', roomId);

  // close old client if any
  if (client) {
    try { await client.close(); } catch(e){ log('close error', e) }
    client = null;
  }

  signal = new IonSFUJSONRPCSignal(SFU_WS);
  client = new SFUClient(signal);

  signal.onopen = async () => {
    log('Signal open, joining SFU room:', roomId);

    // 1) Prepare your remote‐track handler *before* join()
    client.ontrack = (track, stream) => {
      if (track.kind !== 'audio') return;
      log('Received remote audio track:', stream.id, 'from peerId=', stream.peerId);

      const audio = new Audio();
      audio.srcObject = stream;
      audio.autoplay = true;
      document.body.appendChild(audio);
      audioEls[stream.id] = audio;

      // start at full volume; you can add attenuation later
      audio.volume = 1.0;
    };

    // 2) Grab your mic (LocalStream so publish() works)
    localStream = await LocalStream.getUserMedia({ audio: true, video: false });

    // 3) Join the room with your GUID
    await client.join(roomId, guid);

    // 4) Immediately publish your mic
    await client.publish(localStream);
    log('Published local stream');
  };
}

// Tell the code not to auto-reconnect, then close the socket.
export function disconnectProximity() {
  manuallyClosed = true;
  if (proximitySocket) proximitySocket.close();
  proximitySocket = null;
  // if you also want to leave the SFU room immediately:
  currentRoom = null;
  if (client) {
    client.close().catch(() => {});
    client = null;
  }
  log('Proximity completely disabled by user');
}

// ————— Auto-bootstrap on load —————
const saved = localStorage.getItem('guid')
if (saved) {
  setGuid(saved)
  connectProximitySocket()
}

export function toggleMute(shouldMute) {
  if (!localStream) {
    return log('Cannot mute: localStream not initialized');
  }

  // figure out the actual MediaStream object
  let ms;
  if (localStream.mediaStream) {
    // Ion LocalStream exposes .mediaStream
    ms = localStream.mediaStream;
  } else if (localStream.stream) {
    // some versions expose .stream
    ms = localStream.stream;
  } else if (localStream instanceof MediaStream) {
    // or it might itself be a MediaStream
    ms = localStream;
  }

  if (!ms) {
    return log('Cannot mute: no underlying MediaStream found on localStream');
  }

  // disable/enable every audio track
  ms.getAudioTracks().forEach(track => {
    track.enabled = !shouldMute;
  });

  log(`Microphone ${shouldMute ? 'muted' : 'unmuted'}`);
}

export function toggleDeafen(shouldDeafen) {
  // 1) Mute/unmute remote audio elements
  Object.values(audioEls).forEach(audio => {
    audio.muted = shouldDeafen;
  });

  // 2) Mute/unmute your mic tracks
  if (localStream && localStream.stream) {
    localStream.stream.getAudioTracks().forEach(track => {
      track.enabled = !shouldDeafen;
    });
  }

  log('Toggled deafen:', shouldDeafen);
}


