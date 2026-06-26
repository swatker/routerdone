import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const composeFile = 'docker-compose.dokploy.yml';
const expectedService = 'routerdone';
const text = readFileSync(composeFile, 'utf8');

function fail(message) {
  console.error(`Dokploy compose verify failed: ${message}`);
  process.exit(1);
}

if (text.includes('\\n')) {
  fail(`${composeFile} contains literal \\n sequences; write real newlines instead.`);
}

if (!/^services:\s*$/m.test(text)) {
  fail(`${composeFile} must declare a top-level services: mapping.`);
}

if (!new RegExp(`^  ${expectedService}:\\s*$`, 'm').test(text)) {
  fail(`Dokploy domain is attached to service ${expectedService}; compose must declare services.${expectedService}.`);
}

if (/^  app:\s*$/m.test(text)) {
  fail('Do not name the Dokploy service app; Dokploy is configured for service routerdone.');
}

const env = {
  ...process.env,
  JWT_SECRET: process.env.JWT_SECRET || 'verify-jwt-secret',
  INITIAL_PASSWORD: process.env.INITIAL_PASSWORD || 'verify-password',
  BASE_URL: process.env.BASE_URL || 'https://routerdone.example.com',
  NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL || 'https://routerdone.example.com',
  API_KEY_SECRET: process.env.API_KEY_SECRET || 'verify-api-key-secret',
  MACHINE_ID_SALT: process.env.MACHINE_ID_SALT || 'verify-machine-id-salt'
};

const result = spawnSync('docker', ['compose', '-p', 'routerdone-routerdone-ed6gok', '-f', composeFile, 'config'], {
  env,
  encoding: 'utf8',
  shell: process.platform === 'win32'
});

if (result.status !== 0) {
  const detail = (result.stderr || result.stdout || '').trim();
  fail(`docker compose config failed${detail ? `: ${detail}` : '.'}`);
}

if (!/^  routerdone:\s*$/m.test(result.stdout)) {
  fail('docker compose config did not produce services.routerdone.');
}

console.log('Dokploy compose verify passed.');
