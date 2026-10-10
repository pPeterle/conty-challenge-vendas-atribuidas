/**
 * O essencial dos webhooks da Shopify que este serviço usa: `orders/paid` e
 * `refunds/create`. Validação manual, só dos campos que a regra precisa.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { parseMoneyToCents } from "./money.ts";

export const COUNTED_FINANCIAL_STATUSES = ["paid", "partially_refunded", "refunded"] as const;

export interface OrderPayload {
  orderId: string;
  totalCents: number;
  currency: string;
  financialStatus: string;
  createdAt: string;
  discountCodes: string[];
  landingSite: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
}

export interface RefundPayload {
  refundId: string;
  orderId: string;
  createdAt: string;
  amountCents: number;
  currency: string | null;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Ids da Shopify são inteiros grandes; guardamos como texto.
function parseId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d{1,20}$/.test(value)) return value;
  return null;
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function parseCurrency(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null;
}

export function parseUtms(landingSite: string | null): { source: string | null; medium: string | null; campaign: string | null } {
  if (!landingSite) return { source: null, medium: null, campaign: null };
  let params: URLSearchParams;
  try {
    params = new URL(landingSite, "https://loja.invalid").searchParams;
  } catch {
    return { source: null, medium: null, campaign: null };
  }
  const read = (key: string) => {
    const v = params.get(key)?.trim();
    return v ? v : null;
  };
  return { source: read("utm_source"), medium: read("utm_medium"), campaign: read("utm_campaign") };
}

export function parseOrderPayload(body: unknown): Parsed<OrderPayload> {
  if (!isObject(body)) return { ok: false, message: "corpo precisa ser um objeto JSON" };
  const orderId = parseId(body.id);
  if (!orderId) return { ok: false, message: "id do pedido ausente ou inválido" };
  const totalCents = parseMoneyToCents(body.total_price);
  if (totalCents === null) return { ok: false, message: 'total_price precisa ser string decimal, ex.: "199.90"' };
  const currency = parseCurrency(body.currency);
  if (!currency) return { ok: false, message: "currency precisa ser um código ISO de 3 letras, ex.: BRL" };
  if (typeof body.financial_status !== "string" || body.financial_status === "") {
    return { ok: false, message: "financial_status ausente" };
  }
  const createdAt = parseTimestamp(body.created_at);
  if (!createdAt) return { ok: false, message: "created_at ausente ou inválido" };

  const rawCodes = body.discount_codes ?? [];
  if (!Array.isArray(rawCodes)) return { ok: false, message: "discount_codes precisa ser uma lista" };
  const discountCodes: string[] = [];
  for (const item of rawCodes) {
    if (!isObject(item) || typeof item.code !== "string") {
      return { ok: false, message: "cada item de discount_codes precisa ter code (string)" };
    }
    discountCodes.push(item.code);
  }

  const landingSite = body.landing_site ?? null;
  if (landingSite !== null && typeof landingSite !== "string") {
    return { ok: false, message: "landing_site precisa ser string ou null" };
  }
  const utms = parseUtms(landingSite);
  return {
    ok: true,
    value: {
      orderId,
      totalCents,
      currency,
      financialStatus: body.financial_status,
      createdAt,
      discountCodes,
      landingSite,
      utmSource: utms.source,
      utmMedium: utms.medium,
      utmCampaign: utms.campaign,
    },
  };
}

/**
 * Valor do estorno = soma das transações `kind: "refund"` com `status: "success"`.
 * Transações com falha não devolvem dinheiro e por isso não contam.
 */
export function parseRefundPayload(body: unknown): Parsed<RefundPayload> {
  if (!isObject(body)) return { ok: false, message: "corpo precisa ser um objeto JSON" };
  const refundId = parseId(body.id);
  if (!refundId) return { ok: false, message: "id do estorno ausente ou inválido" };
  const orderId = parseId(body.order_id);
  if (!orderId) return { ok: false, message: "order_id ausente ou inválido" };
  const createdAt = parseTimestamp(body.created_at);
  if (!createdAt) return { ok: false, message: "created_at ausente ou inválido" };
  if (!Array.isArray(body.transactions)) return { ok: false, message: "transactions precisa ser uma lista" };

  let amountCents = 0;
  let currency: string | null = null;
  for (const tx of body.transactions) {
    if (!isObject(tx)) return { ok: false, message: "cada transação precisa ser um objeto" };
    const cents = parseMoneyToCents(tx.amount);
    if (cents === null) return { ok: false, message: 'amount da transação precisa ser string decimal, ex.: "50.00"' };
    if (tx.currency !== undefined) {
      const txCurrency = parseCurrency(tx.currency);
      if (!txCurrency) return { ok: false, message: "currency da transação inválida" };
      if (currency !== null && currency !== txCurrency) {
        return { ok: false, message: "transações do mesmo estorno com moedas diferentes" };
      }
      currency = txCurrency;
    }
    if (tx.kind === "refund" && tx.status === "success") amountCents += cents;
  }
  return { ok: true, value: { refundId, orderId, createdAt, amountCents, currency } };
}

export function signBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

/** Confere o header X-Shopify-Hmac-Sha256 (HMAC-SHA256 do corpo cru, em base64). */
export function verifyHmac(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(signBody(rawBody, secret));
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
