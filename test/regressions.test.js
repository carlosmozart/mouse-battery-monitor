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
    textContent: '', checked: false, disabled: false, children: [],
    addEventListener: node.on.bind(node),
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; }
  });
}

function mouse({ batteryInterface = true, name = 'AJAZZ', open } = {}) {
  const device = new EventEmitter();
  return Object.assign(device, {
    vendorId: 0xa8a4, productId: 0x2255, productName: name,
    opened: false, opens: 0, closes: 0, queries: 0,
    collections: [{ usagePage: 0xff01, usage: 0x10,
      outputReports: batteryInterface ? [{ reportId: 0 }] : [], featureReports: [] }],
    addEventListener: device.on.bind(device),
    removeEventListener: device.off.bind(device),
    async open() { this.opens++; if (open) await open(); this.opened = true; },
    async close() { this.closes++; this.opened = false; },
    async sendReport() { this.queries++; }
  });
}

async function renderer() {
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
  vm.runInContext(source('src/renderer/renderer.js'), context);
  await tick();
  return { context, nodes, state, timers, timeouts, hid, window };
}

async function runTimeouts(timeouts) {
  for (const id of [...timeouts]) { timeouts.delete(id); id.callback(); }
  await tick();
}

function batteryReport(device, battery, charging) {
  const bytes = new Uint8Array([0xaa, 0x30, 0xa5, 0, 0, 0, 0, 0, battery, charging]);
  return { device, reportId: 0, data: new DataView(bytes.buffer) };
}

async function main({ lock = true, hidden = true, packaged = true } = {}) {
  const app = new EventEmitter();
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  const windows = [];
  const trays = [];
  const powerMonitor = new EventEmitter();
  const state = { openAtLogin: true, executableWillLaunchAtLogin: true, quits: 0 };
  Object.assign(app, {
    requestSingleInstanceLock: () => lock,
    quit: () => { state.quits++; },
    isReady: () => true, whenReady: () => Promise.resolve(), isPackaged: packaged,
    getAppPath: () => root, getVersion: () => require('../package.json').version,
    getLoginItemSettings(options) { state.readOptions = options; return state; },
    setLoginItemSettings(options) { state.writeOptions = options; state.openAtLogin = options.openAtLogin; }
  });
  ipcMain.handle = (name, callback) => handlers.set(name, callback);
  class BrowserWindow extends EventEmitter {
    constructor() { super(); this.webContents = { sent: [], send(name) { this.sent.push(name); } }; this.hides = 0; windows.push(this); }
    loadFile() {} hide() { this.hides++; } show() {} focus() {} isMinimized() { return false; }
  }
  class Tray extends EventEmitter {
    constructor(image) { super(); this.images = [image]; trays.push(this); }
    setIgnoreDoubleClickEvents() {} setToolTip(text) { this.tooltip = text; } setContextMenu() {}
    setImage(image) { this.images.push(image); }
  }
  const session = new EventEmitter();
  session.setDevicePermissionHandler = () => {};
  const nativeImage = { createEmpty: () => ({ representations: [], addRepresentation(rep) { this.representations.push(rep); } }) };
  const electron = { app, ipcMain, BrowserWindow, Tray, powerMonitor,
    session: { defaultSession: session }, nativeImage,
    Menu: { buildFromTemplate: (items) => items }, Notification: { isSupported: () => false } };
  const context = vm.createContext({
    Buffer, console, __dirname: path.join(root, 'src'),
    process: { argv: hidden ? ['app', '--hidden'] : ['app'], execPath: 'C:\\app\\monitor.exe' },
    require: (name) => name === 'electron' ? electron : require(name)
  });
  vm.runInContext(source('src/main.js'), context);
  await tick();
  return { app, ipcMain, handlers, windows, trays, powerMonitor, state, context };
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

test('Windows é a fonte da preferência e leitura/gravação usam os mesmos argumentos', async () => {
  const { context, state } = await main();
  assert.equal(context.getStartWithWindows(), true);
  state.executableWillLaunchAtLogin = false;
  assert.equal(context.getStartWithWindows(), false);
  assert.equal(context.setStartWithWindows(true), false);
  assert.equal(JSON.stringify(state.writeOptions.args), JSON.stringify(state.readOptions.args));
  assert.equal(state.writeOptions.path, state.readOptions.path);
  assert.equal(context.setStartWithWindows(false), false);
});

test('inicialização em desenvolvimento inclui o caminho do projeto', async () => {
  const { context, state } = await main({ packaged: false });
  context.setStartWithWindows(true);
  assert.deepEqual(Array.from(state.writeOptions.args), [root, '--hidden']);
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
  assert.equal(nodes.get('#batteryText').textContent, '15% · carregando');
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
  assert.equal(nodes.get('#batteryText').textContent, '51% · carregando');
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
