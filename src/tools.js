'use strict';
// Tool contracts: what the application offers the model.
// The model sees these names, descriptions and schemas. It can only REQUEST a call.
// The executor (executor.js) decides whether anything actually runs.

const TOOLS = [
  {
    name: 'search_menu',
    kind: 'information',
    description:
      "Search today's tea-stall menu. Returns menu records exactly as stored. price_taka or rating can be null when the stall did not list them. Use this before recommending anything.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 80, description: 'Words to match in name, tags or description, e.g. "spicy". Use "" for everything.' },
        category: { type: 'string', enum: ['drink', 'snack', 'sweet', 'any'], description: 'Menu section to search.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'check_rules',
    kind: 'computation',
    description:
      'Check menu items against the user\'s hard limits using exact code. The price limit is STRICT: price must be below max_price_taka. Items with a missing price or rating come back as cannot_verify. Always use this result for prices and limits instead of your own judgement.',
    parameters: {
      type: 'object',
      properties: {
        item_ids: { type: 'array', items: { type: 'string', maxLength: 40 }, minItems: 1, maxItems: 20, description: 'Menu item ids from search_menu.' },
        max_price_taka: { type: 'integer', minimum: 1, maximum: 1000, description: 'Price must be strictly below this number of taka.' },
        min_rating: { type: 'number', minimum: 0, maximum: 5, description: 'Rating must be at least this. Omit if the user gave no rating limit.' },
      },
      required: ['item_ids', 'max_price_taka'],
      additionalProperties: false,
    },
  },
  {
    name: 'view_order',
    kind: 'state check',
    description: 'Read the current team order (the stored state).',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'add_to_order',
    kind: 'state change',
    description:
      'Add ONE item to the team order. Only call this when the user asks to add their chosen item. The app only allows items that passed the latest check_rules call AND that the user tapped "Choose" on. Report the returned status honestly.',
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', maxLength: 40, description: 'Menu item id.' },
        quantity: { type: 'integer', minimum: 1, maximum: 3, description: 'How many (1 to 3).' },
      },
      required: ['item_id', 'quantity'],
      additionalProperties: false,
    },
  },
];

const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// A deliberately small JSON-schema checker: enough to enforce the contracts above.
function validate(schema, value, path = 'arguments') {
  const errors = [];
  const t = schema.type;
  const typeOk =
    (t === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) ||
    (t === 'array' && Array.isArray(value)) ||
    (t === 'string' && typeof value === 'string') ||
    (t === 'integer' && Number.isInteger(value)) ||
    (t === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (t === 'boolean' && typeof value === 'boolean');
  if (!typeOk) {
    errors.push(`${path} must be ${t === 'integer' ? 'a whole number' : 'a ' + t}, got ${JSON.stringify(value)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be ≥ ${schema.minimum} (got ${value})`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be ≤ ${schema.maximum} (got ${value})`);
  }
  if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is too long`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} allows at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${path}[${i}]`)));
  }
  if (t === 'object') {
    for (const req of schema.required || []) if (value[req] === undefined) errors.push(`missing required field "${req}"`);
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties && schema.properties[k];
      if (!sub) {
        if (schema.additionalProperties === false) errors.push(`unexpected field "${k}"`);
        continue;
      }
      errors.push(...validate(sub, v, k));
    }
  }
  return errors;
}

// What the model is shown. Strips app-only fields.
function modelToolDefs() {
  return TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

module.exports = { TOOLS, TOOL_BY_NAME, validate, modelToolDefs };
