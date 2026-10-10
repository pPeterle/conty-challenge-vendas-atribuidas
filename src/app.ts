import type { DatabaseSync } from "node:sqlite";
import { Hono, type Context } from "hono";
import type { Clock } from "./clock.ts";
import { createStore } from "./db.ts";
import { AppError, notFound, validation } from "./errors.ts";
import {
  getOrderView,
  getRefundView,
  getSummary,
  ingestOrder,
  ingestRefund,
  logIgnoredOrder,
  registerCreator,
} from "./sales.ts";
import { COUNTED_FINANCIAL_STATUSES, parseOrderPayload, parseRefundPayload, verifyHmac } from "./shopify.ts";

export interface AppDeps {
  db: DatabaseSync;
  clock: Clock;
  /** Segredo compartilhado com a loja para conferir o X-Shopify-Hmac-Sha256. */
  webhookSecret: string;
}

/** Lê o corpo cru, confere a assinatura e o X-Shopify-Webhook-Id. */
async function readWebhook(c: Context, secret: string): Promise<{ body: unknown; webhookId: string }> {
  const raw = await c.req.text();
  if (!verifyHmac(raw, c.req.header("x-shopify-hmac-sha256"), secret)) {
    throw new AppError(401, "INVALID_SIGNATURE", "assinatura X-Shopify-Hmac-Sha256 ausente ou inválida");
  }
  const webhookId = c.req.header("x-shopify-webhook-id");
  if (!webhookId) throw validation("header X-Shopify-Webhook-Id é obrigatório");
  try {
    return { body: JSON.parse(raw), webhookId };
  } catch {
    throw validation("corpo não é JSON válido");
  }
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw validation("corpo não é JSON válido");
  }
}

const CREATOR_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function parseCreator(body: unknown) {
  if (typeof body !== "object" || body === null) throw validation("corpo precisa ser um objeto JSON");
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || !CREATOR_ID.test(b.id)) {
    throw validation("id do criador precisa ter letras minúsculas, números, _ ou -");
  }
  if (typeof b.name !== "string" || b.name.trim() === "") throw validation("name é obrigatório");
  const utm = b.utmCampaign ?? null;
  if (utm !== null && (typeof utm !== "string" || utm.trim() === "")) throw validation("utmCampaign precisa ser string");
  const coupons = b.coupons ?? [];
  if (!Array.isArray(coupons) || coupons.some((x) => typeof x !== "string" || x.trim() === "")) {
    throw validation("coupons precisa ser uma lista de strings");
  }
  return { creatorId: b.id, name: b.name.trim(), utmCampaign: utm as string | null, coupons: coupons as string[] };
}

export function createApp({ db, clock, webhookSecret }: AppDeps) {
  const store = createStore(db);
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    console.error(err);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "erro interno" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "rota não encontrada" } }, 404));

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/creators", async (c) => {
    const creator = registerCreator(store, clock, parseCreator(await readJson(c)));
    return c.json(creator, 201);
  });

  app.post("/webhooks/shopify/orders", async (c) => {
    const { body, webhookId } = await readWebhook(c, webhookSecret);
    const parsed = parseOrderPayload(body);
    if (!parsed.ok) throw validation(parsed.message);
    const order = parsed.value;
    if (!(COUNTED_FINANCIAL_STATUSES as readonly string[]).includes(order.financialStatus)) {
      // 200 para a loja não reenviar; o pedido entra quando vier o orders/paid.
      logIgnoredOrder(store, clock, order, webhookId);
      return c.json({ result: "ignorado", orderId: order.orderId, reason: `financial_status ${order.financialStatus} não conta como venda` }, 200);
    }
    const result = ingestOrder(store, clock, order, webhookId);
    return c.json({ result, order: getOrderView(store, order.orderId) }, result === "criado" ? 201 : 200);
  });

  app.post("/webhooks/shopify/refunds", async (c) => {
    const { body, webhookId } = await readWebhook(c, webhookSecret);
    const parsed = parseRefundPayload(body);
    if (!parsed.ok) throw validation(parsed.message);
    const result = ingestRefund(store, clock, parsed.value, webhookId);
    return c.json({ result, refund: getRefundView(store, parsed.value.refundId) }, result === "criado" ? 201 : 200);
  });

  app.get("/orders/:id", (c) => c.json(getOrderView(store, c.req.param("id"))));
  app.get("/refunds/:id", (c) => c.json(getRefundView(store, c.req.param("id"))));
  app.get("/creators/summary", (c) => c.json(getSummary(store)));
  app.get("/creators/:id", (c) => {
    const creator = store.getCreator(c.req.param("id"));
    if (!creator) throw notFound(`criador ${c.req.param("id")} não encontrado`);
    return c.json(creator);
  });

  return app;
}
