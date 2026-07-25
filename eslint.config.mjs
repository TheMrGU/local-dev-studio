// Correctness-only lint. No style rules — the point is catching the mistakes that
// a 3-minute smoke test would otherwise have to find, like a reference to a
// variable that a refactor removed.
import js from '@eslint/js';

const NODE_GLOBALS = {
  require: 'readonly', module: 'writable', exports: 'writable',
  process: 'readonly', console: 'readonly', Buffer: 'readonly',
  __dirname: 'readonly', __filename: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly', setImmediate: 'readonly', URL: 'readonly',
  AbortController: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
};

const BROWSER_GLOBALS = {
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', Event: 'readonly',
  URL: 'readonly', localStorage: 'readonly', fetch: 'readonly',
  location: 'readonly', getComputedStyle: 'readonly',
  requestAnimationFrame: 'readonly', CSS: 'readonly',
};

export default [
  { ignores: ['dist/**', 'node_modules/**', 'build/**'] },
  js.configs.recommended,
  {
    files: ['main.js', 'preload.js', 'lib/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: BROWSER_GLOBALS,
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
