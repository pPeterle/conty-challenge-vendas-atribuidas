import { describe, expect, it } from "vitest";
import { order, refund, setupWithCreators } from "./helpers.ts";

describe("resumo por criador", () => {
  it("soma bruto, estornado e líquido por criador, separando vendas sem criador", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendOrder(order({ id: 1, total_price: "100.00" }));
    await ctx.sendOrder(order({ id: 2, total_price: "50.50" }));
    await ctx.sendOrder(order({ id: 3, total_price: "80.00", discount_codes: [{ code: "BRUNO15" }] }));
    await ctx.sendOrder(order({ id: 4, total_price: "10.00", discount_codes: [], landing_site: null }));
    await ctx.sendRefund(refund(11, "20.25", { order_id: 2 }));
    await ctx.sendRefund(refund(12, "80.00", { order_id: 3 }));

    const { status, body } = await ctx.getJson("/creators/summary");
    expect(status).toBe(200);
    expect(body).toEqual({
      creators: [
        { creatorId: "ana", creatorName: "Ana", currency: "BRL", orders: 2, grossCents: 15050, refundedCents: 2025, netCents: 13025 },
        { creatorId: "bruno", creatorName: "Bruno", currency: "BRL", orders: 1, grossCents: 8000, refundedCents: 8000, netCents: 0 },
      ],
      unattributed: [{ currency: "BRL", orders: 1, grossCents: 1000, refundedCents: 0, netCents: 1000 }],
    });
  });

  it("estorno pendente (sem pedido) não entra no resumo", async () => {
    const ctx = await setupWithCreators();
    await ctx.sendRefund(refund(1, "10.00", { order_id: 999 }));
    expect((await ctx.getJson("/creators/summary")).body).toEqual({ creators: [], unattributed: [] });
  });
});
