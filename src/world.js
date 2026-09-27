'use strict';
// Application state: participants, the team order, stress switches and counters.
// This is the "truth about actions". The UI renders the order from here,
// never from what the model says.

const { EventEmitter } = require('events');
const crypto = require('crypto');
const { createMenu, INJECTION_TEXT } = require('./menu');

const MAX_LINES_PER_PERSON = 3;

function newStats() {
  return {
    messages: 0,
    modelCalls: 0,
    liveModelCalls: 0,
    simulatedModelCalls: 0,
    fallbacks: 0,
    proposed: 0,
    executed: 0,
    rejected: 0,
    failed: 0,
    saves: 0,
    duplicatesPrevented: 0,
    injectionsSeen: 0,
    blockedWrites: 0,
    falseSuccessFlags: 0,
    turnMsTotal: 0,
    turnsDone: 0,
  };
}

class World extends EventEmitter {
  constructor({ sandbox = false } = {}) {
    super();
    this.setMaxListeners(0);
    this.sandbox = sandbox;
    this.menu = createMenu();
    this.flags = { saveFails: false, injection: false };
    this.participants = new Map();
    this.order = [];
    this.nextLine = 1;
    this.turns = [];
    this.stats = newStats();
    this.guestCounter = 0;
  }

  // ---- participants ----
  addParticipant(name, { system = false } = {}) {
    const pid = crypto.randomBytes(8).toString('hex');
    if (!system) this.guestCounter += 1;
    const clean = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
    const p = {
      pid,
      name: clean || `Guest ${this.guestCounter}`,
      joinedAt: Date.now(),
      shortlist: null, // { ids, criteria, at, excluded, cannotVerify }
      chosen: null, // { id, at }  set ONLY by the Choose button
      history: [], // [{role, text}]
      messages: 0,
      busy: false,
      system,
    };
    this.participants.set(pid, p);
    this.emit('participants');
    return p;
  }

  getParticipant(pid) {
    return this.participants.get(String(pid || ''));
  }

  // The ONLY way a choice enters application state: an explicit tap in the UI.
  choose(p, itemId) {
    const item = this.menuItem(itemId);
    if (!item) return { ok: false, error: 'Unknown item' };
    if (!p.shortlist || !p.shortlist.ids.includes(itemId)) return { ok: false, error: `${item.name} is not in your latest checked shortlist` };
    p.chosen = { id: itemId, at: Date.now() };
    return { ok: true, item };
  }

  // ---- menu ----
  menuItem(id) {
    return this.menu.find((m) => m.id === id) || null;
  }

  // Menu as the tools see it. The stress switch plants an instruction in untrusted text.
  menuRecord(m) {
    let description = m.description;
    if (this.flags.injection && m.id === 'fuchka') description = `${m.description} ${INJECTION_TEXT}`;
    return { id: m.id, name: m.name, name_bn: m.bn, category: m.category, price_taka: m.price, rating: m.rating, tags: m.tags, description };
  }

  // ---- order (stored state) ----
  linesFor(pid) {
    return this.order.filter((l) => l.pid === pid);
  }

  addOrderLine(p, item, qty) {
    const line = {
      line: this.nextLine++,
      pid: p.pid,
      who: p.name,
      itemId: item.id,
      name: item.name,
      bn: item.bn,
      qty,
      price: item.price,
      at: Date.now(),
      // Audit trail: every stored line must trace back to a Choose tap and a rule check.
      audit: { chosenAt: p.chosen ? p.chosen.at : null, checkedAt: p.shortlist ? p.shortlist.at : null },
    };
    this.order.push(line);
    this.emit('order');
    return line;
  }

  resetOrder() {
    this.order = [];
    this.nextLine = 1;
    for (const p of this.participants.values()) p.chosen = null;
    this.emit('order');
  }

  resetAll() {
    this.resetOrder();
    this.turns = [];
    this.stats = newStats();
    for (const p of this.participants.values()) {
      p.shortlist = null;
      p.chosen = null;
      p.history = [];
      p.messages = 0;
    }
    this.flags = { saveFails: false, injection: false };
    this.emit('reset');
  }

  audit() {
    const bad = this.order.filter((l) => !l.audit.chosenAt || !l.audit.checkedAt);
    return { lines: this.order.length, untraceable: bad.length };
  }

  bump(key, n = 1) {
    this.stats[key] = (this.stats[key] || 0) + n;
    this.emit('stats');
  }

  publicOrder() {
    return this.order.map(({ line, who, itemId, name, bn, qty, price, at }) => ({ line, who, itemId, name, bn, qty, price, at }));
  }
}

module.exports = { World, MAX_LINES_PER_PERSON };
