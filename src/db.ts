/** Todo acesso ao banco passa por aqui. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Attribution } from "./attribution.ts";
import type { RefundDecision, RefundStatus } from "./refunds.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS creators (
  creator_id   TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  utm_campaign TEXT UNIQUE,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS creator_coupons (
  code       TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL REFERENCES creators(creator_id)
);

-- Um pedido por order_id: é isso que impede contar a mesma venda duas vezes.
-- A atribuição é gravada na chegada, junto com o motivo, e não muda depois.
CREATE TABLE IF NOT EXISTS orders (
  order_id             TEXT PRIMARY KEY,
  total_cents          INTEGER NOT NULL CHECK (total_cents >= 0),
  currency             TEXT NOT NULL,
  financial_status     TEXT NOT NULL,
  discount_codes       TEXT NOT NULL,
  landing_site         TEXT,
  utm_source           TEXT,
  utm_medium           TEXT,
  utm_campaign         TEXT,
  creator_id           TEXT REFERENCES creators(creator_id),
  attribution_method   TEXT CHECK (attribution_method IN ('cupom', 'utm')),
  attribution_reason   TEXT NOT NULL,
  attribution_detail   TEXT NOT NULL,
  -- JSON com os criadores que perderam o desempate (ex.: dono da UTM quando o cupom venceu)
  discarded_creator_ids TEXT NOT NULL DEFAULT '[]',
  shop_created_at      TEXT NOT NULL,
  received_at          TEXT NOT NULL,
  webhook_id           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_by_creator ON orders(creator_id);
CREATE INDEX IF NOT EXISTS orders_by_reason ON orders(attribution_reason);

-- Um estorno por refund_id. Pode existir antes do pedido (status pendente).
CREATE TABLE IF NOT EXISTS refunds (
  refund_id        TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL,
  requested_cents  INTEGER NOT NULL CHECK (requested_cents >= 0),
  currency         TEXT,
  status           TEXT NOT NULL CHECK (status IN ('pendente', 'aplicado', 'limitado', 'rejeitado')),
  applied_cents    INTEGER CHECK (applied_cents >= 0),
  reason           TEXT,
  shop_created_at  TEXT NOT NULL,
  received_at      TEXT NOT NULL,
  resolved_at      TEXT,
  webhook_id       TEXT NOT NULL,
  CHECK ((status = 'pendente') = (applied_cents IS NULL))
);
CREATE INDEX IF NOT EXISTS refunds_by_order ON refunds(order_id, status);
CREATE INDEX IF NOT EXISTS refunds_by_status ON refunds(status, received_at);

-- Log de toda entrega recebida, inclusive as repetidas.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id   TEXT NOT NULL,
  topic        TEXT NOT NULL,
  resource_id  TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  received_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_by_resource ON webhook_deliveries(topic, resource_id);
CREATE INDEX IF NOT EXISTS deliveries_by_outcome ON webhook_deliveries(outcome);

-- Histórico não se apaga e não se reescreve. Estas travas valem mesmo que
-- algum código futuro tente.
CREATE TRIGGER IF NOT EXISTS orders_no_delete BEFORE DELETE ON orders
BEGIN SELECT RAISE(ABORT, 'pedidos não podem ser apagados'); END;

CREATE TRIGGER IF NOT EXISTS orders_no_update BEFORE UPDATE ON orders
BEGIN SELECT RAISE(ABORT, 'pedidos não podem ser alterados'); END;

CREATE TRIGGER IF NOT EXISTS refunds_no_delete BEFORE DELETE ON refunds
BEGIN SELECT RAISE(ABORT, 'estornos não podem ser apagados'); END;

CREATE TRIGGER IF NOT EXISTS refunds_resolve_once BEFORE UPDATE ON refunds
WHEN OLD.status <> 'pendente'
  OR NEW.requested_cents <> OLD.requested_cents
  OR NEW.order_id <> OLD.order_id
BEGIN SELECT RAISE(ABORT, 'estorno já resolvido não pode ser alterado'); END;

CREATE TRIGGER IF NOT EXISTS refunds_never_exceed_total BEFORE UPDATE ON refunds
WHEN NEW.applied_cents IS NOT NULL AND
  (SELECT COALESCE(SUM(applied_cents), 0) FROM refunds
     WHERE order_id = NEW.order_id AND refund_id <> NEW.refund_id) + NEW.applied_cents
  > (SELECT total_cents FROM orders WHERE order_id = NEW.order_id)
BEGIN SELECT RAISE(ABORT, 'soma dos estornos passaria do total do pedido'); END;
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  // Banco criado antes desta coluna existir: adiciona sem perder dados.
  const columns = (db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!columns.includes("discarded_creator_ids")) {
    db.exec("ALTER TABLE orders ADD COLUMN discarded_creator_ids TEXT NOT NULL DEFAULT '[]'");
  }
  return db;
}

export interface CreatorRow {
  creatorId: string;
  name: string;
  utmCampaign: string | null;
  coupons: string[];
  createdAt: string;
}

export interface OrderRow {
  orderId: string;
  totalCents: number;
  currency: string;
  financialStatus: string;
  discountCodes: string[];
  landingSite: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  creatorId: string | null;
  attributionMethod: string | null;
  attributionReason: string;
  attributionDetail: string;
  discardedCreatorIds: string[];
  shopCreatedAt: string;
  receivedAt: string;
  webhookId: string;
}

export interface NewOrder
  extends Omit<OrderRow, "creatorId" | "attributionMethod" | "attributionReason" | "attributionDetail" | "discardedCreatorIds"> {
  attribution: Attribution;
}

export interface RefundRow {
  refundId: string;
  orderId: string;
  requestedCents: number;
  currency: string | null;
  status: RefundStatus;
  appliedCents: number | null;
  reason: string | null;
  shopCreatedAt: string;
  receivedAt: string;
  resolvedAt: string | null;
  webhookId: string;
}

export type NewRefund = Omit<RefundRow, "status" | "appliedCents" | "reason" | "resolvedAt">;

export interface SummaryRow {
  creatorId: string | null;
  creatorName: string | null;
  currency: string;
  orders: number;
  grossCents: number;
  refundedCents: number;
  netCents: number;
}

type Row = Record<string, unknown>;

const str = (v: unknown) => v as string;
const strOrNull = (v: unknown) => (v === null ? null : (v as string));
const num = (v: unknown) => Number(v);

function toOrder(r: Row): OrderRow {
  return {
    orderId: str(r.order_id),
    totalCents: num(r.total_cents),
    currency: str(r.currency),
    financialStatus: str(r.financial_status),
    discountCodes: JSON.parse(str(r.discount_codes)) as string[],
    landingSite: strOrNull(r.landing_site),
    utmSource: strOrNull(r.utm_source),
    utmMedium: strOrNull(r.utm_medium),
    utmCampaign: strOrNull(r.utm_campaign),
    creatorId: strOrNull(r.creator_id),
    attributionMethod: strOrNull(r.attribution_method),
    attributionReason: str(r.attribution_reason),
    attributionDetail: str(r.attribution_detail),
    discardedCreatorIds: JSON.parse(str(r.discarded_creator_ids)) as string[],
    shopCreatedAt: str(r.shop_created_at),
    receivedAt: str(r.received_at),
    webhookId: str(r.webhook_id),
  };
}

function toRefund(r: Row): RefundRow {
  return {
    refundId: str(r.refund_id),
    orderId: str(r.order_id),
    requestedCents: num(r.requested_cents),
    currency: strOrNull(r.currency),
    status: str(r.status) as RefundStatus,
    appliedCents: r.applied_cents === null ? null : num(r.applied_cents),
    reason: strOrNull(r.reason),
    shopCreatedAt: str(r.shop_created_at),
    receivedAt: str(r.received_at),
    resolvedAt: strOrNull(r.resolved_at),
    webhookId: str(r.webhook_id),
  };
}

const ORDER_TOTALS = `
  SELECT o.order_id, o.creator_id, o.currency, o.total_cents,
         COALESCE((SELECT SUM(r.applied_cents) FROM refunds r WHERE r.order_id = o.order_id), 0) AS refunded_cents
  FROM orders o`;

export type Store = ReturnType<typeof createStore>;

export function createStore(db: DatabaseSync) {
  const q = {
    insertCreator: db.prepare(
      "INSERT INTO creators (creator_id, name, utm_campaign, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    ),
    insertCoupon: db.prepare("INSERT INTO creator_coupons (code, creator_id) VALUES (?, ?) ON CONFLICT DO NOTHING"),
    creatorById: db.prepare("SELECT * FROM creators WHERE creator_id = ?"),
    couponsOf: db.prepare("SELECT code FROM creator_coupons WHERE creator_id = ? ORDER BY code"),
    couponOwner: db.prepare("SELECT creator_id FROM creator_coupons WHERE code = ?"),
    utmOwner: db.prepare("SELECT creator_id FROM creators WHERE utm_campaign = ?"),
    insertOrder: db.prepare(`
      INSERT INTO orders (order_id, total_cents, currency, financial_status, discount_codes, landing_site,
        utm_source, utm_medium, utm_campaign, creator_id, attribution_method, attribution_reason,
        attribution_detail, discarded_creator_ids, shop_created_at, received_at, webhook_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (order_id) DO NOTHING`),
    orderById: db.prepare("SELECT * FROM orders WHERE order_id = ?"),
    insertRefund: db.prepare(`
      INSERT INTO refunds (refund_id, order_id, requested_cents, currency, status, shop_created_at, received_at, webhook_id)
      VALUES (?, ?, ?, ?, 'pendente', ?, ?, ?)
      ON CONFLICT (refund_id) DO NOTHING`),
    refundById: db.prepare("SELECT * FROM refunds WHERE refund_id = ?"),
    refundsOf: db.prepare("SELECT * FROM refunds WHERE order_id = ? ORDER BY shop_created_at, refund_id"),
    pendingRefundsOf: db.prepare(
      "SELECT * FROM refunds WHERE order_id = ? AND status = 'pendente' ORDER BY shop_created_at, refund_id",
    ),
    refundsByStatus: db.prepare(
      "SELECT * FROM refunds WHERE status IN (SELECT value FROM json_each(?)) ORDER BY received_at, refund_id LIMIT ? OFFSET ?",
    ),
    countByStatus: db.prepare("SELECT COUNT(*) AS n FROM refunds WHERE status IN (SELECT value FROM json_each(?))"),
    tieBreakConflicts: db.prepare(`
      SELECT * FROM orders WHERE attribution_reason IN ('cupom_vence_utm', 'cupons_de_criadores_diferentes')
      ORDER BY received_at, order_id LIMIT ?`),
    divergentDeliveries: db.prepare(
      "SELECT webhook_id, topic, resource_id, received_at FROM webhook_deliveries WHERE outcome = 'duplicado_divergente' ORDER BY delivery_id LIMIT ?",
    ),
    appliedSum: db.prepare("SELECT COALESCE(SUM(applied_cents), 0) AS total FROM refunds WHERE order_id = ?"),
    resolveRefund: db.prepare(
      "UPDATE refunds SET status = ?, applied_cents = ?, reason = ?, resolved_at = ? WHERE refund_id = ? AND status = 'pendente'",
    ),
    logDelivery: db.prepare(
      "INSERT INTO webhook_deliveries (webhook_id, topic, resource_id, outcome, received_at) VALUES (?, ?, ?, ?, ?)",
    ),
    deliveriesOf: db.prepare(
      "SELECT delivery_id, webhook_id, topic, outcome, received_at FROM webhook_deliveries WHERE resource_id = ? AND topic = ? ORDER BY delivery_id",
    ),
    summary: db.prepare(`
      SELECT t.creator_id, c.name AS creator_name, t.currency, COUNT(*) AS orders,
             SUM(t.total_cents) AS gross_cents, SUM(t.refunded_cents) AS refunded_cents
      FROM (${ORDER_TOTALS}) t LEFT JOIN creators c ON c.creator_id = t.creator_id
      GROUP BY t.creator_id, t.currency
      ORDER BY t.creator_id IS NULL, t.creator_id, t.currency`),
  };

  return {
    /** Roda `fn` numa transação de escrita. BEGIN IMMEDIATE pega o lock de escrita logo no início. */
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    insertCreator(c: { creatorId: string; name: string; utmCampaign: string | null; createdAt: string }): boolean {
      return q.insertCreator.run(c.creatorId, c.name, c.utmCampaign, c.createdAt).changes === 1;
    },
    insertCoupon(code: string, creatorId: string): boolean {
      return q.insertCoupon.run(code, creatorId).changes === 1;
    },
    getCreator(creatorId: string): CreatorRow | null {
      const r = q.creatorById.get(creatorId) as Row | undefined;
      if (!r) return null;
      const coupons = (q.couponsOf.all(creatorId) as Row[]).map((c) => str(c.code));
      return {
        creatorId: str(r.creator_id),
        name: str(r.name),
        utmCampaign: strOrNull(r.utm_campaign),
        coupons,
        createdAt: str(r.created_at),
      };
    },
    couponOwner(code: string): string | null {
      const r = q.couponOwner.get(code) as Row | undefined;
      return r ? str(r.creator_id) : null;
    },
    utmOwner(utmCampaign: string): string | null {
      const r = q.utmOwner.get(utmCampaign) as Row | undefined;
      return r ? str(r.creator_id) : null;
    },

    /** Devolve false se o pedido já existia (webhook repetido). */
    insertOrder(o: NewOrder): boolean {
      const a = o.attribution;
      return (
        q.insertOrder.run(
          o.orderId, o.totalCents, o.currency, o.financialStatus, JSON.stringify(o.discountCodes), o.landingSite,
          o.utmSource, o.utmMedium, o.utmCampaign, a.creatorId, a.method, a.reason, a.detail,
          JSON.stringify(a.discardedCreatorIds), o.shopCreatedAt, o.receivedAt, o.webhookId,
        ).changes === 1
      );
    },
    getOrder(orderId: string): OrderRow | null {
      const r = q.orderById.get(orderId) as Row | undefined;
      return r ? toOrder(r) : null;
    },

    /** Grava o estorno como pendente. Devolve false se o refund_id já existia. */
    insertRefund(r: NewRefund): boolean {
      return (
        q.insertRefund.run(r.refundId, r.orderId, r.requestedCents, r.currency, r.shopCreatedAt, r.receivedAt, r.webhookId)
          .changes === 1
      );
    },
    getRefund(refundId: string): RefundRow | null {
      const r = q.refundById.get(refundId) as Row | undefined;
      return r ? toRefund(r) : null;
    },
    refundsOf(orderId: string): RefundRow[] {
      return (q.refundsOf.all(orderId) as Row[]).map(toRefund);
    },
    pendingRefundsOf(orderId: string): RefundRow[] {
      return (q.pendingRefundsOf.all(orderId) as Row[]).map(toRefund);
    },
    refundsWithStatus(statuses: RefundStatus[], limit: number, offset = 0): { total: number; items: RefundRow[] } {
      const list = JSON.stringify(statuses);
      return {
        total: num((q.countByStatus.get(list) as Row).n),
        items: (q.refundsByStatus.all(list, limit, offset) as Row[]).map(toRefund),
      };
    },
    tieBreakConflicts(limit: number): OrderRow[] {
      return (q.tieBreakConflicts.all(limit) as Row[]).map(toOrder);
    },
    divergentDeliveries(limit: number) {
      return (q.divergentDeliveries.all(limit) as Row[]).map((r) => ({
        webhookId: str(r.webhook_id),
        topic: str(r.topic),
        resourceId: str(r.resource_id),
        receivedAt: str(r.received_at),
      }));
    },
    appliedRefundCents(orderId: string): number {
      return num((q.appliedSum.get(orderId) as Row).total);
    },
    resolveRefund(refundId: string, decision: RefundDecision, resolvedAt: string): void {
      const changes = q.resolveRefund.run(decision.status, decision.appliedCents, decision.reason, resolvedAt, refundId).changes;
      if (changes !== 1) throw new Error(`estorno ${refundId} não estava pendente`);
    },

    logDelivery(d: { webhookId: string; topic: string; resourceId: string; outcome: string; receivedAt: string }): void {
      q.logDelivery.run(d.webhookId, d.topic, d.resourceId, d.outcome, d.receivedAt);
    },
    deliveriesOf(topic: string, resourceId: string) {
      return (q.deliveriesOf.all(resourceId, topic) as Row[]).map((r) => ({
        deliveryId: num(r.delivery_id),
        webhookId: str(r.webhook_id),
        outcome: str(r.outcome),
        receivedAt: str(r.received_at),
      }));
    },

    summary(): SummaryRow[] {
      return (q.summary.all() as Row[]).map((r) => {
        const gross = num(r.gross_cents);
        const refunded = num(r.refunded_cents);
        return {
          creatorId: strOrNull(r.creator_id),
          creatorName: strOrNull(r.creator_name),
          currency: str(r.currency),
          orders: num(r.orders),
          grossCents: gross,
          refundedCents: refunded,
          netCents: gross - refunded,
        };
      });
    },
  };
}
