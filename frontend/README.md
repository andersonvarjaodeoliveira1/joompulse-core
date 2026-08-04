# Frontend (painel web)

Fonte editável do painel. O GitHub Pages serve a pasta `../app/`
(artefato de build).

## Desenvolvimento

```bash
cd frontend
cp .env.example .env.local   # se ainda não tiver
npm install
npm run extract              # só se app/index.html monolito for a fonte
npm run dev
```

## Produção (minify + sem sourcemap + ofuscação)

```bash
cd frontend
npm install
npm run build
```

Gera `../app/index.html` + `../app/assets/*.js` ofuscados.
**Source maps desligados** (`build.sourcemap: false`).

## Segurança

- Só a chave **publishable/anon** entra no bundle (pública por design).
- Lógica de ranking, alertas, quotas e pagamentos fica no Supabase.
- Ver [../SECURITY.md](../SECURITY.md) e [../LICENSE](../LICENSE).
