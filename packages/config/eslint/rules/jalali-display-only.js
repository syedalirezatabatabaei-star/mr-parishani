// @ts-check

/**
 * Every date shown in the UI is Jalali (ADR-011; owner decision 1405/07/08): never
 * Gregorian or Hijri, on any page. In the web, admin and UI packages this rule forbids the
 * ways a date can reach the screen without the Jalali wrapper of @sepehr/contracts
 * (`formatJalaliDate`, `formatJalaliDateTime`, …) or the shared `Calendar`:
 *
 * - `toLocaleDateString()` and `toLocaleTimeString()`: a Gregorian (or locale-chosen) date;
 * - `Intl.DateTimeFormat`: formatting dates is the wrapper's job alone;
 * - `toISOString()`, `toUTCString()`, `toDateString()` or `toTimeString()` written into JSX,
 *   directly or through a template string: a raw Gregorian timestamp on the page.
 *
 * `toISOString()` elsewhere stays allowed: an API query, a key, or `<time dateTime={…}>`
 * (machine-readable by the HTML standard) is not shown.
 * `toLocaleString()` is not reported: without types it cannot be told apart from number
 * formatting.
 */

const LOCALE_DATE_METHODS = new Set(['toLocaleDateString', 'toLocaleTimeString']);
const RAW_DATE_METHODS = new Set(['toISOString', 'toUTCString', 'toDateString', 'toTimeString']);

/**
 * The name of the property a call calls, as in `x.name(...)`, or null.
 * @param {import('estree').CallExpression} node
 */
function calledProperty(node) {
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed) return null;
  return callee.property.type === 'Identifier' ? callee.property.name : null;
}

/**
 * Whether `node` is `Intl.DateTimeFormat`.
 * @param {import('estree').Node} node
 */
function isIntlDateTimeFormat(node) {
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.object.type === 'Identifier' &&
    node.object.name === 'Intl' &&
    node.property.type === 'Identifier' &&
    node.property.name === 'DateTimeFormat'
  );
}

/**
 * Whether a node sits inside JSX (a child or an attribute value), so its value is shown.
 * @param {import('eslint').Rule.Node} node
 */
function insideJsx(node) {
  /** @type {any} */
  let current = node.parent;
  while (current) {
    // <time dateTime={…}> is for machines (HTML requires ISO there); its content is shown.
    if (current.type === 'JSXAttribute') return current.name?.name !== 'dateTime';
    if (current.type === 'JSXExpressionContainer' && current.parent?.type !== 'JSXAttribute')
      return true;
    // A function boundary: what a callback computes is not necessarily shown.
    if (
      current.type === 'FunctionDeclaration' ||
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export const jalaliDisplayOnly = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Dates on screen only through the Jalali wrapper or the shared Calendar',
    },
    schema: [],
    messages: {
      localeDate:
        '`{{method}}()` shows a Gregorian date. Use formatJalaliDate / formatJalaliDateTime from @sepehr/contracts, or the Calendar (ADR-011).',
      intlDate:
        '`Intl.DateTimeFormat` formats dates outside the Jalali wrapper. Use formatJalaliDate / formatJalaliDateTime from @sepehr/contracts (ADR-011).',
      rawDate:
        '`{{method}}()` puts a raw Gregorian timestamp on the page. Format it with formatJalaliDate / formatJalaliDateTime from @sepehr/contracts (ADR-011).',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const method = calledProperty(node);
        if (method && LOCALE_DATE_METHODS.has(method)) {
          context.report({ node, messageId: 'localeDate', data: { method } });
        } else if (method && RAW_DATE_METHODS.has(method) && insideJsx(node)) {
          context.report({ node, messageId: 'rawDate', data: { method } });
        } else if (isIntlDateTimeFormat(node.callee)) {
          context.report({ node, messageId: 'intlDate' });
        }
      },
      NewExpression(node) {
        if (isIntlDateTimeFormat(node.callee)) context.report({ node, messageId: 'intlDate' });
      },
    };
  },
};
