import { DatabaseSync } from "node:sqlite";
import { createApp } from "../../src/app.ts";
import { FixedClock } from "../../src/clock.ts";
import { openDatabase } from "../../src/db.ts";
import { signBody } from "../../src/shopify.ts";

export const SECRET = "segredo-de-teste";

let webhookSeq = 0;

export function setup() {
  const db: DatabaseSync = openDatabase(":memory:");
  const clock = new FixedClock("2026-03-01T12:00:00.000Z");
  const app = createApp({ db, clock, webhookSecret: SECRET });

  const send = (path: string, payload: unknown, opts: { webhookId?: string; signature?: string | null } = {}) => {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-shopify-webhook-id": opts.webhookId ?? `wh-${++webhookSeq}`,
    };
    const signature = opts.signature === undefined ? signBody(body, SECRET) : opts.signature;
    if (signature !== null) headers["x-shopify-hmac-sha256"] = signature;
    return app.request(path, { method: "POST", headers, body });
  };

  return {
    app,
    db,
    clock,
    sendOrder: (payload: unknown, opts?: Parameters<typeof send>[2]) => send("/webhooks/shopify/orders", payload, opts),
    sendRefund: (payload: unknown, opts?: Parameters<typeof send>[2]) => send("/webhooks/shopify/refunds", payload, opts),
    createCreator: (body: unknown) =>
      app.request("/creators", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    getJson: async (path: string) => {
      const res = await app.request(path);
      return { status: res.status, body: (await res.json()) as any };
    },
  };
}

export async function setupWithCreators() {
  const ctx = setup();
  await ctx.createCreator({ id: "ana", name: "Ana", utmCampaign: "ana", coupons: ["ANA10"] });
  await ctx.createCreator({ id: "bruno", name: "Bruno", utmCampaign: "bruno", coupons: ["BRUNO15"] });
  return ctx;
}

export function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    total_price: "100.00",
    currency: "BRL",
    financial_status: "paid",
    created_at: "2026-03-01T09:00:00-03:00",
    discount_codes: [{ code: "ANA10", amount: "10.00", type: "percentage" }],
    landing_site: "/?utm_source=conty&utm_campaign=ana",
    ...overrides,
  };
}

export function refund(id: number, amount: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    order_id: 1001,
    created_at: "2026-03-05T10:00:00-03:00",
    transactions: [{ amount, currency: "BRL", kind: "refund", status: "success" }],
    ...overrides,
  };
}
