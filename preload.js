const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onInit: cb => ipcRenderer.on('init', (_, data) => cb(data)),
  onBoxes: cb => ipcRenderer.on('boxes', (_, words) => cb(words)),
  onMode: cb => ipcRenderer.on('setMode', (_, m) => cb(m)),
  done: text => ipcRenderer.send('selected', text),
  cancel: () => ipcRenderer.send('cancel'),
  scroll: () => ipcRenderer.send('scrollMode'),
  setMode: m => ipcRenderer.send('setMode', !!m),
  copyAll: text => ipcRenderer.send('copyAll', text),
});