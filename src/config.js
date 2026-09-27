'use strict';
// Reads settings from .env (if present) and environment variables, and picks a model provider.

const fs = require('fs');
const path = require('path');

// Read a settings file in whatever encoding Windows tools produced (UTF-8, UTF-8 with BOM,
// or UTF-16 from PowerShell's ">" redirect).
function readText(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.slice(2)); b.swap16(); return b.toString('utf16le'); }
  if (buf.length > 3 && buf[1] === 0 && buf[3] === 0) return buf.toString('utf16le');
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

function parseEnv(txt) {
  const out = {};
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/^\s*export\s+/, '').replace(/^\s*set\s+/i, '');
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^".*"$|^'.*'$|^“.*”$|^‘.*’$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v.trim();
  }
  return out;
}

function loadDotEnv(file) {
  let txt;
  try { txt = readText(file); } catch { return null; }
  const vars = parseEnv(txt);
  for (const [k, v] of Object.entries(vars)) if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
  return vars;
}

// Explain what happened with the settings file, so a missing key is easy to fix.
function diagnoseSettings(rootDir, loadedFile, loadedVars) {
  const notes = [];
  let files = [];
  try { files = fs.readdirSync(rootDir).filter((f) => /env/i.test(f) && !/\.(js|md|bat)$/i.test(f)); } catch { /* ignore */ }
  if (loadedFile) {
    const keys = Object.keys(loadedVars).filter((k) => /KEY$/.test(k));
    notes.push(`Settings:  read ${loadedFile}${keys.length ? ` (found ${keys.map((k) => `${k}${loadedVars[k] ? '' : ' but it is EMPTY'}`).join(', ')})` : ' (no ..._API_KEY line found in it)'}`);
  } else {
    notes.push(`Settings:  no settings file found in ${rootDir}`);
    const other = files.filter((f) => f !== '.env.example');
    if (other.length) notes.push(`           ! Found ${other.join(', ')}. Rename it to exactly ".env" (no .txt at the end).`);
  }
  const haveKey = Object.entries(loadedVars || {}).some(([k, v]) => /KEY$/.test(k) && v);
  if (!haveKey) try {
    const ex = parseEnv(readText(path.join(rootDir, '.env.example')));
    if (Object.entries(ex).some(([k, v]) => /KEY$/.test(k) && v)) {
      notes.push('           ! Your key is in .env.example, which the app does not read. Save a copy of that file named ".env".');
    }
  } catch { /* ignore */ }
  return notes;
}

// Model names change often. These defaults were current in September 2026; override with MODEL=...
const PRESETS = {
  gemini: { kind: 'openai', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.5-flash', keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], rpm: 10 },
  openai: { kind: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', keys: ['OPENAI_API_KEY'] },
  anthropic: { kind: 'anthropic', label: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5-20251001', keys: ['ANTHROPIC_API_KEY'] },
  groq: { kind: 'openai', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: '', keys: ['GROQ_API_KEY'] },
  openrouter: { kind: 'openai', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4.1-flash', keys: ['OPENROUTER_API_KEY'], concurrent: 8 },
  ollama: { kind: 'openai', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: '', keys: [], noKey: true },
  custom: { kind: 'openai', label: 'OpenAI-compatible', baseUrl: '', model: '', keys: [] },
  simulated: { kind: 'simulated', label: 'Simulated model', keys: [] },
};

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function loadConfig(rootDir, argv = process.argv.slice(2)) {
  // Windows Notepad often saves ".env" as ".env.txt", so accept that too.
  let loadedFile = null;
  let loadedVars = {};
  for (const f of ['.env', '.env.txt', 'env.txt', '.env.txt.txt']) {
    const vars = loadDotEnv(path.join(rootDir, f));
    if (vars) { loadedFile = f; loadedVars = vars; break; }
  }
  const env = process.env;
  const args = new Set(argv);

  let providerName = (env.PROVIDER || '').toLowerCase().trim();
  if (args.has('--simulated')) providerName = 'simulated';
  if (!providerName || providerName === 'auto') {
    if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) providerName = 'gemini';
    else if (env.ANTHROPIC_API_KEY) providerName = 'anthropic';
    else if (env.OPENAI_API_KEY) providerName = 'openai';
    else if (env.GROQ_API_KEY) providerName = 'groq';
    else if (env.OPENROUTER_API_KEY) providerName = 'openrouter';
    else providerName = 'simulated';
  }
  const preset = PRESETS[providerName];
  if (!preset) throw new Error(`Unknown PROVIDER "${providerName}". Use one of: ${Object.keys(PRESETS).join(', ')}`);

  const apiKey = env.API_KEY || preset.keys.map((k) => env[k]).find(Boolean) || '';
  const model = env.MODEL || preset.model || '';
  const baseUrl = env.BASE_URL || preset.baseUrl || '';

  const problems = [];
  if (preset.kind !== 'simulated') {
    if (!apiKey && !preset.noKey) problems.push(`No API key for ${preset.label}. Set ${preset.keys[0] || 'API_KEY'} in .env.`);
    if (!model) problems.push(`Set MODEL=... in .env for ${preset.label}.`);
    if (!baseUrl) problems.push('Set BASE_URL=... in .env for a custom OpenAI-compatible server.');
  }

  return {
    rootDir,
    providerName,
    preset,
    apiKey,
    model,
    baseUrl,
    problems,
    settingsNotes: diagnoseSettings(rootDir, loadedFile, loadedVars),
    port: num(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    publicUrl: env.PUBLIC_URL || '',
    tunnel: args.has('--tunnel') || env.TUNNEL === '1',
    openStage: !args.has('--no-open') && env.OPEN_STAGE !== '0',
    maxRounds: num(env.MAX_ROUNDS, 4),
    maxToolCalls: num(env.MAX_TOOL_CALLS, 6),
    maxConcurrent: num(env.MAX_CONCURRENT, preset.concurrent || 3),
    rpm: num(env.MODEL_RPM, preset.rpm || 0),
    queueTimeoutMs: num(env.QUEUE_TIMEOUT_S, 20) * 1000,
    modelTimeoutMs: num(env.MODEL_TIMEOUT_S, 40) * 1000,
    fallback: (env.FALLBACK || 'simulated') !== 'none',
    maxMessagesPerPerson: num(env.MAX_MESSAGES_PER_PERSON, 25),
    stageKey: env.STAGE_KEY || '',
    // OpenRouter only: which upstream provider to prefer ("" = OpenRouter's default routing,
    // or "price", "throughput", "latency"), and whether to switch off model "thinking".
    orSort: (env.OPENROUTER_SORT || '').trim().toLowerCase(),
    reasoningOff: /^(off|false|0|no)$/i.test(env.REASONING || ''),
  };
}

module.exports = { loadConfig, PRESETS };
