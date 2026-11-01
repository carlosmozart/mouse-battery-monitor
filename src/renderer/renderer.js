const connectButton = document.querySelector('#connectButton');
const statusText = document.querySelector('#statusText');
const batteryText = document.querySelector('#batteryText');
const batteryDetail = document.querySelector('#batteryDetail');
const batteryFill = document.querySelector('#batteryFill');
const chargingBadge = document.querySelector('#chargingBadge');
const deviceText = document.querySelector('#deviceText');
const connectionText = document.querySelector('#connectionText');
const firmwareText = document.querySelector('#firmwareText');
const devicePickerCard = document.querySelector('#devicePickerCard');
const devicePicker = document.querySelector('#devicePicker');
const cancelPickerButton = document.querySelector('#cancelPickerButton');
const logNode = document.querySelector('#log');
const probeButton = document.querySelector('#probeButton');
const copyLogButton = document.querySelector('#copyLogButton');
const clearLogButton = document.querySelector('#clearLogButton');
const startWithWindows = document.querySelector('#startWithWindows');
const startupStatus = document.querySelector('#startupStatus');
const mouseSettings = document.querySelector('#mouseSettings');
const mouseSettingsStatus = document.querySelector('#mouseSettingsStatus');
const dpiLevels = document.querySelector('#dpiLevels');
const applyDpiButton = document.querySelector('#applyDpiButton');
const lightModeSelect = document.querySelector('#lightModeSelect');
const reportRateSelect = document.querySelector('#reportRateSelect');
const lodSelect = document.querySelector('#lodSelect');
const sleepSelect = document.querySelector('#sleepSelect');
const behaviorOptions = document.querySelector('#behaviorOptions');
const lowAlertSelect = document.querySelector('#lowAlertSelect');
const criticalAlertSelect = document.querySelector('#criticalAlertSelect');
const refreshSelect = document.querySelector('#refreshSelect');
const notifyFullCheckbox = document.querySelector('#notifyFullCheckbox');

let activeDevice = null;
let lastDeviceList = [];
let lastBattery = null;
// Sobrevive à desconexão para mostrar o último valor conhecido.
let lastBatteryReading = null;
let lastCharging = null;
let wasCharging = false;
let fullChargeNotified = false;
let lastBatteryAlertLevel = null;
let batteryRefreshTimer = null;
let batteryResponseTimer = null;
let resumeTimer = null;
let openingDevice = null;
let connectionGeneration = 0;
let connectionQueue = Promise.resolve();
let manualConnectionPending = false;
let startupPreferenceBusy = false;
let mouseConfig = null;
let firmwareVersion = null;
let commandQueue = Promise.resolve();
let pendingCommand = null;
let settingsQueue = Promise.resolve();
let dpiRadios = [];
let dpiInputs = [];
let behaviorInputs = [];
const logEntries = [];
const MAX_LOG_ENTRIES = 200;
const MAX_LOG_ENTRY_LENGTH = 2000;
const BATTERY_RESPONSE_TIMEOUT = 5000;
const BATTERY_QUERY_ATTEMPTS = 2;
const RESUME_REFRESH_DELAY = 3000;
const COMMAND_TIMEOUT = 1500;
const PREFERENCES_KEY = 'preferences';
const LOW_ALERT_OPTIONS = [15, 20, 25, 30];
const CRITICAL_ALERT_OPTIONS = [5, 10, 15];
const REFRESH_OPTIONS = [5, 10, 15, 30, 60];
const DEFAULT_PREFERENCES = { lowAlert: 20, criticalAlert: 10, refreshMinutes: 10, notifyFull: true };
// Opções de liga/desliga do mouse; cada uma lê e altera só o seu campo da configuração.
const BEHAVIOR_TOGGLES = [
  ...SENSOR_OPTIONS.map((option) => ({
    label: option.label,
    hint: option.hint,
    read: (config) => (config.sensorFlag & option.bit) !== 0,
    changes: (config, checked) => ({ sensorFlag: checked ? config.sensorFlag | option.bit : config.sensorFlag & ~option.bit })
  })),
  {
    label: 'Inverter a rolagem',
    hint: 'Troca a direção da roda do mouse.',
    read: (config) => config.scrollFlag === 1,
    changes: (_config, checked) => ({ scrollFlag: checked ? 1 : 0 })
  },
  {
    label: 'Acordar ao mover',
    hint: 'Tira o mouse do repouso quando ele é movido.',
    read: (config) => config.wakeupFlag === 0,
    changes: (_config, checked) => ({ wakeupFlag: checked ? 0 : 1 })
  }
];

