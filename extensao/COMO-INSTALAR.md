# Extensão do Chrome — Gringa Radar

## Baixar

No painel: **Extensão Chrome** → **Baixar extensão (.zip)**  
Ou o arquivo `extensao-gringa-radar.zip` junto do app no GitHub Pages.

## Instalar

1. Extraia o ZIP
2. Abra `chrome://extensions`
3. Ligue o **Modo do desenvolvedor**
4. **Carregar sem compactação** → pasta da extensão

## Login e assinatura

Clique no ícone e entre com a **mesma conta do painel**.

O login consulta `status_assinatura` no banco. Sem assinatura ativa
(ou trial), a sessão não fica salva e os dados na página do ML não liberam.

## Usar

Abra um produto no Mercado Livre. O card aparece na página.

## Segurança

O token fica no service worker da extensão, nunca na página do Mercado Livre.
