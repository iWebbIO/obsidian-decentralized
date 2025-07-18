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

  moduleContext: (id) => {
    if (id.includes('@msgpack')) {
      return 'window';
    }
    return 'undefined';
  },

  plugins: [
    typescript(),
    nodeResolve({ browser: true }),
    commonjs(),
  ]
};
