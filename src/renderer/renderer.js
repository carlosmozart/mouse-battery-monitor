const connectButton = document.querySelector('#connectButton');
const statusText = document.querySelector('#statusText');
const batteryText = document.querySelector('#batteryText');
const deviceText = document.querySelector('#deviceText');
const devicePicker = document.querySelector('#devicePicker');
const logNode = document.querySelector('#log');
const probeButton = document.querySelector('#probeButton');
const copyLogButton = document.querySelector('#copyLogButton');
const clearLogButton = document.querySelector('#clearLogButton');
const startWithWindows = document.querySelector('#startWithWindows');
const startupStatus = document.querySelector('#startupStatus');

let activeDevice = null;
let lastDeviceList = [];
let lastBattery = null;
let lastBatteryAlertLevel = null;
let batteryRefreshTimer = null;
let openingDevice = null;
let connectionGeneration = 0;
let connectionQueue = Promise.resolve();
let manualConnectionPending = false;
let startupPreferenceBusy = false;
const logEntries = [];
const MAX_LOG_ENTRIES = 200;
const MAX_LOG_ENTRY_LENGTH = 2000;

const AJAZZ_VENDOR_IDS = [0xa8a4, 0xa8a5];
const AJAZZ_PRODUCT_ID = 0x2255;

const hex = (value, width = 4) => `0x${value.toString(16).padStart(width, '0')}`;

function isTargetMouse(device) {
  return AJAZZ_VENDOR_IDS.includes(device.vendorId) && device.productId === AJAZZ_PRODUCT_ID;
}

function scoreDevice(device) {
  if (!isTargetMouse(device)) return -1;

  let score = 10;
  for (const collection of device.collections ?? []) {
    if (collection.usagePage === 0xff01 && collection.usage === 0x0010) score += 40;
    if (collection.usagePage === 0xff06 && collection.usage === 0x0002) score += 20;
    if (collection.usagePage >= 0xff00) score += 10;
    if ((collection.outputReports?.length ?? 0) > 0) score += 8;
    if ((collection.inputReports?.length ?? 0) > 0) score += 4;
  }

  return score;
}

function pickBestMouse(devices) {
  return devices.filter(isTargetMouse).sort((a, b) =>
    Number(canRequestBattery(b)) - Number(canRequestBattery(a)) || scoreDevice(b) - scoreDevice(a)
  )[0] ?? null;
}

function canRequestBattery(device) {
  return (device.collections ?? []).some((collection) =>
    collection.usagePage >= 0xff00 && collection.outputReports?.some((report) => report.reportId === 0)
  );
}

function log(message, data) {
  const time = new Date().toLocaleTimeString('pt-BR');
  const suffix = data === undefined ? '' : `\n${JSON.stringify(data, null, 2)}`;
  logEntries.unshift(`[${time}] ${message}${suffix}`.slice(0, MAX_LOG_ENTRY_LENGTH));
  logEntries.length = Math.min(logEntries.length, MAX_LOG_ENTRIES);
  logNode.textContent = logEntries.join('\n\n');
}

async function copyDiagnostics() {
  const diagnostics = {
    appVersion: await window.mouseBridge.getAppVersion(),
    userAgent: navigator.userAgent,
    hidSupported: 'hid' in navigator,
    device: activeDevice ? describeDevice(activeDevice) : null,
    lastBattery,
    pendingDevices: lastDeviceList,
    log: logNode.textContent
  };

  await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
  log('Diagnóstico copiado para a área de transferência.');
}

