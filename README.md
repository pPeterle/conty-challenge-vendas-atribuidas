# Vendas atribuídas ao criador

Serviço que recebe webhooks de pedido e de estorno no formato essencial da Shopify, atribui cada venda a no máximo um criador (por cupom ou UTM) e reverte essa atribuição quando chega estorno, sem apagar o histórico. Não conecta numa loja de verdade: os webhooks são simulados com o mesmo formato, os mesmos headers e a mesma assinatura HMAC.

## Resumo

- Desempate: o cupom vence a UTM, porque o comprador digita o cupom no checkout, perto da compra, enquanto a UTM vem do link de entrada, que pode ser de outra visita ou repassado. Cupom que não é de criador cai para a UTM. Sem nenhum dos dois, a venda fica sem criador. O motivo e os criadores que perderam o desempate (`discardedCreatorIds`) ficam gravados no pedido.
- Idempotência: um pedido por `order_id` e um estorno por `refund_id`, com UNIQUE no banco. Webhook repetido, inclusive simultâneo ou depois de reiniciar o processo, responde 200 e não muda nada.
- Teto de estornos: a soma aplicada nunca passa do total do pedido. O excedente fica registrado no estorno como `limitado` ou `rejeitado`, com motivo. Nada é apagado, e triggers no sqlite seguram isso mesmo fora da API.
- Estorno antes do pedido: fica `pendente` e é aplicado na mesma transação em que o pedido chega, em ordem cronológica.

### Por onde começar a leitura

| Arquivo | O que tem |
| --- | --- |
| `src/attribution.ts` | a regra de atribuição e o desempate, função pura |
| `src/refunds.ts` | quanto de um estorno é aplicado, função pura |
| `src/sales.ts` | ingestão de pedido e estorno, cada uma numa transação |
| `src/schemas.ts` | validação de toda entrada com zod |
| `src/db.ts` | schema, triggers e todo o SQL |
| `test/integration/refunds.test.ts` | estorno parcial, repetido, antes do pedido, concorrente |

## Como rodar

Precisa de Node 22.13 ou mais novo (por causa do `node:sqlite`). Para a carga, também de Docker.

```bash
npm install
npm run seed        # cadastra os criadores de exemplo "ana" e "bruno" em data/vendas.sqlite
npm run dev         # sobe em http://127.0.0.1:3000 (PORT, DB_PATH e WEBHOOK_SECRET por variável de ambiente)
npm test            # unitários + integração (sqlite em memória e em arquivo, relógio fixo)
npm run typecheck
npm run load        # k6 via Docker na porta 3103 + verificação das invariantes
```

Sem `WEBHOOK_SECRET`, o servidor usa um segredo de desenvolvimento e avisa no log. A CI roda testes e typecheck em Node 22.13 e 24.

## Endpoints

| Método | Rota | O que faz |
| --- | --- | --- |
| POST | `/webhooks/shopify/orders` | webhook `orders/paid` |
| POST | `/webhooks/shopify/refunds` | webhook `refunds/create` |
| GET | `/orders/:id` | pedido com atribuição, estornos, líquido e log de entregas |
| GET | `/orders/:id/refunds` | estornos de um `order_id`, inclusive pendentes de pedido que ainda não chegou |
| GET | `/refunds/:id` | um estorno e suas entregas |
| GET | `/creators/summary` | bruto, estornado e líquido por criador e moeda, mais as vendas sem criador |
| POST | `/creators` | cadastra criador com `utmCampaign` e `coupons` |
| GET | `/creators/:id` | criador cadastrado |

Erros saem como `{ "error": { "code", "message", "details"? } }`. Os status são 400 (validação, com `path` e `message` de cada campo em `details`), 401 (assinatura), 404, 409 (cupom ou UTM de outro criador), 413 (corpo acima de 1 MB) e 500 genérico, sem stack trace. Nos webhooks, 400 e 401 são recusa: a Shopify trata resposta fora de 2xx como falha e reenvia. A entrega recusada por payload inválido fica em `webhook_deliveries` como `recusado: <motivo>`.

Exemplos reais de request e response estão em [docs/exemplos.md](docs/exemplos.md).

## Regras e decisões

**Atribuição** (`src/attribution.ts`). Ordem: cupom de criador; se houver cupons de criadores diferentes, vence o primeiro na ordem enviada. Depois vem a UTM de criador, que exige `utm_source=conty` e `utm_campaign` igual ao código do criador (lida do `landing_site`). Exijo `utm_source=conty` para que uma campanha da própria marca com nome igual ao código de um criador não seja atribuída a ele. A atribuição é gravada na chegada e não muda depois. Com os estornos, o status passa de `ativa` a `parcialmente_revertida` ou `revertida`.

