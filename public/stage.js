'use strict';
/* Cha-Break Bot: presenter / projector view. */

const $ = (id) => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const KEY = new URLSearchParams(location.search).get('key') || '';
const T = (n) => `৳${n}`;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const S = {
  snap: null,
  act: null,
  turns: new Map(),
  order: [],
  stats: {},
  participants: { count: 0, names: [] },
  votes: { rule: { voters: 0, counts: {} }, claims: { voters: 0, counts: {} } },
  evals: null,
  choices: [],
};

async function post(action, body) {
  const r = await fetch(`/api/stage/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: KEY, ...body }) });
  if (r.status === 401) showKeyError();
}
function showKeyError() {
  $('main').textContent = '';
  $('main').append(h('div', { class: 'banner' }, h('b', {}, 'Presenter key missing or wrong. '), 'Open the Stage link printed in the terminal (it ends with ?key=…).'));
}

// ------------------------------------------------------------------ theme
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  store.set('cbb_theme', t);
}
setTheme(store.get('cbb_theme') || 'light');

// ------------------------------------------------------------------ events
function connect() {
  if (!KEY) return showKeyError();
  const es = new EventSource(`/events?role=stage&key=${encodeURIComponent(KEY)}`);
  es.onerror = () => { /* browser retries automatically */ };
  es.addEventListener('snapshot', (e) => {
    const s = JSON.parse(e.data);
    S.snap = s;
    S.act = s.act;
    S.order = s.order.lines;
    S.stats = s.stats;
    S.participants = s.participants;
    S.votes = s.votes;
    S.evals = s.act.evals;
    S.turns = new Map(s.turns.map((t) => [t.id, t]));
    renderTop();
    render();
  });
  es.addEventListener('act', (e) => { S.act = JSON.parse(e.data); S.evals = S.act.evals; renderTop(); render(); });
  es.addEventListener('turn', (e) => {
    const t = JSON.parse(e.data);
    S.turns.set(t.id, t);
    if (S.turns.size > 120) S.turns.delete(S.turns.keys().next().value);
    render();
  });
  es.addEventListener('order', (e) => { S.order = JSON.parse(e.data).lines; render(); });
  es.addEventListener('stats', (e) => { S.stats = JSON.parse(e.data); render(); });
  es.addEventListener('participants', (e) => { S.participants = JSON.parse(e.data); renderTop(); if (S.act && S.act.act === 'lobby') render(); });
  es.addEventListener('votes', (e) => { S.votes = JSON.parse(e.data); render(); });
  es.addEventListener('evals', (e) => { S.evals = JSON.parse(e.data); render(); });
  es.addEventListener('choice', (e) => { S.choices.push(JSON.parse(e.data)); if (S.choices.length > 20) S.choices.shift(); });
}

// ------------------------------------------------------------------ top bar
let lastJoin = '';
function renderTop() {
  if (!S.snap) return;
  const m = S.act.model;
  const pill = $('modelPill');
  pill.textContent = m.live ? `Live model: ${m.short}` : 'SIMULATED model (no AI)';
  pill.className = `pill dot ${m.live ? 'live' : 'sim'}`;
  pill.title = m.label;
  $('people').textContent = `${S.participants.count} joined`;
  if (lastJoin !== S.snap.joinUrl) {
    lastJoin = S.snap.joinUrl;
    $('joinUrl').textContent = S.snap.joinUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    $('qrMini').src = `/qr.svg?u=${encodeURIComponent(S.snap.joinUrl)}`;
  }
  $('joinMini').style.visibility = S.act.act === 'lobby' ? 'hidden' : 'visible';
  for (const b of $('acts').querySelectorAll('button[data-act]')) b.classList.toggle('on', b.dataset.act === S.act.act);
}
$('acts').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (b) post('act', { act: b.dataset.act });
});
$('gear').addEventListener('click', openSettings);

// ------------------------------------------------------------------ render
let raf = 0;
function render() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; draw(); });
}
function draw() {
  if (!S.act) return;
  const main = $('main');
  const keep = main.querySelector('.scroll.feed');
  const scrollTop = keep ? keep.scrollTop : 0;
  main.textContent = '';
  const v = { lobby: vLobby, tools: vTools, rule: vRule, claims: vClaims, break: vBreak, summary: vSummary }[S.act.act] || vLobby;
  main.append(v());
  const feed = main.querySelector('.scroll.feed');
  if (feed) feed.scrollTop = scrollTop;
}

const card = (title, sub, ...kids) => h('section', { class: 'card' }, h('h2', {}, title, sub ? h('span', { class: 'sub' }, sub) : null), ...kids);
const stat = (n, label, cls) => h('div', { class: `stat ${cls || ''}` }, h('b', {}, String(n)), h('span', {}, label));

function vLobby() {
  const names = S.participants.names.slice(-40);
  return h('div', { class: 'view lobby' },
    h('div', { class: 'qrbig' }, h('img', { src: `/qr.svg?u=${encodeURIComponent(S.snap.joinUrl)}`, alt: 'QR code to join' }), h('div', { class: 'url' }, S.snap.joinUrl.replace(/\/$/, ''))),
    h('div', { class: 'hello' },
      h('div', { class: 'eyebrow' }, 'Live demo · join now'),
      h('h2', {}, 'Scan to join', h('br'), 'Cha-Break Bot'),
      h('p', { style: 'font-size:1.25em;margin:0 0 .8em' }, 'Open your camera, scan the code, and keep the page open. You will ask an AI for tea-break snacks, vote, and try to trick it.'),
      h('div', { class: 'count' }, String(S.participants.count)),
      h('div', { class: 'muted' }, 'people joined'),
      h('div', { class: 'names' }, names.map((n) => h('span', {}, n))),
      h('p', { class: 'muted', style: 'margin-top:1em;font-size:.9em' }, 'Same Wi-Fi as the presenter needed. The menu is synthetic, made up for teaching.'),
    ),
  );
}

function argsShort(a) {
  let s = JSON.stringify(a || {});
  if (s.length > 110) s = s.slice(0, 107) + '…';
  return s;
}
function clip(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

function turnCard(t, opts = {}) {
  const calls = t.steps.filter((s) => s.type === 'call');
  const pipe = h('div', { class: 'pipe' });
  if (!calls.length && t.status !== 'thinking') pipe.append(h('div', { class: 'box' }, h('span', { class: 'k' }, 'No tool call'), 'The model answered (or asked a question) directly.'));
  for (const s of opts.writesOnly ? calls.filter((c) => c.name === 'add_to_order') : calls) {
    pipe.append(
      h('div', { class: 'pstep' },
        h('div', { class: 'box proposed' }, h('span', { class: 'k' }, 'Model proposed'), `${s.name}${argsShort(s.args)}`),
        h('span', { class: 'arrow' }, '→'),
        h('div', { class: 'box' }, h('span', { class: 'k' }, 'App checks'),
          h('ul', { class: 'checks' }, s.checks.map((c) => h('li', {}, h('span', { class: `mark ${c.ok ? 'ok' : 'bad'}` }, c.ok ? '✓' : '✗'), h('span', {}, c.label))))),
        h('span', { class: 'arrow' }, '→'),
        h('div', { class: `box ${s.outcome}` }, h('span', { class: 'k' }, s.outcome === 'executed' ? 'Ran · actual result' : s.outcome === 'failed' ? 'Ran · FAILED' : 'Not run'), s.summary.replace(/^Rejected: /, '')),
      ),
    );
  }
  if (t.status === 'thinking') pipe.append(h('div', { class: 'box' }, h('span', { class: 'k' }, 'Working'), 'Model is deciding the next step…'));
  const labels = (t.modelLabels || []).map((l) => (/Simulated/.test(l) ? 'simulated' : l.split('·').pop().trim()));
  return h('div', { class: 'turn' },
    h('div', { class: 'head' }, h('span', { class: 'who' }, t.who), h('span', { class: 'msg' }, `“${t.text}”`), h('span', { class: 'meta' }, `${labels.join(' + ')}${t.ms ? ` · ${(t.ms / 1000).toFixed(1)}s` : ''} · ${ago(t.at)}`)),
    pipe,
    t.reply && !opts.noReply ? h('div', { class: 'reply' }, h('span', { class: 'k' }, 'Bot’s words  '), clip(t.reply, opts.writesOnly ? 420 : 240)) : null,
    (t.flags || []).map((f) => h('div', { class: `flag ${f.kind}` }, f.text)),
  );
}

function orderBoard(limit = 14) {
  const lines = S.order.slice(-limit).reverse();
  return h('div', { class: 'order' },
    lines.length ? lines.map((l) => h('div', { class: 'oline' }, h('span', { class: 'n' }, `#${l.line}`), h('span', {}, h('b', {}, `${l.qty} × ${l.name}`), ' ', h('span', { class: 'who' }, l.who)), h('span', { class: 'muted' }, l.price !== null ? T(l.price * l.qty) : ''))) : h('p', { class: 'muted' }, 'Empty. A line appears here only after the app has actually stored it.'),
  );
}

