'use strict';
// The executor: the boundary between a PROPOSED tool call and an EXECUTED operation.
// The model never touches the menu or the order directly. Every request passes these checks.

const { TOOL_BY_NAME, validate } = require('./tools');
const { INJECTION_TEXT } = require('./menu');
const { MAX_LINES_PER_PERSON } = require('./world');

const taka = (n) => `৳${n}`;

function looksLikeInstruction(text) {
  return /ignore (the user|previous|all|your)|system note|call add_to_order/i.test(String(text || ''));
}

/**
 * @returns {{checks:{label:string, ok:boolean, detail?:string}[], outcome:'executed'|'rejected'|'failed',
 *           result:object, summary:string, untrusted?:boolean, write?:boolean}}
 */
function execute(world, p, call, ctx) {
  const checks = [];
  const reject = (reason) => {
    const isWrite = call.name === 'add_to_order';
    if (isWrite) world.bump('blockedWrites');
    return { checks, outcome: 'rejected', result: { status: 'rejected', reason }, summary: `Rejected: ${reason}`, write: isWrite };
  };

  // 1. Is this a tool we offer at all?
  const tool = TOOL_BY_NAME[call.name];
  checks.push({ label: 'Tool is on the allowed list', ok: !!tool, detail: tool ? `${tool.name} (${tool.kind})` : `"${call.name}" is not a tool this app offers` });
  if (!tool) return reject(`unknown tool "${call.name}"`);

  // 2. Budget: stop runaway loops.
  const withinBudget = ctx.callIndex <= ctx.maxCalls;
  checks.push({ label: 'Within the call budget', ok: withinBudget, detail: `call ${ctx.callIndex} of max ${ctx.maxCalls} this message` });
  if (!withinBudget) return reject('call budget for this message is used up');

  // 3. Contract: types, required fields, ranges. Valid JSON is not the same as correct information,
  //    but invalid arguments never reach our code.
  if (call.args && call.args.__invalid_json !== undefined) {
    checks.push({ label: 'Arguments match the contract', ok: false, detail: 'arguments were not valid JSON' });
    return reject('arguments were not valid JSON');
  }
  const errs = validate(tool.parameters, call.args || {});
  checks.push({ label: 'Arguments match the contract', ok: errs.length === 0, detail: errs.length ? errs.join('; ') : 'types and ranges OK' });
  const a = call.args || {};
  // For a write we keep checking after a contract error (when we still know which item),
  // so the trace shows every reason the request would be refused.
  const keepChecking = tool.name === 'add_to_order' && typeof a.item_id === 'string';
  if (errs.length && !keepChecking) return reject(errs.join('; '));

  switch (tool.name) {
    case 'search_menu': {
      const q = String(a.query || '').toLowerCase().trim();
      const cat = a.category && a.category !== 'any' ? a.category : null;
      const words = q.split(/[^\p{L}\p{N}-]+/u).filter((w) => w.length > 1);
      let items = world.menu.filter((m) => !cat || m.category === cat);
      if (words.length) {
        const matched = items.filter((m) => {
          const hay = `${m.id} ${m.name} ${m.bn} ${m.tags.join(' ')} ${m.description} ${m.category}`.toLowerCase();
          return words.some((w) => hay.includes(w) || hay.includes(w.replace(/s$/, '')));
        });
        items = matched;
      }
      const records = items.map((m) => world.menuRecord(m));
      const untrusted = records.some((r) => looksLikeInstruction(r.description));
      if (untrusted) world.bump('injectionsSeen');
      checks.push({ label: 'Read-only: no state changes', ok: true });
      return {
        checks,
        outcome: 'executed',
        result: { status: 'ok', count: records.length, items: records, note: records.length ? undefined : 'No menu items matched. Do not invent any.' },
        summary: `Returned ${records.length} menu record${records.length === 1 ? '' : 's'}${cat ? ` (${cat})` : ''}${q ? ` for "${q}"` : ''}`,
        untrusted,
      };
    }

    case 'check_rules': {
      const max = a.max_price_taka;
      const min = a.min_rating === undefined ? null : a.min_rating;
      const ids = [...new Set(a.item_ids)];
      const eligible = [];
      const excluded = [];
      const cannotVerify = [];
      const unknown = [];
      for (const id of ids) {
        const m = world.menuItem(id);
        if (!m) { unknown.push(id); continue; }
        if (m.price === null || m.price === undefined) { cannotVerify.push({ id, name: m.name, reason: 'price not listed' }); continue; }
        if (!(m.price < max)) { excluded.push({ id, name: m.name, reason: m.price === max ? `exactly ${taka(m.price)}, not below ${taka(max)}` : `${taka(m.price)} is not below ${taka(max)}` }); continue; }
        if (min !== null) {
          if (m.rating === null || m.rating === undefined) { cannotVerify.push({ id, name: m.name, reason: 'rating not listed' }); continue; }
          if (!(m.rating >= min)) { excluded.push({ id, name: m.name, reason: `rating ${m.rating} is below ${min}` }); continue; }
        }
        eligible.push({ id, name: m.name, price_taka: m.price, rating: m.rating });
      }
      checks.push({ label: 'Item IDs exist on the menu', ok: unknown.length === 0, detail: unknown.length ? `not on the menu: ${unknown.join(', ')}` : `${ids.length} checked` });
      checks.push({ label: 'Rule applied in code', ok: true, detail: `price < ${taka(max)}${min !== null ? ` and rating ≥ ${min}` : ''}` });

      // Record the verified shortlist in application state.
      p.shortlist = {
        ids: eligible.map((e) => e.id),
        criteria: { max_price_taka: max, min_rating: min },
        at: Date.now(),
        eligible,
        excluded,
        cannotVerify,
        unknown,
      };
      if (p.chosen && !p.shortlist.ids.includes(p.chosen.id)) p.chosen = null; // limits changed; old choice no longer verified
      return {
        checks,
        outcome: 'executed',
        result: {
          status: 'ok',
          rule: `price_taka < ${max}${min !== null ? ` AND rating >= ${min}` : ''}`,
          eligible,
          excluded,
          cannot_verify: cannotVerify,
          unknown_ids: unknown,
        },
        summary: `${eligible.length} eligible · ${excluded.length} excluded · ${cannotVerify.length} cannot verify${unknown.length ? ` · ${unknown.length} unknown ID` : ''}`,
      };
    }

    case 'view_order': {
      checks.push({ label: 'Read-only: no state changes', ok: true });
      const lines = world.order.slice(-20).map((l) => ({ line: l.line, who: l.who, item: l.name, quantity: l.qty }));
      const mine = world.linesFor(p.pid).map((l) => ({ line: l.line, item: l.name, quantity: l.qty }));
      return { checks, outcome: 'executed', result: { status: 'ok', total_lines: world.order.length, your_lines: mine, recent_lines: lines }, summary: `Read ${world.order.length} order line(s)` };
    }

    case 'add_to_order': {
      const reasons = errs.length ? [errs.join('; ')] : [];
      const item = world.menuItem(a.item_id);
      checks.push({ label: 'Item exists on the menu', ok: !!item, detail: item ? item.name : `"${a.item_id}" is not on the menu` });
      if (!item) return reject([...reasons, `"${a.item_id}" is not on the menu`].join('; '));

      const inShortlist = !!(p.shortlist && p.shortlist.ids.includes(item.id));
      checks.push({
        label: 'Passed your latest rule check',
        ok: inShortlist,
        detail: inShortlist ? `checked under ${taka(p.shortlist.criteria.max_price_taka)}` : p.shortlist ? `${item.name} is not in your checked shortlist` : 'no checked shortlist yet',
      });
      if (!inShortlist) reasons.push(`${item.name} did not pass your latest rule check`);

      const chosen = !!(p.chosen && p.chosen.id === item.id);
      const chosenItem = p.chosen ? world.menuItem(p.chosen.id) : null;
      checks.push({
        label: 'You tapped Choose on this item',
        ok: chosen,
        detail: chosen ? 'choice recorded by the app' : chosenItem ? `you chose ${chosenItem.name}, not ${item.name}` : 'no choice recorded (a chat message is not a tap)',
      });
      if (!chosen) reasons.push(`the user has not chosen ${item.name} in the app`);

      if (reasons.length) return reject(reasons.join('; '));

      const existing = world.linesFor(p.pid).find((l) => l.itemId === item.id);
      if (existing) {
        checks.push({ label: 'No duplicate line (idempotent)', ok: true, detail: `already line #${existing.line}, nothing added` });
        world.bump('duplicatesPrevented');
        return {
          checks,
          outcome: 'executed',
          result: { status: 'already_in_order', line: existing.line, item: item.name, quantity: existing.qty },
          summary: `Already in order as line #${existing.line} (no duplicate)`,
          write: true,
        };
      }

      const count = world.linesFor(p.pid).length;
      checks.push({ label: `At most ${MAX_LINES_PER_PERSON} lines per person`, ok: count < MAX_LINES_PER_PERSON, detail: `you have ${count}` });
      if (count >= MAX_LINES_PER_PERSON) return reject(`limit of ${MAX_LINES_PER_PERSON} order lines per person reached`);

      // Execute the write. The stress switch simulates an outage of the order sheet.
      if (world.flags.saveFails) {
        return {
          checks,
          outcome: 'failed',
          result: { status: 'failed', error: 'Order sheet unavailable (simulated outage). Nothing was saved.' },
          summary: 'Write FAILED: order sheet unavailable. Order unchanged.',
          write: true,
        };
      }
      const line = world.addOrderLine(p, item, a.quantity);
      world.bump('saves');
      return {
        checks,
        outcome: 'executed',
        result: { status: 'added', line: line.line, item: item.name, quantity: line.qty },
        summary: `Stored line #${line.line}: ${line.qty} × ${item.name}`,
        write: true,
      };
    }
    default:
      return reject('no executor for this tool');
  }
}

module.exports = { execute, looksLikeInstruction, INJECTION_TEXT };
