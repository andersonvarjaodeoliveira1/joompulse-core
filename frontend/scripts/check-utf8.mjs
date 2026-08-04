import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const files = [
  'app/index.html',
  'frontend/index.html',
  'frontend/src/main.js',
];

const assetsDir = path.join(root, 'app/assets');
for (const name of fs.readdirSync(assetsDir)) {
  if (name.endsWith('.js') || name.endsWith('.css')) files.push(`app/assets/${name}`);
}

const badRe = /Conte├|Ôû¥|Extens├|VocÃ|diÃ¡rio|├º├|Ã§Ã£o/;
const good = ['Conteúdo', 'Extensão', 'Concorrência', 'Você'];

for (const rel of files) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) continue;
  const buf = fs.readFileSync(p);
  const s = buf.toString('utf8');
  const bad = badRe.test(s);
  const goods = Object.fromEntries(good.map((g) => [g, s.includes(g)]));
  let uAcute = 0;
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0xc3 && buf[i + 1] === 0xba) uAcute++;
  }
  console.log(rel, { bad, uAcute, ...goods, bytes: buf.length });
}
