<template>
  <div id="app">
    <div v-if="!guidSet" class="guid-prompt">
      <input v-model="guidInput" type="number" placeholder="Enter your GUID" />
      <button @click="setGuidHandler">OK</button>
    </div>

    <div v-else class="main-ui">
  <label><input type="checkbox" v-model="proximityEnabled" @change="toggleProximity" /> Enable Proximity</label>
  <label><input type="checkbox" v-model="muted" @change="toggleMuteHandler" /> Mute</label>
  <label><input type="checkbox" v-model="deafened" @change="toggleDeafenHandler" /> Deafen</label>

  <button @click="guidSet = false">Change GUID</button>

  <div v-if="DEBUG" class="debug">
    <h3>Nearby Players</h3>
    <ul>
      <li v-for="player in nearbyPlayers" :key="player.guid">
        {{ player.guid }}
      </li>
    </ul>
  </div>
</div>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import {
  DEBUG,
  setGuid,
  getNearbyPlayers,
  reconnectSocket,
  connectProximitySocket, 
  disconnectProximity,
  toggleMute,
  toggleDeafen
} from "./webrtcClient.js";

const guidInput = ref("");
const guidSet = ref(false);
const muted = ref(false);
const deafened = ref(false);
const nearbyPlayers = ref([]);
const proximityEnabled = ref(true)

function setGuidHandler() {
  if (guidInput.value) {
    setGuid(guidInput.value);
    guidSet.value = true;
    reconnectSocket();
  }
}


function toggleProximity() {
  if (proximityEnabled.value) {
    // user just *checked* the box
    connectProximitySocket()
  } else {
    // user just *unchecked* the box
    disconnectProximity()
  }
}

function toggleMuteHandler() {
  toggleMute(muted.value)
}

function toggleDeafenHandler() {
toggleDeafen(deafened.value)
toggleMute(deafened.value)
muted.value = deafened.value
}

onMounted(() => {
  const stored = localStorage.getItem("guid");
  if (stored) {
    setGuid(stored);
    guidSet.value = true;
    reconnectSocket();
  }

  setInterval(() => {
    nearbyPlayers.value = getNearbyPlayers();
  }, 1000);
});
</script>

<style>
body {
  background: #1e1e2f;
  color: #eee;
  margin: 0;
  font-family: sans-serif;
}

#app {
  padding: 1rem;
  width: 250px;
  height: auto;
  overflow: hidden;
}

.guid-prompt {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

input[type="number"],
button {
  padding: 0.5rem;
  font-size: 0.9rem;
  background: #2e2e40;
  color: white;
  border: none;
  border-radius: 4px;
}

button:hover {
  background: #44445c;
}

label {
  display: block;
  margin-top: 0.5rem;
}

.debug {
  margin-top: 1rem;
  font-size: 0.8rem;
}
</style>