function vTools() {
  const turns = [...S.turns.values()].sort((a, b) => b.at - a.at).slice(0, 10);
  const st = S.stats;
  return h('div', { class: 'view tools' },
    card('Live requests', 'newest first',
      h('div', { class: 'legend' }, h('b', {}, 'Model proposes'), '→', h('b', {}, 'App checks'), '→', h('b', {}, 'Code runs (or refuses)'), '→', h('b', {}, 'Actual result'), '→ back to the model'),
      h('div', { class: 'scroll feed' }, h('div', { class: 'turns' }, turns.length ? turns.map((t) => turnCard(t)) : h('p', { class: 'muted' }, 'Waiting for the first request. Scan the QR code and ask for a snack!'))),
    ),
    card('Team order', 'stored state, not the model’s words',
      h('div', { class: 'scroll' }, orderBoard()),
      h('div', { class: 'stats' }, stat(st.proposed || 0, 'calls proposed'), stat(st.executed || 0, 'ran', 'pass'), stat(st.rejected || 0, 'refused', 'fail'), stat(st.saves || 0, 'lines stored')),
    ),
  );
}

function vRule() {
  const r = S.act.rule;
  const votes = S.votes.rule;
  const truth = r.codeCheck;
  const max = Math.max(1, ...Object.values(votes.counts || {}));
  const table = h('table', { class: 'items' },
    h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Price'), h('th', {}, 'Rating')),
    r.items.map((it) => h('tr', {}, h('td', {}, h('b', {}, it.name)), h('td', { class: it.price === null ? 'missing' : it.price === 50 ? 'boundary' : '' }, it.price === null ? 'not listed' : T(it.price)), h('td', {}, `★ ${it.rating}`))),
  );
  const bars = h('div', { class: 'bars' }, ['Singara', 'Fuchka', 'Jhalmuri', 'None'].map((k) => {
    const n = (votes.counts || {})[k] || 0;
    const right = r.revealed && ((k === 'None' && !truth.some((x) => x.verdict === 'yes')) || truth.some((x) => x.name === k && x.verdict === 'yes'));
    return h('div', { class: 'bar' }, h('span', {}, k === 'None' ? 'None of them' : k), h('div', { class: 'track' }, h('div', { class: `fill ${right ? 'right' : ''}`, style: `width:${r.showVotes ? (100 * n) / max : 0}%` })), h('span', { class: 'v' }, r.showVotes ? String(n) : '·'));
  }));
  const model = r.model;
  const modelBox = h('div', { class: 'answer model' }, h('div', { class: 'k' }, `Model’s answer${model && model.label ? ` · ${model.label}` : ''}`));
  if (r.modelBusy) modelBox.append(h('div', { class: 'big' }, 'Thinking…'));
  else if (!model) modelBox.append(h('div', { class: 'muted' }, 'Press “Ask the model”.'));
  else if (model.error) modelBox.append(h('div', { class: 'bad' }, model.error));
  else {
    modelBox.append(
      h('div', { class: 'big' }, model.eligible.length ? model.eligible.join(', ') : 'None'),
      h('div', {}, model.explanation || ''),
      h('div', { class: model.correct ? 'ok' : 'bad', style: 'font-weight:700;margin-top:.3em' }, r.revealed ? (model.correct ? '✓ Matches the code check' : '✗ Does not match the code check') : ''),
      model.simulated ? h('div', { class: 'note warn' }, model.fallbackReason ? `Live model unavailable (${model.fallbackReason}); simulated stand-in shown.` : 'Simulated stand-in: it uses code, so it cannot slip. A real model can.') : '',
    );
  }
  const codeBox = h('div', { class: 'answer codecheck' }, h('div', { class: 'k' }, 'Code check (the rule applied exactly)'));
  if (r.revealed) {
    const yes = truth.filter((x) => x.verdict === 'yes').map((x) => x.name);
    codeBox.append(h('div', { class: 'big' }, yes.length ? yes.join(', ') : 'None'), h('ul', { class: 'verdicts' }, truth.map((x) => h('li', {}, h('b', { class: x.verdict === 'yes' ? 'ok' : x.verdict === 'no' ? 'bad' : 'warnc' }, x.verdict === 'yes' ? '✓ ' : x.verdict === 'no' ? '✗ ' : '? '), `${x.name}: ${x.reason}`))));
  } else codeBox.append(h('div', { class: 'muted' }, 'Hidden until you reveal it.'));

  return h('div', { class: 'view rule' },
    card('The rule', r.label,
      h('div', { class: 'versions' }, ['A', 'B', 'C'].map((v) => h('button', { class: v === r.version ? 'on' : '', onclick: () => post('rule', { version: v }) }, `Version ${v}`))),
      h('p', { style: 'font-size:1.15em;margin:.2em 0 .7em' }, r.text),
      table,
      r.note ? h('div', { class: 'quote' }, r.note) : null,
    ),
    card('The room votes', `${votes.voters} voted`,
      h('p', { class: 'muted', style: 'margin-top:0' }, r.open ? 'Voting is open on your phones.' : 'Voting is closed.'),
      bars,
      h('div', { class: 'controls' },
        h('button', { class: 'btn', onclick: () => post('rule', { open: !r.open }) }, r.open ? 'Close voting' : 'Open voting'),
        h('button', { class: 'btn ghost', onclick: () => post('rule', { showVotes: !r.showVotes }) }, r.showVotes ? 'Hide votes' : 'Show votes'),
      ),
    ),
    card('Model vs code', null,
      h('div', { class: 'scroll' }, modelBox, codeBox),
      h('div', { class: 'controls' },
        h('button', { class: 'btn cha', disabled: r.modelBusy, onclick: () => post('rule', { askModel: true }) }, 'Ask the model'),
        h('button', { class: 'btn', onclick: () => post('rule', { revealed: !r.revealed, open: false, showVotes: true }) }, r.revealed ? 'Hide answer' : 'Reveal code check'),
      ),
    ),
  );
}