const AJAZZ_VENDOR_IDS = [0xa8a4, 0xa8a5];
const AJAZZ_PRODUCT_ID = 0x2255;
// O configurador oficial identifica o cabo pelo vendor ID; o outro é o receptor 2.4G.
const AJAZZ_USB_VENDOR_ID = 0xa8a4;

const hex = (value, width = 4) => `0x${value.toString(16).padStart(width, '0')}`;
const formatTime = (date) => date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

let preferences = loadPreferences();

function loadPreferences() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}') ?? {};
  } catch {
    stored = {};
  }
  const pick = (value, options, fallback) => (options.includes(value) ? value : fallback);
  const lowAlert = pick(stored.lowAlert, LOW_ALERT_OPTIONS, DEFAULT_PREFERENCES.lowAlert);
  const criticalAlert = pick(stored.criticalAlert, CRITICAL_ALERT_OPTIONS, DEFAULT_PREFERENCES.criticalAlert);
  return {
    lowAlert,
    // O aviso crítico precisa ficar abaixo do aviso de bateria baixa.
    criticalAlert: criticalAlert < lowAlert ? criticalAlert : DEFAULT_PREFERENCES.criticalAlert,
    refreshMinutes: pick(stored.refreshMinutes, REFRESH_OPTIONS, DEFAULT_PREFERENCES.refreshMinutes),
    notifyFull: typeof stored.notifyFull === 'boolean' ? stored.notifyFull : DEFAULT_PREFERENCES.notifyFull
  };
}

function savePreferences() {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch (error) {
    log('Não foi possível salvar as preferências.', error.message);
  }
}

function setStatus(text, tone = 'idle') {
  statusText.textContent = text;
  statusText.className = `status-pill ${tone}`;
}

function isTargetMouse(device) {
  return AJAZZ_VENDOR_IDS.includes(device.vendorId) && device.productId === AJAZZ_PRODUCT_ID;
}

function connectionMode(device) {
  return device.vendorId === AJAZZ_USB_VENDOR_ID ? 'USB' : '2.4G';
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
    firmwareVersion,
    mouseConfig,
    lastBattery,
    lastBatteryReading,
    preferences,
    pendingDevices: lastDeviceList,
    log: logNode.textContent
  };

  await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
  log('Diagnóstico copiado para a área de transferência.');
}

function hideDevicePicker() {
  lastDeviceList = [];
  devicePickerCard.hidden = true;
  devicePicker.replaceChildren();
}

