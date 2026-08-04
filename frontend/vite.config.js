/**
 * Copyright (c) 2026 Gringa Radar. Todos os direitos reservados.
 * Build de produção: minify + sem source maps + ofuscação do JS.
 */
import { defineConfig, loadEnv } from 'vite';
import obfuscator from 'rollup-plugin-obfuscator';
import path from 'node:path';
import fs from 'node:fs';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    base: './',
    publicDir: false,
    build: {
      outDir: path.resolve(__dirname, '../app'),
      emptyOutDir: false,
      sourcemap: false,
      minify: 'terser',
      terserOptions: {
        compress: { drop_console: true, drop_debugger: true, passes: 2 },
        mangle: { toplevel: true },
        format: { comments: false },
      },
      rollupOptions: {
        plugins: [
          obfuscator({
            options: {
              compact: true,
              controlFlowFlattening: true,
              controlFlowFlatteningThreshold: 0.4,
              deadCodeInjection: false,
              debugProtection: false,
              disableConsoleOutput: true,
              identifierNamesGenerator: 'hexadecimal',
              renameGlobals: false,
              selfDefending: false,
              simplify: true,
              splitStrings: true,
              splitStringsChunkLength: 8,
              stringArray: true,
              stringArrayThreshold: 0.75,
              transformObjectKeys: false,
              unicodeEscapeSequence: false,
            },
          }),
        ],
        output: {
          entryFileNames: 'assets/app.[hash].js',
          chunkFileNames: 'assets/[name].[hash].js',
          assetFileNames: 'assets/[name].[hash][extname]',
        },
      },
    },
    define: {
      // Garante que URL/key existam no build (publishable — esperadas no cliente).
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(
        env.VITE_SUPABASE_URL || 'https://blnupzfgfhvykrgmvwhw.supabase.co',
      ),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(
        env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_gabCC-2dHNLezVN4VmyCJA_sONtVPg8',
      ),
    },
    plugins: [
      {
        name: 'preserve-static-assets',
        closeBundle() {
          // Mantém ZIP da extensão se existir (não faz parte do Vite).
          const zip = path.resolve(__dirname, '../app/extensao-gringa-radar.zip');
          if (!fs.existsSync(zip)) return;
        },
      },
    ],
  };
});
