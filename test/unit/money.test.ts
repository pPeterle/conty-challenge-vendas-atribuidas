import { describe, expect, it } from "vitest";
import { parseMoneyToCents } from "../../src/money.ts";

describe("parseMoneyToCents", () => {
  it("converte string decimal em centavos inteiros sem float", () => {
    expect(parseMoneyToCents("199.90")).toBe(19990);
    expect(parseMoneyToCents("0.1")).toBe(10);
    expect(parseMoneyToCents("10")).toBe(1000);
    expect(parseMoneyToCents("0.29")).toBe(29); // 0.29 * 100 em float dá 28.999...
  });

  it("aceita zeros depois da segunda casa", () => {
    expect(parseMoneyToCents("1.230")).toBe(123);
    expect(parseMoneyToCents("10.000")).toBe(1000);
  });

  it("recusa número, negativo, dígito significativo depois da segunda casa e lixo", () => {
    for (const bad of [19.9, "-1.00", "1.234", "10.005", "1,00", "10,00", "1.", "", "abc", null, undefined]) {
      expect(parseMoneyToCents(bad)).toBeNull();
    }
  });
});