function renderDevicePicker(devices) {
  lastDeviceList = devices;
  if (!devices.length) {
    devicePicker.className = 'device-list empty';
    devicePicker.textContent = 'Nenhum dispositivo HID foi retornado.';
    return;
  }

  devicePicker.className = 'device-list';
  devicePicker.replaceChildren(
    ...devices.map((device) => {
      const row = document.createElement('div');
      row.className = 'device';

      const info = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'device-name';
      name.textContent = `${isTargetMouse(device) ? 'AJAZZ AJ139 V2 MC - ' : ''}${device.name}`;

      const meta = document.createElement('div');
      meta.className = 'device-meta';
      meta.textContent = `VID ${hex(device.vendorId)} · PID ${hex(device.productId)}${device.serialNumber ? ` · Serial ${device.serialNumber}` : ''}`;

      info.append(name, meta);

      const button = document.createElement('button');
      button.className = 'select-button';
      button.textContent = 'Selecionar';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const selected = await window.mouseBridge.chooseDevice(device.deviceId);
          if (!selected) throw new Error('A seleção expirou. Clique em Conectar mouse novamente.');
          lastDeviceList = [];
          devicePicker.className = 'device-list empty';
          devicePicker.textContent = 'Dispositivo selecionado.';
        } catch (error) {
          button.disabled = false;
          log('Não foi possível selecionar o mouse.', error.message);
        }
      });

      row.append(info, button);
      return row;
    })
  );
}

function describeDevice(device) {
  return {
    productName: device.productName,
    vendorId: hex(device.vendorId),
    productId: hex(device.productId),
    collections: device.collections.map((collection) => ({
      usagePage: hex(collection.usagePage),
      usage: hex(collection.usage),
      inputReports: collection.inputReports?.map((report) => report.reportId) ?? [],
      outputReports: collection.outputReports?.map((report) => report.reportId) ?? [],
      featureReports: collection.featureReports?.map((report) => report.reportId) ?? []
    }))
  };
}

function applyBatteryLevel(battery) {
  if (!Number.isInteger(battery) || battery < 0 || battery > 100) return;
  batteryText.textContent = `${battery}%`;
  window.mouseBridge.setTrayBattery(`${battery}%`);

  // Rearma os alertas somente após recuperar carga acima de 25%.
  if (battery > 25) lastBatteryAlertLevel = null;
  const alertLevel = battery <= 10 ? 10 : battery <= 20 ? 20 : null;
  if (alertLevel !== null && (lastBatteryAlertLevel === null || alertLevel < lastBatteryAlertLevel)) {
    window.mouseBridge.notifyLowBattery(battery);
    lastBatteryAlertLevel = alertLevel;
  }
  lastBattery = battery;
}

function enqueueConnection(operation) {
  const result = connectionQueue.then(operation);
  // Uma falha não deve impedir futuras tentativas.
  connectionQueue = result.catch(() => {});
  return result;
}

function clearConnection() {
  const previous = activeDevice;
  previous?.removeEventListener('inputreport', handleInputReport);
  activeDevice = null;
  lastBattery = null;
  if (batteryRefreshTimer) clearInterval(batteryRefreshTimer);
  batteryRefreshTimer = null;
  statusText.textContent = 'Aguardando conexão';
  connectButton.textContent = 'Conectar mouse';
  batteryText.textContent = '--';
  deviceText.textContent = '--';
  window.mouseBridge.setTrayBattery('mouse desconectado');
  return previous;
}

async function closeDevice(device) {
  try {
    if (device?.opened) await device.close();
  } catch (error) {
    log('Não foi possível fechar a interface anterior.', error.message);
  }
}

function handleInputReport(event) {
  if (event.device !== activeDevice) return;
  const bytes = [...new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)];
  log(`Relatório recebido: id ${event.reportId}`, bytes.map((byte) => hex(byte, 2)));
  const battery = guessBatteryPercent(bytes);
  if (battery !== null) {
    applyBatteryLevel(battery);
    log(`Bateria detectada: ${battery}%`);
  }
}

