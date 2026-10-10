/**
 * Decisão de quanto de um estorno é aplicado ao pedido. Função pura: recebe o
 * que já foi aplicado e devolve o resultado, sem tocar no banco.
 *
 * A soma aplicada nunca passa do total do pedido. O excedente não some: o
 * estorno fica registrado como `limitado` (aplicado em parte) ou `rejeitado`
 * (nada aplicado), sempre com o motivo.
 */

export type RefundStatus = "pendente" | "aplicado" | "limitado" | "rejeitado";

export interface RefundDecisionInput {
  orderTotalCents: number;
  alreadyAppliedCents: number;
  requestedCents: number;
  orderCurrency: string;
  refundCurrency: string | null;
}

export interface RefundDecision {
  status: Exclude<RefundStatus, "pendente">;
  appliedCents: number;
  reason: string | null;
}

export function decideRefund(input: RefundDecisionInput): RefundDecision {
  if (input.refundCurrency !== null && input.refundCurrency !== input.orderCurrency) {
    return {
      status: "rejeitado",
      appliedCents: 0,
      reason: `moeda do estorno (${input.refundCurrency}) diferente da moeda do pedido (${input.orderCurrency})`,
    };
  }
  if (input.requestedCents === 0) {
    return { status: "rejeitado", appliedCents: 0, reason: "estorno sem valor: nenhuma transação de refund com sucesso" };
  }
  // Pedido de R$ 0,00 (ex.: brinde com cupom de 100%) conta como venda atribuída, mas não tem o que estornar.
  if (input.orderTotalCents === 0) {
    return { status: "rejeitado", appliedCents: 0, reason: "pedido de valor zero: não há o que estornar" };
  }
  const remaining = Math.max(0, input.orderTotalCents - input.alreadyAppliedCents);
  if (input.requestedCents <= remaining) {
    return { status: "aplicado", appliedCents: input.requestedCents, reason: null };
  }
  if (remaining === 0) {
    return {
      status: "rejeitado",
      appliedCents: 0,
      reason: `pedido já está totalmente estornado; ${input.requestedCents} centavos pedidos não foram aplicados`,
    };
  }
  return {
    status: "limitado",
    appliedCents: remaining,
    reason: `pedido tinha ${remaining} centavos restantes; ${input.requestedCents - remaining} centavos pedidos a mais não foram aplicados`,
  };
}

export type AttributionStatus = "ativa" | "parcialmente_revertida" | "revertida" | "sem_criador";

/** Situação da atribuição depois dos estornos. Nada é apagado: só o líquido muda. */
export function attributionStatus(creatorId: string | null, totalCents: number, refundedCents: number): AttributionStatus {
  if (creatorId === null) return "sem_criador";
  if (refundedCents === 0) return "ativa";
  if (refundedCents >= totalCents) return "revertida";
  return "parcialmente_revertida";
}