function renderDevicePicker(devices) {
  lastDeviceList = devices;
  devicePickerCard.hidden = false;
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
          hideDevicePicker();
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

function renderBatteryGauge(battery, charging) {
  const tone = battery === null ? 'unknown' : battery > 50 ? 'high' : battery > preferences.lowAlert ? 'medium' : 'low';
  batteryFill.className = `battery-fill ${tone}${charging ? ' charging' : ''}`;
  batteryFill.style.width = `${battery ?? 0}%`;
  chargingBadge.hidden = !charging;
}

function applyBatteryLevel(battery, charging = null) {
  if (!Number.isInteger(battery) || battery < 0 || battery > 100) return;
  clearBatteryResponseTimer();
  // Pacotes sem indicador de carga mantêm o último estado conhecido.
  charging = typeof charging === 'boolean' ? charging : lastCharging;
  batteryText.textContent = `${battery}%`;
  renderBatteryGauge(battery, charging);
  window.mouseBridge.setTrayBattery(charging ? `${battery}% (carregando)` : `${battery}%`, { battery, charging: charging === true });

  // Rearma os alertas somente após recuperar 5 pontos acima do aviso de bateria baixa.
  if (battery > preferences.lowAlert + 5) lastBatteryAlertLevel = null;
  const alertLevel = battery <= preferences.criticalAlert
    ? preferences.criticalAlert
    : battery <= preferences.lowAlert ? preferences.lowAlert : null;
  // Com o cabo conectado o aviso para recarregar não faz sentido.
  if (!charging && alertLevel !== null && (lastBatteryAlertLevel === null || alertLevel < lastBatteryAlertLevel)) {
    window.mouseBridge.notifyLowBattery(battery);
    lastBatteryAlertLevel = alertLevel;
  }

  if (battery < 95) fullChargeNotified = false;
  // O indicador pode ser limpo ao completar a carga, por isso vale também o estado anterior.
  if (battery === 100 && (charging || wasCharging) && !fullChargeNotified) {
    if (preferences.notifyFull) window.mouseBridge.notifyFullBattery();
    fullChargeNotified = true;
  }
  if (charging !== null) wasCharging = charging;
  lastBattery = battery;
  lastCharging = charging;
  lastBatteryReading = { battery, time: new Date() };
  batteryDetail.textContent = `Atualizado às ${formatTime(lastBatteryReading.time)}`;
}

function describeLastReading() {
  if (!lastBatteryReading) return '';
  return `Última leitura: ${lastBatteryReading.battery}% às ${formatTime(lastBatteryReading.time)}`;
}

function clearBatteryResponseTimer() {
  if (batteryResponseTimer) clearTimeout(batteryResponseTimer);
  batteryResponseTimer = null;
}

function startBatteryRefresh() {
  if (batteryRefreshTimer) clearInterval(batteryRefreshTimer);
  batteryRefreshTimer = setInterval(() => requestBattery(), preferences.refreshMinutes * 60 * 1000);
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
  lastCharging = null;
  wasCharging = false;
  if (batteryRefreshTimer) clearInterval(batteryRefreshTimer);
  batteryRefreshTimer = null;
  clearBatteryResponseTimer();
  finishCommand(null);
  mouseConfig = null;
  firmwareVersion = null;
  setStatus('Aguardando conexão');
  connectButton.textContent = 'Conectar mouse';
  batteryText.textContent = '--';
  batteryDetail.textContent = describeLastReading();
  renderBatteryGauge(null, false);
  deviceText.textContent = 'Nenhum mouse conectado';
  connectionText.textContent = '--';
  firmwareText.textContent = '--';
  renderMouseSettings('Conecte o mouse para ver as configurações.');
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

  if (pendingCommand?.device === event.device && bytes[0] === 0xaa && bytes[1] === pendingCommand.code) {
    finishCommand(bytes);
  }

  const report = parseMouseReport(bytes);
  if (report?.type === 'battery') {
    applyBatteryLevel(report.battery, report.charging);
    log(`Bateria detectada: ${report.battery}%${report.charging ? ' (carregando)' : ''}`);
  } else if (report?.type === 'status') {
    applyMouseStatus(report);
  } else if (report?.type === 'online') {
    log(report.online ? 'O receptor informou que o mouse está ligado.' : 'O receptor informou que o mouse está desligado ou fora de alcance.');
    if (report.online) {
      setStatus('Conectado', 'ok');
      void requestBattery();
    } else {
      setStatus('Mouse desligado', 'warn');
    }
  }
}

// Chamado apenas pela fila: uma interface é aberta por vez.
async function openDevice(device) {
  if (!device) return;
  if (activeDevice === device && device.opened) {
    setStatus('Conectado', 'ok');
    return;
  }
  const generation = connectionGeneration;
  openingDevice = device;
  try {
    await closeDevice(clearConnection());
    if (generation !== connectionGeneration) return;
    setStatus('Conectando', 'busy');
    if (!device.opened) await device.open();
    if (generation !== connectionGeneration || !device.opened) {
      await closeDevice(device);
      return;
    }
    activeDevice = device;
    device.addEventListener('inputreport', handleInputReport);
    deviceText.textContent = device.productName || `${hex(device.vendorId)}:${hex(device.productId)}`;
    connectionText.textContent = connectionMode(device) === 'USB' ? 'Cabo USB' : 'Receptor 2.4G';
    setStatus('Conectado', 'ok');
    connectButton.textContent = 'Reconectar';
    batteryText.textContent = 'Aguardando pacote';
    renderMouseSettings('Lendo configurações do mouse...');
    window.mouseBridge.setTrayBattery('aguardando bateria');
    log('Dispositivo conectado', describeDevice(device));
    startBatteryRefresh();
    window.mouseBridge.notifyMouseConnected();
    await requestBattery();
    void loadMouseSettings(device).catch((error) => log('Falha ao ler as configurações do mouse.', error.message));
    // A consulta do protocolo é prioritária; a sondagem é apenas diagnóstica.
    void probeFeatureReports(device).catch((error) => log('Falha na sondagem do dispositivo.', error.message));
  } catch (error) {
    if (generation === connectionGeneration) {
      await closeDevice(clearConnection());
      setStatus('Erro na conexão', 'error');
    }
    throw error;
  } finally {
    openingDevice = null;
  }
}

async function requestBattery(attempt = 1) {
  const device = activeDevice;
  if (!device?.opened) {
    log('Conecte o AJAZZ antes de consultar a bateria.');
    return;
  }

  if (!canRequestBattery(device)) {
    log('A interface selecionada não anuncia output report 0. Reconecte e selecione a interface vendor-specific.');
    return;
  }

  clearBatteryResponseTimer();
  try {
    await device.sendReport(0, batteryCommand());
    log('Consulta de bateria enviada.');
  } catch (error) {
    log('Falha ao consultar bateria', error.message);
    return;
  }
  if (activeDevice !== device) return;

  // Em repouso o mouse pode ignorar a consulta; repete uma vez antes de desistir.
  batteryResponseTimer = setTimeout(() => {
    batteryResponseTimer = null;
    if (activeDevice !== device || !device.opened) return;
    if (attempt < BATTERY_QUERY_ATTEMPTS) {
      log('Sem resposta da bateria. Repetindo consulta.');
      void requestBattery(attempt + 1);
      return;
    }
    log('O mouse não respondeu à consulta de bateria. Mova o mouse e clique em Atualizar bateria.');
    if (lastBattery === null) {
      batteryText.textContent = 'Sem resposta';
      window.mouseBridge.setTrayBattery('sem resposta');
    } else {
      batteryDetail.textContent = `${describeLastReading()} · sem resposta agora`;
    }
  }, BATTERY_RESPONSE_TIMEOUT);
}

function finishCommand(bytes) {
  const command = pendingCommand;
  if (!command) return;
  pendingCommand = null;
  clearTimeout(command.timer);
  command.resolve(bytes);
}

// Envia um comando de configuração e espera a resposta AA [código]; null se não houver.
// Como no configurador oficial, só um comando fica pendente por vez.
function sendMouseCommand(device, payload) {
  const run = () => new Promise((resolve, reject) => {
    if (activeDevice !== device || !device.opened) {
      resolve(null);
      return;
    }
    const command = { device, code: payload[1], resolve };
    command.timer = setTimeout(() => finishCommand(null), COMMAND_TIMEOUT);
    pendingCommand = command;
    device.sendReport(0, payload).catch((error) => {
      if (pendingCommand === command) {
        clearTimeout(command.timer);
        pendingCommand = null;
      }
      reject(error);
    });
  });
  const result = commandQueue.then(run);
  commandQueue = result.catch(() => {});
  return result;
}

async function loadMouseSettings(device) {
  if (!canRequestBattery(device)) {
    renderMouseSettings('Esta interface do mouse não aceita configuração. Reconecte e escolha a interface vendor-specific.');
    return;
  }
  const version = await sendMouseCommand(device, versionCommand());
  if (activeDevice !== device) return;
  if (version) {
    firmwareVersion = parseFirmwareVersion(version);
    firmwareText.textContent = firmwareVersion;
  }

  const response = await sendMouseCommand(device, readConfigCommand());
  if (activeDevice !== device) return;
  if (!response) {
    log('O mouse não respondeu à leitura das configurações.');
    renderMouseSettings('O mouse não respondeu. Mova o mouse e reconecte para tentar de novo.');
    return;
  }
  mouseConfig = parseMouseConfig(response);
  log('Configurações do mouse lidas', mouseConfig);
  renderMouseSettings(mouseConfig.factoryDefaults ? 'O mouse está com a configuração de fábrica.' : '');
}

function sameSetting(a, b) {
  return Array.isArray(a) ? a.length === b.length && a.every((value, index) => value === b[index]) : a === b;
}

// Grava só as mudanças pedidas sobre a configuração lida do mouse e confere lendo de novo.
// `update` pode ser uma função: ela recebe a configuração atual quando chega a vez na fila.
function saveMouseConfig(update, description) {
  const run = async () => {
    const device = activeDevice;
    if (!device || !mouseConfig) return false;
    const changes = typeof update === 'function' ? update(mouseConfig) : update;
    const next = { ...mouseConfig, ...changes, dpis: [...(changes.dpis ?? mouseConfig.dpis)] };
    const error = validateMouseConfig(next, Object.keys(changes));
    if (error) {
      mouseSettingsStatus.textContent = error;
      return false;
    }

    mouseSettings.disabled = true;
    mouseSettingsStatus.textContent = `Salvando ${description.toLowerCase()}...`;
    try {
      if (changes.lightMode !== undefined) await sendMouseCommand(device, lightModeCommand(next.lightMode));
      await sendMouseCommand(device, writeConfigCommand(next));
      const response = await sendMouseCommand(device, readConfigCommand());
      if (activeDevice !== device) return false;
      const saved = response ? parseMouseConfig(response) : null;
      const confirmed = saved !== null && Object.keys(changes).every((key) => sameSetting(saved[key], next[key]));
      mouseConfig = saved ?? next;
      log(confirmed ? `Salvo no mouse: ${description}.` : `Enviado, mas o mouse não confirmou: ${description}.`, mouseConfig);
      renderMouseSettings(confirmed ? `Salvo no mouse: ${description}.` : `Enviado, mas o mouse não confirmou: ${description}. Confira no mouse.`);
      return confirmed;
    } catch (sendError) {
      log(`Falha ao salvar ${description.toLowerCase()}.`, sendError.message);
      renderMouseSettings(`Não foi possível salvar ${description.toLowerCase()}.`);
      return false;
    }
  };
  const result = settingsQueue.then(run);
  settingsQueue = result.catch(() => {});
  return result;
}

function applyMouseStatus(status) {
  if (!mouseConfig) return;
  mouseConfig.dpiIndex = status.dpiIndex;
  if (status.reportRate !== null) mouseConfig.reportRate = status.reportRate;
  log(`Mouse alterado pelo botão: DPI ${mouseConfig.dpis[status.dpiIndex]}.`);
  dpiRadios.forEach((radio, index) => { radio.checked = index === status.dpiIndex; });
  reportRateSelect.value = String(mouseConfig.reportRate);
}

function createOption(value, label) {
  const option = document.createElement('option');
  option.value = String(value);
  option.textContent = label;
  return option;
}

function renderDpiLevels() {
  dpiRadios = [];
  dpiInputs = [];
  dpiLevels.replaceChildren(
    ...(mouseConfig?.dpis ?? DEFAULT_MOUSE_CONFIG.dpis).map((dpi, index) => {
      const row = document.createElement('label');
      row.className = 'dpi-level';

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'activeDpi';
      radio.checked = mouseConfig?.dpiIndex === index;
      radio.title = `Usar o nível ${index + 1}`;
      radio.addEventListener('change', () => {
        if (radio.checked) void saveMouseConfig({ dpiIndex: index }, 'Nível de DPI');
      });

      const swatch = document.createElement('span');
      swatch.className = `dpi-swatch level-${index + 1}`;
      swatch.title = 'Cor do indicador no mouse';

      const input = document.createElement('input');
      input.type = 'number';
      input.min = String(DPI_MIN);
      input.max = String(DPI_MAX);
      input.step = String(DPI_STEP);
      input.value = String(dpi);
      input.setAttribute('aria-label', `DPI do nível ${index + 1}`);

      dpiRadios.push(radio);
      dpiInputs.push(input);
      row.append(radio, swatch, input);
      return row;
    })
  );
}

function renderMouseSettings(message = '') {
  mouseSettings.disabled = !mouseConfig;
  mouseSettingsStatus.textContent = message;
  renderDpiLevels();
  if (!mouseConfig) return;
  lightModeSelect.value = String(mouseConfig.lightMode);
  reportRateSelect.value = String(mouseConfig.reportRate);
  lodSelect.value = String(mouseConfig.lod);
  sleepSelect.value = String(mouseConfig.sleepMinutes);
  behaviorInputs.forEach((input, index) => { input.checked = BEHAVIOR_TOGGLES[index].read(mouseConfig); });
  // Pelo cabo o mouse trabalha sempre a 1000 Hz; a taxa vale para o receptor 2.4G.
  reportRateSelect.disabled = connectionMode(activeDevice) === 'USB';
}

function buildBehaviorToggles() {
  behaviorInputs = [];
  behaviorOptions.replaceChildren(
    ...BEHAVIOR_TOGGLES.map((toggle) => {
      const row = document.createElement('label');
      row.className = 'toggle';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.addEventListener('change', () => {
        const checked = input.checked;
        void saveMouseConfig((config) => toggle.changes(config, checked), toggle.label);
      });

      const text = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = toggle.label;
      const hint = document.createElement('small');
      hint.textContent = toggle.hint;
      text.append(title, hint);

      behaviorInputs.push(input);
      row.append(input, text);
      return row;
    })
  );
}

function applyDpiValues() {
  const dpis = dpiInputs.map((input) => Number(input.value));
  return saveMouseConfig({ dpis }, 'DPI');
}

async function connect() {
  if (manualConnectionPending) return;
  manualConnectionPending = true;
  connectButton.disabled = true;
  try {
    if (!('hid' in navigator)) {
      setStatus('WebHID indisponível', 'error');
      log('Este runtime não expôs navigator.hid.');
      return;
    }

    if (await listAuthorizedDevices()) return;

    setStatus('Selecionando dispositivo', 'busy');
    log('Solicitando seleção HID filtrada para AJAZZ AJ139 V2 MC...');
    const devices = await navigator.hid.requestDevice({
      filters: AJAZZ_VENDOR_IDS.map((vendorId) => ({ vendorId, productId: AJAZZ_PRODUCT_ID }))
    });
    hideDevicePicker();

    if (!devices.length) {
      setStatus('Seleção cancelada');
      log('Nenhum dispositivo foi selecionado.');
      return;
    }

    await enqueueConnection(() => openDevice(pickBestMouse(devices)));
  } catch (error) {
    if (!activeDevice) setStatus('Erro na conexão', 'error');
    log(error.message || 'Erro desconhecido', { name: error.name, stack: error.stack });
  } finally {
    manualConnectionPending = false;
    connectButton.disabled = false;
  }
}

async function listAuthorizedDevices() {
  if (!('hid' in navigator)) {
    setStatus('WebHID indisponível', 'error');
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

      const report = parseMouseReport(bytes);
      if (report?.type === 'battery') applyBatteryLevel(report.battery, report.charging);
    } catch (error) {
      log(`Não foi possível ler feature report ${reportId}`, error.message);
    }
  }
}

