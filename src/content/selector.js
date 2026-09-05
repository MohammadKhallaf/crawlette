/**
 * Selector inference for the visual picker.
 *
 * The user clicks one example of the thing they want; we work out a CSS
 * selector that matches all of its siblings. Getting this right is what makes
 * the picker usable, so the logic lives here on its own and is unit tested --
 * it is pure DOM reasoning with no browser interaction.
 *
 * The hard part is choosing classes. Modern sites mix three kinds:
 *   - component classes ("speaker-card")      -- exactly what we want
 *   - utility classes ("flex gap-4 text-sm")  -- meaningless on their own
 *   - hashed/scoped classes ("css-1x2y3z")    -- change on every deploy
 * We prefer the first and reject the last two.
 */

/** Classes that carry no meaning or will not survive a rebuild. */
const HASHED = [
  /^css-[a-z0-9]{4,}$/i,        // emotion / styled-components
  /^sc-[a-zA-Z0-9]{5,}$/,       // styled-components
  /^[a-z]+_[a-zA-Z0-9]{5,}$/,   // CSS modules
  /^jsx-\d+$/,                  // styled-jsx
  /^svelte-[a-z0-9]+$/,
  /^_[a-zA-Z0-9]{5,}$/,
  /^[a-z0-9]{8,}$/i,            // bare hashes
];

/**
 * Tailwind-shaped utilities: layout noise, not identity.
 *
 * Note the trailing `\S*` on the layout words. An earlier version listed bare
 * `flex`, which let `flex-col` through and made it the chosen selector on a
 * real page -- utilities must be matched as families, not exact words.
 */
const UTILITY = new RegExp(
  '^(?:'
  // layout families, including their modifiers (flex-col, grid-cols-3, ...)
  + 'flex\\S*|grid\\S*|block|inline\\S*|hidden|absolute|relative|fixed|sticky|static'
  + '|contents|isolate|float-\\S+|clear-\\S+|box-\\S+|container|antialiased'
  // spacing and sizing
  + '|[mp][trblxyse]?-\\S+|-[mp][trblxyse]?-\\S+|gap\\S*|space-\\S+|inset\\S*'
  + '|[whz]-\\S+|min-\\S+|max-\\S+|size-\\S+|basis-\\S+|grow\\S*|shrink\\S*'
  // typography
  + '|text-\\S+|font-\\S+|leading-\\S+|tracking-\\S+|align-\\S+|whitespace-\\S+'
  + '|uppercase|lowercase|capitalize|normal-case|italic|not-italic|underline|no-underline'
  + '|line-through|truncate|break-\\S+|indent-\\S+|list-\\S+'
  // colour, borders, effects
  + '|bg-\\S+|border\\S*|rounded\\S*|shadow\\S*|opacity-\\S+|ring\\S*|outline\\S*'
  + '|divide-\\S+|from-\\S+|via-\\S+|to-\\S+|fill-\\S+|stroke-\\S+|backdrop-\\S+'
  // interaction and motion
  + '|cursor-\\S+|pointer-events-\\S+|select-\\S+|transition\\S*|duration-\\S+'
  + '|ease-\\S+|delay-\\S+|animate-\\S+|transform|scale-\\S+|rotate-\\S+|translate-\\S+'
  // alignment
  + '|items-\\S+|justify-\\S+|content-\\S+|self-\\S+|place-\\S+|order-\\S+'
  + '|col-\\S+|row-\\S+|object-\\S+|aspect-\\S+|overflow-\\S+|overscroll-\\S+'
  + '|visible|invisible|sr-only|not-sr-only|group|peer'
  // variant prefixes: md:flex, hover:bg-red, dark:text-white, lg:gap-4
  + '|(?:sm|md|lg|xl|2xl|hover|focus|active|group-hover|dark|first|last|odd|even|disabled):\\S+'
  + ')$',
);

/** Is this class worth putting in a selector? */
export function isMeaningfulClass(name) {
  if (!name || name.length < 2) return false;
  if (UTILITY.test(name)) return false;
  if (HASHED.some((re) => re.test(name))) return false;
  // Bare digits or near-random strings with no separator are rarely semantic.
  if (/^\d/.test(name)) return false;
  return true;
}

/** Meaningful classes on an element, best-looking first. */
export function meaningfulClasses(el) {
  const classes = (el.getAttribute?.('class') || '').split(/\s+/).filter(Boolean);
  return classes
    .filter(isMeaningfulClass)
    // A hyphenated, wordy class is far more likely to be a component name.
    .sort((a, b) => (b.includes('-') ? 1 : 0) - (a.includes('-') ? 1 : 0) || a.length - b.length);
}

/** Escape a class name for use in a selector. */
const esc = (name) => name.replace(/([^a-zA-Z0-9_-])/g, '\\$1');

/** How many elements a selector matches in `root`. */
function countMatches(root, selector) {
  try {
    return root.querySelectorAll(selector).length;
  } catch {
    return 0; // an invalid selector matches nothing
  }
}

