import { describe, expect, it } from "vitest";
import { order, refund, setup, setupWithCreators } from "./helpers.ts";

describe("webhook de pedido", () => {
  it("pedido novo é gravado com a atribuição e o motivo", async () => {
    const ctx = await setupWithCreators();
    const res = await ctx.sendOrder(order());
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.result).toBe("criado");
    expect(body.order).toMatchObject({
      orderId: "1001",
      totalCents: 10000,
      netCents: 10000,
      attribution: { creatorId: "ana", method: "cupom", reason: "cupom", status: "ativa" },
    });
  });

  it("webhook repetido não soma a venda de novo (200, sem efeito)", async () => {
    const ctx = await setupWithCreators();
    expect((await ctx.sendOrder(order(), { webhookId: "w-1" })).status).toBe(201);
    const again = await ctx.sendOrder(order(), { webhookId: "w-1" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).result).toBe("duplicado");
    // a Shopify pode reenviar o mesmo pedido com outro webhook id; a chave é o order_id
    expect((await ctx.sendOrder(order(), { webhookId: "w-2" })).status).toBe(200);

    const summary = await ctx.getJson("/creators/summary");
    expect(summary.body.creators).toEqual([
      { creatorId: "ana", creatorName: "Ana", currency: "BRL", orders: 1, grossCents: 10000, refundedCents: 0, netCents: 10000 },
    ]);
    const view = await ctx.getJson("/orders/1001");
    expect(view.body.deliveries.map((d: any) => d.outcome)).toEqual(["criado", "duplicado", "duplicado"]);
  });

  it("dez entregas iguais e simultâneas gravam um pedido só", async () => {
    const ctx = await setupWithCreators();
    const responses = await Promise.all(Array.from({ length: 10 }, () => ctx.sendOrder(order(), { webhookId: "w-x" })));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    const count = ctx.db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number };
    expect(count.n).toBe(1);
    expect((await ctx.getJson("/creators/summary")).body.creators[0].grossCents).toBe(10000);
  });

  it("repetição com conteúdo diferente não sobrescreve: vale a primeira versão", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order());
    const again = await ctx.sendOrder(order({ total_price: "999.00", discount_codes: [{ code: "BRUNO15" }] }));
    expect(((await again.json()) as any).result).toBe("duplicado_divergente");
    const view = await ctx.getJson("/orders/1001");
    expect(view.body).toMatchObject({ totalCents: 10000, attribution: { creatorId: "ana" } });
  });

  it("desempate: cupom e UTM de criadores diferentes, o cupom vence e o motivo fica gravado", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order({ landing_site: "/?utm_source=conty&utm_campaign=bruno" }));
    const view = await ctx.getJson("/orders/1001");
    expect(view.body.attribution).toEqual({
      creatorId: "ana",
      method: "cupom",
      reason: "cupom_vence_utm",
      detail: "cupom ana10 venceu a UTM bruno (bruno)",
      discardedCreatorIds: ["bruno"],
      status: "ativa",
    });
    const row = ctx.db.prepare("SELECT discarded_creator_ids FROM orders WHERE order_id = '1001'").get() as { discarded_creator_ids: string };
    expect(JSON.parse(row.discarded_creator_ids)).toEqual(["bruno"]);
  });

  it("cupom desconhecido cai para a UTM", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order({ discount_codes: [{ code: "FRETEGRATIS" }], landing_site: "/?utm_source=conty&utm_campaign=bruno" }));
    expect((await ctx.getJson("/orders/1001")).body.attribution).toMatchObject({ creatorId: "bruno", method: "utm", reason: "utm" });
  });

  it("sem cupom nem UTM de criador: venda gravada sem criador, com motivo", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order({ discount_codes: [], landing_site: null }));
    const view = await ctx.getJson("/orders/1001");
    expect(view.body.attribution).toMatchObject({ creatorId: null, reason: "sem_criador", status: "sem_criador" });
    const summary = await ctx.getJson("/creators/summary");
    expect(summary.body.unattributed).toEqual([{ currency: "BRL", orders: 1, grossCents: 10000, refundedCents: 0, netCents: 10000 }]);
  });

  it("pedido ainda não pago é ignorado com 200 e não conta como venda", async () => {
    const ctx = await setupWithCreators();
    const res = await ctx.sendOrder(order({ financial_status: "pending" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).result).toBe("ignorado");
    expect((await ctx.getJson("/orders/1001")).status).toBe(404);
    expect((await ctx.sendOrder(order())).status).toBe(201);
  });

  it("assinatura HMAC inválida ou ausente devolve 401 e não grava nada", async () => {
    const ctx = await setupWithCreators();
    const bad = await ctx.sendOrder(order(), { signature: "abc" });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as any).error.code).toBe("INVALID_SIGNATURE");
    expect((await ctx.sendOrder(order(), { signature: null })).status).toBe(401);
    expect((await ctx.getJson("/orders/1001")).status).toBe(404);
  });

  it("payload inválido devolve 400 com mensagem e a entrega recusada fica no log", async () => {
    const ctx = setup();
    const res = await ctx.sendOrder(order({ total_price: "10.005" }), { webhookId: "w-ruim" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: 'total_price precisa ser string decimal, ex.: "199.90"',
        details: [{ path: "total_price", message: 'total_price precisa ser string decimal, ex.: "199.90"' }],
      },
    });
    const log = ctx.db.prepare("SELECT webhook_id, resource_id, outcome FROM webhook_deliveries").all();
    expect(log).toEqual([
      { webhook_id: "w-ruim", resource_id: "1001", outcome: 'recusado: total_price precisa ser string decimal, ex.: "199.90"' },
    ]);
  });

  it("total com zero depois da segunda casa (\"1.230\") é aceito", async () => {
    const ctx = await setupWithCreators();
    const res = await ctx.sendOrder(order({ total_price: "1.230" }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).order.totalCents).toBe(123);
  });

  it("pedido de valor zero é aceito e atribuído; estorno nele é rejeitado com motivo", async () => {
    const ctx = await setupWithCreators();
    const res = await ctx.sendOrder(order({ total_price: "0.00" }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).order).toMatchObject({ totalCents: 0, netCents: 0, attribution: { creatorId: "ana", status: "ativa" } });
    const r = await ctx.sendRefund(refund(1, "10.00"));
    expect(((await r.json()) as any).refund).toMatchObject({ status: "rejeitado", appliedCents: 0, reason: "pedido de valor zero: não há o que estornar" });
    expect((await ctx.getJson("/creators/summary")).body.creators[0]).toMatchObject({ orders: 1, grossCents: 0, refundedCents: 0, netCents: 0 });
  });

  it("ids acima de 2^53 (como os reais da Shopify) não perdem precisão nem colidem", async () => {
    const ctx = await setupWithCreators();
    // os dois viram o mesmo número em ponto flutuante; como texto são pedidos diferentes
    const a = '{"id":820982911946154508,"total_price":"10.00","currency":"BRL","financial_status":"paid","created_at":"2026-03-01T09:00:00Z"}';
    const b = a.replace("820982911946154508", "820982911946154509");
    expect(JSON.parse(a).id).toBe(JSON.parse(b).id);
    expect((await ctx.sendRaw("/webhooks/shopify/orders", a)).status).toBe(201);
    expect((await ctx.sendRaw("/webhooks/shopify/orders", b)).status).toBe(201);
    expect((await ctx.getJson("/orders/820982911946154508")).body.orderId).toBe("820982911946154508");
    expect((await ctx.getJson("/orders/820982911946154509")).body.orderId).toBe("820982911946154509");

    const r = '{"id":990000000000000001,"order_id":820982911946154509,"created_at":"2026-03-02T09:00:00Z","transactions":[{"amount":"4.00","kind":"refund","status":"success"}]}';
    const res = await ctx.sendRaw("/webhooks/shopify/refunds", r);
    expect(((await res.json()) as any).refund).toMatchObject({ refundId: "990000000000000001", orderId: "820982911946154509", status: "aplicado" });
    expect((await ctx.getJson("/orders/820982911946154508")).body.refundedCents).toBe(0);
    expect((await ctx.getJson("/orders/820982911946154509")).body.refundedCents).toBe(400);
  });

  it("id 123 e \"0123\" são o mesmo pedido; id 0 é recusado", async () => {
    const ctx = await setupWithCreators();
    expect((await ctx.sendOrder(order({ id: 123 }))).status).toBe(201);
    expect((await ctx.sendOrder(order({ id: "0123" }))).status).toBe(200);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n).toBe(1);
    expect((await ctx.sendOrder(order({ id: 0 }))).status).toBe(400);
  });

  it("atribuição gravada não pode ser reescrita depois, nem direto no banco", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order());
    expect(() => ctx.db.prepare("UPDATE orders SET creator_id = 'bruno'").run()).toThrow(/não podem ser alterados/);
  });
});

describe("cadastro de criador", () => {
  it("cupom já usado por outro criador devolve 409", async () => {
    const ctx = await setupWithCreators();
    const res = await ctx.createCreator({ id: "carla", name: "Carla", coupons: ["ana10"] });
    expect(res.status).toBe(409);
    expect((await ctx.getJson("/creators/carla")).status).toBe(404);
  });
});
