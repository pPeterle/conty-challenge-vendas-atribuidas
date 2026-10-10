import { describe, expect, it } from "vitest";
import { order, refund, setupWithCreators } from "./helpers.ts";

describe("leituras de acompanhamento", () => {
  it("GET /refunds/pending lista todos os pendentes, de vários pedidos, com paginação", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendRefund(refund(1, "10.00", { order_id: 501 }));
    ctx.clock.advance(1000);
    await ctx.sendRefund(refund(2, "10.00", { order_id: 502 }));
    ctx.clock.advance(1000);
    await ctx.sendRefund(refund(3, "10.00", { order_id: 503 }));
    await ctx.sendOrder(order({ id: 502 }));

    const all = (await ctx.getJson("/refunds/pending")).body;
    expect(all).toMatchObject({ total: 2, limit: 100, offset: 0 });
    expect(all.refunds.map((r: any) => [r.refundId, r.orderId])).toEqual([["1", "501"], ["3", "503"]]);

    const page = (await ctx.getJson("/refunds/pending?limit=1&offset=1")).body;
    expect(page.refunds.map((r: any) => r.refundId)).toEqual(["3"]);
  });

  it.each([["limit=0"], ["limit=501"], ["limit=abc"], ["offset=-1"], ["offset=x"]])("GET /refunds/pending?%s devolve 400", async (query) => {
    const ctx = await setupWithCreators();
    const res = await ctx.getJson(`/refunds/pending?${query}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("GET /review junta desempates, estornos limitados ou rejeitados e repetições divergentes", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order({ id: 1, landing_site: "/?utm_source=conty&utm_campaign=bruno" }));
    await ctx.sendOrder(order({ id: 2 }));
    await ctx.sendRefund(refund(10, "80.00", { order_id: 2 }));
    await ctx.sendRefund(refund(11, "80.00", { order_id: 2 }));
    await ctx.sendRefund(refund(12, "5.00", { order_id: 2 }));
    await ctx.sendRefund(refund(10, "99.00", { order_id: 2 }));

    const review = (await ctx.getJson("/review")).body;
    expect(review.tieBreakConflicts).toEqual([
      expect.objectContaining({ orderId: "1", creatorId: "ana", discardedCreatorIds: ["bruno"], reason: "cupom_vence_utm" }),
    ]);
    expect(review.cappedOrRejectedRefunds.total).toBe(2);
    expect(review.cappedOrRejectedRefunds.refunds.map((r: any) => [r.refundId, r.status])).toEqual([
      ["11", "limitado"],
      ["12", "rejeitado"],
    ]);
    expect(review.divergentDeliveries).toEqual([expect.objectContaining({ topic: "refunds/create", resourceId: "10" })]);
  });
});
