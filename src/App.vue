<template>
  <div id="app">
    <!-- GUID prompt -->
    <div v-if="!guidSet" class="guid-prompt">
      <input v-model="guidInput" type="number" placeholder="Enter your GUID" />
      <button @click="setGuidHandler">OK</button>
    </div>

    <div v-else class="main-ui">
      <label>
        <input type="checkbox" v-model="muted" @change="onMuteChange" />
        Mute (mic only)
      </label>
      <label>
        <input type="checkbox" v-model="deafened" @change="onDeafenChange" />
        Deafen (mic + speakers)
      </label>
      <button @click="resetGuid">Change GUID</button>

      <!-- Hidden audio tags, one per peer -->
      <div style="display: none">
        <audio
          v-for="peer in peers"
          :key="peer.guid"
          :data-guid="peer.guid"
          ref="audioEls"
          autoplay
          playsinline
        ></audio>
      </div>

      <!-- debug panel -->
      <div v-if="DEBUG" class="debug">
        <h3>Nearby Players</h3>
        <ul>
          <li v-for="p in peers" :key="p.guid">
            GUID {{ p.guid }} — {{ p.distance.toFixed(1) }} yd
          </li>
          <li v-if="peers.length===0">No one nearby</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, nextTick } from 'vue'
import {
  DEBUG,
  setGuid,
  resumeAudio,
  reconnectSocket,
  toggleMute,
  toggleDeafen,
  getNearbyPlayers
} from './webrtcClient.js'

const guidInput  = ref('')
const guidSet    = ref(false)
const muted      = ref(false)
const deafened   = ref(false)
const peers      = ref([])     // [{ guid, distance }]
const audioEls   = ref([])     // Vue will populate this with <audio> elements

// distance→volume: 1 yd→1.0, 50 yd→0.0
function computeVolume(d) {
  if (d <= 1) return 1
  if (d >= 50) return 0
  return 1 - (d - 1) / 49
}

async function setGuidHandler() {
  if (!guidInput.value) return
  setGuid(guidInput.value)
  guidSet.value = true
  await resumeAudio()
  reconnectSocket()
}

function onMuteChange() {
  toggleMute(muted.value)
  if (!muted.value && deafened.value) {
    deafened.value = false
    toggleDeafen(false)
  }
}

function onDeafenChange() {
  toggleDeafen(deafened.value)
  muted.value = deafened.value
}

function resetGuid() {
  guidSet.value = false
  localStorage.removeItem('guid')
}

async function tick() {
  // fetch latest distances
  peers.value = getNearbyPlayers()

  // wait for Vue to render any new <audio> tags
  await nextTick()

  // adjust volume on each audio element in our ref array
  audioEls.value.forEach(a => {
    const id = a.dataset.guid
    const p  = peers.value.find(x => x.guid === id)
    const vol = p ? computeVolume(p.distance) : 0
    a.volume = vol
    if (deafened.value) a.muted = true
  })
}

onMounted(() => {
  const saved = localStorage.getItem('guid')
  if (saved) {
    setGuid(saved)
    guidSet.value = true
    resumeAudio().then(() => {
      reconnectSocket()
    })
  }

  setInterval(tick, 500)
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