/**
 * Find the element the user probably meant.
 *
 * A click lands on whatever is under the cursor -- usually a heading or a span
 * deep inside a card -- but they mean the card, because that is what holds all
 * the fields.
 *
 * The rule: walk outward while the match count stays the SAME, and stop when it
 * changes. That yields the largest element still corresponding one-to-one with
 * the thing clicked. On a quotes page, `span.text` (10) and `div.quote` (10)
 * share a count so we expand to the quote, but `div.row` (2) groups several
 * quotes together, so we stop before it. Taking the outermost match instead
 * returned `div.row` and lost 8 of every 10 items.
 */
export function findRepeatingContainer(el, root = el.ownerDocument) {
  let best = null;
  let node = el;

  for (let depth = 0; node && node !== root.body && depth < 8; depth += 1) {
    const classes = meaningfulClasses(node);
    if (classes.length) {
      const selector = `${node.tagName.toLowerCase()}.${esc(classes[0])}`;
      const count = countMatches(root, selector);

      if (count >= 2 && count <= 5000) {
        if (!best) {
          best = { node, selector, count };
        } else if (count === best.count) {
          best = { node, selector, count }; // same set, bigger element: prefer it
        } else {
          break;                            // a different grouping: stop here
        }
      }
    }
    node = node.parentElement;
  }
  return best;
}

/**
 * Nearest ancestor carrying a meaningful class, however many it matches.
 *
 * Detail pages hold ONE record, so nothing repeats and
 * `findRepeatingContainer` finds nothing -- but the page still has a perfectly
 * good container like `.speaker-detail` a few levels up. Without this, clicking
 * a heading whose own classes are all utilities falls through to a brittle
 * nth-of-type path.
 */
export function findMeaningfulAncestor(el, root = el.ownerDocument) {
  let node = el;
  for (let depth = 0; node && node !== root.body && depth < 8; depth += 1) {
    const classes = meaningfulClasses(node);
    if (classes.length) {
      const selector = `${node.tagName.toLowerCase()}.${esc(classes[0])}`;
      const count = countMatches(root, selector);
      if (count >= 1) return { node, selector, count };
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Infer a selector for the element the user clicked.
 *
 * Order matters: a repeating container is the best answer for a list, a
 * meaningful ancestor is the best answer for a single-record detail page, and
 * the structural path is a last resort because it breaks on any redesign.
 *
 * @returns {{selector: string, count: number, element: Element}|null}
 */
export function inferSelector(el, root = el.ownerDocument) {
  if (!el || !el.tagName) return null;

  const repeating = findRepeatingContainer(el, root);
  if (repeating) return { selector: repeating.selector, count: repeating.count, element: repeating.node };

  const ancestor = findMeaningfulAncestor(el, root);
  if (ancestor) return { selector: ancestor.selector, count: ancestor.count, element: ancestor.node };

  if (el.id) {
    const selector = `#${esc(el.id)}`;
    return { selector, count: countMatches(root, selector), element: el };
  }

  return { selector: pathSelector(el, root), count: 1, element: el };
}

/**
 * Last resort: a structural path.
 *
 * Brittle across redesigns, so only used when an element has nothing stable to
 * identify it by.
 */
export function pathSelector(el, root = el.ownerDocument) {
  const parts = [];
  let node = el;

  while (node && node !== root.body && node.tagName) {
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (!parent) { parts.unshift(tag); break; }

    const siblings = [...parent.children].filter((c) => c.tagName === node.tagName);
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
    node = parent;
  }
  return parts.join(' > ');
}

/**
 * Suggest fields for a schema by looking at what one example contains.
 *
 * Saves the user hand-writing selectors for the obvious pieces: a heading, a
 * link, an image. They can prune what they do not want.
 */
export function suggestFields(el) {
  const fields = [];
  const seen = new Set();

  const add = (name, selector, type, attribute) => {
    if (seen.has(name)) return;
    seen.add(name);
    fields.push(attribute ? { name, selector, type, attribute } : { name, selector, type });
  };

  const heading = el.querySelector('h1, h2, h3, h4, [class*="title" i], [class*="name" i]');
  if (heading) {
    const cls = meaningfulClasses(heading)[0];
    add('title', cls ? `${heading.tagName.toLowerCase()}.${esc(cls)}` : heading.tagName.toLowerCase(), 'text');
  }

  const link = el.querySelector('a[href]');
  if (link) add('url', 'a[href]', 'attribute', 'href');

  const img = el.querySelector('img[src]');
  if (img) add('image', 'img', 'attribute', 'src');

  // A paragraph that is not the heading is usually the description or role.
  const para = el.querySelector('p');
  if (para && para !== heading) {
    const cls = meaningfulClasses(para)[0];
    add('description', cls ? `p.${esc(cls)}` : 'p', 'text');
  }

  return fields;
}

/** Build a complete, runnable schema from one clicked example. */
export function buildSchema(el, root = el.ownerDocument) {
  const inferred = inferSelector(el, root);
  if (!inferred) return null;

  const fields = suggestFields(inferred.element);
  return {
    schema: {
      name: 'Picked items',
      baseSelector: inferred.selector,
      fields: fields.length ? fields : [{ name: 'text', type: 'text' }],
    },
    count: inferred.count,
  };
}
