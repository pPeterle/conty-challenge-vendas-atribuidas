import { describe, expect, it } from "vitest";
import { orderWebhookSchema, parseUtms, refundWebhookSchema } from "../../src/schemas.ts";
import { signBody, verifyHmac } from "../../src/shopify.ts";

const parseOrderPayload = (body: unknown) => orderWebhookSchema.safeParse(body);
const parseRefundPayload = (body: unknown) => refundWebhookSchema.safeParse(body);

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
    expect(parsed.success && parsed.data).toMatchObject({
      totalCents: 19990,
      discountCodes: ["ANA10"],
      utmSource: "conty",
      utmMedium: "video",
      utmCampaign: "ana",
    });
  });

  it("recusa total_price numérico (evita float)", () => {
    const parsed = parseOrderPayload({ id: 1, total_price: 199.9, currency: "BRL", financial_status: "paid", created_at: "2026-01-01T00:00:00Z" });
    expect(parsed.success).toBe(false);
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
    expect(parsed.success && parsed.data).toMatchObject({ amountCents: 3550, currency: "BRL" });
  });

  it("transação com falha em outra moeda não derruba o estorno válido", () => {
    const parsed = parseRefundPayload({
      id: 9,
      order_id: 1,
      created_at: "2026-01-02T00:00:00Z",
      transactions: [
        { amount: "10.00", kind: "refund", status: "failure", currency: "USD" },
        { amount: "30.00", kind: "refund", status: "success", currency: "BRL" },
      ],
    });
    expect(parsed.success && parsed.data).toMatchObject({ amountCents: 3000, currency: "BRL" });
  });
});

describe("ids", () => {
  const base = { total_price: "1.00", currency: "BRL", financial_status: "paid", created_at: "2026-01-01T00:00:00Z" };

  it("123 e \"0123\" viram o mesmo id canônico", () => {
    const a = parseOrderPayload({ ...base, id: 123 });
    const b = parseOrderPayload({ ...base, id: "0123" });
    expect(a.success && a.data.orderId).toBe("123");
    expect(b.success && b.data.orderId).toBe("123");
  });

  it("recusa id zero ou negativo", () => {
    for (const id of [0, "0", "000", -5, "-5"]) expect(parseOrderPayload({ ...base, id }).success).toBe(false);
  });
});

describe("mensagens de erro", () => {
  it("vêm em português, com caminho de cada campo", () => {
    const parsed = parseRefundPayload({ id: 1, order_id: 2, created_at: "2026-01-02", transactions: [{ amount: 5, kind: "refund", status: "success" }] });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((i) => [i.path.join("."), i.message])).toEqual([
      ["created_at", "created_at precisa ser data ISO 8601 com fuso, ex.: 2026-03-01T09:00:00-03:00"],
    ]);
  });
});

describe("fuso da data", () => {
  const base = { id: 1, total_price: "1.00", currency: "BRL", financial_status: "paid" };
  it.each(["+24:00", "+99:00", "+23:60", "-15:00", "+14:01"])("fuso impossível %s é recusado com mensagem própria", (offset) => {
    const parsed = parseOrderPayload({ ...base, created_at: `2026-01-01T10:00:00${offset}` });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((i) => i.message)).toEqual(["created_at tem um fuso impossível (aceito de -14:00 a +14:00)"]);
  });

  it.each(["+14:00", "-14:00", "+05:45", "Z"])("fuso %s é aceito", (offset) => {
    expect(parseOrderPayload({ ...base, created_at: `2026-01-01T10:00:00${offset}` }).success).toBe(true);
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
