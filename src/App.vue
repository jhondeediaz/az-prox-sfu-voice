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
          v-model="proximityEnabled"
          @change="toggleProximity"
        />
        Enable Proximity
      </label>

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

      <button @click="guidSet = false">Change GUID</button>

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
  connectProximitySocket,
  disconnectProximity,
  reconnectSocket,
  toggleMute,
  toggleDeafen,
  onNearby
} from './webrtcClient.js'

// reactive state
const guidInput         = ref('')
const guidSet           = ref(false)
const proximityEnabled  = ref(true)
const muted             = ref(false)
const deafened          = ref(false)
const nearbyPlayers     = ref([])

// 1) when user clicks OK, save GUID & start socket
function setGuidHandler() {
  if (!guidInput.value) return
  setGuid(guidInput.value)
  guidSet.value = true
  reconnectSocket()
  // if the "Enable Proximity" box was already checked, kick it off
  if (proximityEnabled.value) connectProximitySocket()
}

// 2) toggle proximity on/off
function toggleProximity() {
  if (proximityEnabled.value) connectProximitySocket()
  else                         disconnectProximity()
}

// 3) toggle mute (mic only)
function toggleMuteHandler() {
  toggleMute(muted.value)
}

// 4) toggle deafen (mic + speakers)
function toggleDeafenHandler() {
  toggleDeafen(deafened.value)
  // keep the Mute box in sync
  muted.value = deafened.value
}

// 5) subscribe to proximity updates
onMounted(() => {
  const saved = localStorage.getItem('guid')
  if (saved) {
    setGuid(saved)
    guidSet.value = true
    reconnectSocket()
    if (proximityEnabled.value) connectProximitySocket()
  }

  // whenever the module computes a new nearby list, update our ref
  onNearby(list => {
    nearbyPlayers.value = list
  })
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
