const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
	  width: 360,
    height: 320,
    resizable: false,
    title: 'AzerothFunkProximityVoice',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
});

  win.loadURL('http://localhost:5173'); // This is where Vite serves
}

app.whenReady().then(createWindow);
