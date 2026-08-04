# Extensão do Chrome — Gringa Radar

## Instalar

[Gringa Radar na Chrome Web Store](https://chromewebstore.google.com/detail/gringa-radar/eilndeohnfhbfhbcikepjpbmgkdkjblp)

1. Abra o link
2. Clique em **Usar no Chrome** / **Adicionar ao Chrome**
3. Confirme

No painel: **Extensão Chrome** → **Instalar extensão no Chrome**.

## Login e assinatura

Clique no ícone e entre com a **mesma conta do painel**.

O login consulta `status_assinatura` no banco. Sem assinatura ativa
(ou trial), a sessão não fica salva e os dados na página do ML não liberam.

## Usar

Abra um produto no Mercado Livre. O card aparece na página.
Vendidos no Monitor são atualizados quando você abre um produto monitorado
(a API do ML não libera `sold_quantity` de terceiro).

## Segurança

O token fica no service worker da extensão, nunca na página do Mercado Livre.
