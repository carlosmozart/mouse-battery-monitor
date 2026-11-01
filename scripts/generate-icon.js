// Gera build/icon.ico (executável e instalador) a partir de formas vetoriais simples.
// Uso: npm run icon
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
const SUPERSAMPLING = 4;
const COLORS = {
  tileTop: [59, 130, 246],
  tileBottom: [29, 78, 216],
  white: [255, 255, 255],
  battery: [34, 197, 94]
};

// Distância até um retângulo arredondado centrado em (cx, cy); negativa dentro dele.
function roundedRect(x, y, cx, cy, halfWidth, halfHeight, radius) {
  const qx = Math.abs(x - cx) - (halfWidth - radius);
  const qy = Math.abs(y - cy) - (halfHeight - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

// Cor de um ponto em coordenadas 0..1; null fora do ícone.
function sample(x, y) {
  if (roundedRect(x, y, 0.5, 0.5, 0.46, 0.46, 0.2) > 0) return null;
  const t = y;
  const tile = COLORS.tileTop.map((top, i) => top + (COLORS.tileBottom[i] - top) * t);
  let color = tile;

  // Mouse: corpo arredondado, divisão dos botões e roda.
  if (roundedRect(x, y, 0.42, 0.48, 0.18, 0.29, 0.18) <= 0) color = COLORS.white;
  if (Math.abs(x - 0.42) <= 0.012 && y >= 0.19 && y <= 0.4) color = tile;
  if (Math.abs(y - 0.4) <= 0.012 && Math.abs(x - 0.42) <= 0.17) color = tile;
  if (roundedRect(x, y, 0.42, 0.3, 0.03, 0.06, 0.03) <= 0) color = tile;

  // Selo de bateria no canto, separado do mouse por uma borda da cor do fundo.
  if (roundedRect(x, y, 0.71, 0.74, 0.19, 0.12, 0.05) <= 0) color = tile;
  if (roundedRect(x, y, 0.69, 0.74, 0.15, 0.09, 0.03) <= 0) color = COLORS.white;
  if (roundedRect(x, y, 0.86, 0.74, 0.02, 0.04, 0.01) <= 0) color = COLORS.white;
  if (roundedRect(x, y, 0.69, 0.74, 0.12, 0.06, 0.015) <= 0) color = tile;
  if (roundedRect(x, y, 0.64, 0.74, 0.07, 0.06, 0.015) <= 0) color = COLORS.battery;
  return color;
}

function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SUPERSAMPLING);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < SUPERSAMPLING; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLING; sx += 1) {
          const color = sample((px * SUPERSAMPLING + sx + 0.5) * step, (py * SUPERSAMPLING + sy + 0.5) * step);
          if (!color) continue;
          sum[0] += color[0]; sum[1] += color[1]; sum[2] += color[2]; sum[3] += 1;
        }
      }
      const offset = (py * size + px) * 4;
      if (!sum[3]) continue;
      pixels[offset] = Math.round(sum[0] / sum[3]);
      pixels[offset + 1] = Math.round(sum[1] / sum[3]);
      pixels[offset + 2] = Math.round(sum[2] / sum[3]);
      pixels[offset + 3] = Math.round((sum[3] / SUPERSAMPLING ** 2) * 255);
    }
  }
  return pixels;
}

function encodePng(size, pixels) {
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const output = Buffer.alloc(12 + data.length);
    output.writeUInt32BE(data.length, 0);
    body.copy(output, 4);
    output.writeUInt32BE(crc32(body), data.length + 8);
    return output;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ICO com uma imagem PNG por tamanho (formato aceito desde o Windows Vista).
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

function generateIcon() {
  return encodeIco(ICON_SIZES.map((size) => ({ size, png: encodePng(size, drawIcon(size)) })));
}

if (require.main === module) {
  const output = path.join(__dirname, '..', 'build', 'icon.ico');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, generateIcon());
  // Prévia em 256 px para conferir o desenho sem abrir o .ico.
  if (process.argv.includes('--preview')) fs.writeFileSync(path.join(path.dirname(output), 'icon-preview.png'), encodePng(256, drawIcon(256)));
  console.log(`Ícone gerado em ${path.relative(process.cwd(), output)}`);
}

module.exports = { ICON_SIZES, drawIcon, encodePng, generateIcon };
