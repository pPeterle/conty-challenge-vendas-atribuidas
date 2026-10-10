import { describe, expect, it } from "vitest";
import { order, refund, setupWithCreators, signedHeaders } from "./helpers.ts";

const cancelled = (overrides: Record<string, unknown> = {}) =>
  order({ cancelled_at: "2026-03-07T10:00:00-03:00", financial_status: "refunded", ...overrides });

describe("cancelamento de pedido", () => {
  it("reverte o saldo restante num lançamento rastreável e a atribuição fica cancelada", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order());
    await ctx.sendRefund(refund(1, "30.00"));
    const res = await ctx.sendOrder(cancelled());
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.result).toBe("cancelado");
    expect(body.order).toMatchObject({
      refundedCents: 10000,
      netCents: 0,
      cancelledAt: "2026-03-07T10:00:00-03:00",
      attribution: { creatorId: "ana", status: "cancelada" },
    });
    expect(body.order.refunds.map((r: any) => [r.kind, r.status, r.appliedCents, r.reason])).toEqual([
      ["estorno", "aplicado", 3000, null],
      ["cancelamento", "aplicado", 7000, "cancelamento do pedido: saldo restante revertido"],
    ]);
    expect((await ctx.getJson("/creators/summary")).body.creators[0]).toMatchObject({ orders: 1, grossCents: 10000, netCents: 0 });
  });

  it("cancelamento repetido e webhooks atrasados não reativam nem mexem no saldo", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order());
    await ctx.sendOrder(cancelled());
    const again = await ctx.sendOrder(cancelled());
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).result).toBe("duplicado");
    // orders/paid atrasado é só repetição
    expect(((await (await ctx.sendOrder(order())).json()) as any).result).toBe("duplicado");
    // estorno atrasado encontra o saldo zerado
    const late = await ctx.sendRefund(refund(9, "20.00"));
    expect(((await late.json()) as any).refund).toMatchObject({ status: "rejeitado", appliedCents: 0 });
    const view = (await ctx.getJson("/orders/1001")).body;
    expect(view).toMatchObject({ refundedCents: 10000, netCents: 0 });
    expect(view.refunds.filter((r: any) => r.kind === "cancelamento")).toHaveLength(1);
  });

  it("financial_status voided também cancela, e a rota orders/cancelled aceita o mesmo payload", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order({ id: 1 }));
    await ctx.sendOrder(order({ id: 2 }));
    expect(((await (await ctx.sendOrder(order({ id: 1, financial_status: "voided" }))).json()) as any).result).toBe("cancelado");
    const res = await ctx.app.request("/webhooks/shopify/orders/cancelled", {
      method: "POST",
      headers: signedHeaders(JSON.stringify(cancelled({ id: 2 }))),
      body: JSON.stringify(cancelled({ id: 2 })),
    });
    expect(res.status).toBe(201);
    expect((await ctx.getJson("/orders/1")).body.netCents).toBe(0);
    expect((await ctx.getJson("/orders/2")).body.netCents).toBe(0);
  });

  it("cancelamento de pedido pago que ainda não tinha chegado grava a venda já cancelada", async () => {
    const ctx = await setupWithCreators();
    const res = await ctx.sendOrder(cancelled());
    expect(((await res.json()) as any).result).toBe("cancelado");
    expect(((await (await ctx.sendOrder(order())).json()) as any).result).toBe("duplicado");
    expect((await ctx.getJson("/orders/1001")).body).toMatchObject({ totalCents: 10000, netCents: 0, attribution: { status: "cancelada" } });
  });

  it("pedido anulado antes de chegar como pago fica com cancelamento pendente; o pago atrasado entra já cancelado", async () => {
    const ctx = await setupWithCreators();
    const res = await ctx.sendOrder(order({ financial_status: "voided" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ result: "cancelamento_pendente", orderId: "1001", order: null });
    expect((await ctx.getJson("/orders/1001/refunds")).body).toMatchObject({ orderReceived: false, pendingCount: 1 });

    await ctx.sendOrder(order());
    expect((await ctx.getJson("/orders/1001")).body).toMatchObject({ netCents: 0, attribution: { status: "cancelada" } });
  });

  it("pedido, estornos e cancelamento simultâneos e repetidos: um cancelamento só e soma igual ao total", async () => {
    const ctx = await setupWithCreators();
    const sends = [];
    for (let i = 0; i < 4; i++) {
      sends.push(ctx.sendOrder(order()), ctx.sendRefund(refund(1, "60.00")), ctx.sendOrder(cancelled()), ctx.sendRefund(refund(2, "60.00")));
    }
    await Promise.all(sends);
    const view = (await ctx.getJson("/orders/1001")).body;
    expect(view).toMatchObject({ refundedCents: 10000, netCents: 0 });
    expect(view.refunds.filter((r: any) => r.kind === "cancelamento")).toHaveLength(1);
    expect(view.refunds.reduce((s: number, r: any) => s + r.appliedCents, 0)).toBe(10000);
  });
});
