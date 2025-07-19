import typescript from '@rollup/plugin-typescript';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

export default {
  input: 'main.ts',
  output: {
    dir: '.',
    sourcemap: 'inline',
    format: 'cjs',
    exports: 'default',
  },
  external: ['obsidian'],

  // --- ADD THIS ENTIRE BLOCK ---
  // This is a more specific fix for the "this is undefined" warning.
  // It tells Rollup to use 'window' as the context for only the problematic modules.
  moduleContext: (id) => {
    if (id.includes('@msgpack')) {
      return 'window';
    }
    return 'undefined'; // The default behavior for all other modules
  },
  // -----------------------------

  plugins: [
    typescript(),
    nodeResolve({ browser: true }),
    commonjs(),
  ]
};