**Estorno** (`src/refunds.ts`). Valor do estorno é a soma das transações `kind: "refund"` com `status: "success"`. As outras são ignoradas antes de checar valor e moeda. Estorno sem transações dá 400. Estorno de valor zero, em outra moeda ou em pedido já zerado vira `rejeitado`; o que passa do restante vira `limitado`. Repetição com outro conteúdo não muda nada e fica marcada como `duplicado_divergente`.

**Dinheiro.** Sempre centavos inteiros, convertidos direto da string (`"199.90"`), sem float. Recuso valor numérico (`199.9`) porque o `JSON.parse` lê número como float, e um valor como `0.29` não tem representação exata em float. A Shopify manda string, então número indica erro de quem enviou. Zeros depois da segunda casa são aceitos (`"1.230"`); outro dígito ali (`"10.005"`) é recusado. Pedido de `"0.00"` (brinde com cupom de 100%, por exemplo) é aceito e atribuído; estorno nele é `rejeitado` com motivo, porque não há o que devolver.

**Pedido não pago.** `financial_status` fora de `paid`, `partially_refunded` e `refunded` responde 200 com `"result": "ignorado"` e não grava venda. O pedido entra quando chegar como pago.

**Validação** (`src/schemas.ts`). Corpo, headers e params passam por zod. Nos webhooks, confiro o HMAC sobre o corpo cru e só depois faço `JSON.parse` e `safeParse`. Datas exigem fuso e precisam existir no calendário. Ids são inteiros positivos normalizados (`123` e `"0123"` são o mesmo pedido). Listas e textos têm limite (50 cupons, 50 transações, 100 caracteres por cupom). Campos desconhecidos são ignorados.

## Idempotência e concorrência

Cada webhook roda numa transação `BEGIN IMMEDIATE` com `INSERT ... ON CONFLICT DO NOTHING`. A chave é o `order_id`/`refund_id`, não o `X-Shopify-Webhook-Id`, porque o mesmo pedido pode chegar por entregas diferentes. Os testes disparam entregas iguais e diferentes ao mesmo tempo com `Promise.all`, e um teste com arquivo em disco fecha e reabre o banco para mostrar que pendência e idempotência sobrevivem.

## Por que essa solução

Um processo Node com sqlite serializa as escritas. Com uma instância só, a transação curta com restrição UNIQUE resolve duplicidade e corrida sem fila nem lock. Não usei Redis porque a restrição do banco já garante que a mesma venda não entra duas vezes, e um lock externo seria mais uma peça para cair.

Com várias instâncias, eu trocaria o sqlite por Postgres e manteria a ideia: `order_id` e `refund_id` únicos, `INSERT ... ON CONFLICT DO NOTHING` e `SELECT ... FOR UPDATE` na linha do pedido ao aplicar estorno. Lock distribuído só valeria com efeito colateral fora do banco, como pagar o criador na hora, e mesmo assim eu começaria por uma tabela de outbox.

## Teste de carga

O k6 entrega 600 pedidos e 750 estornos, cada um 8 vezes, em ordem embaralhada e em pares simultâneos, com 10% de payloads inválidos no meio. No fim, um script confere o resumo por criador contra o esperado e confirma que nenhum pedido tem estorno acima do total. Na última execução, nesta máquina: checks 100% (12000/12000), 0% de falhas, p95 de 26 ms e 5219 req/s, com as invariantes mantidas. O cenário completo e a saída estão em [docs/carga.md](docs/carga.md).

## O que ficou de fora

- Atualizações de pedido (`orders/updated`, `orders/cancelled`). Cancelamento sem estorno não reverte a atribuição.
- Moedas com casas decimais diferentes de duas.
- Valor de estorno por item (`refund_line_items`). Uso só as transações.
- Autenticação no `POST /creators` e nas leituras.
- Fila: o webhook é processado na própria requisição, numa transação curta.

## O que eu faria diferente com mais tempo

- Guardar o payload cru de cada entrega para reprocessar se a regra mudar.
- Listar estornos pendentes antigos de todos os pedidos (pedido que nunca chegou), com alerta.
- Janela de validade da UTM, quando a loja mandar dados de sessão.
- Paginação e filtro por período no resumo.

## Uso de IA

O código, os testes e este README foram produzidos com Claude Code (Claude Opus) a partir do enunciado do desafio. As decisões de modelagem (cupom vence UTM, estorno limitado com motivo, pendente aplicado na transação do pedido, triggers de histórico) foram propostas nesse processo.

**O que eu revisei:** Revisei as regras de atribuição e de estorno e os testes que cobrem cada item do enunciado. Rodei `npm test`, `npm run typecheck` e `npm run load` localmente e conferi os exemplos de request e response contra o servidor rodando.
