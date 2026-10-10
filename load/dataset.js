// Massa de dados determinística usada pelo k6 (para enviar) e pelo
// scripts/verify-load.ts (para calcular o esperado). JavaScript puro para
// rodar nos dois lugares.

export const CREATOR_COUNT = 5;
export const ORDER_COUNT = 600;

export function buildCreators() {
  return Array.from({ length: CREATOR_COUNT }, (_, i) => ({
    id: `criador-${i}`,
    name: `Criador ${i}`,
    utmCampaign: `utm-criador-${i}`,
    coupons: [`CUPOM${i}`],
  }));
}

const money = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

export function buildDataset() {
  const orders = [];
  const refunds = [];
  for (let i = 0; i < ORDER_COUNT; i++) {
    const orderId = 100000 + i;
    const totalCents = 1000 + ((i * 7919) % 49000);
    const a = Math.floor(i / 5) % CREATOR_COUNT;
    const b = (a + 2) % CREATOR_COUNT;
    const utm = (n) => `/produtos/x?utm_source=conty&utm_campaign=utm-criador-${n}`;

    // Cinco formatos de pedido, cada um com o criador esperado escrito à mão.
    let discountCodes = [];
    let landingSite = null;
    let expectedCreator = null;
    switch (i % 5) {
      case 0: discountCodes = [`CUPOM${a}`]; expectedCreator = `criador-${a}`; break;
      case 1: landingSite = utm(a); expectedCreator = `criador-${a}`; break;
      case 2: discountCodes = [`CUPOM${a}`]; landingSite = utm(b); expectedCreator = `criador-${a}`; break; // cupom vence UTM
      case 3: discountCodes = ["FRETEGRATIS"]; landingSite = utm(b); expectedCreator = `criador-${b}`; break; // cupom desconhecido cai para UTM
      case 4: break; // sem criador
    }

    // Quatro formatos de estorno: nenhum, um parcial, dois que somam 90%, dois que somam 130%.
    const shares = [[], [30], [50, 40], [70, 60]][i % 4];
    const amounts = shares.map((pct) => Math.floor((totalCents * pct) / 100));
    const orderRefunds = amounts.map((cents, k) => ({
      id: orderId * 10 + k,
      order_id: orderId,
      created_at: `2026-03-0${k + 2}T10:00:00Z`,
      transactions: [{ amount: money(cents), currency: "BRL", kind: "refund", status: "success" }],
    }));
    const requested = amounts.reduce((s, c) => s + c, 0);

    orders.push({
      payload: {
        id: orderId,
        total_price: money(totalCents),
        currency: "BRL",
        financial_status: "paid",
        created_at: "2026-03-01T10:00:00Z",
        discount_codes: discountCodes.map((code) => ({ code, amount: "5.00", type: "fixed_amount" })),
        landing_site: landingSite,
      },
      totalCents,
      expectedCreator,
      expectedRefundedCents: Math.min(totalCents, requested),
    });
    refunds.push(...orderRefunds);
  }
  return { orders, refunds };
}

/** Todos os eventos (pedidos e estornos) numa lista só. */
export function buildEvents() {
  const { orders, refunds } = buildDataset();
  return [
    ...orders.map((o) => ({ path: "/webhooks/shopify/orders", webhookId: `orders-${o.payload.id}`, body: JSON.stringify(o.payload) })),
    ...refunds.map((r) => ({ path: "/webhooks/shopify/refunds", webhookId: `refunds-${r.id}`, body: JSON.stringify(r) })),
  ];
}
