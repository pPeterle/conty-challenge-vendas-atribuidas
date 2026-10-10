# Exemplos reais

Saídas copiadas de uma execução local, com `npm run seed` e o servidor em `PORT=3103 WEBHOOK_SECRET=segredo-local`. Os horários de `receivedAt` e `resolvedAt` são os do relógio real no momento da execução.

Para assinar como a Shopify:

```bash
SECRET=segredo-local
URL=http://127.0.0.1:3103
send() { # $1 caminho, $2 webhook id, $3 corpo
  SIG=$(printf '%s' "$3" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)
  curl -s -w '\nHTTP %{http_code}\n' -X POST "$URL$1" \
    -H 'content-type: application/json' \
    -H "x-shopify-webhook-id: $2" \
    -H "x-shopify-hmac-sha256: $SIG" \
    -d "$3"
}
```

## Estorno que chega antes do pedido fica pendente

```bash
send /webhooks/shopify/refunds wh-r1 '{"id":7001,"order_id":5001,"created_at":"2026-03-05T10:00:00-03:00","transactions":[{"amount":"40.00","currency":"BRL","kind":"refund","status":"success"}]}'
```

```json
{"result":"criado","refund":{"refundId":"7001","kind":"estorno","orderId":"5001","status":"pendente","requestedCents":4000,"appliedCents":null,"reason":null,"currency":"BRL","createdAt":"2026-03-05T10:00:00-03:00","receivedAt":"2026-10-10T13:05:07.385Z","resolvedAt":null,"deliveries":[{"webhookId":"wh-r1","outcome":"criado","receivedAt":"2026-10-10T13:05:07.385Z"}]}}
HTTP 201
```

O pedido ainda não existe, mas os estornos dele já podem ser consultados:

```bash
curl -s $URL/orders/5001/refunds
```

```json
{"orderId":"5001","orderReceived":false,"pendingCount":1,"refunds":[{"refundId":"7001","kind":"estorno","orderId":"5001","status":"pendente","requestedCents":4000,"appliedCents":null,"reason":null,"currency":"BRL","createdAt":"2026-03-05T10:00:00-03:00","receivedAt":"2026-10-10T13:05:07.385Z","resolvedAt":null}]}
HTTP 200
```

## Pedido com cupom da Ana e UTM do Bruno

O cupom vence, o Bruno aparece em `discardedCreatorIds` e o estorno pendente é aplicado na mesma transação:

```bash
send /webhooks/shopify/orders wh-o1 '{"id":5001,"total_price":"199.90","currency":"BRL","financial_status":"paid","created_at":"2026-03-01T09:00:00-03:00","discount_codes":[{"code":"ANA10","amount":"19.99","type":"percentage"}],"landing_site":"/produtos/tenis?utm_source=conty&utm_campaign=bruno"}'
```

```json
{"result":"criado","order":{"orderId":"5001","totalCents":19990,"refundedCents":4000,"netCents":15990,"currency":"BRL","financialStatus":"paid","cancelledAt":null,"createdAt":"2026-03-01T09:00:00-03:00","receivedAt":"2026-10-10T13:05:07.420Z","discountCodes":["ANA10"],"utm":{"source":"conty","medium":null,"campaign":"bruno"},"attribution":{"creatorId":"ana","method":"cupom","reason":"cupom_vence_utm","detail":"cupom ana10 venceu a UTM bruno (bruno)","discardedCreatorIds":["bruno"],"status":"parcialmente_revertida"},"refunds":[{"refundId":"7001","kind":"estorno","orderId":"5001","status":"aplicado","requestedCents":4000,"appliedCents":4000,"reason":null,"currency":"BRL","createdAt":"2026-03-05T10:00:00-03:00","receivedAt":"2026-10-10T13:05:07.385Z","resolvedAt":"2026-10-10T13:05:07.420Z"}],"deliveries":[{"topic":"orders/paid","webhookId":"wh-o1","outcome":"criado","receivedAt":"2026-10-10T13:05:07.420Z"}]}}
HTTP 201
```

O mesmo webhook de novo responde `HTTP 200` com `"result":"duplicado"` e os mesmos valores (`totalCents: 19990`, `refundedCents: 4000`). Só o log de entregas ganha uma linha `duplicado`.

## Estorno que passa do restante é limitado

R$ 180,00 pedidos, R$ 159,90 restantes:

```bash
send /webhooks/shopify/refunds wh-r2 '{"id":7002,"order_id":5001,"created_at":"2026-03-08T10:00:00-03:00","transactions":[{"amount":"180.00","currency":"BRL","kind":"refund","status":"success"}]}'
```

