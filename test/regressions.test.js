const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = path.join(__dirname, '..');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function element() {
  const node = new EventEmitter();
  return Object.assign(node, {
    textContent: '', checked: false, disabled: false, hidden: false, value: '', children: [], style: {},
    addEventListener: node.on.bind(node),
    setAttribute(name, value) { this[name] = value; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; }
  });
}

const defaultMouseConfig = () => ({
  lightMode: 2, reportRate: 3, dpiCount: 6, dpiIndex: 1, dpis: [400, 800, 1600, 2400, 3200, 6400],
  scrollFlag: 0, lod: 1, sensorFlag: 53, keyRespond: 4, sleepMinutes: 10, highspeedMode: 0, wakeupFlag: 1
});

// Codificação independente da resposta de leitura, conforme o configurador oficial.
function configResponse(config) {
  const bytes = new Uint8Array(64);
  bytes.set([0xaa, 0x0e, 0xa5, 0x0b, 0x2f, 0x01, 0x01]);
  bytes[9] = config.lightMode; bytes[10] = config.reportRate + 1;
  bytes[11] = config.dpiCount; bytes[12] = config.dpiIndex + 1;
  config.dpis.forEach((dpi, i) => { bytes[13 + i * 2] = dpi & 0xff; bytes[14 + i * 2] = dpi >> 8; });
  bytes[48] = config.scrollFlag; bytes[49] = config.lod; bytes[50] = config.sensorFlag;
  bytes[51] = config.keyRespond; bytes[52] = config.sleepMinutes; bytes[53] = config.highspeedMode;
  bytes[55] = config.wakeupFlag;
  return bytes;
}

// Simula o mouse: responde a versão, leitura/gravação de configuração e modo de luz.
function mouse({ batteryInterface = true, name = 'AJAZZ', open, vendorId = 0xa8a4, silent = false, ignoreWrites = false } = {}) {
  const device = new EventEmitter();
  const reply = (bytes) => device.emit('inputreport', { device, reportId: 0, data: new DataView(bytes.buffer) });
  return Object.assign(device, {
    vendorId, productId: 0x2255, productName: name,
    opened: false, opens: 0, closes: 0, queries: 0, reports: [], config: defaultMouseConfig(),
    collections: [{ usagePage: 0xff01, usage: 0x10,
      outputReports: batteryInterface ? [{ reportId: 0 }] : [], featureReports: [] }],
    addEventListener: device.on.bind(device),
    removeEventListener: device.off.bind(device),
    async open() { this.opens++; if (open) await open(); this.opened = true; },
    async close() { this.closes++; this.opened = false; },
    async sendReport(reportId, data) {
      const bytes = Array.from(data);
      this.reports.push(bytes);
      const code = bytes[1];
      if (code === 0x30) { this.queries++; return; }
      if (silent) return;
      if (code === 0x03) {
        const version = new Uint8Array(64); version.set([0xaa, 0x03]); version.set([0x31, 0x30, 0x34], 23);
        reply(version);
      } else if (code === 0x0e) {
        reply(configResponse(this.config));
      } else if (code === 0x0f) {
        if (!ignoreWrites) {
          this.config = {
            lightMode: bytes[9], reportRate: bytes[10] - 1, dpiCount: bytes[11], dpiIndex: bytes[12] - 1,
            dpis: [0, 1, 2, 3, 4, 5].map((i) => bytes[13 + i * 2] | (bytes[14 + i * 2] << 8)),
            scrollFlag: bytes[48], lod: bytes[49], sensorFlag: bytes[50], keyRespond: bytes[51],
            sleepMinutes: bytes[52], highspeedMode: bytes[53], wakeupFlag: bytes[54]
          };
        }
        reply(new Uint8Array([0xaa, 0x0f, ...new Array(62).fill(0)]));
      } else if (code === 0x21) {
        if (!ignoreWrites) this.config.lightMode = bytes[10];
        reply(new Uint8Array([0xaa, 0x21, ...new Array(62).fill(0)]));
      }
    }
  });
}

async function settle() {
  for (let i = 0; i < 10; i++) await tick();
}

