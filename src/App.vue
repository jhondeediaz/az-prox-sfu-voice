<template>
  <div id="app">
    <!-- GUID prompt -->
    <div v-if="!guidSet" class="guid-prompt">
      <input
        v-model="guidInput"
        type="number"
        placeholder="Enter your GUID"
      />
      <button @click="setGuidHandler">OK</button>
    </div>

    <!-- Main UI once GUID is set -->
    <div v-else class="main-ui">
      <label>
        <input
          type="checkbox"
          v-model="muted"
          @change="toggleMuteHandler"
        />
        Mute (mic only)
      </label>

      <label>
        <input
          type="checkbox"
          v-model="deafened"
          @change="toggleDeafenHandler"
        />
        Deafen (mic + speakers)
      </label>

      <button @click="resetGuid">Change GUID</button>

      <!-- debug panel -->
      <div v-if="DEBUG" class="debug">
        <h3>Nearby Players</h3>
        <ul>
          <li v-for="p in nearbyPlayers" :key="p.guid">
            GUID {{ p.guid }} — {{ p.distance.toFixed(1) }} yd
          </li>
          <li v-if="nearbyPlayers.length === 0">No one nearby</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import {
  DEBUG,
  setGuid,
  resumeAudio,
  reconnectSocket,
  toggleMute,
  toggleDeafen,
  getNearbyPlayers
} from './webrtcClient.js'

const guidInput      = ref('')
const guidSet        = ref(false)
const muted          = ref(false)
const deafened       = ref(false)
const nearbyPlayers  = ref([])

// Called when user enters GUID
async function setGuidHandler() {
  if (!guidInput.value) return

  setGuid(guidInput.value)
  guidSet.value = true

  // unlock audio context and start SFU/proximity flow
  await resumeAudio()
  reconnectSocket()
}

// Reset everything to prompt for a new GUID
function resetGuid() {
  guidSet.value = false
  localStorage.removeItem('guid')
}

// Mute/unmute mic only.
// If they un-mute while still deafened, clear deafen.
function toggleMuteHandler() {
  toggleMute(muted.value)
  if (!muted.value && deafened.value) {
    deafened.value = false
    toggleDeafen(false)
  }
}

// Deafen = mute mic + silence all incoming.
// Toggling deafen also forces the mic-mute checkbox.
function toggleDeafenHandler() {
  toggleDeafen(deafened.value)
  // mirror “deafened” into the mic‐muted checkbox
  muted.value = deafened.value
}

// On mount, if we already had a GUID, rehydrate and reconnect
onMounted(() => {
  const saved = localStorage.getItem('guid')
  if (saved) {
    setGuid(saved)
    guidSet.value = true
    resumeAudio().then(reconnectSocket)
  }

  // keep the debug list up to date
  setInterval(() => {
    nearbyPlayers.value = getNearbyPlayers()
  }, 1000)
})
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