import * as esbuild from 'esbuild';

const isProduction = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const sharedOptions = {
  bundle: true,
  minify: isProduction,
  sourcemap: !isProduction,
  logLevel: 'info',
};

const buildTargets = [
  {
    ...sharedOptions,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...sharedOptions,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
  {
    ...sharedOptions,
    entryPoints: ['src/lyricsWebview/main.ts'],
    outfile: 'dist/lyrics.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
];

if (isWatch) {
  const contexts = await Promise.all(buildTargets.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(buildTargets.map((options) => esbuild.build(options)));
}