function renderPreferences() {
  lowAlertSelect.value = String(preferences.lowAlert);
  criticalAlertSelect.value = String(preferences.criticalAlert);
  refreshSelect.value = String(preferences.refreshMinutes);
  notifyFullCheckbox.checked = preferences.notifyFull;
}

function updatePreferences(changes) {
  const next = { ...preferences, ...changes };
  if (next.criticalAlert >= next.lowAlert) {
    renderPreferences();
    log('O aviso crítico precisa ser menor que o aviso de bateria baixa.');
    return;
  }
  const intervalChanged = next.refreshMinutes !== preferences.refreshMinutes;
  preferences = next;
  savePreferences();
  renderPreferences();
  if (intervalChanged && batteryRefreshTimer) startBatteryRefresh();
}

function populateSelects() {
  lightModeSelect.replaceChildren(...LIGHT_MODES.map((mode) => createOption(mode.value, mode.label)));
  reportRateSelect.replaceChildren(...REPORT_RATES.map((rate, index) => createOption(index, `${rate} Hz`)));
  lodSelect.replaceChildren(...LOD_HEIGHTS.map((height) => createOption(height, `${height} mm`)));
  sleepSelect.replaceChildren(...SLEEP_MINUTES.map((minutes) => createOption(minutes, `${minutes} min`)));
  lowAlertSelect.replaceChildren(...LOW_ALERT_OPTIONS.map((value) => createOption(value, `${value}%`)));
  criticalAlertSelect.replaceChildren(...CRITICAL_ALERT_OPTIONS.map((value) => createOption(value, `${value}%`)));
  refreshSelect.replaceChildren(...REFRESH_OPTIONS.map((value) => createOption(value, `${value} min`)));
}

