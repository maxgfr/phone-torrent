import globals from 'globals';

export default [
  {
    files: ['app.js', 'saver.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none' }],
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-constant-condition': 'warn',
      eqeqeq: 'error',
    },
  },
  {
    files: ['sw.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.serviceworker } },
    rules: { 'no-undef': 'error', 'no-unused-vars': 'error', 'no-unreachable': 'error', eqeqeq: 'error' },
  },
  {
    files: ['proxy/cloudflare-worker.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.serviceworker } },
    rules: { 'no-undef': 'error', 'no-unused-vars': 'error', 'no-unreachable': 'error' },
  },
  {
    files: ['test/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { args: 'none' }], 'no-unreachable': 'error' },
  },
];