async function renderer({ storage = {} } = {}) {
  const nodes = new Map();
  const hid = new EventEmitter();
  const window = new EventEmitter();
  const state = { devices: [], alerts: [], full: 0, connections: 0, tray: '', trayLevel: null, clipboard: '', enabled: false };
  const timers = new Set();
  const timeouts = new Set();
  hid.getDevices = async () => state.devices;
  hid.addEventListener = hid.on.bind(hid);
  window.addEventListener = window.on.bind(window);
  window.mouseBridge = {
    onDeviceList() {}, onTrayConnect() {},
    onPowerResume(callback) { state.resume = callback; },
    cancelDeviceSelection: async () => { state.cancelled = (state.cancelled ?? 0) + 1; return true; },
    getStartWithWindows: async () => state.enabled,
    setStartWithWindows: async () => state.enabled,
    getAppVersion: async () => require('../package.json').version,
    setTrayBattery: (value, level = null) => { state.tray = value; state.trayLevel = level; },
    notifyLowBattery: (value) => state.alerts.push(value),
    notifyFullBattery: () => { state.full++; },
    notifyMouseConnected: () => { state.connections++; }
  };
  const context = vm.createContext({
    console, window,
    localStorage: { getItem: (key) => storage[key] ?? null, setItem: (key, value) => { storage[key] = value; } },
    navigator: { hid, clipboard: { writeText: async (value) => { state.clipboard = value; } } },
    document: {
      querySelector(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
      createElement: element
    },
    setInterval(callback) { timers.add(callback); return callback; },
    clearInterval(callback) { timers.delete(callback); },
    setTimeout(callback) { const id = { callback }; timeouts.add(id); return id; },
    clearTimeout(id) { timeouts.delete(id); }
  });
  vm.runInContext(source('src/renderer/protocol.js'), context);
  vm.runInContext(source('src/renderer/renderer.js'), context);
  await tick();
  return { context, nodes, state, timers, timeouts, hid, window, storage };
}

async function runTimeouts(timeouts) {
  for (const id of [...timeouts]) { timeouts.delete(id); id.callback(); }
  await tick();
}

function batteryReport(device, battery, charging) {
  const bytes = new Uint8Array([0xaa, 0x30, 0xa5, 0, 0, 0, 0, 0, battery, charging]);
  return { device, reportId: 0, data: new DataView(bytes.buffer) };
}

const INSTALLED_EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\Mouse Battery Monitor\\Mouse Battery Monitor.exe';

async function main({ lock = true, hidden = true, packaged = true, notifications = false, registry = [] } = {}) {
  const app = new EventEmitter();
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  const windows = [];
  const trays = [];
  const powerMonitor = new EventEmitter();
  const notices = [];
  const state = { quits: 0, writes: [], registry: new Map(registry) };
  // Imita o Electron 38 no Windows: o caminho é lido como linha de comando e,
  // sem aspas, cortado no primeiro espaço.
  const program = (value) => (value.startsWith('"') ? value.slice(1, value.indexOf('"', 1)) : value.split(' ')[0]);
  Object.assign(app, {
    setAppUserModelId(id) { state.appUserModelId = id; },
    requestSingleInstanceLock: () => lock,
    quit: () => { state.quits++; },
    isReady: () => true, whenReady: () => Promise.resolve(), isPackaged: packaged,
    getAppPath: () => root, getVersion: () => require('../package.json').version,
    getLoginItemSettings(options) {
      const lookup = program(options.path).toLowerCase();
      const launchItems = [...state.registry]
        .filter(([, item]) => item.path.toLowerCase() === lookup)
        // Como o Electron, devolve só os argumentos que não são opções.
        .map(([name, item]) => ({ name, path: item.path, args: item.args.filter((arg) => !arg.startsWith('-')), scope: 'user', enabled: item.enabled }));
      return { openAtLogin: false, executableWillLaunchAtLogin: launchItems.some((item) => item.enabled), launchItems };
    },
    setLoginItemSettings(options) {
      state.writes.push(options);
      if (options.openAtLogin) state.registry.set(options.name, { path: options.path, args: [...options.args], enabled: options.enabled ?? true });
      else state.registry.delete(options.name);
    }
  });
  ipcMain.handle = (name, callback) => handlers.set(name, callback);
  class BrowserWindow extends EventEmitter {
    constructor() { super(); this.webContents = { sent: [], send(name) { this.sent.push(name); } }; this.hides = 0; windows.push(this); }
    loadFile() {} hide() { this.hides++; } show() { this.shows = (this.shows ?? 0) + 1; } focus() {} isMinimized() { return false; }
  }
  class Tray extends EventEmitter {
    constructor(image) { super(); this.images = [image]; trays.push(this); }
    setIgnoreDoubleClickEvents() {} setToolTip(text) { this.tooltip = text; } setContextMenu() {}
    setImage(image) { this.images.push(image); }
  }
  const session = new EventEmitter();
  session.setDevicePermissionHandler = (handler) => { state.permissionHandler = handler; };
  class Notification extends EventEmitter {
    static isSupported() { return notifications; }
    constructor(options) { super(); Object.assign(this, options); notices.push(this); }
    show() { this.shown = true; }
  }
  const nativeImage = { createEmpty: () => ({ representations: [], addRepresentation(rep) { this.representations.push(rep); } }) };
  const electron = { app, ipcMain, BrowserWindow, Tray, powerMonitor,
    session: { defaultSession: session }, nativeImage,
    Menu: { buildFromTemplate: (items) => items }, Notification };
  const context = vm.createContext({
    Buffer, console, __dirname: path.join(root, 'src'),
    process: { argv: hidden ? ['app', '--hidden'] : ['app'], execPath: INSTALLED_EXE, platform: 'win32' },
    require: (name) => name === 'electron' ? electron : require(name)
  });
  vm.runInContext(source('src/main.js'), context);
  await tick();
  return { app, ipcMain, handlers, windows, trays, notices, powerMonitor, state, context };
}

test('seleção manual funciona com os metadados enviados pelo processo principal', async () => {
  const { context, nodes } = await renderer();
  context.renderDevicePicker([{ deviceId: '1', name: 'AJAZZ', vendorId: 0xa8a4, productId: 0x2255 }]);
  assert.equal(nodes.get('#devicePicker').children.length, 1);
  assert.equal(nodes.get('#devicePicker').children[0].children[1].textContent, 'Selecionar');
});

test('conexões concorrentes abrem uma vez e mantêm um listener e um temporizador', async () => {
  const { context, state, timers, nodes } = await renderer();
  const device = mouse(); state.devices = [device];
  await Promise.all([context.listAuthorizedDevices(), context.listAuthorizedDevices(), context.connect()]);
  assert.equal(device.opens, 1);
  assert.equal(device.listenerCount('inputreport'), 1);
  assert.equal(timers.size, 1);
  assert.equal(nodes.get('#statusText').textContent, 'Conectado');
});

test('desconexão limpa status, bateria, listener e temporizador; reconecta sem duplicar', async () => {
  const { context, state, timers, hid, nodes } = await renderer();
  const device = mouse(); state.devices = [device];
  await context.listAuthorizedDevices(); context.applyBatteryLevel(72);
  state.devices = []; device.opened = false; hid.emit('disconnect', { device }); await tick();
  assert.equal(nodes.get('#batteryText').textContent, '--');
  assert.equal(nodes.get('#chargingBadge').hidden, true);
  assert.equal(nodes.get('#statusText').textContent, 'Aguardando conexão');
  assert.equal(state.tray, 'mouse desconectado');
  assert.equal(device.listenerCount('inputreport'), 0); assert.equal(timers.size, 0);
  state.devices = [device]; hid.emit('connect', { device }); await tick();
  assert.equal(device.opens, 2); assert.equal(timers.size, 1);
  assert.equal(device.listenerCount('inputreport'), 1);
});

test('desconexão durante open cancela o resultado tardio', async () => {
  const { context, state, hid, timers, nodes } = await renderer();
  let resolveOpen;
  const device = mouse({ open: () => new Promise((resolve) => { resolveOpen = resolve; }) });
  state.devices = [device]; const pending = context.listAuthorizedDevices(); await tick();
  state.devices = []; hid.emit('disconnect', { device }); resolveOpen(); await pending; await tick();
  assert.equal(device.opened, false); assert.equal(timers.size, 0);
  assert.equal(state.connections, 0); assert.equal(nodes.get('#batteryText').textContent, '--');
});

test('hotplug reavalia todas as interfaces e fecha a anterior', async () => {
  const { context, state, hid } = await renderer();
  const old = mouse({ batteryInterface: false }); const best = mouse({ name: 'bateria' });
  state.devices = [old]; await context.listAuthorizedDevices();
  state.devices = [old, best]; hid.emit('connect', { device: old }); await tick();
  assert.equal(old.closes, 1); assert.equal(old.listenerCount('inputreport'), 0);
  assert.equal(best.opens, 1); assert.equal(best.queries, 1);
});

test('oscilação em 10/11 e 20/21 não repete alertas; recarga acima de 25 rearma', async () => {
  const { context, state } = await renderer();
  [20,21,20,10,11,10,11,21,20,25,20].forEach(context.applyBatteryLevel);
  assert.deepEqual(state.alerts, [20,10]);
  [26,20,10].forEach(context.applyBatteryLevel);
  assert.deepEqual(state.alerts, [20,10,20,10]);
});

test('pacotes respeitam offset e relatórios de interfaces antigas são ignorados', async () => {
  const { context, state, nodes } = await renderer();
  const device = mouse(); state.devices = [device]; await context.listAuthorizedDevices();
  const buffer = new Uint8Array(20); buffer.set([0xaa,0x30,0xa5,0,0,0,0,0,72,0], 4);
  const report = { device, data: new DataView(buffer.buffer, 4, 10), reportId: 0 };
  context.handleInputReport(report); assert.equal(nodes.get('#batteryText').textContent, '72%');
  buffer[12] = 5; context.handleInputReport({ ...report, device: mouse() });
  assert.equal(nodes.get('#batteryText').textContent, '72%');
});

test('histórico é limitado e diagnóstico usa a versão do aplicativo', async () => {
  const { context, state, nodes } = await renderer();
  for (let i = 0; i < 250; i++) context.log(String(i), 'x'.repeat(3000));
  assert.ok(nodes.get('#log').textContent.length <= 200 * 2002);
  await context.copyDiagnostics();
  assert.equal(JSON.parse(state.clipboard).appVersion, require('../package.json').version);
  nodes.get('#clearLogButton').emit('click'); context.log('novo');
  assert.ok(!nodes.get('#log').textContent.includes('xxx'));
});

test('inicialização é confirmada pela entrada do app mesmo com espaços no caminho', async () => {
  const { app, context, state } = await main();
  // Sem aspas o Electron não encontra a entrada: era isso que desmarcava a caixa.
  assert.equal(context.getStartWithWindows(), false);
  assert.equal(context.setStartWithWindows(true), true);
  assert.equal(app.getLoginItemSettings({ path: INSTALLED_EXE }).launchItems.length, 0);
  const entry = state.registry.get('com.mousebatterymonitor.app');
  assert.equal(entry.path, INSTALLED_EXE); assert.deepEqual(entry.args, ['--hidden']);

  entry.enabled = false;
  assert.equal(context.getStartWithWindows(), false);
  entry.enabled = true;
  // Outra entrada ativa para o mesmo executável não conta como a do app.
  state.registry.set('outro', { path: INSTALLED_EXE, args: ['--hidden'], enabled: true });
  assert.equal(context.setStartWithWindows(false), false);
  assert.equal(state.registry.has('com.mousebatterymonitor.app'), false);
});

test('inicialização em desenvolvimento usa entrada própria com o caminho do projeto', async () => {
  const { context, state } = await main({ packaged: false });
  assert.equal(context.setStartWithWindows(true), true);
  assert.deepEqual(state.registry.get('com.mousebatterymonitor.app.dev').args, [root, '--hidden']);
  assert.equal(state.registry.has('com.mousebatterymonitor.app'), false);
  // Entrada de outra cópia do projeto não vale para esta.
  state.registry.get('com.mousebatterymonitor.app.dev').args = ['C:\\outro-projeto', '--hidden'];
  assert.equal(context.getStartWithWindows(), false);
});

test('entrada das versões antigas é migrada sem abrir o app duas vezes no login', async () => {
  const legacy = (enabled, exe = INSTALLED_EXE) => ['electron.app.Mouse Battery Monitor', { path: exe, args: ['--hidden'], enabled }];
  const active = await main({ registry: [legacy(true)] });
  assert.deepEqual([...active.state.registry.keys()], ['com.mousebatterymonitor.app']);
  assert.equal(active.context.getStartWithWindows(), true);

  const disabled = await main({ registry: [legacy(false)] });
  assert.equal(disabled.state.registry.size, 0);

  const current = ['com.mousebatterymonitor.app', { path: INSTALLED_EXE, args: ['--hidden'], enabled: false }];
  const both = await main({ registry: [legacy(true), current] });
  assert.deepEqual([...both.state.registry.keys()], ['com.mousebatterymonitor.app']);
  assert.equal(both.context.getStartWithWindows(), false);

  const other = await main({ registry: [legacy(true, 'C:\\outro\\app.exe')] });
  assert.equal(other.state.registry.has('electron.app.Mouse Battery Monitor'), true);
  assert.equal(other.state.writes.length, 0);
});

test('interface reflete bloqueio do Windows e atualiza ao receber foco', async () => {
  const { context, nodes, state, window } = await renderer();
  const checkbox = nodes.get('#startWithWindows');
  checkbox.checked = true; checkbox.emit('change'); await tick();
  assert.equal(checkbox.checked, false);
  assert.match(nodes.get('#startupStatus').textContent, /não foi confirmada/);
  state.enabled = true; window.emit('focus'); await tick(); assert.equal(checkbox.checked, true);
  state.enabled = false; await context.refreshStartupPreference(); assert.equal(checkbox.checked, false);
});

test('ocultação acontece uma única vez e abertura explícita cancela a espera', async () => {
  const first = await main(); const win = first.windows[0];
  first.ipcMain.emit('mouse-connected', { sender: win.webContents });
  first.context.showWindow();
  first.ipcMain.emit('mouse-connected', { sender: win.webContents });
  assert.equal(win.hides, 1);
  const second = await main(); second.context.showWindow();
  second.ipcMain.emit('mouse-connected', { sender: second.windows[0].webContents });
  assert.equal(second.windows[0].hides, 0);
  const manual = await main({ hidden: false });
  manual.ipcMain.emit('mouse-connected', { sender: manual.windows[0].webContents });
  assert.equal(manual.windows[0].hides, 0);
});

test('segunda instância encerra antes de criar janela ou registrar IPC', async () => {
  const { windows, handlers, state } = await main({ lock: false });
  assert.equal(state.quits, 1); assert.equal(windows.length, 0); assert.equal(handlers.size, 0);
});

test('carregamento aparece na tela, suprime alerta baixo e avisa carga completa uma vez', async () => {
  const { context, state, nodes } = await renderer();
  const device = mouse(); state.devices = [device]; await context.listAuthorizedDevices();
  context.handleInputReport(batteryReport(device, 15, 1));
  assert.equal(nodes.get('#batteryText').textContent, '15%');
  assert.equal(nodes.get('#chargingBadge').hidden, false);
  assert.equal(state.tray, '15% (carregando)');
  assert.equal(JSON.stringify(state.trayLevel), JSON.stringify({ battery: 15, charging: true }));
  assert.deepEqual(state.alerts, []);
  [100, 100].forEach((battery) => context.handleInputReport(batteryReport(device, battery, 1)));
  assert.equal(state.full, 1);
  context.handleInputReport(batteryReport(device, 15, 0));
  assert.deepEqual(state.alerts, [15]);
});

test('carga completa é avisada mesmo quando o indicador some em 100%', async () => {
  const { context, state } = await renderer();
  context.applyBatteryLevel(99, true); context.applyBatteryLevel(100, false);
  assert.equal(state.full, 1);
  context.applyBatteryLevel(100, false); assert.equal(state.full, 1);
});

test('pacote sem indicador de carga mantém o último estado', async () => {
  const { context, state, nodes } = await renderer();
  const device = mouse(); state.devices = [device]; await context.listAuthorizedDevices();
  context.handleInputReport(batteryReport(device, 50, 1));
  const bytes = new Uint8Array([0xaa, 0xfa, 0, 0, 0, 0, 0, 0, 0xd0, 51]);
  context.handleInputReport({ device, reportId: 0, data: new DataView(bytes.buffer) });
  assert.equal(nodes.get('#batteryText').textContent, '51%');
  assert.equal(nodes.get('#chargingBadge').hidden, false);
});

test('consulta sem resposta é repetida uma vez e depois mostra o aviso', async () => {
  const { context, state, nodes, timeouts } = await renderer();
  const device = mouse(); state.devices = [device]; await context.listAuthorizedDevices();
  assert.equal(device.queries, 1); assert.equal(timeouts.size, 1);
  await runTimeouts(timeouts); assert.equal(device.queries, 2);
  await runTimeouts(timeouts); assert.equal(device.queries, 2);
  assert.equal(nodes.get('#batteryText').textContent, 'Sem resposta');
  assert.equal(state.tray, 'sem resposta');
});

test('resposta e desconexão cancelam a espera da consulta', async () => {
  const { context, state, hid, timeouts } = await renderer();
  const device = mouse(); state.devices = [device]; await context.listAuthorizedDevices();
  context.handleInputReport(batteryReport(device, 60, 0)); assert.equal(timeouts.size, 0);
  await context.requestBattery(); assert.equal(timeouts.size, 1);
  state.devices = []; device.opened = false; hid.emit('disconnect', { device }); await tick();
  assert.equal(timeouts.size, 0);
});

test('retomada da suspensão consulta a bateria ou reconecta o mouse', async () => {
  const { context, state, timeouts } = await renderer();
  const device = mouse(); state.devices = [device]; await context.listAuthorizedDevices();
  context.handleInputReport(batteryReport(device, 60, 0));
  state.resume(); state.resume(); assert.equal(timeouts.size, 1);
  await runTimeouts(timeouts); assert.equal(device.queries, 2);

  const idle = await renderer(); const sleeping = mouse(); idle.state.devices = [sleeping];
  idle.state.resume(); await runTimeouts(idle.timeouts); await tick();
  assert.equal(sleeping.opens, 1);
});

test('ícone da bandeja mostra nível, cor e carregamento', async () => {
  const { context } = await main();
  const pixel = (pixels, size, u, v) => {
    const offset = (Math.floor((v * size) / 16) * size + Math.floor((u * size) / 16)) * 4;
    return Array.from(pixels.subarray(offset, offset + 3));
  };
  const blue = [37, 99, 235];
  const high = context.drawTrayIcon(32, { battery: 80, charging: false });
  assert.deepEqual(pixel(high, 32, 6.2, 12.5), [34, 197, 94]);
  assert.deepEqual(pixel(high, 32, 6.2, 3.2), blue);
  const low = context.drawTrayIcon(32, { battery: 10, charging: false });
  assert.deepEqual(pixel(low, 32, 6.2, 12.5), [239, 68, 68]);
  assert.deepEqual(pixel(low, 32, 8, 8), blue);
  assert.deepEqual(pixel(context.drawTrayIcon(32, { battery: 10, charging: true }), 32, 8, 8), [15, 23, 42]);
  assert.deepEqual(pixel(context.drawTrayIcon(16, null), 16, 6.2, 12.5), blue);
});

test('bandeja troca o ícone só quando o nível muda e retomada avisa o renderer', async () => {
  const { ipcMain, trays, windows, powerMonitor } = await main();
  const [tray] = trays;
  assert.equal(tray.images[0].representations.length, 4);
  ipcMain.emit('tray-battery', {}, '80%', { battery: 80, charging: false });
  ipcMain.emit('tray-battery', {}, '80%', { battery: 80, charging: false });
  assert.equal(tray.images.length, 2); assert.equal(tray.tooltip, 'Mouse Battery Monitor: 80%');
  ipcMain.emit('tray-battery', {}, 'mouse desconectado', null);
  ipcMain.emit('tray-battery', {}, 'valor inválido', { battery: 400 });
  assert.equal(tray.images.length, 3);
  powerMonitor.emit('resume');
  assert.deepEqual(windows[0].webContents.sent, ['power-resume']);
});

test('notificações usam o ID do instalador e o clique abre o monitor', async () => {
  const packaged = await main({ notifications: true, hidden: false });
  assert.equal(packaged.state.appUserModelId, require('../package.json').build.appId);
  packaged.ipcMain.emit('low-battery-notification', {}, 15);
  packaged.ipcMain.emit('full-battery-notification', {});
  assert.deepEqual(packaged.notices.map((notice) => notice.title), ['Bateria do mouse baixa', 'Mouse carregado']);
  assert.ok(packaged.notices.every((notice) => notice.shown));
  packaged.notices[0].emit('click');
  assert.equal(packaged.windows[0].shows, 1);
  const dev = await main({ packaged: false });
  assert.equal(dev.state.appUserModelId, INSTALLED_EXE);
  dev.ipcMain.emit('low-battery-notification', {}, 15);
  assert.equal(dev.notices.length, 0);
});

test('permissão HID persiste só para o mouse monitorado', async () => {
  const { state } = await main();
  const allowed = (details) => state.permissionHandler(details);
  assert.equal(allowed({ deviceType: 'hid', device: { vendorId: 0xa8a5, productId: 0x2255 } }), true);
  assert.equal(allowed({ deviceType: 'hid', device: { vendorId: 0x046d, productId: 0xc52b } }), false);
  assert.equal(allowed({ deviceType: 'usb', device: { vendorId: 0xa8a4, productId: 0x2255 } }), false);
  assert.equal(allowed({ deviceType: 'hid' }), false);
});

test('janela não navega para fora nem abre novas janelas', async () => {
  const { app } = await main();
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = (handler) => { contents.openHandler = handler; };
  app.emit('web-contents-created', {}, contents);
  let prevented = false;
  contents.emit('will-navigate', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(contents.openHandler({ url: 'https://example.com' }).action, 'deny');
});

test('janela mostra horário da leitura e mantém o último valor após desconectar', async () => {
  const { context, state, hid, nodes, timeouts } = await renderer();
  const detail = () => nodes.get('#batteryDetail').textContent;
  const device = mouse(); state.devices = [device]; await context.listAuthorizedDevices();
  assert.equal(detail(), '');
  context.handleInputReport(batteryReport(device, 64, 0));
  assert.match(detail(), /^Atualizado às \d{2}:\d{2}$/);
  await context.requestBattery(); await runTimeouts(timeouts); await runTimeouts(timeouts);
  assert.match(detail(), /^Última leitura: 64% às \d{2}:\d{2} · sem resposta agora$/);
  assert.equal(nodes.get('#batteryText').textContent, '64%');
  state.devices = []; device.opened = false; hid.emit('disconnect', { device }); await tick();
  assert.equal(nodes.get('#batteryText').textContent, '--');
  assert.match(detail(), /^Última leitura: 64% às \d{2}:\d{2}$/);
});

test('protocolo grava e lê a configuração nos bytes do configurador oficial', async () => {
  const { context } = await renderer();
  const config = defaultMouseConfig();
  const payload = Array.from(context.writeConfigCommand(config));
  assert.equal(payload.length, 64);
  assert.deepEqual(payload.slice(0, 13), [0x55, 0x0f, 0xae, 0x0a, 0x2f, 1, 1, 0, 0, 2, 4, 6, 2]);
  assert.deepEqual(payload.slice(13, 25), [0x90, 0x01, 0x20, 0x03, 0x40, 0x06, 0x60, 0x09, 0x80, 0x0c, 0x00, 0x19]);
  assert.deepEqual(payload.slice(48, 56), [0, 1, 53, 4, 10, 0, 1, 0]);
  const parsed = context.parseMouseConfig(Array.from(configResponse(config)));
  assert.equal(JSON.stringify(parsed), JSON.stringify(config));
  assert.equal(context.parseMouseConfig(new Array(64).fill(0xff)).factoryDefaults, true);
  assert.deepEqual(Array.from(context.lightModeCommand(5)).slice(0, 11), [0x55, 0x21, 0, 0, 3, 0, 0, 0, 0, 0, 5]);
  assert.deepEqual(Array.from(context.batteryCommand()).slice(0, 7), [0x55, 0x30, 0xa5, 0x0b, 0x2e, 1, 1]);
});

test('validação recusa valores fora do configurador e confere só os campos alterados', async () => {
  const { context } = await renderer();
  const config = { ...defaultMouseConfig(), reportRate: -1 };
  assert.equal(context.validateMouseConfig(config, ['lightMode']), null);
  assert.match(context.validateMouseConfig(config, ['reportRate']), /polling/);
  assert.match(context.validateMouseConfig({ ...config, dpis: [400, 800, 1600, 2400, 3200, 123] }, ['dpis']), /123/);
  assert.match(context.validateMouseConfig({ ...config, dpis: [400, 800, 1600, 2400, 3200, 24050] }, ['dpis']), /24050/);
  assert.match(context.validateMouseConfig({ ...config, lightMode: 9 }, ['lightMode']), /iluminação/);
  assert.equal(context.validateMouseConfig({ ...config, sleepMinutes: 30 }, ['sleepMinutes']), null);
});

test('eventos do mouse: bateria com carga, botão de DPI e receptor', async () => {
  const { context } = await renderer();
  const event = (bytes) => context.parseMouseReport(bytes);
  assert.equal(JSON.stringify(event([0xaa, 0xfa, 0, 0, 0, 0, 0, 0, 0xd0, 40, 1])), JSON.stringify({ type: 'battery', battery: 40, charging: true }));
  assert.equal(JSON.stringify(event([0xaa, 0xfa, 0, 0, 0, 0, 0, 0, 0x01, 3, 2])), JSON.stringify({ type: 'status', dpiIndex: 2, reportRate: 1 }));
  assert.equal(event([0xaa, 0xfa, 0, 0, 0, 0, 0, 0, 0x01, 9, 2]), null);
  assert.equal(JSON.stringify(event([0xaa, 0xed, 0, 0, 0, 0, 0, 0, 2, 0])), JSON.stringify({ type: 'online', online: true }));
  assert.equal(event([0x55, 0x30, 0xa5, 0, 0, 0, 0, 0, 50, 0]), null);
});

test('ao conectar o app lê firmware e configurações e libera os controles', async () => {
  const { context, state, nodes } = await renderer();
  const device = mouse(); state.devices = [device]; await context.listAuthorizedDevices(); await settle();
  assert.equal(nodes.get('#firmwareText').textContent, '1.0.4');
  assert.equal(nodes.get('#connectionText').textContent, 'Cabo USB');
  assert.equal(nodes.get('#mouseSettings').disabled, false);
  assert.equal(nodes.get('#lightModeSelect').value, '2');
  assert.equal(nodes.get('#reportRateSelect').disabled, true);
  const levels = nodes.get('#dpiLevels').children;
  assert.deepEqual(levels.map((level) => level.children[2].value), ['400', '800', '1600', '2400', '3200', '6400']);
  assert.equal(levels[1].children[0].checked, true);

  const wireless = await renderer();
  const dongle = mouse({ vendorId: 0xa8a5 }); wireless.state.devices = [dongle];
  await wireless.context.listAuthorizedDevices(); await settle();
  assert.equal(wireless.nodes.get('#connectionText').textContent, 'Receptor 2.4G');
  assert.equal(wireless.nodes.get('#reportRateSelect').disabled, false);
});

test('iluminação, polling e DPI são gravados no mouse e conferidos', async () => {
  const { context, state, nodes } = await renderer();
  const device = mouse({ vendorId: 0xa8a5 }); state.devices = [device]; await context.listAuthorizedDevices(); await settle();
  const light = nodes.get('#lightModeSelect'); light.value = '4'; light.emit('change'); await settle();
  assert.equal(device.config.lightMode, 4);
  assert.ok(device.reports.some((bytes) => bytes[1] === 0x21 && bytes[10] === 4));
  assert.equal(nodes.get('#mouseSettingsStatus').textContent, 'Salvo no mouse: Iluminação.');

  const rate = nodes.get('#reportRateSelect'); rate.value = '1'; rate.emit('change'); await settle();
  assert.equal(device.config.reportRate, 1);
  assert.equal(device.config.lightMode, 4);

  const levels = nodes.get('#dpiLevels').children;
  levels[5].children[2].value = '12000';
  nodes.get('#applyDpiButton').emit('click'); await settle();
  assert.deepEqual(device.config.dpis, [400, 800, 1600, 2400, 3200, 12000]);
  assert.equal(device.config.sensorFlag, 53);
  assert.equal(device.config.wakeupFlag, 1);

  nodes.get('#dpiLevels').children[3].children[0].checked = true;
  nodes.get('#dpiLevels').children[3].children[0].emit('change'); await settle();
  assert.equal(device.config.dpiIndex, 3);
});

test('DPI inválido não é enviado e gravação sem confirmação é avisada', async () => {
  const { context, state, nodes } = await renderer();
  const device = mouse({ ignoreWrites: true }); state.devices = [device]; await context.listAuthorizedDevices(); await settle();
  const writes = () => device.reports.filter((bytes) => bytes[1] === 0x0f).length;
  nodes.get('#dpiLevels').children[0].children[2].value = '425';
  nodes.get('#applyDpiButton').emit('click'); await settle();
  assert.equal(writes(), 0);
  assert.match(nodes.get('#mouseSettingsStatus').textContent, /DPI inválido: 425/);
  const sleep = nodes.get('#sleepSelect'); sleep.value = '30'; sleep.emit('change'); await settle();
  assert.equal(writes(), 1);
  assert.match(nodes.get('#mouseSettingsStatus').textContent, /não confirmou/);
});

test('mouse sem resposta mantém os controles bloqueados', async () => {
  const { context, state, nodes, timeouts } = await renderer();
  const device = mouse({ silent: true }); state.devices = [device]; await context.listAuthorizedDevices(); await settle();
  // Versão e leitura de configuração esperam a resposta; a bateria também tem seu temporizador.
  for (let i = 0; i < 3; i++) { await runTimeouts(timeouts); await settle(); }
  assert.equal(nodes.get('#mouseSettings').disabled, true);
  assert.match(nodes.get('#mouseSettingsStatus').textContent, /não respondeu/);
  assert.equal(device.reports.filter((bytes) => bytes[1] === 0x0f).length, 0);
});

test('botão de DPI no mouse e receptor atualizam a tela', async () => {
  const { context, state, nodes } = await renderer();
  const device = mouse({ vendorId: 0xa8a5 }); state.devices = [device]; await context.listAuthorizedDevices(); await settle();
  const report = (bytes) => context.handleInputReport({ device, reportId: 0, data: new DataView(new Uint8Array(bytes).buffer) });
  report([0xaa, 0xfa, 0, 0, 0, 0, 0, 0, 0x01, 5, 2]);
  const radios = nodes.get('#dpiLevels').children.map((level) => level.children[0].checked);
  assert.deepEqual(radios, [false, false, false, false, true, false]);
  assert.equal(nodes.get('#reportRateSelect').value, '1');
  report([0xaa, 0xed, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(nodes.get('#statusText').textContent, 'Mouse desligado');
  report([0xaa, 0xed, 0, 0, 0, 0, 0, 0, 2, 0]);
  assert.equal(nodes.get('#statusText').textContent, 'Conectado');
  assert.equal(device.queries, 2);
});

test('preferências de alerta são salvas e mudam os avisos e o intervalo', async () => {
  const storage = {};
  const first = await renderer({ storage });
  const low = first.nodes.get('#lowAlertSelect'); low.value = '30'; low.emit('change');
  const critical = first.nodes.get('#criticalAlertSelect'); critical.value = '15'; critical.emit('change');
  assert.equal(JSON.parse(storage.preferences).lowAlert, 30);
  [31, 30, 16, 15].forEach((battery) => first.context.applyBatteryLevel(battery));
  assert.deepEqual(first.state.alerts, [30, 15]);

  const second = await renderer({ storage });
  assert.equal(second.nodes.get('#lowAlertSelect').value, '30');
  assert.equal(second.nodes.get('#criticalAlertSelect').value, '15');
  const device = mouse(); second.state.devices = [device]; await second.context.listAuthorizedDevices();
  const [before] = second.timers;
  const refresh = second.nodes.get('#refreshSelect'); refresh.value = '30'; refresh.emit('change');
  assert.equal(second.timers.size, 1); assert.notEqual([...second.timers][0], before);

  const full = second.nodes.get('#notifyFullCheckbox'); full.checked = false; full.emit('change');
  second.context.applyBatteryLevel(99, true); second.context.applyBatteryLevel(100, true);
  assert.equal(second.state.full, 0);
});

test('preferências inválidas voltam ao padrão e aviso crítico fica abaixo do baixo', async () => {
  const { nodes, storage } = await renderer({ storage: { preferences: '{"lowAlert":7,"criticalAlert":15,"refreshMinutes":"x"}' } });
  assert.equal(nodes.get('#lowAlertSelect').value, '20');
  assert.equal(nodes.get('#criticalAlertSelect').value, '15');
  const low = nodes.get('#lowAlertSelect'); low.value = '15'; low.emit('change');
  assert.equal(nodes.get('#lowAlertSelect').value, '20');
  assert.equal(storage.preferences.includes('"lowAlert":7'), true);
  const broken = await renderer({ storage: { preferences: '{nada' } });
  assert.equal(broken.nodes.get('#refreshSelect').value, '10');
});

test('lista de seleção aparece com dispositivos e some ao cancelar', async () => {
  const { context, nodes, state } = await renderer();
  const card = nodes.get('#devicePickerCard');
  context.renderDevicePicker([{ deviceId: '1', name: 'AJAZZ', vendorId: 0xa8a4, productId: 0x2255 }]);
  assert.equal(card.hidden, false);
  nodes.get('#cancelPickerButton').emit('click'); await settle();
  assert.equal(card.hidden, true); assert.equal(state.cancelled, 1);
});


test('opções do sensor alteram só o seu bit e preservam os demais', async () => {
  const { context, state, nodes } = await renderer();
  const device = mouse(); state.devices = [device]; await context.listAuthorizedDevices(); await settle();
  const toggles = nodes.get('#behaviorOptions').children.map((row) => row.children[0]);
  const labels = nodes.get('#behaviorOptions').children.map((row) => row.children[1].children[0].textContent);
  assert.deepEqual(labels, ['Motion Sync', 'Controle de ondulação', 'Correção de linha reta', 'Inverter a rolagem', 'Acordar ao mover']);
  assert.deepEqual(toggles.map((toggle) => toggle.checked), [true, true, true, false, false]);

  // Dois cliques seguidos: o segundo parte da configuração já gravada pelo primeiro.
  toggles[0].checked = false; toggles[0].emit('change');
  toggles[1].checked = false; toggles[1].emit('change');
  await settle();
  assert.equal(device.config.sensorFlag, 53 & ~32 & ~1);
  assert.equal(nodes.get('#mouseSettingsStatus').textContent, 'Salvo no mouse: Controle de ondulação.');

  toggles[3].checked = true; toggles[3].emit('change'); await settle();
  assert.equal(device.config.scrollFlag, 1);
  toggles[4].checked = true; toggles[4].emit('change'); await settle();
  assert.equal(device.config.wakeupFlag, 0);
  assert.equal(device.reports.filter((bytes) => bytes[1] === 0x0f).at(-1)[54], 0);
  assert.equal(device.config.sensorFlag, 20);
});

test('validação dos campos de sensor, rolagem e despertar', async () => {
  const { context } = await renderer();
  const config = defaultMouseConfig();
  assert.equal(context.validateMouseConfig({ ...config, sensorFlag: 255 }, ['sensorFlag']), null);
  assert.match(context.validateMouseConfig({ ...config, sensorFlag: 256 }, ['sensorFlag']), /sensor/);
  assert.match(context.validateMouseConfig({ ...config, scrollFlag: 2 }, ['scrollFlag']), /rolagem/);
  assert.match(context.validateMouseConfig({ ...config, wakeupFlag: -1 }, ['wakeupFlag']), /despertar/);
});

test('ícone do app tem todos os tamanhos do Windows em PNG', () => {
  const { ICON_SIZES, generateIcon } = require('../scripts/generate-icon.js');
  const ico = generateIcon();
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), ICON_SIZES.length);
  ICON_SIZES.forEach((size, index) => {
    const entry = 6 + index * 16;
    assert.equal(ico[entry] || 256, size);
    const offset = ico.readUInt32LE(entry + 12);
    assert.equal(ico.subarray(offset + 1, offset + 4).toString('ascii'), 'PNG');
  });
  assert.deepEqual(fs.readFileSync(path.join(root, 'build', 'icon.ico')), ico);
});
