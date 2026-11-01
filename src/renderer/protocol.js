// Protocolo do AJAZZ AJ139 V2 MC, igual ao configurador oficial (139v2mc.yjx2012.com).
// Comandos vão no output report 0 com 64 bytes e começam com 55 [código].
// As respostas começam com AA e repetem o código do comando.

const MOUSE_REPORT_LENGTH = 64;
const MOUSE_COMMAND = {
  version: 0x03,
  readConfig: 0x0e,
  writeConfig: 0x0f,
  lightMode: 0x21,
  battery: 0x30
};
const MOUSE_EVENT = { status: 0xfa, online: 0xed };

const DPI_LEVELS = 6;
const DPI_MIN = 50;
const DPI_MAX = 24000;
const DPI_STEP = 50;
// Cores que o mouse usa para indicar cada nível de DPI.
const DPI_COLORS = ['#ff0000', '#00ff00', '#0000ff', '#00ffff', '#ffff00', '#800080'];
const LIGHT_MODES = [
  { value: 1, label: 'Onda' },
  { value: 2, label: 'Neon' },
  { value: 3, label: 'Flash circular' },
  { value: 4, label: 'Bola YoYo' },
  { value: 5, label: 'Flash único' },
  { value: 6, label: 'Respiração' },
  { value: 0, label: 'Desligado' }
];
// O índice gravado no mouse é a posição nesta lista.
const REPORT_RATES = [125, 250, 500, 1000];
const SLEEP_MINUTES = [1, 3, 5, 10, 20, 30, 60];
const LOD_HEIGHTS = [1, 2];
// Bits de sensorFlag que o configurador oficial expõe; os demais são preservados.
const SENSOR_OPTIONS = [
  { bit: 32, label: 'Motion Sync', hint: 'Sincroniza a leitura do sensor com o envio ao computador.' },
  { bit: 1, label: 'Controle de ondulação', hint: 'Reduz o tremido do sensor acima de 9.000 DPI.' },
  { bit: 16, label: 'Correção de linha reta', hint: 'Endireita movimentos levemente inclinados.' }
];

// Valores de fábrica usados pelo configurador quando o mouse devolve a configuração vazia.
const DEFAULT_MOUSE_CONFIG = {
  lightMode: 2,
  reportRate: 3,
  dpiCount: 5,
  dpiIndex: 1,
  dpis: [400, 800, 1200, 1600, 2400, 3200],
  scrollFlag: 0,
  lod: 1,
  sensorFlag: 53,
  keyRespond: 4,
  sleepMinutes: 10,
  highspeedMode: 0,
  wakeupFlag: 0
};

function buildMouseCommand(bytes) {
  const payload = new Uint8Array(MOUSE_REPORT_LENGTH);
  payload.set(bytes);
  return payload;
}

function batteryCommand() {
  return buildMouseCommand([0x55, MOUSE_COMMAND.battery, 0xa5, 0x0b, 0x2e, 0x01, 0x01]);
}

function versionCommand() {
  return buildMouseCommand([0x55, MOUSE_COMMAND.version]);
}

function readConfigCommand() {
  return buildMouseCommand([0x55, MOUSE_COMMAND.readConfig, 0xa5, 0x0b, 0x2f, 0x01, 0x01]);
}

function lightModeCommand(mode) {
  const payload = buildMouseCommand([0x55, MOUSE_COMMAND.lightMode, 0x00, 0x00, 0x03]);
  payload[10] = mode;
  return payload;
}

function writeConfigCommand(config) {
  const payload = buildMouseCommand([0x55, MOUSE_COMMAND.writeConfig, 0xae, 0x0a, 0x2f, 0x01, 0x01]);
  payload[9] = config.lightMode;
  payload[10] = config.reportRate + 1;
  payload[11] = config.dpiCount;
  payload[12] = config.dpiIndex + 1;
  config.dpis.forEach((dpi, index) => {
    payload[13 + index * 2] = dpi & 0xff;
    payload[14 + index * 2] = dpi >> 8;
  });
  payload[48] = config.scrollFlag;
  payload[49] = config.lod;
  payload[50] = config.sensorFlag;
  payload[51] = config.keyRespond;
  payload[52] = config.sleepMinutes;
  payload[53] = config.highspeedMode;
  // O configurador grava este campo no byte 54, embora o leia do byte 55.
  payload[54] = config.wakeupFlag;
  return payload;
}

