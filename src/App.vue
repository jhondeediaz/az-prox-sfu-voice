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
  disconnectProximity,
  toggleMute,
  toggleDeafen,
  getNearbyPlayers
} from './webrtcClient.js'

const guidInput      = ref('')
const guidSet        = ref(false)
const muted          = ref(false)
const deafened       = ref(false)
const nearbyPlayers  = ref([])

// 1) User enters GUID
async function setGuidHandler() {
  if (!guidInput.value) return

  setGuid(guidInput.value)
  guidSet.value = true

  // unlock audio
  await resumeAudio()

  // start proximity + SFU flow
  reconnectSocket()
}

// 2) Reset GUID
function resetGuid() {
  guidSet.value = false
  localStorage.removeItem('guid')
  // clean up connections
  disconnectProximity()
}

// 3) Mute (mic only)
function toggleMuteHandler() {
  toggleMute(muted.value)
  // if unmuting while still deafened, clear deafen
  if (!muted.value && deafened.value) {
    deafened.value = false
    toggleDeafen(false)
  }
}

// 4) Deafen = mic + all incoming
function toggleDeafenHandler() {
  toggleDeafen(deafened.value)
  // always sync mute checkbox
  muted.value = deafened.value
}

// on mount, re-hydrate GUID + start
onMounted(() => {
  const saved = localStorage.getItem('guid')
  if (saved) {
    setGuid(saved)
    guidSet.value = true
    resumeAudio().then(() => reconnectSocket())
  }

  // refresh debug list
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