// Chamado apenas pela fila: uma interface é aberta por vez.
async function openDevice(device) {
  if (!device) return;
  if (activeDevice === device && device.opened) {
    statusText.textContent = 'Conectado';
    return;
  }
  const generation = connectionGeneration;
  openingDevice = device;
  try {
    await closeDevice(clearConnection());
    if (generation !== connectionGeneration) return;
    statusText.textContent = 'Conectando';
    if (!device.opened) await device.open();
    if (generation !== connectionGeneration || !device.opened) {
      await closeDevice(device);
      return;
    }
    activeDevice = device;
    device.addEventListener('inputreport', handleInputReport);
    deviceText.textContent = device.productName || `${hex(device.vendorId)}:${hex(device.productId)}`;
    statusText.textContent = 'Conectado';
    connectButton.textContent = 'Mouse conectado';
    batteryText.textContent = 'Aguardando pacote';
    window.mouseBridge.setTrayBattery('aguardando bateria');
    log('Dispositivo conectado', describeDevice(device));
    batteryRefreshTimer = setInterval(() => requestBattery(), 10 * 60 * 1000);
    window.mouseBridge.notifyMouseConnected();
    await requestBattery();
    // A consulta do protocolo é prioritária; a sondagem é apenas diagnóstica.
    void probeFeatureReports(device).catch((error) => log('Falha na sondagem do dispositivo.', error.message));
  } catch (error) {
    if (generation === connectionGeneration) {
      await closeDevice(clearConnection());
      statusText.textContent = 'Erro na conexão';
    }
    throw error;
  } finally {
    openingDevice = null;
  }
}

async function requestBattery() {
  const device = activeDevice;
  if (!device?.opened) {
    log('Conecte o AJAZZ antes de consultar a bateria.');
    return;
  }

  if (!canRequestBattery(device)) {
    log('A interface selecionada não anuncia output report 0. Reconecte e selecione a interface vendor-specific.');
    return;
  }

  // Comando usado pelo configurador oficial do AJ139 V2 MC.
  const payload = new Uint8Array(64);
  payload.set([0x55, 0x30, 0xa5, 0x0b, 0x2e, 0x01, 0x01]);
  try {
    await device.sendReport(0, payload);
    log('Consulta de bateria enviada.');
  } catch (error) {
    log('Falha ao consultar bateria', error.message);
  }
}

async function connect() {
  if (manualConnectionPending) return;
  manualConnectionPending = true;
  connectButton.disabled = true;
  try {
    if (!('hid' in navigator)) {
      statusText.textContent = 'WebHID indisponível';
      log('Este runtime não expôs navigator.hid.');
      return;
    }

    if (await listAuthorizedDevices()) return;

    statusText.textContent = 'Selecionando dispositivo';
    log('Solicitando seleção HID filtrada para AJAZZ AJ139 V2 MC...');
    const devices = await navigator.hid.requestDevice({
      filters: AJAZZ_VENDOR_IDS.map((vendorId) => ({ vendorId, productId: AJAZZ_PRODUCT_ID }))
    });

    if (!devices.length) {
      statusText.textContent = 'Seleção cancelada';
      log('Nenhum dispositivo foi selecionado.');
      return;
    }

    await enqueueConnection(() => openDevice(pickBestMouse(devices)));
  } catch (error) {
    if (!activeDevice) statusText.textContent = 'Erro na conexão';
    log(error.message || 'Erro desconhecido', { name: error.name, stack: error.stack });
  } finally {
    manualConnectionPending = false;
    connectButton.disabled = false;
  }
}

async function listAuthorizedDevices() {
  if (!('hid' in navigator)) {
    statusText.textContent = 'WebHID indisponível';
    log('WebHID não está disponível neste runtime.');
    return;
  }

  return enqueueConnection(async () => {
    const devices = await navigator.hid.getDevices();
    const mouse = pickBestMouse(devices);
    if (!mouse) return false;
    await openDevice(mouse);
    return activeDevice === mouse && mouse.opened;
  });
}

async function probeFeatureReports(device) {
  const generation = connectionGeneration;
  const reportIds = new Set();
  for (const collection of device.collections) {
    for (const report of collection.featureReports ?? []) {
      reportIds.add(report.reportId);
    }
  }

  if (!reportIds.size) {
    log('Nenhum feature report anunciado pelo dispositivo.');
    return;
  }

  for (const reportId of reportIds) {
    if (generation !== connectionGeneration || activeDevice !== device || !device.opened) return;
    try {
      const data = await device.receiveFeatureReport(reportId);
      if (generation !== connectionGeneration || activeDevice !== device || !device.opened) return;
      const bytes = [...new Uint8Array(data.buffer, data.byteOffset, data.byteLength)];
      log(`Feature report ${reportId}`, bytes.map((byte) => hex(byte, 2)));

      const guessedBattery = guessBatteryPercent(bytes);
      if (guessedBattery !== null) {
        applyBatteryLevel(guessedBattery);
      }
    } catch (error) {
      log(`Não foi possível ler feature report ${reportId}`, error.message);
    }
  }
}

