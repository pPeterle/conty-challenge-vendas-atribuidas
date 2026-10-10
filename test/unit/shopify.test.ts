import { describe, expect, it } from "vitest";
import { parseOrderPayload, parseRefundPayload, parseUtms, signBody, verifyHmac } from "../../src/shopify.ts";

describe("payload de pedido", () => {
  it("extrai o essencial e as UTMs do landing_site", () => {
    const parsed = parseOrderPayload({
      id: 5678901234567,
      total_price: "199.90",
      currency: "BRL",
      financial_status: "paid",
      created_at: "2026-01-01T10:00:00-03:00",
      discount_codes: [{ code: "ANA10", amount: "10.00", type: "percentage" }],
      landing_site: "/produtos/x?utm_source=conty&utm_medium=video&utm_campaign=ana",
    });
    expect(parsed.ok && parsed.value).toMatchObject({
      totalCents: 19990,
      discountCodes: ["ANA10"],
      utmSource: "conty",
      utmMedium: "video",
      utmCampaign: "ana",
    });
  });

  it("recusa total_price numérico (evita float)", () => {
    const parsed = parseOrderPayload({ id: 1, total_price: 199.9, currency: "BRL", financial_status: "paid", created_at: "2026-01-01T00:00:00Z" });
    expect(parsed.ok).toBe(false);
  });

  it("landing_site ausente ou sem UTM vira nulo", () => {
    expect(parseUtms(null)).toEqual({ source: null, medium: null, campaign: null });
    expect(parseUtms("/")).toEqual({ source: null, medium: null, campaign: null });
  });
});

describe("payload de estorno", () => {
  it("soma só transações de refund com sucesso", () => {
    const parsed = parseRefundPayload({
      id: 9,
      order_id: 1,
      created_at: "2026-01-02T00:00:00Z",
      transactions: [
        { amount: "30.00", kind: "refund", status: "success", currency: "BRL" },
        { amount: "5.50", kind: "refund", status: "success", currency: "BRL" },
        { amount: "99.00", kind: "refund", status: "failure", currency: "BRL" },
      ],
    });
    expect(parsed.ok && parsed.value).toMatchObject({ amountCents: 3550, currency: "BRL" });
  });
});

describe("HMAC", () => {
  it("aceita assinatura correta e recusa corpo alterado", () => {
    const body = '{"id":1}';
    const sig = signBody(body, "segredo");
    expect(verifyHmac(body, sig, "segredo")).toBe(true);
    expect(verifyHmac('{"id":2}', sig, "segredo")).toBe(false);
    expect(verifyHmac(body, undefined, "segredo")).toBe(false);
  });
});