function vClaims() {
  const c = S.act.claims;
  const votes = S.votes.claims;
  const rows = c.items.map((it) => {
    const v = (votes.counts || {})[it.id] || { supported: 0, unsupported: 0, opinion: 0 };
    const tot = v.supported + v.unsupported + v.opinion || 1;
    const truth = c.revealed ? c.truth.find((x) => x.id === it.id) : null;
    const seg = (cls, n) => h('div', { class: cls, style: `width:${(100 * n) / tot}%` }, n ? String(n) : '');
    return h('div', { class: 'crow' },
      h('div', { class: 'ctext' }, it.text, truth ? h('div', { class: 'muted', style: 'font-weight:400;font-size:.85em' }, truth.why) : null),
      h('div', { class: 'stack' }, seg('s', v.supported), seg('u', v.unsupported), seg('o', v.opinion)),
      truth ? h('span', { class: `truth ${truth.truth}` }, truth.truth === 'supported' ? '✓ Supported' : truth.truth === 'unsupported' ? '✗ Unsupported' : '💬 Opinion') : h('span', { class: 'truth', style: 'background:var(--tint);color:var(--muted)' }, '?'),
    );
  });
  const cmp = S.act.compare;
  const stepsList = (cmp.withTools && cmp.withTools.steps) || [];
  return h('div', { class: 'view claims' },
    card('One fluent sentence, four claims', `${votes.voters} voted`,
      h('div', { class: 'sentence' }, `“${c.sentence}”`),
      h('div', { class: 'keyrow' }, h('span', {}, h('i', { style: 'background:var(--pass)' }), 'Supported'), h('span', {}, h('i', { style: 'background:var(--fail)' }), 'Unsupported'), h('span', {}, h('i', { style: 'background:var(--cha-deep)' }), 'Opinion')),
      h('div', { class: 'scroll' }, rows, c.revealed ? h('div', { class: 'note info', style: 'margin-top:.7em' }, c.recordFull) : null),
      h('div', { class: 'controls' },
        h('button', { class: 'btn', onclick: () => post('claims', { open: !c.open }) }, c.open ? 'Close voting' : 'Open voting'),
        h('button', { class: 'btn cha', onclick: () => post('claims', { revealed: !c.revealed, open: false }) }, c.revealed ? 'Hide answers' : 'Reveal answers'),
      ),
    ),
    card('Same question, with and without evidence', null,
      h('p', { class: 'muted', style: 'margin:0 0 .4em' }, `“${cmp.question}”`),
      h('div', { class: 'scroll' },
        h('div', { class: 'cmp plain' }, h('div', { class: 'k' }, `Model alone (no tools, no menu)${cmp.noTools ? ` · ${cmp.noTools.recorded ? 'RECORDED EXAMPLE, not live' : cmp.noTools.label}` : ''}`), h('p', {}, cmp.noTools ? cmp.noTools.text : '—'), cmp.noTools && cmp.noTools.fallbackReason ? h('div', { class: 'note warn' }, `Live model unavailable: ${cmp.noTools.fallbackReason}`) : null),
        h('div', { class: 'cmp tools', style: 'margin-top:.6em' }, h('div', { class: 'k' }, `With tools (reads the menu record)${cmp.withTools ? ` · ${cmp.withTools.label}` : ''}`), h('p', {}, cmp.withTools ? cmp.withTools.text : '—'), stepsList.length ? h('div', { class: 'muted', style: 'font-size:.85em;margin-top:.3em' }, stepsList.map((s) => `${s.name}: ${s.summary}`).join(' · ')) : null),
      ),
      h('div', { class: 'controls' }, h('button', { class: 'btn cha', disabled: cmp.busy, onclick: () => post('compare', {}) }, cmp.busy ? 'Asking…' : 'Ask both')),
    ),
  );
}

