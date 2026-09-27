'use strict';
// Adapter for Anthropic's Messages API (Claude) with tool use.

const { ProviderError } = require('./openai-compatible');

function toAnthropicMessages(messages, providerId) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text || '(empty)' });
    else if (m.role === 'assistant') {
      if (m.raw && m.provider === providerId && Array.isArray(m.raw.content) && m.raw.content.length) {
        out.push({ role: 'assistant', content: m.raw.content });
      } else {
        const content = [];
        if (m.text) content.push({ type: 'text', text: m.text });
        for (const c of m.toolCalls || []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args && !c.args.__invalid_json ? c.args : {} });
        out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no text)' }] });
      }
    } else if (m.role === 'tool') {
      out.push({ role: 'user', content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })) });
    }
  }
  return out;
}

function create({ id = 'anthropic', label = 'Anthropic Claude', baseUrl = 'https://api.anthropic.com', apiKey, model }) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/v1/messages`;
  return {
    id,
    label,
    model,
    live: true,
    async generate({ system, messages, tools = [], signal }) {
      const body = { model, max_tokens: 1024, system, messages: toAnthropicMessages(messages, id) };
      if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal,
      });
      const txt = await res.text();
      if (!res.ok) throw new ProviderError(res.status, txt);
      const data = JSON.parse(txt);
      const blocks = Array.isArray(data.content) ? data.content : [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const toolCalls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
      return { text, toolCalls, raw: { content: blocks }, usage: data.usage };
    },
  };
}

module.exports = { create, toAnthropicMessages };
