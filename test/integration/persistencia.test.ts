import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { FixedClock } from "../../src/clock.ts";
import { openDatabase } from "../../src/db.ts";
import { signBody } from "../../src/shopify.ts";
import { order, refund, SECRET } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "vendas-persistencia-"));
  dirs.push(dir);
  return join(dir, "vendas.sqlite");
}

function boot(path: string) {
  const db = openDatabase(path);
  const app = createApp({ db, clock: new FixedClock(), webhookSecret: SECRET });
  const send = (route: string, payload: unknown, webhookId: string) => {
    const body = JSON.stringify(payload);
    return app.request(route, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-webhook-id": webhookId, "x-shopify-hmac-sha256": signBody(body, SECRET) },
      body,
    });
  };
  const get = async (route: string) => (await app.request(route)).json() as Promise<any>;
  return { db, app, send, get };
}

describe("persistência em arquivo", () => {
  it("estorno pendente e idempotência sobrevivem a fechar e reabrir o banco", async () => {
    const path = tempDbPath();
    const first = boot(path);
    expect((await first.send("/webhooks/shopify/refunds", refund(1, "30.00"), "wh-r1")).status).toBe(201);
    expect((await first.send("/webhooks/shopify/orders", order({ id: 2002 }), "wh-o2")).status).toBe(201);
    first.db.close();

    const second = boot(path);
    // pendência continua lá
    expect(await second.get("/refunds/1")).toMatchObject({ status: "pendente", requestedCents: 3000 });
    // reenvio depois de reiniciar continua sendo repetição
    expect((await second.send("/webhooks/shopify/refunds", refund(1, "30.00"), "wh-r1")).status).toBe(200);
    expect((await second.send("/webhooks/shopify/orders", order({ id: 2002 }), "wh-o2")).status).toBe(200);
    // e o pendente é aplicado quando o pedido chega no processo novo
    expect((await second.send("/webhooks/shopify/orders", order(), "wh-o1")).status).toBe(201);
    expect(await second.get("/orders/1001")).toMatchObject({ refundedCents: 3000, netCents: 7000 });
    expect((second.db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n).toBe(2);
    second.db.close();
  });

  it("banco criado sem a coluna discarded_creator_ids ganha a coluna ao abrir, sem perder pedidos", () => {
    const path = tempDbPath();
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE orders (
      order_id TEXT PRIMARY KEY, total_cents INTEGER NOT NULL, currency TEXT NOT NULL, financial_status TEXT NOT NULL,
      discount_codes TEXT NOT NULL, landing_site TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
      creator_id TEXT, attribution_method TEXT, attribution_reason TEXT NOT NULL, attribution_detail TEXT NOT NULL,
      shop_created_at TEXT NOT NULL, received_at TEXT NOT NULL, webhook_id TEXT NOT NULL)`);
    old.exec(`INSERT INTO orders VALUES ('7', 100, 'BRL', 'paid', '[]', NULL, NULL, NULL, NULL, NULL, NULL, 'sem_criador', '-', 't', 't', 'w')`);
    old.close();

    const db = openDatabase(path);
    const row = db.prepare("SELECT order_id, discarded_creator_ids FROM orders").get();
    expect(row).toEqual({ order_id: "7", discarded_creator_ids: "[]" });
    db.close();
  });
});