```json
{"result":"criado","refund":{"refundId":"7002","kind":"estorno","orderId":"5001","status":"limitado","requestedCents":18000,"appliedCents":15990,"reason":"pedido tinha 15990 centavos restantes; 2010 centavos pedidos a mais não foram aplicados","currency":"BRL","createdAt":"2026-03-08T10:00:00-03:00","receivedAt":"2026-10-10T13:05:07.475Z","resolvedAt":"2026-10-10T13:05:07.475Z","deliveries":[{"webhookId":"wh-r2","outcome":"criado","receivedAt":"2026-10-10T13:05:07.475Z"}]}}
HTTP 201
```

Depois disso, `GET /orders/5001` mostra `"netCents":0` e a atribuição `"status":"revertida"`, com os dois estornos listados.

## Resumo por criador

Neste ponto só existe o pedido 5001:

```bash
curl -s $URL/creators/summary
```

```json
{"creators":[{"creatorId":"ana","creatorName":"Ana Souza","currency":"BRL","orders":1,"grossCents":19990,"refundedCents":19990,"netCents":0}],"unattributed":[]}
```

## Pedido cancelado

Um estorno só com transação `pending` não é gravado (a versão `success` que vier depois será aplicada normalmente):

```bash
send /webhooks/shopify/refunds wh-r3 '{"id":7003,"order_id":5003,"created_at":"2026-03-09T10:00:00-03:00","transactions":[{"amount":"20.00","currency":"BRL","kind":"refund","status":"pending"}]}'
```

```json
{"result":"sem_transacao_concluida","refundId":"7003","orderId":"5003"}
HTTP 200
```

Depois de o pedido 5003 (R$ 80,00, cupom do Bruno) chegar pago, o cancelamento reverte o saldo restante num lançamento `cancelamento-5003`:

```bash
send /webhooks/shopify/orders/cancelled wh-c3 '{"id":5003,"total_price":"80.00","currency":"BRL","financial_status":"voided","created_at":"2026-03-09T09:00:00-03:00","cancelled_at":"2026-03-10T08:00:00-03:00","discount_codes":[{"code":"BRUNO15"}],"landing_site":null}'
```

```json
{"result":"cancelado","orderId":"5003","order":{"orderId":"5003","totalCents":8000,"refundedCents":8000,"netCents":0,"currency":"BRL","financialStatus":"paid","cancelledAt":"2026-03-10T08:00:00-03:00","createdAt":"2026-03-09T09:00:00-03:00","receivedAt":"2026-10-10T13:05:07.562Z","discountCodes":["BRUNO15"],"utm":{"source":null,"medium":null,"campaign":null},"attribution":{"creatorId":"bruno","method":"cupom","reason":"cupom","detail":"cupom bruno15","discardedCreatorIds":[],"status":"cancelada"},"refunds":[{"refundId":"cancelamento-5003","kind":"cancelamento","orderId":"5003","status":"aplicado","requestedCents":8000,"appliedCents":8000,"reason":"cancelamento do pedido: saldo restante revertido","currency":"BRL","createdAt":"2026-03-10T08:00:00-03:00","receivedAt":"2026-10-10T13:05:07.581Z","resolvedAt":"2026-10-10T13:05:07.581Z"}],"deliveries":[{"topic":"orders/paid","webhookId":"wh-o3","outcome":"criado","receivedAt":"2026-10-10T13:05:07.562Z"},{"topic":"orders/cancelled","webhookId":"wh-c3","outcome":"cancelado","receivedAt":"2026-10-10T13:05:07.581Z"}]}}
HTTP 201
```

## Payload inválido

```bash
send /webhooks/shopify/orders wh-x '{"id":5002,"total_price":199.9,"currency":"BRL","financial_status":"paid","created_at":"2026-03-01T09:00:00"}'
```

```json
{"error":{"code":"VALIDATION_ERROR","message":"total_price precisa ser string decimal, ex.: \"199.90\"","details":[{"path":"total_price","message":"total_price precisa ser string decimal, ex.: \"199.90\""},{"path":"created_at","message":"created_at precisa ser data ISO 8601 com fuso, ex.: 2026-03-01T09:00:00-03:00"}]}}
HTTP 400
```

## Assinatura errada

```json
{"error":{"code":"INVALID_SIGNATURE","message":"assinatura X-Shopify-Hmac-Sha256 ausente ou inválida"}}
HTTP 401
```
