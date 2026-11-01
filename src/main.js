const { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, powerMonitor, session } = require('electron');
const zlib = require('zlib');
const path = require('path');

let mainWindow;
let pendingDeviceCallback = null;
let pendingDevices = [];
let tray;
let trayLevelKey = 'null';
let isQuitting = false;
let hideAfterFirstConnection = process.argv.includes('--hidden');
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();

const TRAY_COLORS = {
  background: [37, 99, 235],
  body: [255, 255, 255],
  high: [34, 197, 94],
  medium: [245, 158, 11],
  low: [239, 68, 68],
  bolt: [15, 23, 42]
};
// Raio de carregamento na mesma grade de 16 unidades do desenho.
const TRAY_BOLT = [[7.6, 3], [10, 3], [8.8, 7.2], [10, 7.2], [7, 13], [7.6, 9], [6, 9]];

function insidePolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function normalizeTrayLevel(level) {
  const battery = level?.battery;
  if (!Number.isInteger(battery) || battery < 0 || battery > 100) return null;
  return { battery, charging: level.charging === true };
}

// Desenha em uma grade de 16 unidades para que cada resolução tenha o mesmo formato.
// Sem nível conhecido, o interior da bateria fica vazio.
function drawTrayIcon(size, level) {
  const pixels = Buffer.alloc(size * size * 4);
  const battery = level?.battery ?? null;
  const fillColor = battery > 50 ? TRAY_COLORS.high : battery > 20 ? TRAY_COLORS.medium : TRAY_COLORS.low;
  // O interior ocupa y 3..13; cargas acima de zero mostram ao menos uma unidade.
  const fillTop = battery === null ? Infinity : 13 - Math.max(battery / 10, battery > 0 ? 1 : 0);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = ((x + 0.5) * 16) / size;
      const v = ((y + 0.5) * 16) / size;
      let color = null;
      if ((u - 8) ** 2 + (v - 8) ** 2 <= 56) color = TRAY_COLORS.background;
      if ((u >= 5 && u < 11 && v >= 2 && v < 14) || (u >= 7 && u < 9 && v >= 1 && v < 2)) color = TRAY_COLORS.body;
      if (u >= 6 && u < 10 && v >= 3 && v < 13) {
        color = v >= fillTop ? fillColor : TRAY_COLORS.background;
        if (level?.charging && insidePolygon(u, v, TRAY_BOLT)) color = TRAY_COLORS.bolt;
      }
      if (!color) continue;
      const offset = (y * size + x) * 4;
      pixels.set([...color, 255], offset);
    }
  }
  return pixels;
}

function encodePng(size, pixels) {
  // PNG RGBA gerado em memoria, com cantos transparentes.
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
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function createTrayIcon(level = null) {
  // Uma representação por escala evita ícone borrado em telas com DPI alto.
  const image = nativeImage.createEmpty();
  for (const scaleFactor of [1, 1.25, 1.5, 2]) {
    const size = Math.round(16 * scaleFactor);
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: encodePng(size, drawTrayIcon(size, level)) });
  }
  return image;
}

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
  tray = new Tray(createTrayIcon());
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

  ipcMain.on('tray-battery', (_event, text, level) => {
    tray?.setToolTip(`Mouse Battery Monitor: ${String(text).slice(0, 40)}`);
    const normalized = normalizeTrayLevel(level);
    const key = JSON.stringify(normalized);
    if (!tray || key === trayLevelKey) return;
    trayLevelKey = key;
    tray.setImage(createTrayIcon(normalized));
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

  ipcMain.on('full-battery-notification', () => {
    if (!Notification.isSupported()) return;
    new Notification({
      title: 'Mouse carregado',
      body: 'Seu AJAZZ AJ139 V2 MC chegou a 100%. Você já pode desconectar o cabo USB.'
    }).show();
  });

  // Durante a suspensão o mouse pode descarregar ou trocar de interface.
  powerMonitor.on('resume', () => {
    mainWindow?.webContents.send('power-resume');
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
