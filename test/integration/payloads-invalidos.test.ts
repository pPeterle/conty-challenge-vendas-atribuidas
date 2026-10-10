import { describe, expect, it, vi } from "vitest";
import { signBody } from "../../src/shopify.ts";
import { order, refund, SECRET, setup, setupWithCreators } from "./helpers.ts";

type Ctx = Awaited<ReturnType<typeof setupWithCreators>>;

/** Envia um corpo cru já assinado, para testar o que vem depois do HMAC. */
function sendRaw(ctx: Ctx, path: string, raw: string, headers: Record<string, string> = {}) {
  return ctx.app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-webhook-id": "wh-invalido",
      "x-shopify-hmac-sha256": signBody(raw, SECRET),
      ...headers,
    },
    body: raw,
  });
}

function counts(ctx: Ctx) {
  const n = (sql: string) => (ctx.db.prepare(sql).get() as { n: number }).n;
  return {
    orders: n("SELECT COUNT(*) AS n FROM orders"),
    refunds: n("SELECT COUNT(*) AS n FROM refunds"),
    creators: n("SELECT COUNT(*) AS n FROM creators"),
    accepted: n("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE outcome NOT LIKE 'recusado:%'"),
  };
}

const rawBodies: Array<[string, string]> = [
  ["JSON malformado", "{"],
  ["corpo vazio", ""],
  ["null", "null"],
  ["array", "[]"],
  ["string solta", '"oi"'],
  ["número solto", "42"],
];

const badOrders: Array<[string, Record<string, unknown>]> = [
  ["sem id", { id: undefined }],
  ["id zero", { id: 0 }],
  ["id negativo", { id: -1 }],
  ["id com espaço", { id: "12 3" }],
  ["id unicode", { id: "１２３" }],
  ["id enorme", { id: 1e30 }],
  ["id objeto", { id: { a: 1 } }],
  ["total número", { total_price: 100 }],
  ["total negativo", { total_price: "-1.00" }],
  ["total vazio", { total_price: "" }],
  ["total só espaços", { total_price: "   " }],
  ["total NaN", { total_price: "NaN" }],
  ["total Infinity", { total_price: "Infinity" }],
  ["total enorme", { total_price: "99999999999999999.00" }],
  ["total em notação científica", { total_price: "1e5" }],
  ["total com vírgula", { total_price: "10,00" }],
  ["moeda minúscula", { currency: "brl" }],
  ["moeda ausente", { currency: undefined }],
  ["financial_status desconhecido", { financial_status: "talvez" }],
  ["financial_status número", { financial_status: 1 }],
  ["data inválida", { created_at: "ontem" }],
  ["data sem fuso", { created_at: "2026-03-01T09:00:00" }],
  ["data inexistente", { created_at: "2026-02-30T09:00:00Z" }],
  ["cancelled_at sem fuso", { cancelled_at: "2026-03-07 10:00" }],
  ["fuso +24:00", { created_at: "2026-03-01T09:00:00+24:00" }],
  ["fuso +99:00", { created_at: "2026-03-01T09:00:00+99:00" }],
  ["fuso +23:60", { created_at: "2026-03-01T09:00:00+23:60" }],
  ["fuso -15:00", { created_at: "2026-03-01T09:00:00-15:00" }],
  ["cancelled_at com fuso +24:00", { cancelled_at: "2026-03-07T10:00:00+24:00" }],
  ["discount_codes objeto", { discount_codes: { code: "ANA10" } }],
  ["cupom vazio", { discount_codes: [{ code: "  " }] }],
  ["cupom número", { discount_codes: [{ code: 10 }] }],
  ["cupons demais", { discount_codes: Array.from({ length: 51 }, (_, i) => ({ code: `C${i}` })) }],
  ["landing_site número", { landing_site: 5 }],
  ["landing_site enorme", { landing_site: `/?${"a".repeat(3000)}` }],
];

