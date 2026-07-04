const fs = require('fs');
const path = require('path');

const extensionRoot = path.resolve(__dirname, '..');
const envPath = path.join(extensionRoot, '.env');
const publicConfigPath = path.join(extensionRoot, 'public', 'config.js');
const backgroundConfigPath = path.join(extensionRoot, 'src', 'background', 'config.js');

function parseEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};

  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .reduce((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return acc;
      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) return acc;
      const key = trimmed.slice(0, separatorIndex).trim();
      const rawValue = trimmed.slice(separatorIndex + 1).trim();
      let value = rawValue;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      acc[key] = value;
      return acc;
    }, {});
}

const env = parseEnv(envPath);
const apiBase = env.EXTENSION_API_BASE || 'http://localhost:3001/api';
const configPayload = {
  API_BASE: apiBase,
};

const publicConfigContent = `window.__EXTENSION_CONFIG__ = ${JSON.stringify(configPayload, null, 2)};\n`;
const backgroundConfigContent = `export const EXTENSION_CONFIG = ${JSON.stringify(configPayload, null, 2)};\n`;

fs.writeFileSync(publicConfigPath, publicConfigContent, 'utf8');
fs.writeFileSync(backgroundConfigPath, backgroundConfigContent, 'utf8');
console.log(`Extension config written to ${path.relative(extensionRoot, publicConfigPath)} and ${path.relative(extensionRoot, backgroundConfigPath)}`);
