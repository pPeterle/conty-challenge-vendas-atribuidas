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
{"result":"criado","refund":{"refundId":"7001","orderId":"5001","status":"pendente","requestedCents":4000,"appliedCents":null,"reason":null,"currency":"BRL","createdAt":"2026-03-05T10:00:00-03:00","receivedAt":"2026-10-10T04:18:11.293Z","resolvedAt":null,"deliveries":[{"webhookId":"wh-r1","outcome":"criado","receivedAt":"2026-10-10T04:18:11.293Z"}]}}
HTTP 201
```

O pedido ainda não existe, mas os estornos dele já podem ser consultados:

```bash
curl -s $URL/orders/5001/refunds
```

```json
{"orderId":"5001","orderReceived":false,"pendingCount":1,"refunds":[{"refundId":"7001","orderId":"5001","status":"pendente","requestedCents":4000,"appliedCents":null,"reason":null,"currency":"BRL","createdAt":"2026-03-05T10:00:00-03:00","receivedAt":"2026-10-10T04:18:11.293Z","resolvedAt":null}]}
HTTP 200
```

## Pedido com cupom da Ana e UTM do Bruno

O cupom vence, o Bruno aparece em `discardedCreatorIds` e o estorno pendente é aplicado na mesma transação:

```bash
send /webhooks/shopify/orders wh-o1 '{"id":5001,"total_price":"199.90","currency":"BRL","financial_status":"paid","created_at":"2026-03-01T09:00:00-03:00","discount_codes":[{"code":"ANA10","amount":"19.99","type":"percentage"}],"landing_site":"/produtos/tenis?utm_source=conty&utm_campaign=bruno"}'
```

```json
{"result":"criado","order":{"orderId":"5001","totalCents":19990,"refundedCents":4000,"netCents":15990,"currency":"BRL","financialStatus":"paid","createdAt":"2026-03-01T09:00:00-03:00","receivedAt":"2026-10-10T04:18:11.333Z","discountCodes":["ANA10"],"utm":{"source":"conty","medium":null,"campaign":"bruno"},"attribution":{"creatorId":"ana","method":"cupom","reason":"cupom_vence_utm","detail":"cupom ana10 venceu a UTM bruno (bruno)","discardedCreatorIds":["bruno"],"status":"parcialmente_revertida"},"refunds":[{"refundId":"7001","orderId":"5001","status":"aplicado","requestedCents":4000,"appliedCents":4000,"reason":null,"currency":"BRL","createdAt":"2026-03-05T10:00:00-03:00","receivedAt":"2026-10-10T04:18:11.293Z","resolvedAt":"2026-10-10T04:18:11.333Z"}],"deliveries":[{"webhookId":"wh-o1","outcome":"criado","receivedAt":"2026-10-10T04:18:11.333Z"}]}}
HTTP 201
```

O mesmo webhook de novo responde `HTTP 200` com `"result":"duplicado"` e os mesmos valores (`totalCents: 19990`, `refundedCents: 4000`). Só o log de entregas ganha uma linha `duplicado`.

## Estorno que passa do restante é limitado

R$ 180,00 pedidos, R$ 159,90 restantes:

```bash
send /webhooks/shopify/refunds wh-r2 '{"id":7002,"order_id":5001,"created_at":"2026-03-08T10:00:00-03:00","transactions":[{"amount":"180.00","currency":"BRL","kind":"refund","status":"success"}]}'
```

```json
{"result":"criado","refund":{"refundId":"7002","orderId":"5001","status":"limitado","requestedCents":18000,"appliedCents":15990,"reason":"pedido tinha 15990 centavos restantes; 2010 centavos pedidos a mais não foram aplicados","currency":"BRL","createdAt":"2026-03-08T10:00:00-03:00","receivedAt":"2026-10-10T04:18:11.389Z","resolvedAt":"2026-10-10T04:18:11.389Z","deliveries":[{"webhookId":"wh-r2","outcome":"criado","receivedAt":"2026-10-10T04:18:11.389Z"}]}}
HTTP 201
```

Depois disso, `GET /orders/5001` mostra `"netCents":0` e a atribuição `"status":"revertida"`, com os dois estornos listados.

## Resumo por criador

```bash
curl -s $URL/creators/summary
```

```json
{"creators":[{"creatorId":"ana","creatorName":"Ana Souza","currency":"BRL","orders":1,"grossCents":19990,"refundedCents":19990,"netCents":0}],"unattributed":[]}
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
