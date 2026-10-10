import { describe, expect, it } from "vitest";
import { order, refund, setupWithCreators } from "./helpers.ts";

describe("webhook de estorno", () => {
  it("estorno parcial reduz o líquido e mantém a atribuição", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order());
    const res = await ctx.sendRefund(refund(1, "30.00"));
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).refund).toMatchObject({ status: "aplicado", requestedCents: 3000, appliedCents: 3000 });

    const view = await ctx.getJson("/orders/1001");
    expect(view.body).toMatchObject({
      totalCents: 10000,
      refundedCents: 3000,
      netCents: 7000,
      attribution: { creatorId: "ana", status: "parcialmente_revertida" },
    });
    const summary = await ctx.getJson("/creators/summary");
    expect(summary.body.creators[0]).toMatchObject({ grossCents: 10000, refundedCents: 3000, netCents: 7000 });
  });

  it("estorno total zera o líquido mas mantém pedido e estorno no histórico", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order());
    await ctx.sendRefund(refund(1, "100.00"));
    const view = await ctx.getJson("/orders/1001");
    expect(view.body).toMatchObject({ netCents: 0, attribution: { creatorId: "ana", status: "revertida" } });
    expect(view.body.refunds).toHaveLength(1);
    expect((await ctx.getJson("/creators/summary")).body.creators[0]).toMatchObject({ orders: 1, grossCents: 10000, netCents: 0 });
  });

  it("estorno repetido depois do pedido é aplicado uma vez só", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order());
    expect((await ctx.sendRefund(refund(1, "30.00"))).status).toBe(201);
    const again = await ctx.sendRefund(refund(1, "30.00"));
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).result).toBe("duplicado");
    expect((await ctx.getJson("/orders/1001")).body).toMatchObject({ refundedCents: 3000, netCents: 7000 });
    expect((await ctx.getJson("/refunds/1")).body.deliveries.map((d: any) => d.outcome)).toEqual(["criado", "duplicado"]);
  });

  it("estorno que chega antes do pedido fica pendente e é aplicado quando o pedido chega", async () => {
    const ctx = await setupWithCreators();
    const early = await ctx.sendRefund(refund(1, "25.00"));
    expect(early.status).toBe(201);
    expect(((await early.json()) as any).refund).toMatchObject({ status: "pendente", appliedCents: null });
    expect((await ctx.getJson("/refunds/1")).body.status).toBe("pendente");

    ctx.clock.advance(60_000);
    const created = await ctx.sendOrder(order());
    const body = (await created.json()) as any;
    // a resposta do pedido já traz o estorno aplicado: foi na mesma transação
    expect(body.order).toMatchObject({ refundedCents: 2500, netCents: 7500 });
    expect(body.order.refunds[0]).toMatchObject({ status: "aplicado", appliedCents: 2500, resolvedAt: "2026-03-01T12:01:00.000Z" });
  });

  it("GET /orders/:id/refunds lista os pendentes mesmo sem o pedido existir", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendRefund(refund(2, "10.00", { created_at: "2026-03-06T10:00:00Z" }));
    await ctx.sendRefund(refund(1, "20.00", { created_at: "2026-03-05T10:00:00Z" }));
    const before = await ctx.getJson("/orders/1001/refunds");
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ orderId: "1001", orderReceived: false, pendingCount: 2 });
    expect(before.body.refunds.map((r: any) => [r.refundId, r.status])).toEqual([["1", "pendente"], ["2", "pendente"]]);
    expect((await ctx.getJson("/orders/1001")).status).toBe(404);

    await ctx.sendOrder(order());
    const after = await ctx.getJson("/orders/1001/refunds");
    expect(after.body).toMatchObject({ orderReceived: true, pendingCount: 0 });
    expect(after.body.refunds.map((r: any) => r.status)).toEqual(["aplicado", "aplicado"]);
    expect((await ctx.getJson("/orders/9999/refunds")).body).toEqual({ orderId: "9999", orderReceived: false, pendingCount: 0, refunds: [] });
  });

  it("estorno repetido antes do pedido também conta uma vez só", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendRefund(refund(1, "25.00"));
    expect((await ctx.sendRefund(refund(1, "25.00"))).status).toBe(200);
    await ctx.sendOrder(order());
    expect((await ctx.sendRefund(refund(1, "25.00"))).status).toBe(200);
    const view = await ctx.getJson("/orders/1001");
    expect(view.body).toMatchObject({ refundedCents: 2500, netCents: 7500 });
    expect(view.body.refunds).toHaveLength(1);
  });

  it("vários estornos pendentes cuja soma passa do total: o excedente fica limitado com motivo", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendRefund(refund(1, "60.00", { created_at: "2026-03-05T10:00:00Z" }));
    await ctx.sendRefund(refund(2, "60.00", { created_at: "2026-03-06T10:00:00Z" }));
    await ctx.sendOrder(order());
    const view = await ctx.getJson("/orders/1001");
    expect(view.body).toMatchObject({ refundedCents: 10000, netCents: 0 });
    expect(view.body.refunds.map((r: any) => [r.refundId, r.status, r.appliedCents])).toEqual([
      ["1", "aplicado", 6000],
      ["2", "limitado", 4000],
    ]);
    expect(view.body.refunds[1].reason).toContain("2000 centavos pedidos a mais");
  });

  it("pendentes são aplicados pelo instante real, mesmo com fusos misturados", async () => {
    const ctx = await setupWithCreators();
    // 10:00-03:00 é 13:00Z, depois de 12:00Z, embora a string venha antes na ordem alfabética
    await ctx.sendRefund(refund(1, "60.00", { created_at: "2026-03-05T10:00:00-03:00" }));
    await ctx.sendRefund(refund(2, "60.00", { created_at: "2026-03-05T12:00:00Z" }));
    await ctx.sendOrder(order());
    const view = await ctx.getJson("/orders/1001");
    expect(view.body.refunds.map((r: any) => [r.refundId, r.status, r.appliedCents])).toEqual([
      ["2", "aplicado", 6000],
      ["1", "limitado", 4000],
    ]);
  });

  it("estorno num pedido já zerado é rejeitado, fica registrado e não muda o líquido", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order());
    await ctx.sendRefund(refund(1, "100.00"));
    const res = await ctx.sendRefund(refund(2, "10.00"));
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).refund).toMatchObject({ status: "rejeitado", appliedCents: 0 });
    expect((await ctx.getJson("/orders/1001")).body).toMatchObject({ refundedCents: 10000, netCents: 0 });
  });

  it("estornos diferentes e concorrentes nunca somam mais que o total", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order());
    // 8 estornos de R$ 20 para um pedido de R$ 100, cada um enviado 3 vezes ao mesmo tempo
    const sends = Array.from({ length: 8 }, (_, i) => i + 1).flatMap((id) =>
      Array.from({ length: 3 }, () => ctx.sendRefund(refund(id, "20.00"))),
    );
    await Promise.all(sends);
    const view = await ctx.getJson("/orders/1001");
    expect(view.body.refundedCents).toBe(10000);
    expect(view.body.refunds).toHaveLength(8);
    const applied = view.body.refunds.filter((r: any) => r.status === "aplicado");
    expect(applied).toHaveLength(5);
  });

  it("estorno e pedido chegando juntos, várias vezes cada, terminam no mesmo estado", async () => {
    const ctx = await setupWithCreators();
    const sends = [];
    for (let i = 0; i < 5; i++) {
      sends.push(ctx.sendRefund(refund(1, "40.00")), ctx.sendOrder(order()), ctx.sendRefund(refund(2, "10.00")));
    }
    await Promise.all(sends);
    const view = await ctx.getJson("/orders/1001");
    expect(view.body).toMatchObject({ totalCents: 10000, refundedCents: 5000, netCents: 5000 });
    expect(view.body.refunds.every((r: any) => r.status === "aplicado")).toBe(true);
  });

  it("estorno sem transação concluída não é gravado; a versão pending -> success é aplicada depois", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order());
    for (const status of ["pending", "failure"]) {
      const res = await ctx.sendRefund(refund(1, "50.00", { transactions: [{ amount: "50.00", kind: "refund", status }] }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: "sem_transacao_concluida", refundId: "1", orderId: "1001" });
    }
    expect((await ctx.getJson("/refunds/1")).status).toBe(404);
    expect((await ctx.getJson("/orders/1001")).body.netCents).toBe(10000);

    const done = await ctx.sendRefund(refund(1, "50.00", { transactions: [{ amount: "50.00", kind: "refund", status: "success" }] }));
    expect(done.status).toBe(201);
    expect(((await done.json()) as any).refund).toMatchObject({ status: "aplicado", appliedCents: 5000 });
    expect((await ctx.getJson("/orders/1001")).body.netCents).toBe(5000);
    const log = ctx.db.prepare("SELECT outcome FROM webhook_deliveries WHERE topic = 'refunds/create' ORDER BY delivery_id").all();
    expect(log.map((r: any) => r.outcome)).toEqual(["sem_transacao_concluida", "sem_transacao_concluida", "criado"]);
  });

  it("estorno com transação success de valor zero é gravado como rejeitado, com motivo", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order());
    await ctx.sendRefund(refund(1, "0.00"));
    const view = (await ctx.getJson("/refunds/1")).body;
    expect(view).toMatchObject({ status: "rejeitado", requestedCents: 0, appliedCents: 0 });
    expect(view.reason).toBe("estorno sem valor: as transações concluídas somam zero");
  });

  it("o banco recusa apagar estorno ou passar do total, mesmo fora da API", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order());
    await ctx.sendRefund(refund(1, "30.00"));
    expect(() => ctx.db.prepare("DELETE FROM refunds").run()).toThrow(/não podem ser apagados/);
    expect(() => ctx.db.prepare("UPDATE refunds SET applied_cents = 1 WHERE refund_id = '1'").run()).toThrow(/já resolvido/);
    ctx.db.prepare(
      "INSERT INTO refunds (refund_id, order_id, requested_cents, status, shop_created_at, received_at, webhook_id) VALUES ('x', '1001', 99999, 'pendente', 't', 't', 'w')",
    ).run();
    expect(() =>
      ctx.db.prepare("UPDATE refunds SET status = 'aplicado', applied_cents = 99999 WHERE refund_id = 'x'").run(),
    ).toThrow(/passaria do total/);
  });

  it("estorno repetido com outro valor não muda nada e fica marcado como duplicado_divergente", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order());
    await ctx.sendRefund(refund(1, "30.00"));
    const res = await ctx.sendRefund(refund(1, "90.00"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).result).toBe("duplicado_divergente");
    expect((await ctx.getJson("/orders/1001")).body.refundedCents).toBe(3000);
    expect((await ctx.getJson("/refunds/1")).body.deliveries.map((d: any) => d.outcome)).toEqual(["criado", "duplicado_divergente"]);
  });

  it("GET de estorno ou pedido inexistente devolve 404", async () => {
    const ctx = await setupWithCreators();
    expect((await ctx.getJson("/refunds/404")).body.error.code).toBe("NOT_FOUND");
    expect((await ctx.getJson("/orders/404")).status).toBe(404);
  });
});
