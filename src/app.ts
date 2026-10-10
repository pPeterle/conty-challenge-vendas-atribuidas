import type { DatabaseSync } from "node:sqlite";
import { zValidator } from "@hono/zod-validator";
import { Hono, type MiddlewareHandler, type ValidationTargets } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { ZodSchema } from "zod";
import type { Clock } from "./clock.ts";
import { createStore } from "./db.ts";
import { AppError, notFound, validation } from "./errors.ts";
import {
  getOrderView,
  getRefundView,
  getSummary,
  ingestOrder,
  ingestRefund,
  listOrderRefunds,
  logIgnoredOrder,
  logRejectedDelivery,
  registerCreator,
} from "./sales.ts";
import {
  COUNTED_FINANCIAL_STATUSES,
  createCreatorSchema,
  creatorParamSchema,
  orderParamSchema,
  orderWebhookSchema,
  parseWebhookJson,
  refundParamSchema,
  refundWebhookSchema,
  toValidationError,
  webhookHeadersSchema,
} from "./schemas.ts";
import { verifyHmac } from "./shopify.ts";

export interface AppDeps {
  db: DatabaseSync;
  clock: Clock;
  /** Segredo compartilhado com a loja para conferir o X-Shopify-Hmac-Sha256. */
  webhookSecret: string;
}

const MAX_BODY_BYTES = 1024 * 1024;

/** Um só ponto que transforma falha do zod no erro padrão da API. */
const validate = <T extends keyof ValidationTargets, S extends ZodSchema>(target: T, schema: S) =>
  zValidator(target, schema, (result) => {
    if (!result.success) throw toValidationError(result.error);
  });

const requireJsonContentType: MiddlewareHandler = async (c, next) => {
  if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) {
    throw validation("Content-Type precisa ser application/json");
  }
  await next();
};

export function createApp({ db, clock, webhookSecret }: AppDeps) {
  const store = createStore(db);
  const app = new Hono();

  /** Confere a assinatura sobre o corpo cru antes de qualquer outra validação. */
  const verifySignature: MiddlewareHandler = async (c, next) => {
    const raw = await c.req.text();
    if (!verifyHmac(raw, c.req.header("x-shopify-hmac-sha256"), webhookSecret)) {
      throw new AppError(401, "INVALID_SIGNATURE", "assinatura X-Shopify-Hmac-Sha256 ausente ou inválida");
    }
    await next();
  };

  /** JSON.parse + safeParse depois do HMAC. Entrega recusada fica no log com o motivo. */
  async function parseWebhook<S extends ZodSchema>(raw: string, schema: S, topic: string, webhookId: string) {
    let body: unknown;
    try {
      body = parseWebhookJson(raw);
    } catch {
      logRejectedDelivery(store, clock, { topic, webhookId, body: undefined, message: "corpo não é JSON válido" });
      throw validation("corpo não é JSON válido");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const error = toValidationError(parsed.error);
      logRejectedDelivery(store, clock, { topic, webhookId, body, message: error.message });
      throw error;
    }
    return parsed.data as ReturnType<S["parse"]>;
  }

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toBody(), err.status);
    if (err instanceof HTTPException && err.status === 400) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "corpo não é JSON válido" } }, 400);
    }
    console.error(err);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "erro interno" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "rota não encontrada" } }, 404));

  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "corpo maior que 1 MB" } }, 413),
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/creators", requireJsonContentType, validate("json", createCreatorSchema), (c) => {
    const creator = registerCreator(store, clock, c.req.valid("json"));
    return c.json(creator, 201);
  });

  app.post("/webhooks/shopify/orders", verifySignature, validate("header", webhookHeadersSchema), async (c) => {
    const webhookId = c.req.valid("header")["x-shopify-webhook-id"];
    const order = await parseWebhook(await c.req.text(), orderWebhookSchema, "orders/paid", webhookId);
    if (!(COUNTED_FINANCIAL_STATUSES as readonly string[]).includes(order.financialStatus)) {
      // 200 para a loja não reenviar; o pedido entra quando vier o orders/paid.
      logIgnoredOrder(store, clock, order, webhookId);
      return c.json({ result: "ignorado", orderId: order.orderId, reason: `financial_status ${order.financialStatus} não conta como venda` }, 200);
    }
    const result = ingestOrder(store, clock, order, webhookId);
    return c.json({ result, order: getOrderView(store, order.orderId) }, result === "criado" ? 201 : 200);
  });

  app.post("/webhooks/shopify/refunds", verifySignature, validate("header", webhookHeadersSchema), async (c) => {
    const webhookId = c.req.valid("header")["x-shopify-webhook-id"];
    const refund = await parseWebhook(await c.req.text(), refundWebhookSchema, "refunds/create", webhookId);
    const result = ingestRefund(store, clock, refund, webhookId);
    return c.json({ result, refund: getRefundView(store, refund.refundId) }, result === "criado" ? 201 : 200);
  });

  app.get("/orders/:id", validate("param", orderParamSchema), (c) => c.json(getOrderView(store, c.req.valid("param").id)));
  app.get("/orders/:id/refunds", validate("param", orderParamSchema), (c) =>
    c.json(listOrderRefunds(store, c.req.valid("param").id)),
  );
  app.get("/refunds/:id", validate("param", refundParamSchema), (c) => c.json(getRefundView(store, c.req.valid("param").id)));
  app.get("/creators/summary", (c) => c.json(getSummary(store)));
  app.get("/creators/:id", validate("param", creatorParamSchema), (c) => {
    const { id } = c.req.valid("param");
    const creator = store.getCreator(id);
    if (!creator) throw notFound(`criador ${id} não encontrado`);
    return c.json(creator);
  });

  return app;
}
