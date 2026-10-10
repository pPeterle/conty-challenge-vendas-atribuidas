// Escritor independente: abre a própria conexão sqlite no mesmo arquivo e
// ingere estornos. Usado pelo teste de concorrência entre conexões.
import { parentPort, workerData } from "node:worker_threads";
import { FixedClock } from "../../../src/clock.ts";
import { createStore, openDatabase } from "../../../src/db.ts";
import { ingestRefund } from "../../../src/sales.ts";
import type { RefundPayload } from "../../../src/schemas.ts";

const { path, refunds, gate } = workerData as { path: string; refunds: RefundPayload[]; gate: SharedArrayBuffer };
const store = createStore(openDatabase(path));
const clock = new FixedClock();

parentPort!.postMessage("pronto");
// espera a largada, para os dois escritores começarem juntos
Atomics.wait(new Int32Array(gate), 0, 0);
// pausa de 1 ms entre transações, como requisições chegando ao longo do tempo;
// sem ela, o escritor que pega o lock primeiro tende a fazer tudo antes do outro
const pause = new Int32Array(new SharedArrayBuffer(4));
const results = refunds.map((r) => {
  const result = ingestRefund(store, clock, r, `w-${r.refundId}`);
  Atomics.wait(pause, 0, 0, 1);
  return result;
});
parentPort!.postMessage(results);
