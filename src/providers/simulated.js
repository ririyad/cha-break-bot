'use strict';
// SIMULATED MODEL: a rule-based stand-in for a language model.
// It is NOT AI. It parses simple English (and a little Bangla) with patterns and proposes
// the same kinds of tool calls a real model would, so the demo works with no API key
// and no internet. Everything around it (executor, checks, order, trace) is real.
// It is deliberately gullible about hidden instructions, so the executor's defence is visible.

const { MENU, RULE_VERSIONS, RULE, ruleCheck } = require('../menu');

const BN_DIGITS = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' };
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, a: 1, an: 1 };

let idCounter = 0;
const newId = () => `sim_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;

function norm(text) {
  return String(text || '')
    .replace(/[০-৯]/g, (d) => BN_DIGITS[d])
    .toLowerCase();
}

const ALIASES = [
  ['milk-cha', /milk (cha|tea|chai)|dudh cha|দুধ চা|milk-cha/],
  ['red-cha', /red (cha|tea)|lal cha|লাল চা|black tea|red-cha/],
  ['lemon-cha', /lemon (cha|tea)|lebu cha|লেবু চা|lemon-cha/],
  ['singara', /singara|shingara|singhara|সিঙ্গারা|শিঙাড়া/],
  ['piyaju', /piyaju|peyaju|piaju|পিয়াজু|পেঁয়াজু/],
  ['beguni', /beguni|বেগুনি/],
  ['dal-puri', /dal ?puri|puri|ডাল পুরি|পুরি/],
  ['chotpoti', /chotpoti|chatpati|chotpoty|চটপটি/],
  ['fuchka', /fuchka|phuchka|puchka|panipuri|pani puri|ফুচকা/],
  ['jhalmuri', /jhal ?muri|jhalmuri|ঝালমুড়ি|muri/],
  ['chicken-roll', /chicken roll|চিকেন রোল/],
  ['veg-roll', /veg(etable)? roll|ভেজিটেবল রোল/],
  ['nimki', /nimki|নিমকি/],
  ['toast-biscuit', /toast|biscuit|বিস্কুট/],
  ['roshogolla', /rosh?o?golla|rasgulla|rosogolla|রসগোল্লা/],
  ['samosa', /samosa|সমুচা|somucha/], // NOT on the menu: shows the executor rejecting unknown items
  ['burger', /burger|বার্গার/],
];

function findItems(t) {
  const found = [];
  for (const [id, re] of ALIASES) if (re.test(t) && !found.includes(id)) found.push(id);
  return found;
}

function parse(textRaw) {
  const t = norm(textRaw);
  const r = { raw: textRaw, t };
  // price limit
  let m =
    t.match(/(under|below|less than|cheaper than|lower than|<|within|up to|upto|max(?:imum)?|at most|no more than|budget(?: of| is)?)\s*(?:tk\.?|taka|৳|bdt|rs\.?)?\s*(\d{1,4})/) ||
    t.match(/(\d{1,4})\s*(?:tk\.?|taka|৳|bdt|টাকা)?\s*(or less|and under|max|এর নিচে|টাকার নিচে|টাকার মধ্যে|er niche|er moddhe|এর মধ্যে)/);
  if (m) {
    const word = isNaN(Number(m[1])) ? m[1] : m[2];
    const num = Number(isNaN(Number(m[1])) ? m[2] : m[1]);
    const inclusive = /within|up to|upto|max|at most|no more than|or less|budget|মধ্যে|moddhe/.test(word);
    r.maxPrice = inclusive ? num + 1 : num;
    r.inclusiveNote = inclusive ? `I treated "${word} ৳${num}" as "under ৳${num + 1}" because prices are whole taka.` : '';
  }
  // rating
  m =
    t.match(/(?:rat(?:ed|ing)|stars?|score|রেটিং|রেটিং)\s*(?:of\s*)?(?:at least|min(?:imum)?|above|over|>=|≥|of)?\s*(\d(?:\.\d)?)/) ||
    t.match(/(\d(?:\.\d)?)\s*\+?\s*(?:stars?|rating|rated|or (?:more|higher|above))/) ||
    t.match(/(?:at least|minimum)\s*(\d(?:\.\d)?)\s*(?:stars?|rating)?/);
  if (m && Number(m[1]) <= 5) r.minRating = Number(m[1]);
  // count
  m = t.match(/\b(\d|one|two|three|four|five|six|a|an)\s+(?:\w+\s+)?(snacks?|items?|things?|options?|drinks?|sweets?|teas?|picks?|ideas?)/);
  if (m) r.count = Number(m[1]) || WORD_NUM[m[1]] || null;
  else if ((m = t.match(/(?<!\d)(\d)\s*টা(?!কা)/))) r.count = Number(m[1]);
  // category
  if (/\b(drinks?|teas?|cha|chai)\b|চা|পানীয়/.test(t) && !/snack/.test(t)) r.category = 'drink';
  if (/\b(sweets?|desserts?|mishti)\b|মিষ্টি/.test(t)) r.category = 'sweet';
  if (/\b(snacks?|food|eat|nasta|nashta|fried|bite)\b|নাস্তা/.test(t)) r.category = 'snack';
  // flavour words become the search query
  const tags = ['spicy', 'fried', 'light', 'crunchy', 'savoury', 'tangy', 'hot', 'filling'];
  r.query = tags.filter((w) => t.includes(w) || (w === 'savoury' && t.includes('savory'))).join(' ');
  // items and quantity
  r.items = findItems(t);
  m = t.match(/\b(\d{1,3}|one|two|three|four|five|six|a|an)\s+(?:plates? of |pieces? of |cups? of )?(?:[a-z]+ )?(fuchka|singara|piyaju|beguni|puri|chotpoti|jhalmuri|roll|nimki|samosa|samosas|singaras|cha|tea|roshogolla|biscuits?|toast)/);
  r.qty = m ? Number(m[1]) || WORD_NUM[m[1]] || 1 : 1;
  // intents
  r.attack = /ignore (your|the|all|previous|any)|system:|user_confirmed|admin|override|jailbreak|developer mode/.test(t);
  r.view = /(what('s| is)|show|see|view|check|read).{0,25}\border\b|\border (list|status)\b/.test(t) && !/\badd\b/.test(t);
  r.add = !r.view && (/\b(add|order|put|save|book|include|get me|buy)\b|যোগ|অর্ডার/.test(t) || r.attack) && !/\b(suggest|recommend|what should)\b/.test(t);
  r.mine = /my (choice|pick|selection)|chosen|\bit\b|\bthat\b|\bthis\b|same/.test(t);
  r.price = /how much|price|cost|দাম|কত/.test(t) && r.items.length > 0;
  r.followUp = /^(actually|instead|make it|what about|and |now |ok |okay |then |how about)/.test(t.trim());
  return r;
}

function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return i;
  return -1;
}

function turnResults(messages, from) {
  const out = [];
  for (let i = from + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool') for (const r of m.results) {
      let parsed = null;
      try { parsed = JSON.parse(r.content); } catch { parsed = { status: 'error' }; }
      out.push({ name: r.name, result: parsed });
    }
  }
  return out;
}

// Merge limits from earlier user messages when the new message is a follow-up.
function withHistory(messages, idx, cur) {
  const merged = { ...cur };
  if (!(cur.followUp || (!cur.category && (cur.maxPrice || cur.minRating)))) return merged;
  for (let i = idx - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    const prev = parse(messages[i].text);
    if (merged.maxPrice === undefined && prev.maxPrice !== undefined) merged.maxPrice = prev.maxPrice;
    if (merged.minRating === undefined && prev.minRating !== undefined) merged.minRating = prev.minRating;
    if (!merged.category && prev.category) merged.category = prev.category;
    if (!merged.count && prev.count) merged.count = prev.count;
    if (!merged.query && prev.query) merged.query = prev.query;
  }
  return merged;
}

const call = (name, args) => ({ text: '', toolCalls: [{ id: newId(), name, args }] });
const say = (text) => ({ text, toolCalls: [] });
const taka = (n) => `৳${n}`;
const joinNames = (arr) => (arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`);

