/**
 * Schema-driven structured extraction, no LLM required.
 *
 * Port of crawl4ai's JsonCssExtractionStrategy (extraction_strategy.py:1989).
 * The schema format is identical, so schemas written for crawl4ai work here
 * unchanged:
 *
 *   {
 *     name: 'Products',
 *     baseSelector: 'div.product',
 *     baseFields: [{ name: 'id', type: 'attribute', attribute: 'data-id' }],
 *     fields: [
 *       { name: 'title', selector: 'h3', type: 'text' },
 *       { name: 'price', selector: '.price', type: ['text', 'regex'],
 *         pattern: '([\\d.]+)', default: '0' },
 *       { name: 'tags', selector: '.tag', type: 'list',
 *         fields: [{ name: 'label', type: 'text' }] },
 *       { name: 'reviews', selector: '.review', type: 'nested_list',
 *         fields: [{ name: 'stars', selector: '.stars', type: 'text' }] },
 *     ],
 *   }
 *
 * Field types: text | attribute | html | regex | nested | list | nested_list.
 * `type` may be an ARRAY, forming a pipeline: ['attribute', 'regex'] reads an
 * attribute then applies `pattern` to it. A pipeline aborts at the first null.
 *
 * NOTE: crawl4ai's `computed` field type with an `expression` string is
 * deliberately NOT supported. Upstream disabled it because it evaluates
 * arbitrary code against untrusted page content; reintroducing it in an
 * extension would be worse, since the extension origin holds host permissions.
 */

/** Apply `transform` to an extracted value. */
function applyTransform(value, transform) {
  if (typeof value !== 'string') return value;
  switch (transform) {
    case 'lowercase': return value.toLowerCase();
    case 'uppercase': return value.toUpperCase();
    case 'strip': return value.trim();
    default: return value;
  }
}

const elementText = (el) => (el.textContent || '').trim();

/** Resolve `source: "+ selector"` sibling navigation. */
function resolveSource(element, source) {
  const match = /^\+\s*(.*)$/.exec(source.trim());
  if (!match) return element;

  const selector = match[1].trim();
  for (let sib = element.nextElementSibling; sib; sib = sib.nextElementSibling) {
    if (!selector || sib.matches(selector)) return sib;
  }
  return null;
}

/** Run one step of a type pipeline. */
function applyStep(value, step, field) {
  switch (step) {
    case 'text':
      return typeof value === 'string' ? value : elementText(value);
    case 'attribute':
      return typeof value === 'string' ? value : value.getAttribute(field.attribute);
    case 'html':
      return typeof value === 'string' ? value : value.innerHTML;
    case 'regex': {
      if (!field.pattern) return value;
      const source = typeof value === 'string' ? value : elementText(value);
      const match = new RegExp(field.pattern).exec(source);
      return match ? (match[field.group ?? 1] ?? null) : null;
    }
    default:
      return value;
  }
}

/** Extract a scalar field, honouring type pipelines and defaults. */
function extractSingle(element, field) {
  let target = element;
  if (field.selector) {
    target = element.querySelector(field.selector);
    if (!target) return field.default ?? null;
  }

  const steps = Array.isArray(field.type) ? field.type : [field.type];
  let value = target;
  for (const step of steps) {
    value = applyStep(value, step, field);
    if (value === null || value === undefined) break;
  }

  if (value !== null && value !== undefined && field.transform) {
    value = applyTransform(value, field.transform);
  }
  return value ?? field.default ?? null;
}

/** Extract one field of any type against `element`. */
function extractField(element, field) {
  try {
    let target = element;
    if (field.source) {
      target = resolveSource(element, field.source);
      if (!target) return field.default ?? null;
    }

    if (field.type === 'nested') {
      const el = field.selector ? target.querySelector(field.selector) : target;
      return el ? extractItem(el, field.fields ?? []) : {};
    }

    if (field.type === 'list') {
      const els = field.selector ? [...target.querySelectorAll(field.selector)] : [target];
      // Upstream's "list" is intentionally non-recursive: child fields are
      // scalars only. Use nested_list for sub-structure.
      return els.map((el) => {
        const item = {};
        for (const child of field.fields ?? []) {
          const value = extractSingle(el, child);
          if (value !== null) item[child.name] = value;
        }
        return item;
      });
    }

    if (field.type === 'nested_list') {
      const els = field.selector ? [...target.querySelectorAll(field.selector)] : [target];
      return els.map((el) => extractItem(el, field.fields ?? []));
    }

    if (field.type === 'computed') {
      // `expression` is unsupported by design; only a provided function runs.
      return typeof field.function === 'function' ? field.function(element) : (field.default ?? null);
    }

    return extractSingle(target, field);
  } catch {
    return field.default ?? null;
  }
}

/** Extract every field of a schema against one base element. */
function extractItem(element, fields) {
  const item = {};
  for (const field of fields) {
    const value = field.type === 'computed'
      ? (typeof field.function === 'function' ? field.function(item) : field.default ?? null)
      : extractField(element, field);
    if (value !== null && value !== undefined) item[field.name] = value;
  }
  return item;
}

/**
 * Run a schema over a document.
 *
 * @param {Document|Element} root
 * @param {object} schema  requires `baseSelector` and `fields`
 * @returns {object[]} one object per matched base element; empties are dropped
 */
export function extractJsonCss(root, schema) {
  if (!schema?.baseSelector) throw new Error('Schema requires a baseSelector');
  if (!Array.isArray(schema.fields)) throw new Error('Schema requires a fields array');

  const out = [];
  for (const base of root.querySelectorAll(schema.baseSelector)) {
    const item = {};

    for (const field of schema.baseFields ?? []) {
      const value = extractSingle(base, field);
      if (value !== null) item[field.name] = value;
    }
    Object.assign(item, extractItem(base, schema.fields));

    if (Object.keys(item).length) out.push(item);
  }
  return out;
}

/** Validate a schema, returning human-readable problems. */
export function validateSchema(schema) {
  const errors = [];
  if (!schema || typeof schema !== 'object') return ['Schema must be an object'];
  if (!schema.baseSelector) errors.push('Missing baseSelector');
  if (!Array.isArray(schema.fields)) errors.push('Missing fields array');

  const walk = (fields, path) => {
    for (const [i, field] of (fields ?? []).entries()) {
      const at = `${path}[${i}]`;
      if (!field.name) errors.push(`${at}: missing name`);
      if (!field.type) errors.push(`${at}: missing type`);
      if (field.type === 'attribute' && !field.attribute) {
        errors.push(`${at}: type "attribute" requires an attribute name`);
      }
      if (['nested', 'list', 'nested_list'].includes(field.type) && !Array.isArray(field.fields)) {
        errors.push(`${at}: type "${field.type}" requires a fields array`);
      }
      if (field.type === 'computed' && field.expression) {
        errors.push(`${at}: "expression" is unsupported for security reasons; use a function`);
      }
      if (Array.isArray(field.fields)) walk(field.fields, `${at}.fields`);
    }
  };
  walk(schema.fields, 'fields');

  return errors;
}
