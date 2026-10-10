import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/clock.ts";
import { createStore, openDatabase } from "../../src/db.ts";
import { ingestOrder } from "../../src/sales.ts";
import { orderWebhookSchema, type RefundPayload } from "../../src/schemas.ts";
import { order } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function startWriter(path: string, refunds: RefundPayload[], gate: SharedArrayBuffer) {
  const worker = new Worker(new URL("./workers/refund-writer.ts", import.meta.url), {
    workerData: { path, refunds, gate },
    execArgv: ["--import", "tsx"],
  });
  const ready = new Promise<void>((resolve) => worker.once("message", () => resolve()));
  const done = new Promise<string[]>((resolve, reject) => {
    worker.on("message", (m) => Array.isArray(m) && resolve(m));
    worker.on("error", reject);
  });
  return { worker, ready, done };
}

describe("concorrência entre conexões independentes", () => {
  it("dois escritores em threads separadas, cada um com sua conexão, nunca passam do total", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vendas-conexoes-"));
    dirs.push(dir);
    const path = join(dir, "vendas.sqlite");

    const main = createStore(openDatabase(path));
    ingestOrder(main, new FixedClock(), orderWebhookSchema.parse(order({ total_price: "100.00", discount_codes: [], landing_site: null })), "w-o");

    // 600 estornos de R$ 0,25 num pedido de R$ 100; os dois escritores mandam todos, em ordens opostas
    const refunds: RefundPayload[] = Array.from({ length: 600 }, (_, i) => ({
      refundId: String(i + 1),
      orderId: "1001",
      createdAt: "2026-03-05T10:00:00Z",
      amountCents: 25,
      currency: "BRL",
      concludedTransactions: 1,
    }));
    const gate = new SharedArrayBuffer(4);
    const a = startWriter(path, refunds, gate);
    const b = startWriter(path, [...refunds].reverse(), gate);
    await Promise.all([a.ready, b.ready]);
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    const [ra, rb] = await Promise.all([a.done, b.done]);
    await Promise.all([a.worker.terminate(), b.worker.terminate()]);

    // cada estorno foi criado por exatamente um dos dois escritores
    const created = [...ra, ...rb].filter((r) => r === "criado").length;
    expect(created).toBe(600);
    // os dois escreveram de fato (ordens opostas: cada um chega primeiro em parte dos ids)
    expect(ra.filter((r) => r === "criado").length).toBeGreaterThan(0);
    expect(rb.filter((r) => r === "criado").length).toBeGreaterThan(0);
    const rows = main.refundsOf("1001");
    expect(rows).toHaveLength(600);
    expect(rows.reduce((s, r) => s + (r.appliedCents ?? 0), 0)).toBe(10000);
    expect(rows.filter((r) => r.status === "aplicado")).toHaveLength(400);
    expect(rows.filter((r) => r.status === "rejeitado")).toHaveLength(200);
    expect(rows.filter((r) => r.status === "pendente")).toHaveLength(0);
  }, 30_000);
});
