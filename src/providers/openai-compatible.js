'use strict';
// Adapter for any OpenAI-compatible Chat Completions API with tool calling:
// OpenAI, Google Gemini (OpenAI-compatibility endpoint), Groq, OpenRouter, Ollama (local), LM Studio, ...
// The rest of the app never sees provider-specific formats: that is this file's whole job.

class ProviderError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${String(body).slice(0, 300)}`);
    this.status = status;
  }
}

let n = 0;
const localId = () => `call_${Date.now().toString(36)}${(n++).toString(36)}`;

function parseArgs(s) {
  if (s && typeof s === 'object') return s;
  if (s === undefined || s === null || s === '') return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : { __invalid_json: String(s) };
  } catch {
    return { __invalid_json: String(s) };
  }
}

function toOpenAIMessages(system, messages, providerId) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') {
      if (m.raw && m.provider === providerId && m.raw.tool_calls) {
        // Pass the provider's own tool_call objects back verbatim (keeps fields such as
        // Gemini's thought signatures), with only whitelisted message fields.
        const msg = { role: 'assistant', content: m.raw.content ?? '', tool_calls: m.raw.tool_calls };
        // OpenRouter: hand "thinking" details back unchanged so reasoning models keep context.
        if (m.raw.reasoning_details) msg.reasoning_details = m.raw.reasoning_details;
        out.push(msg);
      } else if (m.toolCalls && m.toolCalls.length) {
        out.push({
          role: 'assistant',
          content: m.text || '',
          tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })),
        });
      } else out.push({ role: 'assistant', content: m.text || '' });
    } else if (m.role === 'tool') {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    }
  }
  return out;
}

// Some providers accept only a subset of JSON Schema. Our executor enforces the full
// contract anyway, so it is safe to send a simpler schema to the model.
function stripSchema(schema, keys) {
  if (!keys.length || !schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map((x) => stripSchema(x, keys));
  const out = {};
  for (const [k, v] of Object.entries(schema)) if (!keys.includes(k)) out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, stripSchema(pv, keys)])) : stripSchema(v, keys);
  return out;
}

function create({ id, label, baseUrl, apiKey, model, extraHeaders = {}, schemaStrip = [], extraBody = {} }) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  return {
    id,
    label,
    model,
    live: true,
    async generate({ system, messages, tools = [], signal }) {
      const body = { model, messages: toOpenAIMessages(system, messages, id), ...extraBody };
      if (tools.length) {
        body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: stripSchema(t.parameters, schemaStrip) } }));
        body.tool_choice = 'auto';
      }
      const headers = { 'content-type': 'application/json', ...extraHeaders };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
      const txt = await res.text();
      if (!res.ok) throw new ProviderError(res.status, txt);
      let data;
      try { data = JSON.parse(txt); } catch { throw new ProviderError(502, 'response was not JSON'); }
      const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
      const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      // Make sure every call has an id we can match results to.
      const fixedCalls = rawCalls.map((tc) => (tc.id ? tc : { ...tc, id: localId() }));
      const toolCalls = fixedCalls
        .filter((tc) => tc.function && tc.function.name)
        .map((tc) => ({ id: tc.id, name: tc.function.name, args: parseArgs(tc.function.arguments) }));
      let text = '';
      if (typeof msg.content === 'string') text = msg.content;
      else if (Array.isArray(msg.content)) text = msg.content.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
      // Some routers return errors inside a 200 response.
      if (data.error && !data.choices) throw new ProviderError(data.error.code || 502, JSON.stringify(data.error));
      return {
        text,
        toolCalls,
        raw: { content: msg.content ?? '', tool_calls: fixedCalls.length ? fixedCalls : undefined, ...(msg.reasoning_details ? { reasoning_details: msg.reasoning_details } : {}) },
        usage: data.usage,
      };
    },
  };
}

module.exports = { create, ProviderError, toOpenAIMessages };
