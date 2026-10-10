/**
 * Casos de uso: ingestão de pedido e de estorno, cadastro de criador e
 * leituras. Cada escrita roda numa única transação.
 */
import { attribute, normalizeCode, type CreatorDirectory } from "./attribution.ts";
import type { Clock } from "./clock.ts";
import type { OrderRow, RefundRow, Store } from "./db.ts";
import { conflict, notFound } from "./errors.ts";
import { attributionStatus, decideRefund } from "./refunds.ts";
import type { NewCreator, OrderPayload, RefundPayload } from "./schemas.ts";

export type IngestResult = "criado" | "duplicado" | "duplicado_divergente";

/** Ordem cronológica real: compara o instante, não a string (fusos podem vir misturados). */
function byShopInstant(a: RefundRow, b: RefundRow): number {
  const diff = Date.parse(a.shopCreatedAt) - Date.parse(b.shopCreatedAt);
  if (diff !== 0) return diff;
  return a.refundId.length - b.refundId.length || (a.refundId < b.refundId ? -1 : a.refundId > b.refundId ? 1 : 0);
}

function applyRefund(store: Store, order: OrderRow, refund: RefundRow, at: string): void {
  const decision = decideRefund({
    orderTotalCents: order.totalCents,
    alreadyAppliedCents: store.appliedRefundCents(order.orderId),
    requestedCents: refund.requestedCents,
    orderCurrency: order.currency,
    refundCurrency: refund.currency,
  });
  store.resolveRefund(refund.refundId, decision, at);
}

/** Busca no banco só os donos dos cupons e da UTM deste pedido. */
function directoryFor(store: Store, payload: OrderPayload): CreatorDirectory {
  const couponOwners = new Map<string, string>();
  for (const code of payload.discountCodes.map(normalizeCode)) {
    const owner = store.couponOwner(code);
    if (owner) couponOwners.set(code, owner);
  }
  const utmOwners = new Map<string, string>();
  if (payload.utmCampaign) {
    const key = normalizeCode(payload.utmCampaign);
    const owner = store.utmOwner(key);
    if (owner) utmOwners.set(key, owner);
  }
  return { couponOwners, utmOwners };
}

export function ingestOrder(store: Store, clock: Clock, payload: OrderPayload, webhookId: string): IngestResult {
  const now = clock.now().toISOString();
  return store.transaction(() => {
    const attribution = attribute(payload, directoryFor(store, payload));
    const inserted = store.insertOrder({
      orderId: payload.orderId,
      totalCents: payload.totalCents,
      currency: payload.currency,
      financialStatus: payload.financialStatus,
      discountCodes: payload.discountCodes,
      landingSite: payload.landingSite,
      utmSource: payload.utmSource,
      utmMedium: payload.utmMedium,
      utmCampaign: payload.utmCampaign,
      attribution,
      shopCreatedAt: payload.createdAt,
      receivedAt: now,
      webhookId,
    });
    const existing = inserted ? null : store.getOrder(payload.orderId)!;
    // Repetição com outro conteúdo não muda nada, mas fica marcada no log para investigar.
    const diverges = existing !== null && (existing.totalCents !== payload.totalCents || existing.currency !== payload.currency);
    const result: IngestResult = inserted ? "criado" : diverges ? "duplicado_divergente" : "duplicado";
    if (inserted) {
      // Estornos que chegaram antes do pedido são aplicados aqui, na mesma transação.
      const order = store.getOrder(payload.orderId)!;
      for (const pending of store.pendingRefundsOf(payload.orderId).sort(byShopInstant)) applyRefund(store, order, pending, now);
    }
    store.logDelivery({ webhookId, topic: "orders/paid", resourceId: payload.orderId, outcome: result, receivedAt: now });
    return result;
  });
}

export function logIgnoredOrder(store: Store, clock: Clock, payload: OrderPayload, webhookId: string): void {
  store.logDelivery({
    webhookId,
    topic: "orders/paid",
    resourceId: payload.orderId,
    outcome: `ignorado:${payload.financialStatus}`,
    receivedAt: clock.now().toISOString(),
  });
}

/** Entrega recusada (payload inválido) também fica no log, com o motivo. */
export function logRejectedDelivery(
  store: Store,
  clock: Clock,
  d: { topic: string; webhookId: string; body: unknown; message: string },
): void {
  const id = typeof d.body === "object" && d.body !== null ? (d.body as Record<string, unknown>).id : undefined;
  store.logDelivery({
    webhookId: d.webhookId,
    topic: d.topic,
    resourceId: typeof id === "string" || typeof id === "number" ? String(id).slice(0, 64) : "?",
    outcome: `recusado: ${d.message}`,
    receivedAt: clock.now().toISOString(),
  });
}

