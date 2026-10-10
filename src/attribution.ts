/**
 * Regra de atribuição: o único lugar que decide qual criador fica com a venda.
 *
 * Ordem de precedência:
 *   1. Cupom de criador. Se o pedido tem mais de um cupom de criadores
 *      diferentes, vence o primeiro na ordem em que a loja enviou.
 *   2. UTM de criador (utm_source=conty e utm_campaign = código UTM do criador).
 *   3. Nenhum dos dois: venda sem criador.
 *
 * Cupom vence UTM porque o cupom é digitado pelo comprador no checkout. A UTM
 * vem do link de entrada e pode ser de outra visita, de um link repassado ou
 * compartilhado. Cupom que não pertence a nenhum criador é ignorado e a regra
 * segue para a UTM.
 */

export const CONTY_UTM_SOURCE = "conty";

export type AttributionMethod = "cupom" | "utm";

export type AttributionReason =
  | "cupom"
  | "cupom_vence_utm"
  | "cupons_de_criadores_diferentes"
  | "utm"
  | "sem_criador";

export interface AttributionInput {
  discountCodes: readonly string[];
  utmSource: string | null;
  utmCampaign: string | null;
}

/** Donos conhecidos, com chaves já normalizadas por `normalizeCode`. */
export interface CreatorDirectory {
  couponOwners: ReadonlyMap<string, string>;
  utmOwners: ReadonlyMap<string, string>;
}

export interface Attribution {
  creatorId: string | null;
  method: AttributionMethod | null;
  reason: AttributionReason;
  detail: string;
  /** Criadores para quem algum sinal (cupom ou UTM) apontava e que perderam o desempate. */
  discardedCreatorIds: string[];
}

export function normalizeCode(value: string): string {
  return value.trim().toLowerCase();
}

export function attribute(input: AttributionInput, directory: CreatorDirectory): Attribution {
  const codes = [...new Set(input.discountCodes.map(normalizeCode).filter((c) => c.length > 0))];
  const creatorCoupons = codes.flatMap((code) => {
    const creatorId = directory.couponOwners.get(code);
    return creatorId ? [{ code, creatorId }] : [];
  });
  const unknownCoupons = codes.filter((code) => !directory.couponOwners.has(code));

  const utmCampaign = input.utmCampaign ? normalizeCode(input.utmCampaign) : null;
  const utmFromConty = input.utmSource !== null && normalizeCode(input.utmSource) === CONTY_UTM_SOURCE;
  const utmCreator = utmFromConty && utmCampaign ? directory.utmOwners.get(utmCampaign) ?? null : null;

  const first = creatorCoupons[0];
  if (first) {
    const others = creatorCoupons.filter((c) => c.creatorId !== first.creatorId);
    if (others.length > 0) {
      const ignored = others.map((c) => `${c.code} (${c.creatorId})`).join(", ");
      const losers = [...others.map((c) => c.creatorId), ...(utmCreator && utmCreator !== first.creatorId ? [utmCreator] : [])];
      return {
        creatorId: first.creatorId,
        method: "cupom",
        reason: "cupons_de_criadores_diferentes",
        detail: `cupom ${first.code} veio primeiro e venceu; ignorados: ${ignored}`,
        discardedCreatorIds: [...new Set(losers)],
      };
    }
    if (utmCreator && utmCreator !== first.creatorId) {
      return {
        creatorId: first.creatorId,
        method: "cupom",
        reason: "cupom_vence_utm",
        detail: `cupom ${first.code} venceu a UTM ${utmCampaign} (${utmCreator})`,
        discardedCreatorIds: [utmCreator],
      };
    }
    return { creatorId: first.creatorId, method: "cupom", reason: "cupom", detail: `cupom ${first.code}`, discardedCreatorIds: [] };
  }

  if (utmCreator) {
    const note = unknownCoupons.length > 0 ? `; cupons sem criador ignorados: ${unknownCoupons.join(", ")}` : "";
    return { creatorId: utmCreator, method: "utm", reason: "utm", detail: `utm_campaign ${utmCampaign}${note}`, discardedCreatorIds: [] };
  }

  const seen = [
    unknownCoupons.length > 0 ? `cupons sem criador: ${unknownCoupons.join(", ")}` : "sem cupom",
    utmCampaign ? `UTM sem criador: ${input.utmSource ?? "?"}/${utmCampaign}` : "sem UTM",
  ];
  return { creatorId: null, method: null, reason: "sem_criador", detail: seen.join("; "), discardedCreatorIds: [] };
}