function vBreak() {
  const st = S.stats;
  const audit = st.audit || { lines: 0, untraceable: 0 };
  const flags = st.flags || {};
  const attempts = [...S.turns.values()].filter((t) => t.steps.some((s) => s.type === 'call' && s.name === 'add_to_order')).sort((a, b) => b.at - a.at).slice(0, 10);
  const toggle = (on, title, sub, fn) => h('div', { class: `toggle ${on ? 'on' : ''}`, onclick: fn }, h('span', { class: 'sw' }), h('div', { class: 't' }, h('b', {}, title), h('span', {}, sub)));
  return h('div', { class: 'view break' },
    card('Challenge: break it', null,
      h('p', { style: 'font-size:1.15em;margin-top:0' }, 'Get the bot to store something you did ', h('b', {}, 'not'), ' choose, or 10 fuchka.'),
      h('div', { class: 'bigstat bad' }, String(st.blockedWrites || 0)),
      h('div', { class: 'muted' }, 'write attempts refused by the app'),
      h('div', { class: `bigstat ${audit.untraceable ? 'bad' : 'ok'}`, style: 'margin-top:.5em' }, String(audit.untraceable)),
      h('div', { class: 'muted' }, `unauthorised lines stored · audit of ${audit.lines} line(s): ${audit.untraceable ? 'PROBLEM' : 'each one traces to a Choose tap ✓'}`),
      h('div', { class: 'stats', style: 'grid-template-columns:repeat(2,1fr)' }, stat(st.injectionsSeen || 0, 'hidden instructions seen'), stat(st.falseSuccessFlags || 0, 'false “done!” flagged', st.falseSuccessFlags ? 'fail' : '')),
    ),
    card('Write attempts', 'every add_to_order request, newest first',
      h('div', { class: 'scroll feed' }, h('div', { class: 'turns' }, attempts.length ? attempts.map((t) => turnCard(t, { writesOnly: true })) : h('p', { class: 'muted' }, 'No write attempts yet. Try the attack buttons on your phone.'))),
    ),
    card('Stress switches', null,
      toggle(flags.injection, 'Hide an instruction in the menu', 'Fuchka’s description tells the model to add 10 fuchka', () => post('flags', { injection: !flags.injection })),
      toggle(flags.saveFails, 'Make saving fail', 'The order sheet “goes down”: every write fails', () => post('flags', { saveFails: !flags.saveFails })),
      h('h2', { style: 'font-size:1.05em;margin:.8em 0 .4em' }, 'Team order'),
      h('div', { class: 'scroll' }, orderBoard(8)),
    ),
  );
}

