import { describe, expect, it } from "vitest";
import { attribute, type CreatorDirectory } from "../../src/attribution.ts";

const directory: CreatorDirectory = {
  couponOwners: new Map([
    ["ana10", "ana"],
    ["bruno15", "bruno"],
  ]),
  utmOwners: new Map([
    ["ana", "ana"],
    ["bruno", "bruno"],
  ]),
};

const input = (codes: string[], utmSource: string | null = null, utmCampaign: string | null = null) => ({
  discountCodes: codes,
  utmSource,
  utmCampaign,
});

describe("attribute (regra de atribuição)", () => {
  it("cupom de criador atribui ao dono do cupom", () => {
    expect(attribute(input(["ANA10"]), directory)).toMatchObject({ creatorId: "ana", method: "cupom", reason: "cupom" });
  });

  it("UTM de criador atribui quando não há cupom", () => {
    expect(attribute(input([], "conty", "bruno"), directory)).toMatchObject({
      creatorId: "bruno",
      method: "utm",
      reason: "utm",
    });
  });

  it("desempate: cupom e UTM de criadores diferentes, o cupom vence", () => {
    const result = attribute(input(["ana10"], "conty", "bruno"), directory);
    expect(result).toMatchObject({ creatorId: "ana", method: "cupom", reason: "cupom_vence_utm", discardedCreatorIds: ["bruno"] });
    expect(result.detail).toContain("bruno");
  });

  it("cupom e UTM do mesmo criador não é conflito", () => {
    expect(attribute(input(["ana10"], "conty", "ana"), directory)).toMatchObject({ reason: "cupom", discardedCreatorIds: [] });
  });

  it("cupom desconhecido cai para a UTM", () => {
    const result = attribute(input(["BLACKFRIDAY"], "conty", "bruno"), directory);
    expect(result).toMatchObject({ creatorId: "bruno", reason: "utm" });
    expect(result.detail).toContain("blackfriday");
  });

  it("dois cupons de criadores diferentes: vence o primeiro na ordem enviada", () => {
    const result = attribute(input(["bruno15", "ana10"]), directory);
    expect(result).toMatchObject({ creatorId: "bruno", reason: "cupons_de_criadores_diferentes", discardedCreatorIds: ["ana"] });
    expect(result.detail).toContain("ana10");
  });

  it("UTM só conta com utm_source=conty", () => {
    expect(attribute(input([], "instagram", "ana"), directory)).toMatchObject({ creatorId: null, reason: "sem_criador" });
    expect(attribute(input([], "CONTY", "ANA"), directory).creatorId).toBe("ana");
  });

  it("sem cupom nem UTM de criador: não atribui e registra o que viu", () => {
    const result = attribute(input(["frete"], "conty", "desconhecido"), directory);
    expect(result).toEqual({
      creatorId: null,
      method: null,
      reason: "sem_criador",
      detail: "cupons sem criador: frete; UTM sem criador: conty/desconhecido",
      discardedCreatorIds: [],
    });
  });
});
