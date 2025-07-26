<template>
  <div id="app">
    <div v-if="!guidSet" class="guid-prompt">
      <input v-model="guidInput" type="number" placeholder="Your GUID" />
      <button @click="onSetGuid">OK</button>
    </div>
    <div v-else>
      <label>
        <input type="checkbox" v-model="muted" @change="onMute" /> Mute
      </label>
      <label>
        <input type="checkbox" v-model="deafened" @change="onDeafen" /> Deafen
      </label>
      <button @click="resetGuid">Change GUID</button>

      <div v-if="DEBUG">
        <h3>Players (dist)</h3>
        <ul>
          <li v-for="p in players" :key="p.guid">
            {{ p.guid }} — {{ p.distance.toFixed(1) }} yd
          </li>
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

const guidInput  = ref('')
const guidSet    = ref(false)
const muted      = ref(false)
const deafened   = ref(false)
const players    = ref([])

async function onSetGuid() {
  if (!guidInput.value) return
  setGuid(guidInput.value)
  guidSet.value = true
  await resumeAudio()
  reconnectSocket()
}

function onMute() {
  toggleMute(muted.value)
  if (!muted.value && deafened.value) {
    deafened.value = false
    toggleDeafen(false)
  }
}

function onDeafen() {
  toggleDeafen(deafened.value)
  muted.value = deafened.value
}

function resetGuid() {
  guidSet.value = false
  localStorage.removeItem('guid')
  disconnectProximity()
}

onMounted(() => {
  const saved = localStorage.getItem('guid')
  if (saved) {
    setGuid(saved)
    guidSet.value = true
    resumeAudio().then(reconnectSocket)
  }
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