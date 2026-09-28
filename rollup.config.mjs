import typescript from '@rollup/plugin-typescript';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);

const isProd = (process.env.BUILD === 'production');

/**
 * Node builtins, all of them reachable only through `ws`. They exist in Obsidian desktop's
 * Electron runtime and must not be bundled — but they must not be *imported* either, see
 * `ignore` below.
 */
const NODE_BUILTINS = [
  'os', 'http', 'dgram', 'events',
  'net', 'tls', 'https', 'url', 'crypto', 'zlib', 'stream', 'util', 'buffer',
];

/**
 * `ws` declares a "browser" field pointing at a stub whose only job is to throw. With
 * nodeResolve({browser: true}) that stub is what gets bundled — it builds cleanly and then
 * fails at runtime. Resolve `ws` to its Node entry explicitly instead. Flipping `browser`
 * off globally is not an option: peerjs, qrcode and html5-qrcode all want browser builds.
 */
const wsNodeEntry = {
  name: 'ws-node-entry',
  resolveId(source) {
    return source === 'ws' ? require.resolve('ws') : null;
  },
};

/**
 * Obsidian mobile has no Node runtime, so a single `require("events")` reached during module
 * evaluation throws MODULE_NOT_FOUND and the plugin silently refuses to enable — which is
 * exactly what shipping `ws` for Offline Host mode did. Everything Node-flavoured must
 * therefore stay inside a function body that only desktop ever calls.
 *
 * Rollup happily undoes that on its own: it hoists external imports to the top of the bundle,
 * evaluates the namespace of an inlined dynamic import eagerly, and converts CJS files to
 * plain ES modules whose bodies then run at load. The `ignore` + `strictRequires` settings on
 * the commonjs plugin, ws-loader.js, and this guard exist to hold that line together, so
 * verify with `npm run test:mobile-load` before shipping any change to them.
 */
const assertNoEagerNodeRequires = {
  name: 'assert-no-eager-node-requires',
  renderChunk(code) {
    // Every legitimate builtin require now sits inside a function, so any that survives at the
    // very top of the chunk is a regression. A prefix window is enough: rollup puts hoisted
    // externals and eager module bodies first, and the plugin's own code opens the bundle.
    const builtins = NODE_BUILTINS.join('|');
    const hoisted = new RegExp(`^[\\s\\S]{0,400}?\\brequire\\((['"])(?:${builtins})\\1\\)`);
    if (hoisted.test(code)) {
      throw new Error(
        'A Node builtin is required at the top of the bundle. Obsidian mobile has no Node, so '
        + 'the plugin would fail to load there. See the commonjs `ignore`/`strictRequires` '
        + 'settings in rollup.config.mjs.',
      );
    }
    return null;
  },
};

/**
 * Obsidian loads a plugin from a folder holding main.js + manifest.json + styles.css, so dist/
 * is made directly installable rather than leaving the two static files behind at the repo root.
 */
const copyPluginAssets = {
  name: 'copy-plugin-assets',
  writeBundle() {
    mkdirSync('dist', { recursive: true });
    for (const file of ['manifest.json', 'styles.css']) {
      copyFileSync(file, `dist/${file}`);
    }
  },
};

export default {
  input: 'src/main.ts',
  output: {
    file: 'dist/main.js',
    // Obsidian's community-plugin installer only fetches main.js/manifest.json/
    // styles.css, so the plugin must be a single self-contained file. Dynamic
    // imports are inlined and merely deferred in evaluation, never split out.
    inlineDynamicImports: true,
    // Inline maps are ~2.2 MB and were previously shipped in production builds.
    sourcemap: isProd ? false : 'inline',
    sourcemapExcludeSources: isProd,
    format: 'cjs',
    exports: 'default',
  },
  // bufferutil and utf-8-validate are ws's optional native accelerators: they are not
  // installed, and ws already requires them inside try/catch, so leaving them unresolved is
  // the intended path.
  external: [
    'obsidian',
    'bufferutil', 'utf-8-validate',
  ],
  plugins: [
    wsNodeEntry,
    // tsconfig enables inlineSourceMap for editor tooling; production must override
    // it or ~2.2 MB of mappings end up in the shipped bundle.
    typescript({
      sourceMap: !isProd,
      inlineSourceMap: !isProd,
      inlineSources: !isProd,
    }),
    nodeResolve({
      browser: true,
    }),
    commonjs({
      transformMixedEsModules: true,
      // Leave `require("net")` & co. exactly where they are written. Listing them as rollup
      // externals instead makes rollup hoist them into the bundle's first statement, above
      // every guard, which is what broke mobile. Unconverted they stay inside the ws function
      // bodies below and hand back the genuine module object — no interop shim in between.
      ignore: NODE_BUILTINS,
      // Left alone, the plugin converts most of `ws` to plain ES modules whose bodies run at
      // bundle load; ws/lib/validation.js then destructures require('buffer') at module scope.
      // strictRequires keeps these files' requires in place and wraps the required modules in
      // lazy factories, so ws first executes at the loadWs() call in DirectIpServer.start().
      // Scoped rather than global: turning it on for peerjs/qrcode/html5-qrcode as well would
      // be a needless behaviour change.
      strictRequires: [/node_modules[\\/]ws[\\/]/, /ws-loader\.js$/],
    }),
    isProd && terser({
      // 'pure' drops console calls whose result is unused (log/info/warn) while
      // keeping side-effect-bearing ones — an unrecoverable bind failure used to
      // console.error + console.log every 10 s forever in production builds.
      compress: { drop_console: 'pure' },
      format: { comments: false },
    }),
    assertNoEagerNodeRequires,
    copyPluginAssets,
  ].filter(Boolean),
  onwarn(warning, warn) {
    if (warning.code === 'THIS_IS_UNDEFINED') {
      return;
    }
    warn(warning);
  }
};