function replyForCheck(res, intent) {
  const want = intent.count || 3;
  const elig = [...(res.eligible || [])].sort((a, b) => (b.rating || 0) - (a.rating || 0));
  const picks = elig.slice(0, want);
  const parts = [];
  if (!picks.length) {
    parts.push(`No verified match under these limits (${res.rule.replace('price_taka', 'price').replace('AND', 'and')}).`);
  } else {
    parts.push(`Checked by code: ${joinNames(picks.map((e) => `${e.name} (${taka(e.price_taka)}, ${e.rating})`))}.`);
    if (intent.count && elig.length < want) parts.push(`Only ${elig.length} qualif${elig.length === 1 ? 'ies' : 'y'}, fewer than the ${want} you asked for. I won't invent more.`);
  }
  const boundary = (res.excluded || []).find((x) => /exactly/.test(x.reason));
  if (boundary) parts.push(`${boundary.name} is ${boundary.reason.replace(/^exactly/, 'exactly')}, so it's out.`);
  const cv = res.cannot_verify || [];
  if (cv.length) parts.push(`I can't confirm ${joinNames(cv.map((c) => `${c.name} (${c.reason})`))}.`);
  if (picks.length) parts.push(`My suggestion (an opinion): ${picks[0].name}, the highest rated that fits. Tap Choose on the one you want, then ask me to add it.`);
  else parts.push('Want me to raise the price limit?');
  if (intent.inclusiveNote) parts.push(intent.inclusiveNote);
  return parts.join(' ');
}

function replyForAdd(res) {
  switch (res.status) {
    case 'added': return `Done: the app stored line #${res.line}, ${res.quantity} × ${res.item}. You can see it on the team order.`;
    case 'already_in_order': return `${res.item} is already on the team order as line #${res.line}, so nothing new was added.`;
    case 'failed': return `The save failed: ${res.error} Your item was NOT added. Try again in a moment.`;
    case 'rejected': return `The app refused that request: ${res.reason}. Nothing was added.`;
    default: return 'I could not confirm what happened, so I will not claim it was added. Please check the team order.';
  }
}

