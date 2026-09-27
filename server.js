#!/usr/bin/env node
'use strict';
// Cha-Break Bot Live: an audience-participation demo for
// "From Answering to Acting". Zero dependencies: Node.js 18+ only.
//
//   npm start            -> start (opens the stage view in your browser)
//   npm run tunnel       -> start + public https link via cloudflared (if venue Wi-Fi blocks phones)
//   npm run eval         -> run the evaluation suite in the terminal

if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error(`\n  Cha-Break Bot needs Node.js 18 or newer (you have ${process.version}).\n  Install the LTS version from https://nodejs.org and try again.\n`);
  process.exit(1);
}

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { loadConfig } = require('./src/config');
const { createProvider } = require('./src/providers');
const { World } = require('./src/world');
const { runTurn, askModel, Limiter, describeError } = require('./src/agent');
const { runEvals, TASKS } = require('./src/evals');
const { RULE, RULE_VERSIONS, ruleCheck, CLAIMS } = require('./src/menu');
const qrcode = require('./lib/qrcode');

const ROOT = __dirname;
const config = loadConfig(ROOT);
const provider = createProvider(config);
const limiter = new Limiter({ concurrent: config.maxConcurrent, rpm: config.rpm });
const world = new World();
const STAGE_KEY = config.stageKey || crypto.randomBytes(3).toString('hex');

// ---------------------------------------------------------------------------
// Live-session state (acts, polls, games)
// ---------------------------------------------------------------------------
const ACTS = ['lobby', 'tools', 'rule', 'claims', 'break', 'summary'];
const live = {
  act: 'lobby',
  rule: { version: 'A', open: false, showVotes: false, revealed: false, votes: new Map(), model: null, modelBusy: false },
  claims: { open: false, revealed: false, votes: new Map() },
  compare: { busy: false, noTools: null, withTools: null, question: 'How much does jhalmuri cost at our stall, and is it the stall’s bestseller?' },
  evals: { running: false, progress: null, summary: null, results: [] },
  settings: { showMessages: true, joinUrlOverride: '' },
  tunnelUrl: '',
};

// Pick the address phones should use. Virtual adapters (WSL, Hyper-V, VirtualBox, VMware,
// Docker, VPNs, Bluetooth) are common on Windows and must not end up in the QR code.
function scoreAddress(name, address) {
  const virtual = /vEthernet|WSL|Hyper-V|Default Switch|VirtualBox|VMware|vmnet|vboxnet|docker|^br-|veth|Bluetooth|Loopback|Npcap|TAP|Tailscale|ZeroTier|WireGuard|OpenVPN|^utun|^awdl|^llw|^bridge|^tun|^gif|^stf|^anpi|^ap\d/i;
  const physical = /^(Wi-?Fi|WLAN|Wireless|Ethernet|en\d|wlan|wlp|wl|eth)/i;
  let score = virtual.test(name) ? 3 : physical.test(name) ? 0 : 1;
  if (/^en0$/.test(name) || /^Wi-?Fi$/i.test(name)) score -= 0.5;
  if (/^(192\.168\.|10\.)/.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address)) score -= 0.25;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) score += 1; // carrier-grade NAT / VPN overlay
  return score;
}
function lanAddresses(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, address: a.address });
    }
  }
  return out.sort((a, b) => scoreAddress(a.name, a.address) - scoreAddress(b.name, b.address));
}

function joinUrl() {
  if (live.settings.joinUrlOverride) return live.settings.joinUrlOverride;
  if (live.tunnelUrl) return `${live.tunnelUrl}/`;
  if (config.publicUrl) return config.publicUrl.replace(/\/?$/, '/');
  const lan = lanAddresses()[0];
  return `http://${lan ? lan.address : 'localhost'}:${config.port}/`;
}

function modelInfo() {
  return {
    live: !!provider.live,
    label: provider.live ? `${provider.label} · ${provider.model}` : 'Simulated model (rule-based stand-in, no AI)',
    short: provider.live ? provider.model : 'Simulated',
    problems: config.problems,
  };
}

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------
const clients = new Set();

function sseSend(c, event, data) {
  try { c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* ignore */ }
}
function toStage(event, data) { for (const c of clients) if (c.role === 'stage') sseSend(c, event, data); }
function toPhones(event, data) { for (const c of clients) if (c.role === 'phone') sseSend(c, event, data); }
function toPhone(pid, event, data) { for (const c of clients) if (c.role === 'phone' && c.pid === pid) sseSend(c, event, data); }

