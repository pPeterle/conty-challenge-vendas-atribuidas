import { describe, expect, it } from "vitest";
import { attributionStatus, decideRefund } from "../../src/refunds.ts";

const base = { orderTotalCents: 10000, alreadyAppliedCents: 0, orderCurrency: "BRL", refundCurrency: "BRL" };

describe("decideRefund", () => {
  it("estorno parcial dentro do total é aplicado inteiro", () => {
    expect(decideRefund({ ...base, requestedCents: 3000 })).toEqual({ status: "aplicado", appliedCents: 3000, reason: null });
  });

  it("estorno que passaria do total é limitado ao que resta, com motivo", () => {
    const d = decideRefund({ ...base, alreadyAppliedCents: 8000, requestedCents: 5000 });
    expect(d.status).toBe("limitado");
    expect(d.appliedCents).toBe(2000);
    expect(d.reason).toContain("3000");
  });

  it("estorno num pedido já zerado é rejeitado, com motivo", () => {
    const d = decideRefund({ ...base, alreadyAppliedCents: 10000, requestedCents: 100 });
    expect(d).toMatchObject({ status: "rejeitado", appliedCents: 0 });
    expect(d.reason).not.toBeNull();
  });

  it("estorno de valor zero é rejeitado com motivo", () => {
    expect(decideRefund({ ...base, requestedCents: 0 })).toMatchObject({ status: "rejeitado", appliedCents: 0 });
  });

  it("estorno em pedido de valor zero é rejeitado com motivo próprio", () => {
    const d = decideRefund({ ...base, orderTotalCents: 0, requestedCents: 500 });
    expect(d).toEqual({ status: "rejeitado", appliedCents: 0, reason: "pedido de valor zero: não há o que estornar" });
  });

  it("estorno em outra moeda é rejeitado", () => {
    expect(decideRefund({ ...base, refundCurrency: "USD", requestedCents: 100 }).status).toBe("rejeitado");
  });

  it("estorno sem moeda informada usa a do pedido", () => {
    expect(decideRefund({ ...base, refundCurrency: null, requestedCents: 100 }).status).toBe("aplicado");
  });
});

describe("attributionStatus", () => {
  it("vai de ativa para parcialmente revertida e revertida conforme os estornos", () => {
    expect(attributionStatus("ana", 100, 0)).toBe("ativa");
    expect(attributionStatus("ana", 100, 40)).toBe("parcialmente_revertida");
    expect(attributionStatus("ana", 100, 100)).toBe("revertida");
    expect(attributionStatus(null, 100, 0)).toBe("sem_criador");
  });
});
