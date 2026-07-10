#!/usr/bin/env node
// Smoke-тест: MCP-handshake (initialize + tools/list) против собранного dist/index.js
// по stdio. Работает с фиктивным ключом и не делает сетевых вызовов.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EXPECTED_TOOLS = [
  'compare_models',
  'find_models',
  'get_api_status',
  'get_model',
  'list_media_models',
];

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const child = spawn(process.execPath, [entry], {
  env: {
    ...process.env,
    ARTIFICIAL_ANALYSIS_API_KEY: process.env.ARTIFICIAL_ANALYSIS_API_KEY || 'smoke-dummy-key',
    MCP_TRANSPORT: 'stdio',
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const timeout = setTimeout(() => fail('timed out after 10s'), 10_000);

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  child.kill();
  process.exit(1);
}

function send(message) {
  child.stdin.write(JSON.stringify(message) + '\n');
}

let buffer = '';
const responses = [];
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) responses.push(JSON.parse(line));
    processResponses();
  }
});

child.on('exit', (code) => {
  if (!done) fail(`server exited early with code ${code}`);
});

let sentToolsList = false;
let done = false;

function processResponses() {
  const initResponse = responses.find((r) => r.id === 1);
  if (initResponse && !sentToolsList) {
    if (initResponse.result?.serverInfo?.name !== 'artificialanalysis-mcp') {
      fail(`unexpected serverInfo: ${JSON.stringify(initResponse.result?.serverInfo)}`);
    }
    sentToolsList = true;
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  }
  const toolsResponse = responses.find((r) => r.id === 2);
  if (toolsResponse && !done) {
    done = true;
    const names = (toolsResponse.result?.tools ?? []).map((t) => t.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) {
      fail(`expected tools ${EXPECTED_TOOLS.join(', ')}, got ${names.join(', ')}`);
    }
    clearTimeout(timeout);
    console.error('SMOKE OK: initialize + tools/list returned the 5 expected tools');
    child.kill();
    process.exit(0);
  }
}

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '0.0.0' },
  },
});
