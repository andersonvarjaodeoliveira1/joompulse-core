/**
 * Copyright (c) 2026 Gringa Radar. Todos os direitos reservados.
 * Extrai CSS/JS do monolito app/index.html para o projeto Vite em frontend/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const srcHtml = path.join(root, 'app', 'index.html');
const outDir = path.join(root, 'frontend');

let html;
const cache = path.join(outDir, '.cache', 'monolith.html');
const appIsBuild = (() => {
  try {
    const cur = fs.readFileSync(srcHtml, 'utf8');
    return cur.includes('assets/app.') && !cur.includes('<script type="module">');
  } catch { return true; }
})();

if (fs.existsSync(cache)) {
  html = fs.readFileSync(cache, 'utf8');
  console.log('usando frontend/.cache/monolith.html');
} else if (!appIsBuild) {
  html = fs.readFileSync(srcHtml, 'utf8');
} else {
  console.error('app/index.html já é build e não há frontend/.cache/monolith.html');
  process.exit(1);
}

// Guarda monolito limpo se ainda não existir cache
if (!fs.existsSync(cache) && html.includes('<script type="module">')) {
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, html, 'utf8');
}

const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/i);
const scriptMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/i);

if (!styleMatch || !scriptMatch) {
  console.error('Não achei <style> ou <script type="module"> no HTML fonte');
  process.exit(1);
}

let js = scriptMatch[1];
js = js.replace(
  /import\s*\{\s*createClient\s*\}\s*from\s*['"]https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2\/\+esm['"];?/,
  "import { createClient } from '@supabase/supabase-js';",
);
js = js.replace(
  /const sb = createClient\(\s*['"]https:\/\/[^'"]+['"]\s*,\s*['"][^'"]+['"]\s*\);/,
  `const sb = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);`,
);
js = "import './styles.css';\n" + js;

// Markup: remove head-ish + style + script
let markup = html
  .replace(/<!doctype html>/ig, '')
  .replace(/<html[^>]*>/ig, '')
  .replace(/<\/html>/ig, '')
  .replace(/<head[\s\S]*?<\/head>/ig, '')
  .replace(/<\/?body[^>]*>/ig, '')
  .replace(/<meta[^>]*>/ig, '')
  .replace(/<title>[\s\S]*?<\/title>/ig, '')
  .replace(/<link[^>]*>/ig, '')
  .replace(/<style>[\s\S]*?<\/style>/ig, '')
  .replace(/<script type="module">[\s\S]*?<\/script>/ig, '')
  .trim();

fs.mkdirSync(path.join(outDir, 'src'), { recursive: true });
fs.mkdirSync(path.join(outDir, '.cache'), { recursive: true });

// Guarda monolito original uma vez (para re-extract)
const cachePath = path.join(outDir, '.cache', 'monolith.html');
if (!fs.existsSync(cachePath) && html.includes('<script type="module">')) {
  fs.writeFileSync(cachePath, html);
}

fs.writeFileSync(path.join(outDir, 'src', 'styles.css'), styleMatch[1].trim() + '\n');
fs.writeFileSync(
  path.join(outDir, 'src', 'main.js'),
  '/** Copyright (c) 2026 Gringa Radar. Todos os direitos reservados. */\n' + js.trim() + '\n',
);

const indexOut = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gringa Radar</title>
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self' https://*.supabase.co; img-src 'self' data: blob: https:; font-src 'self' https://fonts.gstatic.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self'; connect-src 'self' https://*.supabase.co; worker-src 'self' blob:;">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
</head>
<body>
${markup}
<script type="module" src="/src/main.js"></script>
</body>
</html>
`;

fs.writeFileSync(path.join(outDir, 'index.html'), indexOut);
console.log('frontend/ gerado OK');