function guessBatteryPercent(bytes) {
  // Resposta a consulta oficial: AA 30 A5 ... [bateria, carregando].
  if (bytes.length >= 10 && bytes[0] === 0xaa && bytes[1] === 0x30 && bytes[2] === 0xa5) {
    return bytes[8] <= 100 ? bytes[8] : null;
  }

  // Notificacao espontanea observada em algumas conexoes: AA FA ... D0 [bateria].
  if (bytes.length >= 10 && bytes[0] === 0xaa && bytes[1] === 0xfa && bytes[8] === 0xd0) {
    return bytes[9] <= 100 ? bytes[9] : null;
  }

  return null;
}

window.mouseBridge.onDeviceList(renderDevicePicker);
window.mouseBridge.onTrayConnect(() => connect());

navigator.hid?.addEventListener('connect', async (event) => {
  if (!isTargetMouse(event.device)) return;
  log('Mouse AJAZZ conectado. Conectando automaticamente.');
  try {
    await listAuthorizedDevices();
  } catch (error) {
    log('Não foi possível conectar automaticamente', error.message);
  }
});
navigator.hid?.addEventListener('disconnect', (event) => {
  if (event.device !== activeDevice && event.device !== openingDevice) return;
  connectionGeneration += 1;
  void closeDevice(clearConnection());
  log('Mouse desconectado. Aguardando reconexão.');
  // Pode haver outra interface disponível (por exemplo, após trocar o cabo).
  listAuthorizedDevices().catch((error) => log('Falha ao reconectar.', error.message));
});
connectButton.addEventListener('click', connect);
probeButton.addEventListener('click', requestBattery);
copyLogButton.addEventListener('click', () => {
  copyDiagnostics().catch((error) => log('Falha ao copiar diagnóstico.', error.message));
});
clearLogButton.addEventListener('click', () => {
  logEntries.length = 0;
  logNode.textContent = '';
});

function showStartupPreference(enabled) {
  startWithWindows.checked = enabled;
  startupStatus.textContent = enabled ? 'Ativo no Windows.' : 'Desativado no Windows.';
}

async function refreshStartupPreference() {
  if (startupPreferenceBusy) return;
  startupPreferenceBusy = true;
  startWithWindows.disabled = true;
  try {
    showStartupPreference(await window.mouseBridge.getStartWithWindows());
  } catch (error) {
    startupStatus.textContent = 'Não foi possível verificar a inicialização.';
    log(startupStatus.textContent, error.message);
  } finally {
    startupPreferenceBusy = false;
    startWithWindows.disabled = false;
  }
}

startWithWindows.addEventListener('change', async () => {
  if (startupPreferenceBusy) return;
  const requested = startWithWindows.checked;
  startupPreferenceBusy = true;
  startWithWindows.disabled = true;
  try {
    const enabled = await window.mouseBridge.setStartWithWindows(requested);
    showStartupPreference(enabled);
    if (enabled !== requested) {
      startupStatus.textContent = 'A alteração não foi confirmada. Verifique Aplicativos de Inicialização nas Configurações do Windows.';
      log(startupStatus.textContent);
      return;
    }
    log(enabled
      ? 'Inicialização com o Windows ativada. O app aguardará o mouse e então irá para a bandeja.'
      : 'Inicialização com o Windows desativada.');
  } catch (error) {
    try {
      showStartupPreference(await window.mouseBridge.getStartWithWindows());
    } catch {
      startWithWindows.checked = !requested;
    }
    startupStatus.textContent = 'Não foi possível confirmar a alteração.';
    log('Não foi possível alterar a inicialização com o Windows.', error.message);
  } finally {
    startupPreferenceBusy = false;
    startWithWindows.disabled = false;
  }
});

window.addEventListener('focus', refreshStartupPreference);
refreshStartupPreference();

listAuthorizedDevices().catch((error) => {
  log('Erro ao listar dispositivos já autorizados', error.message);
});
