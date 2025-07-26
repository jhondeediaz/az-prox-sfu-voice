<template>
  <div id="app">
    <!-- GUID prompt -->
    <div v-if="!guidSet" class="guid-prompt">
      <input
        v-model="guidInput"
        type="number"
        placeholder="Enter your GUID"
      />
      <button @click="onSetGuid">OK</button>
    </div>

    <!-- Main UI once GUID is set -->
    <div v-else class="main-ui">
      <label>
        <input
          type="checkbox"
          v-model="muted"
          @change="onMute"
        />
        Mute (mic only)
      </label>

      <label>
        <input
          type="checkbox"
          v-model="deafened"
          @change="onDeafen"
        />
        Deafen (mic + speakers)
      </label>

      <button @click="onChangeGuid">Change GUID</button>

      <!-- debug panel -->
      <div v-if="DEBUG" class="debug">
        <h3>Nearby Players</h3>
        <ul>
          <li v-for="p in players" :key="p.guid">
            GUID {{ p.guid }} — {{ p.distance.toFixed(1) }} yd
          </li>
          <li v-if="players.length === 0">No one nearby</li>
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
  connectProximitySocket,
  disconnectProximity,
  reconnectSocket,
  toggleMute,
  toggleDeafen,
  getNearbyPlayers
} from './webrtcClient.js'

const guidInput      = ref('')
const guidSet        = ref(false)
const muted          = ref(false)
const deafened       = ref(false)
const players        = ref([])

// Called when the user clicks “OK” to set their GUID
async function onSetGuid() {
  if (!guidInput.value) return

  // store & flip into “live” mode
  setGuid(guidInput.value)
  guidSet.value = true

  // unlock playback/mic
  await resumeAudio()

  // start proximity → SFU
  reconnectSocket()
  connectProximitySocket()
}

// Toggle mute (mic only)
function onMute() {
  toggleMute(muted.value)
  // if they un-mute but are still deafened, clear deafen too
  if (!muted.value && deafened.value) {
    deafened.value = false
    toggleDeafen(false)
  }
  // ensure when unmuting we unmute any incoming audio
  if (!muted.value) {
    // reenabling proximity will unmute elements
    reconnectSocket()
    connectProximitySocket()
  }
}

// Toggle deafen (mic + speakers)
function onDeafen() {
  toggleDeafen(deafened.value)
  // keep “mute” in sync
  muted.value = deafened.value
  // if undeafening, make sure we reconnect so audio elements are unmuted
  if (!deafened.value) {
    reconnectSocket()
    connectProximitySocket()
  }
}

// Reset GUID and tear everything down
function onChangeGuid() {
  guidSet.value = false
  localStorage.removeItem('guid')
  disconnectProximity()
}

// When this component mounts, rehydrate if they already had a GUID
onMounted(() => {
  const saved = localStorage.getItem('guid')
  if (saved) {
    setGuid(saved)
    guidSet.value = true
    resumeAudio().then(() => {
      reconnectSocket()
      connectProximitySocket()
    })
  }

  // refresh debug list every half second
  setInterval(() => {
    players.value = getNearbyPlayers()
  }, 500)
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