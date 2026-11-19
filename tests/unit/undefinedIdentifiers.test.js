// Every name the app's source refers to must actually be declared somewhere in its file.
//
// This exists because a release shipped with `groupPhotoOn` referenced in an effect after the declaration
// had been renamed, and nothing caught it: `vite build` bundles happily, since an undeclared identifier is
// a perfectly legal reference to a global that might exist at runtime. It does not exist, so opening the
// group attendance dialog threw a ReferenceError and rendered a blank white page. A unit test cannot
// render every screen, but it can read every file and insist that the names add up.
//
// The check is per file rather than per lexical scope, which means it under-reports -- a name declared in
// one function and used in a sibling function is accepted -- but it never reports a correctly declared
// name, so it cannot become noise that gets switched off.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(ROOT, 'src');

// Names vite replaces at build time (vite.config.js `define`). Read from the config so that adding one
// does not mean remembering to add it here as well.
const DEFINES = new Set(
  [...readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8').matchAll(/\b(__[A-Z0-9_]+__)\b/g)].map((m) => m[1]),
);

// Names the browser, the bundler or the language provides.
const GLOBALS = new Set([
  'globalThis', 'window', 'document', 'navigator', 'location', 'history', 'screen', 'console',
  'fetch', 'Request', 'Response', 'Headers', 'FormData', 'URL', 'URLSearchParams', 'Blob', 'File',
  'FileReader', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'AbortController', 'AbortSignal',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'queueMicrotask', 'structuredClone', 'reportError',
  'Image', 'Audio', 'Video', 'Option', 'Event', 'CustomEvent', 'MessageChannel', 'BroadcastChannel',
  'ResizeObserver', 'IntersectionObserver', 'MutationObserver', 'PerformanceObserver', 'performance',
  'crypto', 'localStorage', 'sessionStorage', 'indexedDB', 'IDBKeyRange', 'caches', 'Notification',
  'matchMedia', 'getComputedStyle', 'alert', 'confirm', 'prompt', 'atob', 'btoa',
  'Worker', 'SharedWorker', 'ServiceWorker', 'MediaRecorder', 'MediaStream', 'DOMParser', 'XPathResult',
  'OffscreenCanvas', 'createImageBitmap', 'ImageData', 'Path2File', 'CanvasRenderingContext2D',
  'TextEncoder', 'TextDecoder', 'ReadableStream', 'WritableStream', 'TransformStream', 'CompressionStream',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
  'AggregateError', 'Promise', 'Proxy', 'Reflect', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'Intl',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
  'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'NaN', 'Infinity', 'undefined', 'eval',
  'process', 'Buffer', 'require', 'module', 'exports', '__dirname', '__filename',
  'self', 'importScripts', 'clients', 'skipWaiting', 'registration',
]);

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(js|jsx)$/.test(name) ? [full] : [];
  });
}

// Walks every node in the tree, calling visit(node, parent, key).
function walk(node, visit, parent = null, key = null) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, parent, key);
    return;
  }
  if (typeof node.type !== 'string') return;
  visit(node, parent, key);
  for (const [k, value] of Object.entries(node)) {
    if (k === 'type' || k === 'loc' || k === 'range' || k === 'leadingComments' || k === 'trailingComments') continue;
    walk(value, visit, node, k);
  }
}

// Every name a binding pattern introduces (`const { a, b: [c] } = x`, `(a = 1, ...rest) => {}`).
function bound(node, out) {
  if (!node || typeof node !== 'object') return;
  switch (node.type) {
    case 'Identifier': out.add(node.name); break;
    case 'ObjectPattern': node.properties.forEach((p) => bound(p.type === 'RestElement' ? p.argument : p.value, out)); break;
    case 'ArrayPattern': node.elements.forEach((e) => bound(e, out)); break;
    case 'AssignmentPattern': bound(node.left, out); break;
    case 'RestElement': bound(node.argument, out); break;
    default: break;
  }
}

function analyse(code) {
  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'classProperties', 'classPrivateProperties', 'optionalChaining', 'nullishCoalescingOperator',
      'logicalAssignment', 'topLevelAwait', 'importMeta', 'dynamicImport', 'objectRestSpread'],
  });

  const declared = new Set();
  const referenced = new Map();   // name -> first line

  walk(ast, (node, parent, key) => {
    switch (node.type) {
      case 'VariableDeclarator': bound(node.id, declared); return;
      // Babel gives methods their own node types, so their parameters need collecting here too --
      // `subscribe(listener)` in an object literal and `constructor(code, message)` in a class are not
      // FunctionExpressions.
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'ClassMethod':
      case 'ClassPrivateMethod':
      case 'ObjectMethod':
        if (node.id) declared.add(node.id.name);
        (node.params ?? []).forEach((p) => bound(p, declared));
        return;
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.id) declared.add(node.id.name);
        return;
      case 'CatchClause': bound(node.param, declared); return;
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
      case 'ImportSpecifier': declared.add(node.local.name); return;
      default: break;
    }

    if (node.type !== 'Identifier') return;
    // Positions where an Identifier is a name, not a reference to a value.
    if (!parent) return;
    if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return;
    if (parent.type === 'OptionalMemberExpression' && key === 'property' && !parent.computed) return;
    if ((parent.type === 'ObjectProperty' || parent.type === 'Property') && key === 'key' && !parent.computed) return;
    if (parent.type === 'ClassProperty' || parent.type === 'ClassMethod' || parent.type === 'ObjectMethod') {
      if (key === 'key' && !parent.computed) return;
    }
    if (parent.type === 'JSXAttribute' && key === 'name') return;
    if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return;
    if (parent.type === 'ExportSpecifier' || parent.type === 'ImportAttribute') return;
    // Both halves of `import { a as b }` are names: `b` is already recorded as declared, and `a` belongs
    // to the module being imported from.
    if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier'
      || parent.type === 'ImportNamespaceSpecifier') return;
    if (parent.type === 'MetaProperty') return;
    referenced.set(node.name, referenced.get(node.name) ?? node.loc?.start?.line);
  });

  // JSX element names: <Dialog /> references Dialog, <div /> does not, and <Ctx.Provider> references
  // only Ctx -- the member name after the dot is a property, exactly as in any member expression.
  walk(ast, (node, parent, key) => {
    if (node.type !== 'JSXIdentifier') return;
    if (/^[a-z]/.test(node.name)) return;   // an intrinsic tag, not a binding
    if (parent?.type === 'JSXMemberExpression' && key === 'property') return;
    if (parent?.type === 'JSXAttribute' && key === 'name') return;
    if (parent?.type === 'JSXNamespacedName') return;
    referenced.set(node.name, referenced.get(node.name) ?? node.loc?.start?.line);
  });

  return [...referenced].filter(([name]) => !declared.has(name) && !GLOBALS.has(name) && !DEFINES.has(name));
}

describe('every referenced name is declared', () => {
  const sources = files(SRC);

  it('reads the whole of src/', () => {
    expect(sources.length).toBeGreaterThan(30);
  });

  it.each(sources.map((f) => [path.relative(SRC, f), f]))('%s', (rel, full) => {
    const missing = analyse(readFileSync(full, 'utf8'));
    expect(missing.map(([name, line]) => `${name} (line ${line})`)).toEqual([]);
  });
});
