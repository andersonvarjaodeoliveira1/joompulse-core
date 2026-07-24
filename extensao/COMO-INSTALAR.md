# Extensão do Chrome — Gringa Radar

## Instalar

1. Abra `chrome://extensions` no Chrome
2. Ligue o **Modo do desenvolvedor** (canto superior direito)
3. Clique em **Carregar sem compactação**
4. Escolha esta pasta (`extensao`)

O ícone roxo aparece na barra. Clique nele e faça login com a mesma
conta do painel.

## Usar

Abra qualquer produto no Mercado Livre. O card do Gringa Radar aparece
**dentro da página**, logo acima do bloco de compra — no mesmo lugar onde
você já está olhando para decidir se o produto vale a pena.

Em páginas onde não encontramos onde encaixar, ele vira um card
flutuante no canto direito.

O que ele mostra:

- posição atual e melhor posição já alcançada
- movimento nos últimos 7 dias
- quantos dias esteve no top 10
- número de concorrentes e vendedores distintos
- preço mínimo, mediano e máximo entre os concorrentes
- quantos usam Full

E o botão **Ver insights**, que expande com:

**Vendas** — o total que a própria página do Mercado Livre exibe
("+100 vendidos"), com médias mensal, semanal e diária derivadas do
tempo que acompanhamos o produto.

**Receita e custos** — receita total estimada, comissão de 12%, imposto
de 7% e a sobra bruta.

**Variação de preço** — o gráfico do preço mediano entre os concorrentes,
esse sim vindo da nossa coleta diária.

E o botão para adicionar ao seu Monitor sem sair da página.

## De onde vem cada número

| Dado | Origem |
|---|---|
| Vendidos | a própria página do ML |
| Preço atual | a própria página do ML |
| Médias de venda | vendidos ÷ dias que acompanhamos |
| Posição e movimento | nossa coleta diária |
| Concorrentes e faixa de preço | nossa coleta diária |
| Variação de preço | nossa coleta diária |

**O Mercado Livre arredonda o número de vendidos.** "+100 vendidos" pode
ser 100 ou 149. Tudo derivado disso é ordem de grandeza, não
contabilidade — e o painel avisa isso na tela.

As médias usam como base o tempo que **nós** observamos o produto, não a
data real de criação do anúncio, que a página não expõe. Então são um
piso: o anúncio pode ser bem mais antigo, e nesse caso vende menos por
mês do que o painel mostra.

## Quando o produto não aparece

Cerca de 37% das categorias do Mercado Livre têm ranking público. Se o
produto estiver fora dessa cobertura, o painel oferece **Pedir coleta** —
o pedido entra numa fila ordenada por quantas pessoas pediram o mesmo.

## Formatos de URL reconhecidos

O Mercado Livre usa vários:

| Formato | Como resolvemos |
|---|---|
| `/MLB-4881406189-titulo` | direto da URL |
| `/p/MLB54987753` | direto da URL |
| `?item_id=MLB123` | direto da URL |
| `/up/MLBU3782076252` | lido do HTML da página |

O `MLBU` é um "user product" — agrupamento de variações de um vendedor.
Esse identificador não existe na nossa base, então a extensão procura o
MLB real dentro da página: meta tags, link canônico, campos do
formulário de compra. Se nada funcionar, o card não aparece em vez de
mostrar dado errado.

## Segurança

O token da sua conta fica no service worker da extensão, nunca na página
do Mercado Livre. Nenhuma requisição ao banco sai do contexto da página,
então scripts do próprio site não conseguem ler sua credencial.

## Publicar na Chrome Web Store

Para distribuir aos clientes em vez de instalar manualmente:

1. Conta de desenvolvedor na Chrome Web Store (taxa única de US$ 5)
2. Compactar esta pasta em .zip
3. Enviar, preencher descrição e prints, aguardar revisão

A revisão costuma pedir justificativa para cada permissão. As nossas são
mínimas: `storage` guarda a sessão, `host_permissions` alcança só o
Supabase do projeto.
