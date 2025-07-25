import { IonSFUJSONRPCSignal, SFUClient } from "ion-sdk-js";

const PROXIMITY_WS = import.meta.env.VITE_PROXIMITY_WS;
const SFU_WS = import.meta.env.VITE_SFU_WS;

export const DEBUG = true;

let client;
let signal;
let localStream;
let currentRoom = null;
let proximitySocket = null;
let guid = null;
let state = {
  self: null,
  nearby: [],
  players: [],
};

const audioElements = {};

function log(...args) {
  if (DEBUG) console.log(...args);
}

export function setGuid(newGuid) {
  guid = Number(newGuid);
  localStorage.setItem("guid", guid);
  log("Set GUID:", guid);
}

export function getNearbyPlayers() {
  return state.nearby;
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function getMapRoom(mapId) {
  return `map-${mapId}`;
}

export function connectProximitySocket() {
  if (!guid) {
    log("GUID not set, cannot connect to proximity socket.");
    return;
  }

  if (proximitySocket) {
    proximitySocket.close();
  }

proximitySocket = new WebSocket(PROXIMITY_WS);

  proximitySocket.addEventListener("open", () => {
    log("Connected to proximity server.");
  });

  proximitySocket.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      const players = Array.isArray(data) ? data : [data];
      state.players = players;

      const self = players.find((p) => p.guid === guid);
      if (!self) return;

      state.self = self;

      const nearby = players
        .filter((p) => p.guid !== guid && p.map === self.map)
        .filter((p) => distance(p, self) <= 60);

      if (getMapRoom(self.map) !== currentRoom) {
        joinRoom(getMapRoom(self.map));
      }

      state.nearby = nearby;

      // Proximity logging
      for (const player of nearby) {
        const dx = player.x - self.x;
        const dy = player.y - self.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 40) {
          log(`Player ${player.guid} is nearby (${dist.toFixed(1)} yards)`);
        }
      }
    } catch (err) {
      log("Error parsing player data:", err);
    }
  });

  proximitySocket.addEventListener("close", () => {
    log("Proximity socket closed. Reconnecting...");
    setTimeout(connectProximitySocket, 2000);
  });

  proximitySocket.addEventListener("error", (err) => {
    log("Proximity socket error:", err);
  });
}

export async function joinRoom(roomId) {
  if (roomId === currentRoom) return;

  currentRoom = roomId;
  log(`Switching to room: ${roomId}`);

  if (client) {
    try {
      await client.close();
    } catch (e) {
      log("Failed to close previous client:", e);
    }
  }

  signal = new IonSFUJSONRPCSignal(SFU_WS);
  client = new SFUClient(signal);

  signal.onopen = async () => {
    log("Signal connected. Joining SFU room:", roomId);

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      await client.join(roomId, localStream);

      client.ontrack = (track, stream) => {
        if (track.kind === "audio") {
          const audio = new Audio();
          audio.srcObject = stream;
          audio.autoplay = true;
          audio.play();

          audioElements[stream.id] = audio;
          log("Playing remote audio stream");

          setInterval(() => {
            const target = state.nearby.find((p) => p.streamId === stream.id);
            if (!target || !state.self) return;

            const dist = distance(target, state.self);
            let volume = 0;

            if (dist <= 20) volume = 1.0;
            else if (dist <= 40) volume = 0.6;
            else if (dist <= 60) volume = 0.3;

            audio.volume = volume;
          }, 1000);
        }
      };
    } catch (err) {
      log("Error joining room:", err);
    }
  };
}

// Restore GUID from localStorage on startup
const savedGuid = localStorage.getItem("guid");
if (savedGuid) setGuid(savedGuid);


export function reconnectSocket() {
  connectProximitySocket();
}

export function setGuidFromInput(input) {
  setGuid(input);
  connectProximitySocket();
}