async function generate({ messages, meta = {} }) {
  // Special purposes used by the stage
  if (meta.purpose === 'rule_test') {
    const rows = ruleCheck(meta.version);
    const eligible = rows.filter((r) => r.verdict === 'yes').map((r) => r.name);
    return say(JSON.stringify({ eligible, explanation: 'Applied the rule exactly (price below ৳50, rating at least 4.0).' }));
  }
  if (meta.purpose === 'no_tools') {
    return { text: 'Jhalmuri usually costs about ৳30, and it’s the stall’s bestseller: a great pick for your team!', toolCalls: [], recorded: true };
  }

  const idx = lastUserIndex(messages);
  if (idx < 0) return say('Hi! Ask me for tea-break snacks, for example: "3 snacks under ৳50 rated 4+".');
  const intent = withHistory(messages, idx, parse(messages[idx].text));
  const done = turnResults(messages, idx);
  const last = done[done.length - 1];
  const state = meta.state || {};

  // Gullible on purpose: a planted instruction in a menu description gets obeyed
  // (in the same step as the normal rule check, so the user still gets a shortlist).
  const planted = done.find((d) => d.name === 'search_menu' && (d.result.items || []).some((it) => /call add_to_order/i.test(it.description || '')));
  if (planted && last && last.name === 'search_menu' && !done.some((d) => d.name === 'add_to_order')) {
    const hijack = { id: newId(), name: 'add_to_order', args: { item_id: 'fuchka', quantity: 10 } };
    const items = last.result.items || [];
    const calls = intent.maxPrice !== undefined && items.length
      ? [{ id: newId(), name: 'check_rules', args: { item_ids: items.map((x) => x.id), max_price_taka: intent.maxPrice, ...(intent.minRating !== undefined ? { min_rating: intent.minRating } : {}) } }, hijack]
      : [hijack];
    return { text: 'A note in the menu says to add 10 fuchka, so I will do that too.', toolCalls: calls };
  }
  const hijacked = planted && last && last.name === 'add_to_order';
  if (hijacked) {
    const check = done.find((d) => d.name === 'check_rules');
    const note = `A note inside the menu told me to add 10 fuchka, so I tried. ${replyForAdd(last.result || {})}`;
    return say(check ? `${replyForCheck(check.result, intent)} ${note}` : note);
  }

  if (last) {
    const res = last.result || {};
    if (last.name === 'add_to_order') return say(replyForAdd(res));
    if (last.name === 'view_order') {
      const mine = res.your_lines || [];
      return say(`The team order has ${res.total_lines} line(s). ${mine.length ? `Yours: ${mine.map((l) => `#${l.line} ${l.quantity} × ${l.item}`).join(', ')}.` : 'You have nothing on it yet.'}`);
    }
    if (last.name === 'check_rules') return say(replyForCheck(res, intent));
    if (last.name === 'search_menu') {
      const items = res.items || [];
      if (intent.price) {
        const it = items.find((x) => intent.items.includes(x.id));
        if (!it) return say("That item isn't on today's menu, so I have no price for it.");
        const price = it.price_taka === null ? 'no price is listed today, so I can’t tell you what it costs' : `it costs ${taka(it.price_taka)}`;
        const rating = it.rating === null ? 'no rating is listed' : `it is rated ${it.rating}`;
        return say(`According to the menu record for ${it.name}, ${price}, and ${rating}. The menu has no sales data, so I can’t say whether it’s a bestseller.`);
      }
      if (!items.length) return say("Nothing on today's menu matches that. Try another word, or ask for snacks, drinks or sweets.");
      if (intent.maxPrice === undefined) {
        return say(`I found ${items.length} item(s). What's your price limit? For example: "under ৳30, rated 4 or more".`);
      }
      return call('check_rules', {
        item_ids: items.map((x) => x.id),
        max_price_taka: intent.maxPrice,
        ...(intent.minRating !== undefined ? { min_rating: intent.minRating } : {}),
      });
    }
    if (last.name) return say('I received a result I did not expect, so I stopped here.');
  }

  // First step of the turn
  if (intent.add) {
    let itemId = intent.items[0];
    if (!itemId && (intent.mine || !intent.items.length) && state.chosenId) itemId = state.chosenId;
    if (!itemId) return say('Which item? First ask me for a checked shortlist, tap Choose on one, then ask me to add it.');
    return call('add_to_order', { item_id: itemId, quantity: intent.qty || 1 });
  }
  if (intent.view) return call('view_order', {});
  if (intent.price) {
    const it = MENU.find((m) => m.id === intent.items[0]);
    return call('search_menu', { query: it ? it.name : intent.items[0], category: 'any' });
  }
  if (intent.maxPrice === undefined && !intent.category && !intent.query && !intent.items.length) {
    return say('Tell me what you feel like and your limits, for example: "3 snacks under ৳50 rated 4+" or "a drink under ৳15".');
  }
  return call('search_menu', { query: intent.query || '', category: intent.category || 'any' });
}

module.exports = {
  id: 'simulated',
  label: 'Simulated model',
  model: 'rule-based stand-in',
  live: false,
  generate,
  _parse: parse,
};