const badRefunds: Array<[string, Record<string, unknown>]> = [
  ["sem id", { id: undefined }],
  ["order_id texto", { order_id: "abc" }],
  ["order_id zero", { order_id: 0 }],
  ["data sem fuso", { created_at: "2026-03-05 10:00" }],
  ["fuso +24:00", { created_at: "2026-03-05T10:00:00+24:00" }],
  ["fuso -15:00", { created_at: "2026-03-05T10:00:00-15:00" }],
  ["transactions objeto", { transactions: { amount: "1.00" } }],
  ["transactions vazia", { transactions: [] }],
  ["transactions demais", { transactions: Array.from({ length: 51 }, () => ({ amount: "1.00", kind: "refund", status: "success" })) }],
  ["amount número", { transactions: [{ amount: 10, kind: "refund", status: "success" }] }],
  ["amount negativo", { transactions: [{ amount: "-10.00", kind: "refund", status: "success" }] }],
  ["moeda inválida", { transactions: [{ amount: "10.00", currency: "R$", kind: "refund", status: "success" }] }],
  ["transação não objeto", { transactions: ["10.00"] }],
];

const badCreators: Array<[string, unknown]> = [
  ["array", []],
  ["null", null],
  ["sem id", { name: "X" }],
  ["id com espaço", { id: "a b", name: "X" }],
  ["id unicode", { id: "joão", name: "X" }],
  ["id número", { id: 5, name: "X" }],
  ["nome vazio", { id: "x", name: "   " }],
  ["nome número", { id: "x", name: 1 }],
  ["utm vazia", { id: "x", name: "X", utmCampaign: " " }],
  ["coupons string", { id: "x", name: "X", coupons: "ANA" }],
  ["cupom vazio", { id: "x", name: "X", coupons: [""] }],
  ["cupons demais", { id: "x", name: "X", coupons: Array.from({ length: 51 }, (_, i) => `C${i}`) }],
];

function expectError(body: any, code: string) {
  expect(Object.keys(body)).toEqual(["error"]);
  expect(body.error).toMatchObject({ code, message: expect.any(String) });
  for (const key of Object.keys(body.error)) expect(["code", "message", "details"]).toContain(key);
  if (body.error.details) {
    for (const d of body.error.details) expect(d).toEqual({ path: expect.any(String), message: expect.any(String) });
  }
}

