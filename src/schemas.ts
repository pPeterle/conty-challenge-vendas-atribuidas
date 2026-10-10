/**
 * Todos os schemas de entrada (corpo, headers e params) ficam aqui.
 * Campos desconhecidos são descartados (`strip`, o padrão do zod).
 */
import { z } from "zod";
import { AppError } from "./errors.ts";
import { parseMoneyToCents } from "./money.ts";

export const COUNTED_FINANCIAL_STATUSES = ["paid", "partially_refunded", "refunded"] as const;
export const KNOWN_FINANCIAL_STATUSES = [
  "pending",
  "authorized",
  "partially_paid",
  "paid",
  "partially_refunded",
  "refunded",
  "voided",
  "expired",
] as const;

export const LIMITS = {
  discountCodes: 50,
  codeLength: 100,
  landingSiteLength: 2048,
  transactions: 50,
  coupons: 50,
  text: 100,
  name: 200,
  webhookId: 255,
} as const;

const label = (path: (string | number)[]) => (path.length === 0 ? "corpo" : path.join("."));

/** Mensagens em português para os erros genéricos do zod. Mensagens customizadas passam direto. */
const ptErrorMap: z.ZodErrorMap = (issue, ctx) => {
  const field = label(issue.path);
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.path.length === 0) return { message: "corpo precisa ser um objeto JSON" };
      if (issue.received === "undefined") return { message: `${field} é obrigatório` };
      return { message: `${field} tem tipo inválido (esperado ${issue.expected}, recebido ${issue.received})` };
    case z.ZodIssueCode.too_small:
      if (issue.type === "string") return { message: issue.minimum === 1 ? `${field} não pode ser vazio` : `${field} precisa ter pelo menos ${issue.minimum} caracteres` };
      if (issue.type === "array") return { message: issue.minimum === 1 ? `${field} não pode ser vazia` : `${field} precisa ter pelo menos ${issue.minimum} itens` };
      return { message: `${field} abaixo do mínimo (${issue.minimum})` };
    case z.ZodIssueCode.too_big:
      if (issue.type === "string") return { message: `${field} aceita no máximo ${issue.maximum} caracteres` };
      if (issue.type === "array") return { message: `${field} aceita no máximo ${issue.maximum} itens` };
      return { message: `${field} acima do máximo (${issue.maximum})` };
    case z.ZodIssueCode.invalid_string:
      if (issue.validation === "datetime") return { message: `${field} precisa ser data ISO 8601 com fuso, ex.: 2026-03-01T09:00:00-03:00` };
      return { message: `${field} em formato inválido` };
    case z.ZodIssueCode.invalid_enum_value:
      return { message: `${field} precisa ser um de: ${issue.options.join(", ")}` };
    case z.ZodIssueCode.custom:
      return { message: issue.message ?? `${field} inválido` };
    default:
      return { message: `${field} inválido (${ctx.defaultError})` };
  }
};
z.setErrorMap(ptErrorMap);

export interface ValidationDetail {
  path: string;
  message: string;
}

/** Converte o erro do zod no formato de erro padrão da API (400). */
export function toValidationError(error: z.ZodError): AppError {
  const details: ValidationDetail[] = error.issues.map((i) => ({ path: label(i.path), message: i.message }));
  return new AppError(400, "VALIDATION_ERROR", details[0]?.message ?? "payload inválido", details);
}

// ---------------------------------------------------------------- blocos

const text = (max: number) => z.string().trim().min(1).max(max);

const ID_KEYS = new Set(["id", "order_id"]);

/**
 * JSON.parse que preserva o texto original de `id` e `order_id`. Ids da Shopify
 * passam de 2^53; como número JS eles perdem precisão e dois pedidos vizinhos
 * colidiriam. O reviver recebe o trecho original em `context.source` (Node >= 22).
 */
export function parseWebhookJson(raw: string): unknown {
  const reviver = (key: string, value: unknown, context?: { source?: string }) =>
    ID_KEYS.has(key) && typeof value === "number" && context?.source && /^\d+$/.test(context.source) ? context.source : value;
  return JSON.parse(raw, reviver as (key: string, value: unknown) => unknown);
}

/**
 * Ids da Shopify são inteiros grandes; guardamos como texto canônico, para que
 * 123 e "0123" sejam o mesmo pedido. Zero e negativo são recusados.
 */
const shopifyId = (name: string) =>
  z.unknown().transform((value, ctx) => {
    let id: bigint | null = null;
    if (typeof value === "number" && Number.isSafeInteger(value)) id = BigInt(value);
    else if (typeof value === "string" && /^\d{1,20}$/.test(value)) id = BigInt(value);
    if (id === null || id <= 0n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name} ausente ou inválido` });
      return z.NEVER;
    }
    return String(id);
  });

/** String decimal ("199.90") convertida em centavos inteiros, sem float. */
const moneyCents = (name: string) =>
  z.unknown().transform((value, ctx) => {
    const cents = parseMoneyToCents(value);
    if (cents === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name} precisa ser string decimal, ex.: "199.90"` });
      return z.NEVER;
    }
    return cents;
  });

