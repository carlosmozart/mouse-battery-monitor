const connectButton = document.querySelector('#connectButton');
const statusText = document.querySelector('#statusText');
const batteryText = document.querySelector('#batteryText');
const deviceText = document.querySelector('#deviceText');
const devicePicker = document.querySelector('#devicePicker');
const logNode = document.querySelector('#log');
const probeButton = document.querySelector('#probeButton');
const copyLogButton = document.querySelector('#copyLogButton');
const clearLogButton = document.querySelector('#clearLogButton');

let activeDevice = null;
let lastDeviceList = [];
let lastBattery = null;
let lastBatteryAlertLevel = null;
let batteryRefreshTimer = null;

const AJAZZ_VENDOR_IDS = [0xa8a4, 0xa8a5];
const AJAZZ_PRODUCT_ID = 0x2255;

const hex = (value, width = 4) => `0x${value.toString(16).padStart(width, '0')}`;

function isTargetMouse(device) {
  return AJAZZ_VENDOR_IDS.includes(device.vendorId) && device.productId === AJAZZ_PRODUCT_ID;
}

function scoreDevice(device) {
  if (!isTargetMouse(device)) return -1;

  let score = 10;
  for (const collection of device.collections) {
    if (collection.usagePage === 0xff01 && collection.usage === 0x0010) score += 40;
    if (collection.usagePage === 0xff06 && collection.usage === 0x0002) score += 20;
    if (collection.usagePage >= 0xff00) score += 10;
    if ((collection.outputReports?.length ?? 0) > 0) score += 8;
    if ((collection.inputReports?.length ?? 0) > 0) score += 4;
  }

  return score;
}

function pickBestMouse(devices) {
  return [...devices].sort((a, b) => scoreDevice(b) - scoreDevice(a))[0] ?? null;
}

function log(message, data) {
  const time = new Date().toLocaleTimeString('pt-BR');
  const suffix = data === undefined ? '' : `\n${JSON.stringify(data, null, 2)}`;
  logNode.textContent = `[${time}] ${message}${suffix}\n\n${logNode.textContent}`;
}

