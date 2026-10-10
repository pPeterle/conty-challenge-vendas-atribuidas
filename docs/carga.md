# Teste de carga

`npm run load` (`scripts/load.sh`) sobe a API na porta 3103 com banco temporário, roda `load/webhooks.js` no k6 (`grafana/k6:0.54.0`, via Docker), executa `scripts/verify-load.ts` e encerra o servidor.

## Cenário

- A massa (`load/dataset.js`) tem 5 criadores e 600 pedidos em cinco formatos: só cupom, só UTM, cupom contra UTM, cupom desconhecido com UTM, sem nada. Tem também 750 estornos (um parcial, dois que somam 90% e dois que somam 130% do total).
- Cada evento é entregue 4 vezes em ordem embaralhada, e cada entrega sai em par simultâneo, então são 8 cópias de cada evento. Muitos estornos chegam antes do pedido.
- Uma em cada dez iterações manda um payload inválido (JSON quebrado, tipos errados, data sem fuso, estorno vazio, lixo aleatório), muitas vezes com id de pedido real. Metade vai assinada e precisa voltar 400; a outra metade vai com assinatura errada e precisa voltar 401. O check exige 4xx e nunca 5xx, e esses 4xx não contam em `http_req_failed`.
- Thresholds: p95 abaixo de 500 ms, falhas abaixo de 1%, checks acima de 99,9%. O teto de latência é folgado para a carga passar em máquinas mais lentas; quem reprova a rodada são os checks, a taxa de falha e a verificação final.
- A verificação final compara o resumo por criador com o esperado calculado da massa e confere no banco que os 600 pedidos e os 750 estornos estão lá, que não sobrou pendente, que nenhum pedido tem estorno acima do total, que não houve `duplicado_divergente` e que os inválidos assinados foram recusados. Se algo quebrar, sai com código 1.

Para o k6 importar a massa compartilhada, monto a pasta `load/` no container (`-v load:/load`) em vez de passar o script pelo stdin.

## Resultado

Execução de 2026-10-10 nesta máquina (macOS, k6 em Docker):

```
✓ inválido volta 4xx
✓ inválido nunca 5xx
✓ status 200 ou 201
✓ checks.........................: 100.00% 12000 out of 12000
✓ http_req_duration..............: avg=27.63ms  min=643.92µs med=21.21ms max=880.34ms p(90)=43.15ms p(95)=58.75ms
✓ http_req_failed................: 0.00%   0 out of 11405
http_reqs......................: 11405   2972.06905/s
ok   criador-0: esperado {"orders":96,"grossCents":2396576,"refundedCents":1318654,"netCents":1077922} obtido {"orders":96,"grossCents":2396576,"refundedCents":1318654,"netCents":1077922}
ok   criador-1: esperado {"orders":96,"grossCents":2424696,"refundedCents":1312230,"netCents":1112466} obtido {"orders":96,"grossCents":2424696,"refundedCents":1312230,"netCents":1112466}
ok   criador-2: esperado {"orders":96,"grossCents":2405416,"refundedCents":1344846,"netCents":1060570} obtido {"orders":96,"grossCents":2405416,"refundedCents":1344846,"netCents":1060570}
ok   criador-3: esperado {"orders":96,"grossCents":2482536,"refundedCents":1351842,"netCents":1130694} obtido {"orders":96,"grossCents":2482536,"refundedCents":1351842,"netCents":1130694}
ok   criador-4: esperado {"orders":96,"grossCents":2559656,"refundedCents":1429998,"netCents":1129658} obtido {"orders":96,"grossCents":2559656,"refundedCents":1429998,"netCents":1129658}
ok   (sem criador): esperado {"orders":120,"grossCents":3115420,"refundedCents":1724990,"netCents":1390430} obtido {"orders":120,"grossCents":3115420,"refundedCents":1724990,"netCents":1390430}
pedidos gravados: 600 (esperado 600)
estornos gravados: 750 (esperado 750), pendentes no fim: 0
estornos que chegaram antes do pedido: 379
estornos limitados ou rejeitados por passar do total: 150
pedidos com estorno acima do total: 0
entregas registradas: 11100, duplicadas: 9450, divergentes: 0, recusadas por payload inválido: 300
VERIFICAÇÃO OK: invariantes mantidas
```

A latência muda bastante entre execuções na mesma máquina: nas últimas rodadas, o p95 ficou entre 26 ms e 117 ms. A ordem de envio é fixa, mas 50 VUs disputam as iterações ao mesmo tempo, então a ordem de chegada muda a cada execução. Por isso a contagem de estornos que chegaram antes do pedido varia (já vi de 374 a 381). Os totais por criador e as invariantes não variam.