export function ingestRefund(store: Store, clock: Clock, payload: RefundPayload, webhookId: string): IngestResult {
  const now = clock.now().toISOString();
  return store.transaction(() => {
    const inserted = store.insertRefund({
      refundId: payload.refundId,
      orderId: payload.orderId,
      requestedCents: payload.amountCents,
      currency: payload.currency,
      shopCreatedAt: payload.createdAt,
      receivedAt: now,
      webhookId,
    });
    if (inserted) {
      const order = store.getOrder(payload.orderId);
      // Sem pedido ainda: o estorno fica pendente até o pedido chegar.
      if (order) applyRefund(store, order, store.getRefund(payload.refundId)!, now);
    }
    const existing = inserted ? null : store.getRefund(payload.refundId)!;
    const diverges =
      existing !== null &&
      (existing.orderId !== payload.orderId ||
        existing.requestedCents !== payload.amountCents ||
        existing.currency !== payload.currency);
    const result: IngestResult = inserted ? "criado" : diverges ? "duplicado_divergente" : "duplicado";
    store.logDelivery({ webhookId, topic: "refunds/create", resourceId: payload.refundId, outcome: result, receivedAt: now });
    return result;
  });
}

export function registerCreator(store: Store, clock: Clock, input: NewCreator) {
  return store.transaction(() => {
    if (store.getCreator(input.creatorId)) throw conflict(`criador ${input.creatorId} já existe`);
    const utm = input.utmCampaign ? normalizeCode(input.utmCampaign) : null;
    if (utm && store.utmOwner(utm)) throw conflict(`utm_campaign ${utm} já pertence a outro criador`);
    store.insertCreator({ creatorId: input.creatorId, name: input.name, utmCampaign: utm, createdAt: clock.now().toISOString() });
    for (const code of new Set(input.coupons.map(normalizeCode))) {
      if (!store.insertCoupon(code, input.creatorId)) throw conflict(`cupom ${code} já pertence a outro criador`);
    }
    return store.getCreator(input.creatorId)!;
  });
}

export function refundView(r: RefundRow) {
  return {
    refundId: r.refundId,
    orderId: r.orderId,
    status: r.status,
    requestedCents: r.requestedCents,
    appliedCents: r.appliedCents,
    reason: r.reason,
    currency: r.currency,
    createdAt: r.shopCreatedAt,
    receivedAt: r.receivedAt,
    resolvedAt: r.resolvedAt,
  };
}

export function getOrderView(store: Store, orderId: string) {
  const order = store.getOrder(orderId);
  if (!order) throw notFound(`pedido ${orderId} não encontrado`);
  const refunds = store.refundsOf(orderId).sort(byShopInstant);
  const refundedCents = refunds.reduce((sum, r) => sum + (r.appliedCents ?? 0), 0);
  return {
    orderId: order.orderId,
    totalCents: order.totalCents,
    refundedCents,
    netCents: order.totalCents - refundedCents,
    currency: order.currency,
    financialStatus: order.financialStatus,
    createdAt: order.shopCreatedAt,
    receivedAt: order.receivedAt,
    discountCodes: order.discountCodes,
    utm: { source: order.utmSource, medium: order.utmMedium, campaign: order.utmCampaign },
    attribution: {
      creatorId: order.creatorId,
      method: order.attributionMethod,
      reason: order.attributionReason,
      detail: order.attributionDetail,
      discardedCreatorIds: order.discardedCreatorIds,
      status: attributionStatus(order.creatorId, order.totalCents, refundedCents),
    },
    refunds: refunds.map(refundView),
    deliveries: store.deliveriesOf("orders/paid", orderId),
  };
}

export function getRefundView(store: Store, refundId: string) {
  const refund = store.getRefund(refundId);
  if (!refund) throw notFound(`estorno ${refundId} não encontrado`);
  return { ...refundView(refund), deliveries: store.deliveriesOf("refunds/create", refundId) };
}

export function getSummary(store: Store) {
  const rows = store.summary();
  return {
    creators: rows.filter((r) => r.creatorId !== null),
    unattributed: rows
      .filter((r) => r.creatorId === null)
      .map(({ creatorId: _id, creatorName: _name, ...rest }) => rest),
  };
}