function parseMouseConfig(bytes) {
  const dpiStart = bytes.slice(13, 16);
  if (dpiStart.every((byte) => byte === 0) || dpiStart.every((byte) => byte === 0xff)) {
    return { ...DEFAULT_MOUSE_CONFIG, dpis: [...DEFAULT_MOUSE_CONFIG.dpis], factoryDefaults: true };
  }
  return {
    lightMode: bytes[9],
    reportRate: bytes[10] - 1,
    dpiCount: bytes[11],
    dpiIndex: bytes[12] - 1,
    dpis: Array.from({ length: DPI_LEVELS }, (_, index) => bytes[13 + index * 2] | (bytes[14 + index * 2] << 8)),
    scrollFlag: bytes[48],
    lod: bytes[49],
    sensorFlag: bytes[50],
    keyRespond: bytes[51],
    sleepMinutes: bytes[52],
    highspeedMode: bytes[53],
    wakeupFlag: bytes[55]
  };
}

function parseFirmwareVersion(bytes) {
  const digit = (byte) => (byte >= 0x30 && byte <= 0x39 ? String.fromCharCode(byte) : '0');
  return [bytes[23], bytes[24], bytes[25]].map(digit).join('.');
}

const MOUSE_CONFIG_CHECKS = {
  dpis: (dpis) => {
    if (!Array.isArray(dpis) || dpis.length !== DPI_LEVELS) return 'A configuração precisa de 6 níveis de DPI.';
    const invalid = dpis.find((dpi) => !Number.isInteger(dpi) || dpi < DPI_MIN || dpi > DPI_MAX || dpi % DPI_STEP !== 0);
    return invalid === undefined ? null : `DPI inválido: ${invalid}. Use valores de ${DPI_MIN} a ${DPI_MAX}, em passos de ${DPI_STEP}.`;
  },
  dpiIndex: (index) => (Number.isInteger(index) && index >= 0 && index < DPI_LEVELS ? null : 'Nível de DPI ativo inválido.'),
  lightMode: (mode) => (LIGHT_MODES.some((option) => option.value === mode) ? null : 'Modo de iluminação inválido.'),
  reportRate: (rate) => (Number.isInteger(rate) && rate >= 0 && rate < REPORT_RATES.length ? null : 'Taxa de polling inválida.'),
  lod: (lod) => (LOD_HEIGHTS.includes(lod) ? null : 'Altura de LOD inválida.'),
  sleepMinutes: (minutes) => (SLEEP_MINUTES.includes(minutes) ? null : 'Tempo de repouso inválido.'),
  sensorFlag: (flag) => (Number.isInteger(flag) && flag >= 0 && flag <= 0xff ? null : 'Opções do sensor inválidas.'),
  // 1 inverte a direção da rolagem.
  scrollFlag: (flag) => (flag === 0 || flag === 1 ? null : 'Direção da rolagem inválida.'),
  // 0 liga o despertar ao mover o mouse; 1 desliga.
  wakeupFlag: (flag) => (flag === 0 || flag === 1 ? null : 'Opção de despertar inválida.')
};

// Recusa valores fora do que o configurador oficial permite escolher. Só os campos
// alterados são conferidos: os demais voltam ao mouse exatamente como foram lidos.
function validateMouseConfig(config, keys = Object.keys(MOUSE_CONFIG_CHECKS)) {
  for (const key of keys) {
    const check = MOUSE_CONFIG_CHECKS[key];
    if (!check) return `Configuração desconhecida: ${key}.`;
    const error = check(config[key]);
    if (error) return error;
  }
  return null;
}

// Interpreta relatórios enviados pelo mouse sem consulta prévia ou em resposta à bateria.
function parseMouseReport(bytes) {
  if (bytes.length < 10 || bytes[0] !== 0xaa) return null;

  // Resposta a consulta oficial: AA 30 A5 ... [bateria, carregando].
  if (bytes[1] === MOUSE_COMMAND.battery && bytes[2] === 0xa5) {
    return bytes[8] <= 100 ? { type: 'battery', battery: bytes[8], charging: bytes[9] !== 0 } : null;
  }

  if (bytes[1] === MOUSE_EVENT.status) {
    // AA FA ... D0 [bateria, carregando]; versões curtas não trazem o indicador de carga.
    if (bytes[8] === 0xd0) {
      if (bytes[9] > 100) return null;
      return { type: 'battery', battery: bytes[9], charging: bytes.length > 10 ? bytes[10] !== 0 : null };
    }
    // Demais AA FA: o botão de DPI ou de taxa foi usado no próprio mouse.
    const dpiIndex = bytes[9] - 1;
    const reportRate = bytes.length > 10 ? bytes[10] - 1 : null;
    if (dpiIndex < 0 || dpiIndex >= DPI_LEVELS) return null;
    return { type: 'status', dpiIndex, reportRate: reportRate >= 0 && reportRate < REPORT_RATES.length ? reportRate : null };
  }

  // Receptor 2.4G: o mouse ligou (2) ou desligou/saiu de alcance.
  if (bytes[1] === MOUSE_EVENT.online) return { type: 'online', online: bytes[8] === 2 };

  return null;
}
