/**
 * Copyright (c) 2026 Gringa Radar. Todos os direitos reservados.
 * Build de produção: minify + sem source maps.
 * Sem javascript-obfuscator: splitStrings/stringArray corrompiam UTF-8 (pt-BR).
 */
import { defineConfig, loadEnv } from 'vite';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    base: './',
    publicDir: false,
    build: {
      outDir: path.resolve(__dirname, '../app'),
      emptyOutDir: true,
      sourcemap: false,
      minify: 'terser',
      terserOptions: {
        compress: { drop_console: true, drop_debugger: true, passes: 2 },
        mangle: { toplevel: true },
        format: {
          comments: false,
          // Garante literais UTF-8 no bundle (não \\uXXXX).
          ascii_only: false,
        },
      },
      rollupOptions: {
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
  };
});
