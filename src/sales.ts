/**
 * Casos de uso: ingestão de pedido e de estorno, cadastro de criador e
 * leituras. Cada escrita roda numa única transação.
 */
import { attribute, normalizeCode, type CreatorDirectory } from "./attribution.ts";
import type { Clock } from "./clock.ts";
import type { OrderRow, RefundRow, Store } from "./db.ts";
import { conflict, notFound } from "./errors.ts";
import { attributionStatus, decideCancellation, decideRefund } from "./refunds.ts";
import { COUNTED_FINANCIAL_STATUSES } from "./schemas.ts";
import type { NewCreator, OrderPayload, RefundPayload } from "./schemas.ts";

export type IngestResult = "criado" | "duplicado" | "duplicado_divergente";
export type CancelResult = "cancelado" | "cancelamento_pendente" | "duplicado";

/** O cancelamento é um lançamento na tabela de estornos, com id fixo por pedido: entra uma vez só. */
const CANCELLATION_PREFIX = "cancelamento-";
const cancellationId = (orderId: string) => `${CANCELLATION_PREFIX}${orderId}`;
const isCancellation = (refundId: string) => refundId.startsWith(CANCELLATION_PREFIX);

/** Ordem cronológica real: compara o instante, não a string (fusos podem vir misturados). */
function byShopInstant(a: RefundRow, b: RefundRow): number {
  const diff = Date.parse(a.shopCreatedAt) - Date.parse(b.shopCreatedAt);
  if (diff !== 0) return diff;
  return a.refundId.length - b.refundId.length || (a.refundId < b.refundId ? -1 : a.refundId > b.refundId ? 1 : 0);
}

function applyRefund(store: Store, order: OrderRow, refund: RefundRow, at: string): void {
  const alreadyAppliedCents = store.appliedRefundCents(order.orderId);
  const decision = isCancellation(refund.refundId)
    ? decideCancellation(order.totalCents, alreadyAppliedCents)
    : decideRefund({
        orderTotalCents: order.totalCents,
        alreadyAppliedCents,
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

/** Grava o pedido (se novo) e aplica os pendentes dele. Roda dentro de uma transação já aberta. */
function insertOrderAndApplyPending(store: Store, payload: OrderPayload, webhookId: string, now: string): IngestResult {
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
  return result;
}

export function ingestOrder(store: Store, clock: Clock, payload: OrderPayload, webhookId: string): IngestResult {
  const now = clock.now().toISOString();
  return store.transaction(() => {
    const result = insertOrderAndApplyPending(store, payload, webhookId, now);
    store.logDelivery({ webhookId, topic: "orders/paid", resourceId: payload.orderId, outcome: result, receivedAt: now });
    return result;
  });
}

/**
 * Pedido cancelado ou anulado. Se o pedido chegou pago e ainda não existe aqui,
 * ele é gravado primeiro (a venda existiu). O saldo restante é revertido uma vez
 * só; cancelamento de pedido que ainda não chegou fica pendente como um estorno.
 * Depois disso, nenhum webhook atrasado reativa a venda: orders/paid vira
 * repetição e estornos novos encontram o saldo zerado.
 */
export function cancelOrder(store: Store, clock: Clock, payload: OrderPayload, webhookId: string): CancelResult {
  const now = clock.now().toISOString();
  return store.transaction(() => {
    const counted = (COUNTED_FINANCIAL_STATUSES as readonly string[]).includes(payload.financialStatus);
    if (counted) insertOrderAndApplyPending(store, payload, webhookId, now);
    const refundId = cancellationId(payload.orderId);
    const inserted = store.insertRefund({
      refundId,
      orderId: payload.orderId,
      requestedCents: payload.totalCents,
      currency: payload.currency,
      shopCreatedAt: payload.cancelledAt ?? now,
      receivedAt: now,
      webhookId,
    });
    const order = store.getOrder(payload.orderId);
    if (inserted && order) applyRefund(store, order, store.getRefund(refundId)!, now);
    const result: CancelResult = !inserted ? "duplicado" : order ? "cancelado" : "cancelamento_pendente";
    store.logDelivery({ webhookId, topic: "orders/cancelled", resourceId: payload.orderId, outcome: result, receivedAt: now });
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

/**
 * Estorno sem nenhuma transação concluída (só pending/failure) não é gravado:
 * gravar travaria o refund_id, e a versão com success que vem depois seria
 * tratada como repetição. Só a entrega fica no log.
 */
export function logRefundWithoutConcludedTransaction(store: Store, clock: Clock, payload: RefundPayload, webhookId: string): void {
  store.logDelivery({
    webhookId,
    topic: "refunds/create",
    resourceId: payload.refundId,
    outcome: "sem_transacao_concluida",
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
    kind: isCancellation(r.refundId) ? ("cancelamento" as const) : ("estorno" as const),
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
  const cancellation = refunds.find((r) => isCancellation(r.refundId) && r.status !== "pendente");
  return {
    orderId: order.orderId,
    totalCents: order.totalCents,
    refundedCents,
    netCents: order.totalCents - refundedCents,
    currency: order.currency,
    financialStatus: order.financialStatus,
    cancelledAt: cancellation?.shopCreatedAt ?? null,
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
      status: attributionStatus(order.creatorId, order.totalCents, refundedCents, cancellation !== undefined),
    },
    refunds: refunds.map(refundView),
    deliveries: (["orders/paid", "orders/cancelled"] as const)
      .flatMap((topic) => store.deliveriesOf(topic, orderId).map(({ deliveryId, ...d }) => ({ deliveryId, topic, ...d })))
      .sort((x, y) => x.deliveryId - y.deliveryId)
      .map(({ deliveryId: _id, ...d }) => d),
  };
}

/** Estornos de um order_id, inclusive pendentes de um pedido que ainda não chegou. */
export function listOrderRefunds(store: Store, orderId: string) {
  const refunds = store.refundsOf(orderId).sort(byShopInstant);
  return {
    orderId,
    orderReceived: store.getOrder(orderId) !== null,
    pendingCount: refunds.filter((r) => r.status === "pendente").length,
    refunds: refunds.map(refundView),
  };
}

export function listPendingRefunds(store: Store, page: { limit: number; offset: number }) {
  const { total, items } = store.refundsWithStatus(["pendente"], page.limit, page.offset);
  return { total, limit: page.limit, offset: page.offset, refunds: items.map(refundView) };
}

/** O que merece um olho humano: desempates, estornos limitados ou rejeitados e repetições divergentes. */
export function getReview(store: Store, limit: number) {
  const refunds = store.refundsWithStatus(["limitado", "rejeitado"], limit);
  return {
    tieBreakConflicts: store.tieBreakConflicts(limit).map((o) => ({
      orderId: o.orderId,
      creatorId: o.creatorId,
      discardedCreatorIds: o.discardedCreatorIds,
      reason: o.attributionReason,
      detail: o.attributionDetail,
      receivedAt: o.receivedAt,
    })),
    cappedOrRejectedRefunds: { total: refunds.total, refunds: refunds.items.map(refundView) },
    divergentDeliveries: store.divergentDeliveries(limit),
  };
}

export function getRefundView(store: Store, refundId: string) {
  const refund = store.getRefund(refundId);
  if (!refund) throw notFound(`estorno ${refundId} não encontrado`);
  const deliveries = store.deliveriesOf("refunds/create", refundId).map(({ deliveryId: _id, ...d }) => d);
  return { ...refundView(refund), deliveries };
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
