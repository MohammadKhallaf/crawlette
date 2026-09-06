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

export type FieldType = 'text' | 'attribute' | 'html' | 'regex' | 'nested' | 'list' | 'nested_list' | 'computed';

/** Value an extracted field may hold once resolved. */
export type ExtractedValue = string | number | boolean | null | Record<string, unknown> | ExtractedValue[];

export interface ExtractionField {
  name: string;
  /** A single step, or an array forming a pipeline (e.g. ['attribute', 'regex']). */
  type: FieldType | FieldType[];
  selector?: string;
  attribute?: string;
  pattern?: string;
  group?: number;
  transform?: 'lowercase' | 'uppercase' | 'strip';
  default?: ExtractedValue;
  /** Sibling navigation, e.g. "+ .caption". */
  source?: string;
  /** Nested/list/nested_list field definitions. */
  fields?: ExtractionField[];
  /** For `type: "computed"` -- receives the item built so far. */
  function?: (item: Record<string, unknown> | Element) => ExtractedValue;
}

export interface ExtractionSchema {
  name?: string;
  baseSelector: string;
  baseFields?: ExtractionField[];
  fields: ExtractionField[];
}

export type ExtractedItem = Record<string, unknown>;

/** Apply `transform` to an extracted value. */
function applyTransform(value: ExtractedValue, transform: ExtractionField['transform']): ExtractedValue {
  if (typeof value !== 'string') return value;
  switch (transform) {
    case 'lowercase': return value.toLowerCase();
    case 'uppercase': return value.toUpperCase();
    case 'strip': return value.trim();
    default: return value;
  }
}

const elementText = (el: Element): string => (el.textContent || '').trim();

/** Resolve `source: "+ selector"` sibling navigation. */
function resolveSource(element: Element, source: string): Element | null {
  const match = /^\+\s*(.*)$/.exec(source.trim());
  if (!match) return element;

  const selector = (match[1] ?? '').trim();
  for (let sib = element.nextElementSibling; sib; sib = sib.nextElementSibling) {
    if (!selector || sib.matches(selector)) return sib;
  }
  return null;
}

type StepValue = Element | ExtractedValue;

/** Run one step of a type pipeline. */
function applyStep(value: StepValue, step: FieldType, field: ExtractionField): StepValue {
  switch (step) {
    case 'text':
      return typeof value === 'string' ? value : elementText(value as Element);
    case 'attribute':
      return typeof value === 'string' ? value : (value as Element).getAttribute(field.attribute!);
    case 'html':
      return typeof value === 'string' ? value : (value as HTMLElement).innerHTML;
    case 'regex': {
      if (!field.pattern) return value;
      const source = typeof value === 'string' ? value : elementText(value as Element);
      const match = new RegExp(field.pattern).exec(source);
      return match ? (match[field.group ?? 1] ?? null) : null;
    }
    default:
      return value;
  }
}

/** Extract a scalar field, honouring type pipelines and defaults. */
function extractSingle(element: Element, field: ExtractionField): ExtractedValue {
  let target: Element | null = element;
  if (field.selector) {
    target = element.querySelector(field.selector);
    if (!target) return field.default ?? null;
  }

  const steps = Array.isArray(field.type) ? field.type : [field.type];
  let value: StepValue = target;
  for (const step of steps) {
    value = applyStep(value, step, field);
    if (value === null || value === undefined) break;
  }

  if (value !== null && value !== undefined && field.transform) {
    value = applyTransform(value as ExtractedValue, field.transform);
  }
  return (value as ExtractedValue) ?? field.default ?? null;
}

/** Extract one field of any type against `element`. */
function extractField(element: Element, field: ExtractionField): ExtractedValue {
  try {
    let target: Element | null = element;
    if (field.source) {
      target = resolveSource(element, field.source);
      if (!target) return field.default ?? null;
    }

    if (field.type === 'nested') {
      const el = field.selector ? target!.querySelector(field.selector) : target;
      return el ? extractItem(el, field.fields ?? []) : {};
    }

    if (field.type === 'list') {
      const els = field.selector ? [...target!.querySelectorAll(field.selector)] : [target!];
      // Upstream's "list" is intentionally non-recursive: child fields are
      // scalars only. Use nested_list for sub-structure.
      return els.map((el) => {
        const item: ExtractedItem = {};
        for (const child of field.fields ?? []) {
          const value = extractSingle(el, child);
          if (value !== null) item[child.name] = value;
        }
        return item;
      });
    }

    if (field.type === 'nested_list') {
      const els = field.selector ? [...target!.querySelectorAll(field.selector)] : [target!];
      return els.map((el) => extractItem(el, field.fields ?? []));
    }

    if (field.type === 'computed') {
      // `expression` is unsupported by design; only a provided function runs.
      return typeof field.function === 'function' ? field.function(element) : (field.default ?? null);
    }

    return extractSingle(target!, field);
  } catch {
    return field.default ?? null;
  }
}

/** Extract every field of a schema against one base element. */
function extractItem(element: Element, fields: ExtractionField[]): ExtractedItem {
  const item: ExtractedItem = {};
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
 * @returns one object per matched base element; empties are dropped
 */
export function extractJsonCss(root: Document | Element, schema: ExtractionSchema): ExtractedItem[] {
  if (!schema?.baseSelector) throw new Error('Schema requires a baseSelector');
  if (!Array.isArray(schema.fields)) throw new Error('Schema requires a fields array');

  const out: ExtractedItem[] = [];
  for (const base of root.querySelectorAll(schema.baseSelector)) {
    const item: ExtractedItem = {};

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
export function validateSchema(schema: unknown): string[] {
  const errors: string[] = [];
  if (!schema || typeof schema !== 'object') return ['Schema must be an object'];

  const s = schema as Partial<ExtractionSchema>;
  if (!s.baseSelector) errors.push('Missing baseSelector');
  if (!Array.isArray(s.fields)) errors.push('Missing fields array');

  const walk = (fields: ExtractionField[] | undefined, path: string): void => {
    for (const [i, field] of (fields ?? []).entries()) {
      const at = `${path}[${i}]`;
      if (!field.name) errors.push(`${at}: missing name`);
      if (!field.type) errors.push(`${at}: missing type`);
      if (field.type === 'attribute' && !field.attribute) {
        errors.push(`${at}: type "attribute" requires an attribute name`);
      }
      if (['nested', 'list', 'nested_list'].includes(field.type as string) && !Array.isArray(field.fields)) {
        errors.push(`${at}: type "${field.type}" requires a fields array`);
      }
      if (field.type === 'computed' && (field as unknown as { expression?: string }).expression) {
        errors.push(`${at}: "expression" is unsupported for security reasons; use a function`);
      }
      if (Array.isArray(field.fields)) walk(field.fields, `${at}.fields`);
    }
  };
  walk(s.fields, 'fields');

  return errors;
}