window.mouseBridge.onDeviceList(renderDevicePicker);
window.mouseBridge.onTrayConnect(() => connect());
window.mouseBridge.onPowerResume(() => {
  // O mouse e o Bluetooth levam alguns segundos para voltar após a suspensão.
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    log('Sistema retomado da suspensão. Atualizando bateria.');
    if (activeDevice?.opened) void requestBattery();
    else listAuthorizedDevices().catch((error) => log('Falha ao reconectar.', error.message));
  }, RESUME_REFRESH_DELAY);
});

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
cancelPickerButton.addEventListener('click', async () => {
  await window.mouseBridge.cancelDeviceSelection();
  hideDevicePicker();
});
probeButton.addEventListener('click', () => requestBattery());
copyLogButton.addEventListener('click', () => {
  copyDiagnostics().catch((error) => log('Falha ao copiar diagnóstico.', error.message));
});
clearLogButton.addEventListener('click', () => {
  logEntries.length = 0;
  logNode.textContent = '';
});
applyDpiButton.addEventListener('click', () => { void applyDpiValues(); });
lightModeSelect.addEventListener('change', () => {
  void saveMouseConfig({ lightMode: Number(lightModeSelect.value) }, 'Iluminação');
});
reportRateSelect.addEventListener('change', () => {
  void saveMouseConfig({ reportRate: Number(reportRateSelect.value) }, 'Taxa de polling');
});
lodSelect.addEventListener('change', () => {
  void saveMouseConfig({ lod: Number(lodSelect.value) }, 'Altura de LOD');
});
sleepSelect.addEventListener('change', () => {
  void saveMouseConfig({ sleepMinutes: Number(sleepSelect.value) }, 'Tempo de repouso');
});
lowAlertSelect.addEventListener('change', () => updatePreferences({ lowAlert: Number(lowAlertSelect.value) }));
criticalAlertSelect.addEventListener('change', () => updatePreferences({ criticalAlert: Number(criticalAlertSelect.value) }));
refreshSelect.addEventListener('change', () => updatePreferences({ refreshMinutes: Number(refreshSelect.value) }));
notifyFullCheckbox.addEventListener('change', () => updatePreferences({ notifyFull: notifyFullCheckbox.checked }));

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

populateSelects();
buildBehaviorToggles();
renderPreferences();
renderBatteryGauge(null, false);
renderMouseSettings('Conecte o mouse para ver as configurações.');

window.addEventListener('focus', refreshStartupPreference);
refreshStartupPreference();

listAuthorizedDevices().catch((error) => {
  log('Erro ao listar dispositivos já autorizados', error.message);
});