const currency = z.string().regex(/^[A-Z]{3}$/, "currency precisa ser um código ISO de 3 letras, ex.: BRL");

// Date.parse aceita 30 de fevereiro e rola para março; aqui a data precisa existir.
function calendarDateExists(value: string): boolean {
  const [y, m, d] = value.slice(0, 10).split("-").map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d;
}

/** Data com fuso explícito: sem ele, o instante dependeria do fuso do servidor. */
const timestamp = z
  .string()
  .datetime({ offset: true })
  .refine(calendarDateExists, { message: "created_at tem uma data que não existe no calendário" });

// ---------------------------------------------------------------- webhooks

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

/** Webhook `orders/paid`, só com o essencial. A saída já vem no formato usado pelo domínio. */
export const orderWebhookSchema = z
  .object({
    id: shopifyId("id do pedido"),
    total_price: moneyCents("total_price"),
    currency,
    financial_status: z.enum(KNOWN_FINANCIAL_STATUSES),
    created_at: timestamp,
    discount_codes: z
      .array(z.object({ code: text(LIMITS.codeLength) }))
      .max(LIMITS.discountCodes)
      .nullish(),
    landing_site: z.string().max(LIMITS.landingSiteLength).nullish(),
  })
  .transform((o) => {
    const landingSite = o.landing_site ?? null;
    const utms = parseUtms(landingSite);
    return {
      orderId: o.id,
      totalCents: o.total_price,
      currency: o.currency,
      financialStatus: o.financial_status,
      createdAt: o.created_at,
      discountCodes: (o.discount_codes ?? []).map((d) => d.code),
      landingSite,
      utmSource: utms.source,
      utmMedium: utms.medium,
      utmCampaign: utms.campaign,
    };
  });
export type OrderPayload = z.output<typeof orderWebhookSchema>;

const transactionSchema = z.object({
  kind: z.unknown().optional(),
  status: z.unknown().optional(),
  amount: z.unknown().optional(),
  currency: z.unknown().optional(),
});

/**
 * Webhook `refunds/create`. Valor do estorno = soma das transações
 * `kind: "refund"` com `status: "success"`. As outras não devolvem dinheiro e
 * por isso não passam nem pela checagem de valor e moeda.
 */
export const refundWebhookSchema = z
  .object({
    id: shopifyId("id do estorno"),
    order_id: shopifyId("order_id"),
    created_at: timestamp,
    transactions: z.array(transactionSchema).min(1).max(LIMITS.transactions),
  })
  .transform((r, ctx) => {
    let amountCents = 0;
    let concludedTransactions = 0;
    let refundCurrency: string | null = null;
    r.transactions.forEach((tx, i) => {
      if (tx.kind !== "refund" || tx.status !== "success") return;
      concludedTransactions += 1;
      const cents = parseMoneyToCents(tx.amount);
      if (cents === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["transactions", i, "amount"], message: 'amount da transação precisa ser string decimal, ex.: "50.00"' });
        return;
      }
      if (tx.currency !== undefined) {
        const parsed = currency.safeParse(tx.currency);
        if (!parsed.success) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["transactions", i, "currency"], message: "currency da transação inválida" });
          return;
        }
        if (refundCurrency !== null && refundCurrency !== parsed.data) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["transactions", i, "currency"], message: "transações do mesmo estorno com moedas diferentes" });
          return;
        }
        refundCurrency = parsed.data;
      }
      amountCents += cents;
    });
    return { refundId: r.id, orderId: r.order_id, createdAt: r.created_at, amountCents, currency: refundCurrency, concludedTransactions };
  });
export type RefundPayload = z.output<typeof refundWebhookSchema>;

export const webhookHeadersSchema = z.object({
  "x-shopify-webhook-id": text(LIMITS.webhookId),
});

// ---------------------------------------------------------------- API própria

const CREATOR_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const creatorId = z.string().regex(CREATOR_ID, "id do criador precisa ter de 1 a 64 letras minúsculas, números, _ ou -");

export const createCreatorSchema = z
  .object({
    id: creatorId,
    name: text(LIMITS.name),
    utmCampaign: text(LIMITS.text).nullish(),
    coupons: z.array(text(LIMITS.text)).max(LIMITS.coupons).default([]),
  })
  .transform((c) => ({ creatorId: c.id, name: c.name, utmCampaign: c.utmCampaign ?? null, coupons: c.coupons }));
export type NewCreator = z.output<typeof createCreatorSchema>;

export const creatorParamSchema = z.object({ id: creatorId });
export const orderParamSchema = z.object({ id: shopifyId("id do pedido") });
export const refundParamSchema = z.object({ id: shopifyId("id do estorno") });
