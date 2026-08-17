import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-codex'
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@monotykamary/cordis',
  '@monotykamary/dsh-client-runtime/client',
  '@monotykamary/dsh-client-ui-attachment',
  '@monotykamary/dsh-client-ui-primitives',
] as const

export default [
  {
    entry: {
      index: 'src/index.ts',
      invariant: 'src/invariant.ts',
      tui: 'src/tui.ts',
      bin: 'src/bin.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: {
      neverBundle: [
        '@earendil-works/pi-ai',
        '@monotykamary/schemastery',
        '@monotykamary/cordis',
        '@monotykamary/dsh-agent',
        '@monotykamary/dsh-attachment',
        '@monotykamary/dsh-commands',
        '@monotykamary/dsh-fs',
        '@monotykamary/dsh-host-webserver',
        '@monotykamary/dsh-invariants',
        '@monotykamary/dsh-llm',
        '@monotykamary/dsh-llm-pi-ai',
        '@monotykamary/dsh-session',
        '@monotykamary/dsh-tools',
        '@monotykamary/dsh-web',
      ],
    },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