setInterval(() => { for (const c of clients) { try { c.res.write(': ping\n\n'); } catch { /* ignore */ } } }, 15000).unref();

// Coalesce frequent stage updates.
const pending = new Set();
let flushTimer = null;
function schedule(what) {
  pending.add(what);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const items = [...pending];
    pending.clear();
    for (const w of items) {
      if (w === 'stats') toStage('stats', statsPayload());
      if (w === 'participants') toStage('participants', participantsPayload());
      if (w === 'order') {
        const o = orderPayload();
        toStage('order', o);
        for (const c of clients) if (c.role === 'phone') sseSend(c, 'order', { ...o, mine: myLines(c.pid) });
      }
      if (w === 'votes') toStage('votes', votesPayload());
      if (w === 'act') { toStage('act', actPayload(true)); toPhones('act', actPayload(false)); }
    }
  }, 120);
}
world.on('stats', () => schedule('stats'));
world.on('participants', () => schedule('participants'));
world.on('order', () => schedule('order'));
world.on('reset', () => { toStage('snapshot', snapshot()); toPhones('act', actPayload(false)); toPhones('order', { ...orderPayload(), mine: [] }); toPhones('reset', {}); });

function stageTurn(turn) {
  if (live.settings.showMessages) return turn;
  return { ...turn, text: '(message hidden)', reply: turn.reply ? '(reply hidden)' : '' };
}
function onTurn(turn) {
  toStage('turn', stageTurn(turn));
  toPhone(turn.pid, 'turn', turn);
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------
function statsPayload() {
  const s = world.stats;
  return { ...s, avgTurnMs: s.turnsDone ? Math.round(s.turnMsTotal / s.turnsDone) : 0, audit: world.audit(), flags: world.flags, queue: limiter.waiting };
}
function participantsPayload() {
  const all = [...world.participants.values()].filter((x) => !x.system);
  return { count: all.length, names: all.slice(-60).map((p) => p.name) };
}
function orderPayload() {
  return { lines: world.publicOrder() };
}
function myLines(pid) {
  return world.linesFor(pid).map(({ line, name, qty }) => ({ line, name, qty }));
}
function ruleVotes() {
  const counts = { Singara: 0, Fuchka: 0, Jhalmuri: 0, None: 0 };
  for (const v of live.rule.votes.values()) for (const k of v) if (counts[k] !== undefined) counts[k] += 1;
  return { voters: live.rule.votes.size, counts };
}
function claimVotes() {
  const out = {};
  for (const c of CLAIMS.items) out[c.id] = { supported: 0, unsupported: 0, opinion: 0 };
  for (const v of live.claims.votes.values()) for (const [cid, ans] of Object.entries(v)) if (out[cid] && out[cid][ans] !== undefined) out[cid][ans] += 1;
  return { voters: live.claims.votes.size, counts: out };
}
function votesPayload() {
  return { rule: ruleVotes(), claims: claimVotes() };
}
function actPayload(forStage) {
  const v = RULE_VERSIONS[live.rule.version];
  const base = {
    act: live.act,
    rule: {
      version: live.rule.version,
      label: v.label,
      text: RULE.text,
      items: v.items,
      note: v.note,
      open: live.rule.open,
      revealed: live.rule.revealed,
      answer: live.rule.revealed ? ruleCheck(live.rule.version) : null,
    },
    claims: {
      open: live.claims.open,
      revealed: live.claims.revealed,
      sentence: CLAIMS.sentence,
      record: live.claims.revealed ? CLAIMS.record : null,
      items: CLAIMS.items.map((c) => ({ id: c.id, text: c.text, ...(live.claims.revealed ? { truth: c.truth, why: c.why } : {}) })),
    },
    model: modelInfo(),
  };
  if (forStage) {
    base.rule.showVotes = live.rule.showVotes;
    base.rule.model = live.rule.model;
    base.rule.modelBusy = live.rule.modelBusy;
    base.rule.codeCheck = ruleCheck(live.rule.version);
    base.claims.truth = CLAIMS.items.map((c) => ({ id: c.id, truth: c.truth, why: c.why }));
    base.claims.recordFull = CLAIMS.record;
    base.compare = live.compare;
    base.evals = live.evals;
    base.settings = live.settings;
    base.flags = world.flags;
  }
  return base;
}
function snapshot() {
  return {
    joinUrl: joinUrl(),
    lan: lanAddresses(),
    model: modelInfo(),
    act: actPayload(true),
    order: orderPayload(),
    stats: statsPayload(),
    participants: participantsPayload(),
    votes: votesPayload(),
    turns: world.turns.slice(-40).map(stageTurn),
    tasks: TASKS.map((t) => ({ id: t.id, title: t.title, expected: t.expected })),
    limits: { maxRounds: config.maxRounds, maxToolCalls: config.maxToolCalls, maxConcurrent: config.maxConcurrent, rpm: config.rpm },
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function sendFile(res, file) {
  const ext = path.extname(file);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-store' : 'max-age=60' });
    res.end(buf);
  });
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (d) => { data += d; if (data.length > 16384) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function keyOk(k) {
  const a = Buffer.from(String(k || ''));
  const b = Buffer.from(STAGE_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function qrSvg(text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const m = 2; // quiet zone in modules (plus white card around it in the page)
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  const size = n + 2 * m;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path fill="#111" d="${d}"/></svg>`;
}
function terminalQr(text) {
  const q = qrcode(0, 'L');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && q.isDark(r, c);
  const B = '\x1b[40m', W = '\x1b[47m', fB = '\x1b[30m', fW = '\x1b[37m', X = '\x1b[0m';
  let out = '';
  for (let r = -1; r < n + 1; r += 2) {
    out += '  ';
    for (let c = -2; c < n + 2; c++) {
      const top = dark(r, c), bot = dark(r + 1, c);
      out += (top ? fB : fW) + (bot ? B : W) + '▀';
    }
    out += `${X}\n`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Presenter actions
// ---------------------------------------------------------------------------
function ruleQuestion(version) {
  const v = RULE_VERSIONS[version];
  const lines = v.items.map((it) => `- ${it.name}: ${it.price === null ? 'price not listed' : `৳${it.price}`}, rating ${it.rating}`);
  return `${RULE.text}\n\nItems:\n${lines.join('\n')}${v.note ? `\n\n${v.note}` : ''}\n\nWhich items qualify? Reply with JSON only: {"eligible": ["names"], "explanation": "one short sentence"}`;
}
function parseRuleAnswer(text) {
  let eligible = null, explanation = '';
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (Array.isArray(j.eligible)) eligible = j.eligible.map(String);
      explanation = String(j.explanation || '');
    } catch { /* fall through */ }
  }
  if (!eligible) eligible = ['Singara', 'Fuchka', 'Jhalmuri'].filter((n) => new RegExp(n, 'i').test(text || ''));
  const norm = (a) => [...new Set(a.map((x) => x.toLowerCase().trim()))].filter((x) => x && x !== 'none').sort().join(',');
  const truth = ruleCheck(live.rule.version).filter((r) => r.verdict === 'yes').map((r) => r.name);
  return { eligible, explanation, correct: norm(eligible) === norm(truth) };
}

let stageParticipant = null;
function presenter() {
  if (!stageParticipant || !world.participants.has(stageParticipant.pid)) stageParticipant = world.addParticipant('Presenter', { system: true });
  return stageParticipant;
}

const stageActions = {
  async act(b) {
    if (ACTS.includes(b.act)) live.act = b.act;
    schedule('act');
  },
  async flags(b) {
    if (typeof b.saveFails === 'boolean') world.flags.saveFails = b.saveFails;
    if (typeof b.injection === 'boolean') world.flags.injection = b.injection;
    schedule('stats');
    schedule('act');
  },
  async rule(b) {
    const r = live.rule;
    if (b.version && RULE_VERSIONS[b.version] && b.version !== r.version) {
      r.version = b.version; r.votes = new Map(); r.revealed = false; r.showVotes = false; r.model = null; r.open = true;
    }
    if (typeof b.open === 'boolean') r.open = b.open;
    if (typeof b.showVotes === 'boolean') r.showVotes = b.showVotes;
    if (typeof b.revealed === 'boolean') r.revealed = b.revealed;
    if (b.askModel && !r.modelBusy) {
      r.modelBusy = true;
      schedule('act');
      const version = r.version;
      const started = Date.now();
      try {
        const out = await askModel({ provider, config, limiter, world }, {
          system: 'You check items against a rule. Reply with JSON only.',
          messages: [{ role: 'user', text: ruleQuestion(version) }],
          tools: [],
          meta: { purpose: 'rule_test', version },
        });
        if (live.rule.version === version) r.model = { text: out.text, ...parseRuleAnswer(out.text), label: out.modelLabel, simulated: out.simulated, fallbackReason: out.fallbackReason || '', ms: Date.now() - started };
      } catch (e) {
        r.model = { error: describeError(e) };
      }
      r.modelBusy = false;
    }
    schedule('act');
    schedule('votes');
  },
  async claims(b) {
    if (typeof b.open === 'boolean') live.claims.open = b.open;
    if (typeof b.revealed === 'boolean') live.claims.revealed = b.revealed;
    if (b.resetVotes) live.claims.votes = new Map();
    schedule('act');
    schedule('votes');
  },
  async compare(b) {
    const c = live.compare;
    if (c.busy) return;
    c.busy = true;
    schedule('act');
    const q = String(b.question || c.question).slice(0, 200);
    c.question = q;
    try {
      if (b.which !== 'tools') {
        const out = await askModel({ provider, config, limiter, world }, {
          system: 'You are a helpful assistant. Answer in one or two sentences.',
          messages: [{ role: 'user', text: q }],
          tools: [],
          meta: { purpose: 'no_tools' },
        });
        c.noTools = { text: out.text, label: out.modelLabel, recorded: !!out.recorded, fallbackReason: out.fallbackReason || '' };
      }
      if (b.which !== 'plain') {
        const p = presenter();
        const turn = await runTurn({ world, provider, config, limiter, onTurn }, p, q);
        c.withTools = { text: turn.reply, label: turn.modelLabels.join(' + '), steps: turn.steps.filter((s) => s.type === 'call').map((s) => ({ name: s.name, summary: s.summary, outcome: s.outcome })) };
      }
    } catch (e) {
      c.error = describeError(e);
    }
    c.busy = false;
    schedule('act');
  },
  async reset(b) {
    if (b.what === 'order') world.resetOrder();
    if (b.what === 'all') {
      world.resetAll();
      live.rule = { version: 'A', open: false, showVotes: false, revealed: false, votes: new Map(), model: null, modelBusy: false };
      live.claims = { open: false, revealed: false, votes: new Map() };
      live.compare = { busy: false, noTools: null, withTools: null, question: live.compare.question };
      live.evals = { running: false, progress: null, summary: null, results: [] };
    }
    schedule('act');
    schedule('votes');
  },
  async settings(b) {
    if (typeof b.showMessages === 'boolean') live.settings.showMessages = b.showMessages;
    if (typeof b.joinUrlOverride === 'string') live.settings.joinUrlOverride = b.joinUrlOverride.trim().slice(0, 300);
    toStage('snapshot', snapshot());
  },
  async evals(b) {
    const ev = live.evals;
    if (ev.running) return;
    ev.running = true;
    ev.results = [];
    ev.summary = null;
    schedule('act');
    try {
      const summary = await runEvals({
        provider,
        config,
        limiter,
        trials: Math.min(3, Math.max(1, Number(b.trials) || 1)),
        onProgress: (e) => {
          ev.progress = { done: e.done, total: e.total, running: e.running || null };
          if (e.result) ev.results.push(e.result);
          toStage('evals', ev);
        },
      });
      ev.summary = { passed: summary.passed, total: summary.total, at: summary.at, model: summary.model };
    } catch (e) {
      ev.summary = { error: describeError(e) };
    }
    ev.running = false;
    ev.progress = null;
    toStage('evals', ev);
  },
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // Pages
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return sendFile(res, path.join(ROOT, 'public', 'phone.html'));
    if (req.method === 'GET' && p === '/stage') return sendFile(res, path.join(ROOT, 'public', 'stage.html'));
    if (req.method === 'GET' && p.startsWith('/static/')) {
      const f = path.normalize(path.join(ROOT, 'public', p.slice('/static/'.length)));
      if (!f.startsWith(path.join(ROOT, 'public') + path.sep)) { res.writeHead(403); return res.end(); }
      return sendFile(res, f);
    }
    if (req.method === 'GET' && p === '/qr.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      return res.end(qrSvg(joinUrl()));
    }
    if (req.method === 'GET' && p === '/favicon.ico') return sendFile(res, path.join(ROOT, 'public', 'favicon.svg'));

    // Live updates
    if (req.method === 'GET' && p === '/events') {
      const role = url.searchParams.get('role') === 'stage' ? 'stage' : 'phone';
      if (role === 'stage' && !keyOk(url.searchParams.get('key'))) { res.writeHead(401); return res.end(); }
      // no-transform + an initial 2 KB comment stop proxies/tunnels (e.g. Cloudflare) from
      // compressing or buffering the stream. Phones also poll /api/pulse as a fallback.
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`: ${' '.repeat(2048)}\n\nretry: 2000\n\n`);
      const c = { res, role, pid: url.searchParams.get('pid') || '' };
      clients.add(c);
      req.on('close', () => clients.delete(c));
      if (role === 'stage') sseSend(c, 'snapshot', snapshot());
      else {
        sseSend(c, 'act', actPayload(false));
        sseSend(c, 'order', { ...orderPayload(), mine: myLines(c.pid) });
      }
      return;
    }

    // Audience API
    // Lightweight polling fallback for phones whose live-update stream is blocked by the network.
    if (req.method === 'GET' && p === '/api/pulse') {
      const pid = url.searchParams.get('pid') || '';
      return sendJson(res, 200, { act: actPayload(false), order: { ...orderPayload(), mine: myLines(pid) } });
    }
    if (req.method === 'GET' && p === '/api/config') {
      return sendJson(res, 200, { model: modelInfo(), act: actPayload(false), limits: { maxMessages: config.maxMessagesPerPerson } });
    }
    if (req.method === 'POST' && p === '/api/join') {
      if (world.participants.size >= 800) return sendJson(res, 503, { error: 'The room is full.' });
      const b = await readBody(req);
      const part = world.addParticipant(b.name);
      return sendJson(res, 200, { pid: part.pid, name: part.name });
    }
    if (req.method === 'POST' && p === '/api/me') {
      const b = await readBody(req);
      const part = world.getParticipant(b.pid);
      if (!part) return sendJson(res, 404, { error: 'unknown participant' });
      return sendJson(res, 200, {
        name: part.name,
        chosen: part.chosen ? part.chosen.id : null,
        myLines: world.linesFor(part.pid).map(({ line, name, qty }) => ({ line, name, qty })),
        turns: world.turns.filter((t) => t.pid === part.pid).slice(-10),
      });
    }
    if (req.method === 'POST' && p === '/api/chat') {
      const b = await readBody(req);
      const part = world.getParticipant(b.pid);
      if (!part) return sendJson(res, 404, { error: 'Please join again (the demo was restarted).' });
      const text = String(b.text || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 280);
      if (!text) return sendJson(res, 400, { error: 'Type a message first.' });
      if (part.busy) return sendJson(res, 429, { error: 'One message at a time: the bot is still working on your last one.' });
      if (part.messages >= config.maxMessagesPerPerson) return sendJson(res, 429, { error: `You've used all ${config.maxMessagesPerPerson} messages for this demo. Thanks for playing!` });
      part.busy = true;
      part.messages += 1;
      try {
        const turn = await runTurn({ world, provider, config, limiter, onTurn }, part, text);
        return sendJson(res, 200, { turn });
      } finally {
        part.busy = false;
      }
    }
    if (req.method === 'POST' && p === '/api/choose') {
      const b = await readBody(req);
      const part = world.getParticipant(b.pid);
      if (!part) return sendJson(res, 404, { error: 'unknown participant' });
      const r = world.choose(part, String(b.itemId || ''));
      if (!r.ok) return sendJson(res, 400, { error: r.error });
      toStage('choice', { who: part.name, item: r.item.name, at: Date.now() });
      return sendJson(res, 200, { chosen: r.item.id, name: r.item.name });
    }
    if (req.method === 'POST' && p === '/api/vote') {
      const b = await readBody(req);
      const part = world.getParticipant(b.pid);
      if (!part) return sendJson(res, 404, { error: 'unknown participant' });
      if (b.game === 'rule') {
        if (!live.rule.open || live.rule.revealed) return sendJson(res, 409, { error: 'Voting is closed.' });
        const allowed = ['Singara', 'Fuchka', 'Jhalmuri', 'None'];
        let ans = Array.isArray(b.answer) ? b.answer.filter((a) => allowed.includes(a)) : [];
        if (ans.includes('None')) ans = ['None'];
        live.rule.votes.set(part.pid, ans.length ? ans : ['None']);
      } else if (b.game === 'claims') {
        if (!live.claims.open || live.claims.revealed) return sendJson(res, 409, { error: 'Voting is closed.' });
        const ans = {};
        for (const c of CLAIMS.items) if (['supported', 'unsupported', 'opinion'].includes(b.answer && b.answer[c.id])) ans[c.id] = b.answer[c.id];
        live.claims.votes.set(part.pid, ans);
      } else return sendJson(res, 400, { error: 'unknown game' });
      schedule('votes');
      return sendJson(res, 200, { ok: true });
    }

    // Presenter API
    if (req.method === 'GET' && p === '/api/stage/state') {
      if (!keyOk(url.searchParams.get('key'))) return sendJson(res, 401, { error: 'Wrong or missing presenter key' });
      return sendJson(res, 200, snapshot());
    }
    const sm = p.match(/^\/api\/stage\/([a-z]+)$/);
    if (req.method === 'POST' && sm) {
      const b = await readBody(req);
      if (!keyOk(b.key)) return sendJson(res, 401, { error: 'Wrong or missing presenter key' });
      const fn = stageActions[sm[1]];
      if (!fn) return sendJson(res, 404, { error: 'unknown action' });
      fn(b).catch((e) => console.error('stage action failed:', e));
      return sendJson(res, 200, { ok: true });
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
function banner() {
  const stageUrl = `http://localhost:${config.port}/stage?key=${STAGE_KEY}`;
  const m = modelInfo();
  const lines = [
    '',
    `  ${process.platform === 'win32' ? '' : '☕  '}Cha-Break Bot Live is running`,
    '',
    ...config.settingsNotes.map((x) => `  ${x}`),
    `  Model:     ${m.label}`,
    ...(config.problems.length ? config.problems.map((x) => `             ! ${x}`) : []),
    ...(!m.live && !config.problems.length ? ['             Add OPENROUTER_API_KEY (or another key) to .env for a live model. See README section 2.'] : []),
    `  Audience:  ${joinUrl()}`,
    `  Stage:     ${stageUrl}   <- open this on the projector`,
    '',
  ];
  console.log(lines.join('\n'));
  console.log(terminalQr(joinUrl()));
  if (!live.tunnelUrl && !config.publicUrl) {
    console.log('  If phones cannot open the audience link (guest Wi-Fi often blocks this),');
    console.log(process.platform === 'win32'
      ? '  close this window and double-click "Start demo with public link.bat"\n  (also check that Windows Firewall allows Node.js on Public networks).\n'
      : '  stop with Ctrl+C and run:  npm run tunnel\n');
  }
  return stageUrl;
}

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    else if (process.env.DISPLAY) spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch { /* ignore */ }
}

function startTunnel() {
  console.log('  Starting a public tunnel with cloudflared ...');
  let child;
  try {
    child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${config.port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    child = null;
  }
  if (!child) return;
  child.on('error', () => {
    console.log(process.platform === 'win32'
      ? '\n  ! cloudflared is not installed. In PowerShell run:  winget install --id Cloudflare.cloudflared\n    then close this window and start again.'
      : '\n  ! cloudflared is not installed. On a Mac: brew install cloudflared');
    console.log('    (or use your phone hotspot, or set PUBLIC_URL in .env to another tunnel URL)\n');
  });
  const onData = (d) => {
    const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !live.tunnelUrl) {
      live.tunnelUrl = m[0];
      console.log(`\n  Public link ready: ${live.tunnelUrl}/   (the stage QR code has switched to it)\n`);
      console.log(terminalQr(joinUrl()));
      toStage('snapshot', snapshot());
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  process.on('exit', () => { try { child.kill(); } catch { /* ignore */ } });
  process.on('SIGINT', () => process.exit(0));
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\n  Port ${config.port} is busy. Stop the other copy, or set PORT=3001 in .env\n`);
  else console.error(e);
  process.exit(1);
});

// OpenRouter: check the key and remaining credit at startup, so problems show before the talk.
async function checkOpenRouterKey() {
  if (config.providerName !== 'openrouter' || !provider.live) return;
  const base = config.baseUrl.replace(/\/+$/, '');
  for (const path_ of ['/key', '/auth/key']) {
    try {
      const r = await fetch(`${base}${path_}`, { headers: { authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(8000) });
      if (r.status === 401 || r.status === 403) { console.log('  ! OpenRouter rejected this API key. Check OPENROUTER_API_KEY in .env.\n'); return; }
      if (!r.ok) continue;
      const d = (await r.json()).data || {};
      const left = typeof d.limit_remaining === 'number' ? ` · credit left on this key: $${d.limit_remaining.toFixed(2)}` : '';
      const used = typeof d.usage === 'number' ? ` · used so far: $${d.usage.toFixed(2)}` : '';
      console.log(`  OpenRouter key OK${left}${used}\n`);
      return;
    } catch { /* offline or endpoint changed: skip quietly */ }
  }
}

server.listen(config.port, config.host, () => {
  const stageUrl = banner();
  checkOpenRouterKey();
  if (config.tunnel) startTunnel();
  if (config.openStage) openBrowser(stageUrl);
});
