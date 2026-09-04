import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: 'src/index.js',
    format: ['esm'],
    dts: true,
    outDir: 'lib',
    platform: 'node',
    external: ['pdfjs-dist'],
  },
  {
    entry: 'src/client/index.ts',
    format: ['esm'],
    dts: { resolve: true },
    outDir: 'client',
    platform: 'browser',
    external: [
      'react',
      'react-dom',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-store',
    ],
    globals: {
      react: 'React',
      'react-dom': 'ReactDOM',
    },
  },
])