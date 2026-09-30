const { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, session } = require('electron');
const zlib = require('zlib');
const path = require('path');

let mainWindow;
let pendingDeviceCallback = null;
let pendingDevices = [];
let tray;
let isQuitting = false;
let hideAfterFirstConnection = process.argv.includes('--hidden');
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();

function createTrayIcon() {
  // PNG RGBA gerado em memoria, com cantos transparentes.
  const size = 16;
  const pixels = Buffer.alloc(size * size * 4);
  const putPixel = (x, y, r, g, b, a = 255) => {
    const offset = (y * size + x) * 4;
    pixels[offset] = r; pixels[offset + 1] = g; pixels[offset + 2] = b; pixels[offset + 3] = a;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if ((x - 7.5) ** 2 + (y - 7.5) ** 2 <= 56) putPixel(x, y, 37, 99, 235);
    }
  }
  for (let y = 2; y < 14; y += 1) {
    for (let x = 5; x < 11; x += 1) putPixel(x, y, 255, 255, 255);
  }
  for (let x = 7; x < 9; x += 1) putPixel(x, 1, 255, 255, 255);
  for (let y = 4; y < 12; y += 1) {
    for (let x = 6; x < 10; x += 1) putPixel(x, y, 37, 99, 235);
  }

  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const typeBuffer = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuffer, data]);
    const output = Buffer.alloc(12 + data.length);
    output.writeUInt32BE(data.length, 0);
    body.copy(output, 4);
    output.writeUInt32BE(crc32(body), data.length + 8);
    return output;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) { rows[y * (size * 4 + 1)] = 0; pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return nativeImage.createFromBuffer(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
}

function getTrayIcon() {
  // O icone do executavel e ICO nativo e permanece visivel em temas claro e escuro.
  return createTrayIcon();
}

const trayIcon = getTrayIcon();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 780,
    minHeight: 560,
    title: 'Mouse Battery Monitor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function showWindow() {
  // Uma abertura explícita cancela a ocultação automática pendente.
  hideAfterFirstConnection = false;
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
}

function getStartWithWindows() {
  const settings = app.getLoginItemSettings(getLoginOptions());
  return settings.openAtLogin && settings.executableWillLaunchAtLogin;
}

function setStartWithWindows(enabled) {
  app.setLoginItemSettings({
    ...getLoginOptions(),
    openAtLogin: enabled
  });
  return getStartWithWindows();
}

function getLoginOptions() {
  return {
    path: process.execPath,
    args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden']
  };
}

async function createTray() {
  tray = new Tray(trayIcon);
  tray.setIgnoreDoubleClickEvents(true);
  tray.setToolTip('Mouse Battery Monitor: aguardando bateria');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir monitor', click: showWindow },
    { label: 'Conectar mouse', click: () => { showWindow(); mainWindow?.webContents.send('tray-connect'); } },
    { type: 'separator' },
    { label: 'Sair', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', showWindow);

}

if (hasInstanceLock) app.on('second-instance', () => {
  if (app.isReady()) showWindow();
  else hideAfterFirstConnection = false;
});

if (hasInstanceLock) app.whenReady().then(async () => {
  session.defaultSession.setDevicePermissionHandler(({ deviceType }) => {
    return deviceType === 'hid';
  });

  session.defaultSession.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    if (pendingDeviceCallback) pendingDeviceCallback('');
    pendingDeviceCallback = callback;
    pendingDevices = details.deviceList.map((device, index) => ({
      index,
      deviceId: device.deviceId,
      name: device.productName || 'Dispositivo HID sem nome',
      vendorId: device.vendorId,
      productId: device.productId,
      serialNumber: device.serialNumber
    }));

    mainWindow?.webContents.send('hid-device-list', pendingDevices);
  });

  ipcMain.handle('choose-hid-device', (_event, deviceId) => {
    if (!pendingDeviceCallback || !pendingDevices.some((device) => device.deviceId === deviceId)) return false;
    pendingDeviceCallback(deviceId);
    pendingDeviceCallback = null;
    pendingDevices = [];
    return true;
  });

  ipcMain.handle('cancel-hid-selection', () => {
    if (!pendingDeviceCallback) return false;
    pendingDeviceCallback('');
    pendingDeviceCallback = null;
    pendingDevices = [];
    return true;
  });

  ipcMain.on('tray-battery', (_event, text) => {
    tray?.setToolTip(`Mouse Battery Monitor: ${String(text).slice(0, 40)}`);
  });

  // No início automático a janela fica visível enquanto o renderer reconecta
  // o HID já autorizado. Só a ocultamos depois de uma conexão bem-sucedida;
  // assim o monitor não vai para a bandeja antes de poder ler o mouse.
  ipcMain.on('mouse-connected', (event) => {
    if (event.sender !== mainWindow?.webContents || !hideAfterFirstConnection) return;
    hideAfterFirstConnection = false;
    mainWindow.hide();
  });

  ipcMain.on('low-battery-notification', (_event, battery) => {
    if (!Notification.isSupported()) return;
    new Notification({
      title: 'Bateria do mouse baixa',
      body: `Seu AJAZZ AJ139 V2 MC está com ${Number(battery)}% de bateria. Conecte o cabo USB para recarregar.`
    }).show();
  });

  ipcMain.handle('get-start-with-windows', () => getStartWithWindows());
  ipcMain.handle('set-start-with-windows', (_event, enabled) => setStartWithWindows(Boolean(enabled)));
  ipcMain.handle('get-app-version', () => app.getVersion());

  createWindow();
  await createTray();

  app.on('activate', () => {
    showWindow();
  });
});

app.on('window-all-closed', () => {
  // O monitor continua ativo na bandeja do Windows.
});

app.on('before-quit', () => {
  isQuitting = true;
});