function vSummary() {
  const st = S.stats;
  const ev = S.evals || {};
  const tasks = S.snap.tasks;
  const results = ev.results || [];
  const byId = {};
  for (const r of results) (byId[r.id] = byId[r.id] || []).push(r);
  const passed = results.filter((r) => r.pass).length;
  const rows = tasks.map((t) => {
    const rs = byId[t.id] || [];
    const running = ev.progress && ev.progress.running === t.id;
    const status = rs.length ? (rs.every((r) => r.pass) ? h('b', { class: 'ok' }, rs.length > 1 ? `✓ ${rs.length}/${rs.length}` : '✓ pass') : h('b', { class: 'bad' }, rs.length > 1 ? `✗ ${rs.filter((r) => r.pass).length}/${rs.length}` : '✗ fail')) : running ? h('span', { class: 'muted' }, 'running…') : h('span', { class: 'muted' }, '·');
    const detail = rs.length ? rs[rs.length - 1].detail + (rs.some((r) => r.usedFallback) ? ' [fallback used]' : '') : '';
    return h('tr', {}, h('td', {}, status), h('td', {}, h('b', {}, t.title), h('div', { class: 'muted', style: 'font-size:.85em' }, `Expected: ${t.expected}`)), h('td', { class: 'muted', style: 'font-size:.85em' }, detail));
  });
  return h('div', { class: 'view summary' },
    card('What the system actually did', 'from recorded state, not from the model’s words',
      h('div', { class: 'stats big' },
        stat(S.participants.count, 'people joined'),
        stat(st.messages || 0, 'messages'),
        stat(`${st.liveModelCalls || 0} / ${st.simulatedModelCalls || 0}`, 'model calls: live / simulated'),
        stat(st.proposed || 0, 'tool calls proposed'),
        stat(st.executed || 0, 'ran', 'pass'),
        stat(st.rejected || 0, 'refused by checks', 'fail'),
        stat(st.saves || 0, 'order lines stored', 'pass'),
        stat(st.failed || 0, 'writes failed (outage)'),
        stat(st.duplicatesPrevented || 0, 'duplicates prevented'),
        stat(st.avgTurnMs ? `${(st.avgTurnMs / 1000).toFixed(1)}s` : '·', 'average reply time'),
      ),
    ),
    card('Evaluation: define the outcome, then check it', ev.summary && ev.summary.model ? ev.summary.model : null,
      h('div', { style: 'display:flex;align-items:baseline;gap:1em;margin-bottom:.4em' },
        h('div', { class: results.length ? 'score' : 'score muted', title: 'Tasks passed' }, results.length ? `${passed}/${results.length}` : `–/${tasks.length}`),
        h('div', { class: 'muted' }, ev.running ? `Running… ${ev.progress ? `${ev.progress.done}/${ev.progress.total}` : ''}` : ev.summary && ev.summary.at ? `task success · run at ${new Date(ev.summary.at).toLocaleTimeString()}` : 'tasks passed · not run yet. Each task runs in a sandbox: the real team order is untouched.'),
      ),
      h('div', { class: 'scroll' }, h('table', { class: 'evals' }, h('tr', {}, h('th', {}, 'Result'), h('th', {}, 'Task'), h('th', {}, 'What happened')), rows)),
      h('div', { class: 'controls' },
        h('button', { class: 'btn cha', disabled: ev.running, onclick: () => post('evals', { trials: 1 }) }, ev.running ? 'Running…' : 'Run evaluation'),
        h('button', { class: 'btn ghost', disabled: ev.running, onclick: () => post('evals', { trials: 3 }) }, 'Run 3 trials each'),
      ),
    ),
  );
}

