// A Shopify manda valores como string decimal ("199.90"). Convertemos direto
// da string para centavos inteiros, sem passar por float. Zeros depois da
// segunda casa são aceitos ("1.230"); outro dígito ali ("10.005") é recusado.
const DECIMAL = /^(\d{1,12})(?:\.(\d{1,2})0*)?$/;

export function parseMoneyToCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = DECIMAL.exec(value.trim());
  if (!match) return null;
  const units = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  return units * 100 + fraction;
}
