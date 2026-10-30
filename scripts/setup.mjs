// npm run setup: makes .env.local (a random AUTH_SECRET, data in ./data) and the data folder. Safe to run again: never overwrites.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const env = '.env.local';
if (fs.existsSync(env)) console.log(`${env} already exists, left as it is.`);
else {
  const text = fs.readFileSync('.env.example', 'utf8').replace('change-me-to-a-long-random-string', crypto.randomBytes(32).toString('hex'));
  fs.writeFileSync(env, text, { mode: 0o600 });
  console.log(`Made ${env}.`);
}
fs.mkdirSync('data/dashboard', { recursive: true });
fs.mkdirSync('data/config', { recursive: true });
// optional: WhatsApp works only with the bridge built, and building it needs Go
if (spawnSync('go', ['version']).error) console.warn('Go is not installed, so the WhatsApp bridge was not built (only WhatsApp needs it). See README, WhatsApp.');
else spawnSync('bash', ['scripts/build-wa-bridge.sh'], { stdio: 'inherit' });
console.log('Ready. Start it with: npm run dev   then open http://localhost:3000');