// ------------------------------------------------------------------ settings
function openSettings() {
  const m = $('modal');
  m.hidden = false;
  m.textContent = '';
  const s = S.act.settings;
  const input = h('input', { type: 'text', value: s.joinUrlOverride || '', placeholder: S.snap.joinUrl });
  const lan = (S.snap.lan || []).map((a) => `${a.name}: http://${a.address}:${location.port || 80}/`).join('   ');
  m.append(
    h('section', { class: 'card', onclick: (e) => e.stopPropagation() },
      h('h2', {}, 'Settings'),
      h('div', { class: 'note info' }, h('b', {}, 'Model: '), S.act.model.label, S.act.model.problems && S.act.model.problems.length ? h('div', { class: 'bad' }, S.act.model.problems.join(' ')) : null),
      h('div', { class: 'muted', style: 'font-size:.85em' }, `Limits: ${S.snap.limits.maxRounds} model rounds and ${S.snap.limits.maxToolCalls} tool calls per message · ${S.snap.limits.maxConcurrent} model calls at once${S.snap.limits.rpm ? ` · max ${S.snap.limits.rpm} per minute` : ''}`),
      h('label', {}, 'Join link shown in the QR code (leave empty for automatic)'),
      input,
      h('div', { class: 'muted', style: 'font-size:.8em;margin-top:.3em' }, `Network addresses on this computer: ${lan || 'none found'}`),
      h('div', { class: 'controls', style: 'margin-top:.6em' }, h('button', { class: 'btn', onclick: () => { post('settings', { joinUrlOverride: input.value }); closeSettings(); } }, 'Save link')),
      h('label', {}, 'Big screen'),
      h('div', { class: 'controls', style: 'padding-top:0' },
        h('button', { class: 'btn ghost', onclick: () => post('settings', { showMessages: !s.showMessages }) }, s.showMessages ? 'Hide audience messages' : 'Show audience messages'),
        h('button', { class: 'btn ghost', onclick: () => setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark') }, 'Light / dark'),
        h('button', { class: 'btn ghost', onclick: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()) }, 'Full screen'),
      ),
      h('label', {}, 'Reset'),
      h('div', { class: 'controls', style: 'padding-top:0' },
        h('button', { class: 'btn ghost', onclick: () => { post('reset', { what: 'order' }); closeSettings(); } }, 'Clear team order'),
        h('button', { class: 'btn danger', onclick: () => { if (confirmReset()) { post('reset', { what: 'all' }); closeSettings(); } } }, 'Reset everything'),
      ),
      h('p', { class: 'keys' }, 'Keys: ', h('kbd', {}, '0'), ' join · ', h('kbd', {}, '1'), '–', h('kbd', {}, '4'), ' acts · ', h('kbd', {}, '5'), ' results · ', h('kbd', {}, 'F'), ' full screen · ', h('kbd', {}, 'T'), ' theme · ', h('kbd', {}, 'S'), ' settings · ', h('kbd', {}, 'Esc'), ' close'),
      h('div', { class: 'controls' }, h('button', { class: 'btn', onclick: closeSettings }, 'Close')),
    ),
  );
  m.onclick = closeSettings;
}
let resetArmed = 0;
function confirmReset() {
  // Two clicks within 3 seconds, instead of a blocking browser dialog.
  if (Date.now() - resetArmed < 3000) return true;
  resetArmed = Date.now();
  const b = [...$('modal').querySelectorAll('.btn.danger')][0];
  if (b) b.textContent = 'Click again to confirm';
  return false;
}
function closeSettings() { $('modal').hidden = true; }

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea')) return;
  const acts = ['lobby', 'tools', 'rule', 'claims', 'break', 'summary'];
  if (/^[0-5]$/.test(e.key)) post('act', { act: acts[Number(e.key)] });
  else if (e.key === 'f' || e.key === 'F') (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  else if (e.key === 't' || e.key === 'T') setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  else if (e.key === 's' || e.key === 'S') openSettings();
  else if (e.key === 'Escape') closeSettings();
});

setInterval(() => { if (S.act && (S.act.act === 'tools' || S.act.act === 'break')) render(); }, 15000);
connect();
