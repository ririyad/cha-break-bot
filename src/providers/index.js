'use strict';
// Picks the model adapter. The rest of the app talks to one interface:
//   generate({ system, messages, tools, meta }) -> { text, toolCalls:[{id,name,args}], raw }

const simulated = require('./simulated');
const openaiCompatible = require('./openai-compatible');
const anthropic = require('./anthropic');

function createProvider(config) {
  const p = config.preset;
  if (p.kind === 'simulated' || config.problems.length) return simulated;
  if (p.kind === 'anthropic') {
    return anthropic.create({ id: config.providerName, label: p.label, baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model });
  }
  const extraHeaders = config.providerName === 'openrouter' ? { 'X-Title': 'Cha-Break Bot Live', 'HTTP-Referer': 'https://github.com/cha-break-bot-live' } : {};
  const schemaStrip = config.providerName === 'gemini' ? ['additionalProperties'] : [];
  // OpenRouter routes each request to one of several upstream providers. Only use providers
  // that support every parameter we send (tools!), and optionally sort them.
  const extraBody = {};
  if (config.providerName === 'openrouter') {
    extraBody.provider = { require_parameters: true, ...(config.orSort ? { sort: config.orSort } : {}) };
    if (config.reasoningOff) extraBody.reasoning = { enabled: false };
  }
  return openaiCompatible.create({ id: config.providerName, label: p.label, baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, extraHeaders, schemaStrip, extraBody });
}

module.exports = { createProvider };
