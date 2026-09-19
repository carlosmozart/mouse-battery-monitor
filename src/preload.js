const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mouseBridge', {
  onDeviceList: (callback) => {
    ipcRenderer.on('hid-device-list', (_event, devices) => callback(devices));
  },
  chooseDevice: (deviceId) => ipcRenderer.invoke('choose-hid-device', deviceId),
  cancelDeviceSelection: () => ipcRenderer.invoke('cancel-hid-selection'),
  setTrayBattery: (text) => ipcRenderer.send('tray-battery', text),
  notifyMouseConnected: () => ipcRenderer.send('mouse-connected'),
  notifyLowBattery: (battery) => ipcRenderer.send('low-battery-notification', battery),
  onTrayConnect: (callback) => ipcRenderer.on('tray-connect', callback),
  getStartWithWindows: () => ipcRenderer.invoke('get-start-with-windows'),
  setStartWithWindows: (enabled) => ipcRenderer.invoke('set-start-with-windows', enabled)
});