describe("payloads inválidos devolvem 4xx com o erro padrão e não gravam nada", () => {
  it.each(rawBodies)("pedido: %s", async (_name, raw) => {
    const ctx = await setupWithCreators();
    const res = await sendRaw(ctx, "/webhooks/shopify/orders", raw);
    expect(res.status).toBe(400);
    expectError(await res.json(), "VALIDATION_ERROR");
    expect(counts(ctx)).toMatchObject({ orders: 0, accepted: 0 });
  });

  it.each(rawBodies)("estorno: %s", async (_name, raw) => {
    const ctx = await setupWithCreators();
    const res = await sendRaw(ctx, "/webhooks/shopify/refunds", raw);
    expect(res.status).toBe(400);
    expectError(await res.json(), "VALIDATION_ERROR");
    expect(counts(ctx)).toMatchObject({ refunds: 0, accepted: 0 });
  });

  it.each(rawBodies)("criador: %s", async (_name, raw) => {
    const ctx = setup();
    const res = await ctx.app.request("/creators", { method: "POST", headers: { "content-type": "application/json" }, body: raw });
    expect(res.status).toBe(400);
    expectError(await res.json(), "VALIDATION_ERROR");
    expect(counts(ctx).creators).toBe(0);
  });

  it.each(badOrders)("pedido com %s", async (_name, overrides) => {
    const ctx = await setupWithCreators();
    const res = await sendRaw(ctx, "/webhooks/shopify/orders", JSON.stringify(order(overrides)));
    expect(res.status).toBe(400);
    expectError(await res.json(), "VALIDATION_ERROR");
    expect(counts(ctx)).toMatchObject({ orders: 0, accepted: 0 });
  });

  it.each(badRefunds)("estorno com %s", async (_name, overrides) => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order());
    const res = await sendRaw(ctx, "/webhooks/shopify/refunds", JSON.stringify(refund(1, "10.00", overrides)));
    expect(res.status).toBe(400);
    expectError(await res.json(), "VALIDATION_ERROR");
    expect(counts(ctx).refunds).toBe(0);
    expect((await ctx.getJson("/orders/1001")).body.netCents).toBe(10000);
  });

  it.each(badCreators)("criador com %s", async (_name, body) => {
    const ctx = setup();
    const res = await ctx.createCreator(body);
    expect(res.status).toBe(400);
    expectError(await res.json(), "VALIDATION_ERROR");
    expect(counts(ctx).creators).toBe(0);
  });

  it("erro de validação lista cada campo em details, em português", async () => {
    const ctx = await setupWithCreators();
    const res = await sendRaw(ctx, "/webhooks/shopify/orders", JSON.stringify({ id: 1, total_price: 5, currency: "brl" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.details.map((d: any) => d.path)).toEqual(["total_price", "currency", "financial_status", "created_at"]);
    expect(body.error.details[2].message).toBe("financial_status é obrigatório");
  });

  it("criador sem Content-Type application/json devolve 400", async () => {
    const ctx = setup();
    for (const headers of [{}, { "content-type": "text/plain" }] as Record<string, string>[]) {
      const res = await ctx.app.request("/creators", { method: "POST", headers, body: JSON.stringify({ id: "x", name: "X" }) });
      expect(res.status).toBe(400);
      expectError(await res.json(), "VALIDATION_ERROR");
    }
    expect(counts(ctx).creators).toBe(0);
  });

  it.each([["/orders/abc"], ["/orders/0"], ["/refunds/1 2"], ["/creators/JOÃO"]])("GET %s com id malformado devolve 400", async (path) => {
    const ctx = setup();
    const res = await ctx.app.request(encodeURI(path));
    expect(res.status).toBe(400);
    expectError(await res.json(), "VALIDATION_ERROR");
  });

  it("GET normaliza o id: /orders/0123 acha o pedido 123", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order({ id: 123 }));
    expect((await ctx.getJson("/orders/0123")).body.orderId).toBe("123");
  });

  it("campos extras desconhecidos são ignorados", async () => {
    const ctx = await setupWithCreators();
    const res = await ctx.sendOrder({ ...order(), line_items: [{ x: 1 }], qualquer: { coisa: true } });
    expect(res.status).toBe(201);
  });

  it("sem Content-Type o corpo é lido do mesmo jeito (a assinatura é sobre o corpo cru)", async () => {
    const ctx = await setupWithCreators();
    const raw = JSON.stringify(order());
    const res = await ctx.app.request("/webhooks/shopify/orders", {
      method: "POST",
      headers: { "x-shopify-webhook-id": "w", "x-shopify-hmac-sha256": signBody(raw, SECRET) },
      body: raw,
    });
    expect(res.status).toBe(201);
  });

  it("corpo acima de 1 MB devolve 413", async () => {
    const ctx = await setupWithCreators();
    const raw = JSON.stringify(order({ note: "x".repeat(1024 * 1024) }));
    const res = await sendRaw(ctx, "/webhooks/shopify/orders", raw, { "content-length": String(Buffer.byteLength(raw)) });
    expect(res.status).toBe(413);
    expectError(await res.json(), "PAYLOAD_TOO_LARGE");
    expect(counts(ctx).orders).toBe(0);
  });

  it("webhook sem X-Shopify-Webhook-Id ou com id gigante devolve 400", async () => {
    const ctx = await setupWithCreators();
    const raw = JSON.stringify(order());
    for (const id of ["", "x".repeat(256)]) {
      const res = await sendRaw(ctx, "/webhooks/shopify/orders", raw, { "x-shopify-webhook-id": id });
      expect(res.status).toBe(400);
    }
    expect(counts(ctx).orders).toBe(0);
  });

  it("rota inexistente e método errado devolvem 404 JSON", async () => {
    const ctx = setup();
    for (const [method, path] of [["GET", "/nada"], ["GET", "/webhooks/shopify/orders"], ["PUT", "/orders/1"], ["DELETE", "/creators/ana"]]) {
      const res = await ctx.app.request(path, { method });
      expect(res.status).toBe(404);
      expectError(await res.json(), "NOT_FOUND");
    }
  });

  it("erro inesperado vira 500 JSON genérico, sem stack trace", async () => {
    const ctx = await setupWithCreators();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    ctx.db.close();
    const res = await ctx.app.request("/creators/summary");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "erro interno" } });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