async function copyDiagnostics() {
  const diagnostics = {
    appVersion: '0.1.0',
    userAgent: navigator.userAgent,
    hidSupported: 'hid' in navigator,
    device: activeDevice ? describeDevice(activeDevice) : null,
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
      meta.textContent = `VID ${hex(device.vendorId)} · PID ${hex(device.productId)} · prioridade ${scoreDevice(device)}${device.serialNumber ? ` · Serial ${device.serialNumber}` : ''}`;

      info.append(name, meta);

      const button = document.createElement('button');
      button.className = 'select-button';
      button.textContent = 'Selecionar';
      button.addEventListener('click', async () => {
        await window.mouseBridge.chooseDevice(device.deviceId);
        devicePicker.className = 'device-list empty';
        devicePicker.textContent = 'Dispositivo selecionado. Finalizando conexão...';
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
  batteryText.textContent = `${battery}%`;
  window.mouseBridge.setTrayBattery(`${battery}%`);

  // Alertas por limiar, com histerese para não repetir a mesma notificação.
  const alertLevel = battery <= 10 ? 10 : battery <= 20 ? 20 : null;
  if (alertLevel !== null && alertLevel !== lastBatteryAlertLevel) {
    window.mouseBridge.notifyLowBattery(battery);
    lastBatteryAlertLevel = alertLevel;
  } else if (battery > 20) {
    lastBatteryAlertLevel = null;
  }
  lastBattery = battery;
}

async function openDevice(device) {
  if (activeDevice === device && activeDevice.opened) return;
  activeDevice = device;
  if (!activeDevice.opened) {
    await activeDevice.open();
  }

  deviceText.textContent = activeDevice.productName || `${hex(activeDevice.vendorId)}:${hex(activeDevice.productId)}`;
  statusText.textContent = 'Conectado';
  batteryText.textContent = 'Aguardando pacote';

  log('Dispositivo conectado', describeDevice(activeDevice));

  activeDevice.addEventListener('inputreport', (event) => {
    const bytes = [...new Uint8Array(event.data.buffer)];
    log(`Relatório recebido: id ${event.reportId}`, bytes.map((byte) => hex(byte, 2)));

    const guessedBattery = guessBatteryPercent(bytes);
    if (guessedBattery !== null) {
      applyBatteryLevel(guessedBattery);
      log(`Bateria detectada: ${guessedBattery}%`, {
        protocolo: 'AJAZZ AJ139 V2 MC',
        origem: 'relatorio HID 0',
        byte: bytes[1] === 0x30 ? 8 : 9
      });
    }
  });

  await probeFeatureReports(activeDevice);
  await requestBattery();
  if (batteryRefreshTimer) clearInterval(batteryRefreshTimer);
  batteryRefreshTimer = setInterval(() => requestBattery(), 10 * 60 * 1000);
}

async function requestBattery() {
  if (!activeDevice?.opened) {
    log('Conecte o AJAZZ antes de consultar a bateria.');
    return;
  }

  const hasReportZeroOutput = activeDevice.collections.some((collection) =>
    collection.usagePage >= 0xff00 && collection.outputReports?.some((report) => report.reportId === 0)
  );

  if (!hasReportZeroOutput) {
    log('A interface selecionada não anuncia output report 0. Reconecte e selecione a interface vendor-specific.');
    return;
  }

  // Comando usado pelo configurador oficial do AJ139 V2 MC.
  const payload = new Uint8Array(64);
  payload.set([0x55, 0x30, 0xa5, 0x0b, 0x2e, 0x01, 0x01]);
  try {
    await activeDevice.sendReport(0, payload);
    log('Consulta de bateria enviada.');
  } catch (error) {
    log('Falha ao consultar bateria', error.message);
  }
}

async function connect() {
  try {
    if (!('hid' in navigator)) {
      statusText.textContent = 'WebHID indisponível';
      log('Este runtime não expôs navigator.hid.');
      return;
    }

    const authorizedDevices = await navigator.hid.getDevices();
    const authorizedMouse = pickBestMouse(authorizedDevices.filter(isTargetMouse));
    if (authorizedMouse) {
      statusText.textContent = 'Abrindo mouse autorizado';
      log('Usando AJAZZ AJ139 V2 MC já autorizado.', describeDevice(authorizedMouse));
      await openDevice(authorizedMouse);
      return;
    }

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

    await openDevice(pickBestMouse(devices) ?? devices[0]);
  } catch (error) {
    statusText.textContent = 'Erro na conexão';
    log(error.message || 'Erro desconhecido', { name: error.name, stack: error.stack });
  }
}

async function listAuthorizedDevices() {
  if (!('hid' in navigator)) {
    statusText.textContent = 'WebHID indisponível';
    log('WebHID não está disponível neste runtime.');
    return;
  }

  const devices = await navigator.hid.getDevices();
  if (!devices.length) {
    log('Nenhum dispositivo HID autorizado anteriormente. Clique em Conectar mouse.');
    return;
  }

  log('Dispositivos HID já autorizados', devices.map(describeDevice));

  const authorizedMouse = pickBestMouse(devices.filter(isTargetMouse));
  if (authorizedMouse) {
    log('Mouse AJAZZ autorizado encontrado. Conectando automaticamente.');
    await openDevice(authorizedMouse);
  }
}

async function probeFeatureReports(device) {
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
    try {
      const data = await device.receiveFeatureReport(reportId);
      const bytes = [...new Uint8Array(data.buffer)];
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
    await openDevice(event.device);
  } catch (error) {
    log('Não foi possível conectar automaticamente', error.message);
  }
});
connectButton.addEventListener('click', connect);
probeButton.addEventListener('click', requestBattery);
copyLogButton.addEventListener('click', copyDiagnostics);
clearLogButton.addEventListener('click', () => {
  logNode.textContent = '';
});

listAuthorizedDevices().catch((error) => {
  log('Erro ao listar dispositivos já autorizados', error.message);
});
