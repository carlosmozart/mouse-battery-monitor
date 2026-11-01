const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mouseBridge', {
  onDeviceList: (callback) => {
    ipcRenderer.on('hid-device-list', (_event, devices) => callback(devices));
  },
  chooseDevice: (deviceId) => ipcRenderer.invoke('choose-hid-device', deviceId),
  cancelDeviceSelection: () => ipcRenderer.invoke('cancel-hid-selection'),
  setTrayBattery: (text, level = null) => ipcRenderer.send('tray-battery', text, level),
  notifyMouseConnected: () => ipcRenderer.send('mouse-connected'),
  notifyLowBattery: (battery) => ipcRenderer.send('low-battery-notification', battery),
  notifyFullBattery: () => ipcRenderer.send('full-battery-notification'),
  onTrayConnect: (callback) => ipcRenderer.on('tray-connect', callback),
  onPowerResume: (callback) => ipcRenderer.on('power-resume', () => callback()),
  getStartWithWindows: () => ipcRenderer.invoke('get-start-with-windows'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  setStartWithWindows: (enabled) => ipcRenderer.invoke('set-start-with-windows', enabled)
});
