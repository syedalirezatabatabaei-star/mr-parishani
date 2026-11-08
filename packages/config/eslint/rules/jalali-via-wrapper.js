// @ts-check

/**
 * Jalali dates are the basis of due dates and schedules, so every Jalali conversion goes
 * through the one wrapper in @sepehr/contracts. This rule forbids the ways around it:
 *
 * - importing jalaali-js (or another Jalali library) anywhere but the wrapper itself;
 * - asking Intl for the Persian calendar (`calendar: 'persian'`, `-u-ca-persian`);
 * - formatting dates with a Persian locale, whose default calendar is Persian
 *   (`new Intl.DateTimeFormat('fa-IR')`, `date.toLocaleDateString('fa')`).
 *
 * The wrapper and its Intl cross-check test turn this rule off for their own files.
 * `toLocaleString('fa-IR')` is not reported: without types it cannot be told apart from
 * number formatting.
 */

const JALALI_LIBRARIES = [
  'jalaali-js',
  'moment-jalaali',
  'jalali-moment',
  'date-fns-jalali',
  'jalaliday',
  'persian-date',
  '@persian-tools/persian-tools',
];

/** @param {string} specifier */
const isJalaliLibrary = (specifier) =>
  JALALI_LIBRARIES.some((lib) => specifier === lib || specifier.startsWith(`${lib}/`));

/**
 * The calendar a BCP 47 locale tag selects through its Unicode extension
 * (`fa-IR-u-nu-latn-ca-persian` → `persian`), or null if it selects none.
 * @param {string} tag
 */
function unicodeCalendar(tag) {
  const subtags = tag.toLowerCase().split('-');
  const start = subtags.indexOf('u');
  if (start < 0) return null;
  for (let i = start + 1; i < subtags.length; i++) {
    const subtag = subtags[i] ?? '';
    if (subtag.length === 1) return null; // the next singleton ends the -u- extension
    if (subtag === 'ca') return subtags[i + 1] ?? null;
  }
  return null;
}

/**
 * `fa` and its regional variants use the Persian calendar unless the tag picks another.
 * @param {string} locale
 */
const selectsPersianCalendar = (locale) => {
  const language = locale.toLowerCase().split('-')[0];
  return language === 'fa' && unicodeCalendar(locale) === null;
};

/** @param {import('estree').Node | undefined} node */
function stringValue(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/**
 * Locale strings passed as the first argument (a string or an array of strings).
 * @param {import('estree').Node | undefined} node
 */
function localeStrings(node) {
  if (node?.type === 'ArrayExpression') {
    return node.elements.flatMap((el) => {
      const value = el && el.type !== 'SpreadElement' ? stringValue(el) : null;
      return value === null ? [] : [value];
    });
  }
  const value = stringValue(node);
  return value === null ? [] : [value];
}

/**
 * True when an options object sets `calendar` to a literal value.
 * @param {import('estree').Node | undefined} node
 */
function setsCalendar(node) {
  if (node?.type !== 'ObjectExpression') return false;
  return node.properties.some((prop) => {
    if (prop.type !== 'Property') return false;
    const key =
      prop.key.type === 'Identifier' && !prop.computed ? prop.key.name : stringValue(prop.key);
    return key === 'calendar' && stringValue(prop.value) !== null;
  });
}

/**
 * `Intl.DateTimeFormat` or `DateTimeFormat` (after destructuring).
 * @param {import('estree').Node} callee
 */
function isDateTimeFormat(callee) {
  if (callee.type === 'Identifier') return callee.name === 'DateTimeFormat';
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'DateTimeFormat'
  );
}

/** @param {import('estree').Node} callee */
function isToLocaleDateString(callee) {
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'toLocaleDateString'
  );
}

/** @type {import('eslint').Rule.RuleModule} */
export const jalaliViaWrapper = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require every Jalali date conversion to go through the @sepehr/contracts wrapper',
    },
    schema: [],
    messages: {
      library: "Do not import '{{name}}'. Use the Jalali helpers exported by @sepehr/contracts.",
      intlCalendar:
        "Do not use Intl's Persian calendar. Use the Jalali helpers exported by @sepehr/contracts.",
      persianLocale:
        "Formatting a date with locale '{{locale}}' uses Intl's Persian calendar. Use formatJalaliDate or formatJalaliDateTime from @sepehr/contracts.",
    },
  },
  create(context) {
    /** @param {import('estree').Node | null | undefined} source */
    function checkSource(source) {
      const name = source ? stringValue(source) : null;
      if (source && name !== null && isJalaliLibrary(name)) {
        context.report({ node: source, messageId: 'library', data: { name } });
      }
    }

    /**
     * @param {import('estree').Node} callee
     * @param {import('estree').Node[]} args
     */
    function checkLocaleCall(callee, args) {
      if (!isDateTimeFormat(callee) && !isToLocaleDateString(callee)) return;
      const [first, options] = args;
      if (!first || first.type === 'SpreadElement') return;
      // An explicit calendar in the options wins over the locale's default. A Persian one
      // is reported by the Property visitor.
      if (setsCalendar(options)) return;
      for (const locale of localeStrings(first)) {
        if (selectsPersianCalendar(locale)) {
          context.report({ node: first, messageId: 'persianLocale', data: { locale } });
        }
      }
    }

    return {
      ImportDeclaration: (node) => checkSource(node.source),
      ExportNamedDeclaration: (node) => checkSource(node.source),
      ExportAllDeclaration: (node) => checkSource(node.source),
      ImportExpression: (node) => checkSource(node.source),
      /** @param {any} node TSImportEqualsDeclaration: `import x = require('...')` */
      TSExternalModuleReference(node) {
        checkSource(node.expression);
      },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          const arg = node.arguments[0];
          if (arg && arg.type !== 'SpreadElement') checkSource(arg);
        }
        checkLocaleCall(node.callee, /** @type {import('estree').Node[]} */ (node.arguments));
      },
      NewExpression(node) {
        checkLocaleCall(node.callee, /** @type {import('estree').Node[]} */ (node.arguments));
      },
      // `{ calendar: 'persian' }` in Intl options.
      Property(node) {
        const key =
          node.key.type === 'Identifier' && !node.computed ? node.key.name : stringValue(node.key);
        if (key === 'calendar' && stringValue(node.value)?.toLowerCase() === 'persian') {
          context.report({ node, messageId: 'intlCalendar' });
        }
      },
      // `'fa-IR-u-ca-persian'` anywhere.
      Literal(node) {
        if (typeof node.value === 'string' && unicodeCalendar(node.value) === 'persian') {
          context.report({ node, messageId: 'intlCalendar' });
        }
      },
    };
  },
};
