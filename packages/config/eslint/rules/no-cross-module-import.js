// @ts-check
import path from 'node:path';

/**
 * Hard module boundary for apps/api/src/modules (ADR-002).
 *
 * A file inside modules/<a>/ may not import anything from modules/<b>/, for any b ≠ a —
 * not even the module's index.ts. Modules talk only through interfaces and tokens defined
 * in @sepehr/contracts and through domain events (transactional outbox).
 */

const MODULES_SEGMENT = /(?:^|\/)src\/modules\/([^/]+)\//;
const ALIASED_MODULE = /(?:^|\/)modules\/([^/.][^/]*)/;

/** @param {string} p */
const toPosix = (p) => p.replace(/\\/g, '/');

/**
 * Module that the file belongs to, or null if it is outside apps/api/src/modules.
 * @param {string} filename
 */
function moduleOfFile(filename) {
  return MODULES_SEGMENT.exec(toPosix(filename))?.[1] ?? null;
}

/**
 * Module the specifier points into, or null if it points elsewhere.
 * @param {string} specifier
 * @param {string} filename
 */
function moduleOfSpecifier(specifier, filename) {
  if (specifier.startsWith('.')) {
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(toPosix(filename)), specifier),
    );
    return moduleOfFile(`${resolved}/`);
  }
  // Path aliases such as `src/modules/x` or `@api/modules/x`.
  return ALIASED_MODULE.exec(specifier)?.[1] ?? null;
}

/** @type {import('eslint').Rule.RuleModule} */
export const noCrossModuleImport = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid any import between modules in apps/api/src/modules',
    },
    schema: [],
    messages: {
      crossModule:
        "Module '{{from}}' must not import from module '{{to}}'. Use interfaces and tokens from @sepehr/contracts, or a domain event.",
    },
  },
  create(context) {
    const filename = context.filename;
    const from = moduleOfFile(filename);
    if (from === null) return {};

    /** @param {import('estree').Node | null | undefined} source */
    function check(source) {
      if (!source || source.type !== 'Literal' || typeof source.value !== 'string') return;
      const to = moduleOfSpecifier(source.value, filename);
      if (to !== null && to !== from) {
        context.report({ node: source, messageId: 'crossModule', data: { from, to } });
      }
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          const arg = node.arguments[0];
          if (arg && arg.type !== 'SpreadElement') check(arg);
        }
      },
      /** @param {any} node TSImportEqualsDeclaration: `import x = require('...')` */
      TSExternalModuleReference(node) {
        check(node.expression);
      },
    };
  },
};
