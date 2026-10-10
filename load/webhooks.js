// Carga: cada pedido e cada estorno é entregue várias vezes, em ordem
// embaralhada (muitos estornos chegam antes do pedido) e em pares
// simultâneos idênticos dentro de cada iteração. Uma em cada dez iterações
// manda um payload inválido, que precisa voltar 4xx sem mexer no estado.
import http from "k6/http";
import crypto from "k6/crypto";
import exec from "k6/execution";
import { check } from "k6";
import { buildCreators, buildEvents } from "./dataset.js";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3103";
const SECRET = __ENV.WEBHOOK_SECRET || "segredo-de-carga";
const DELIVERIES = 4; // iterações por evento; cada iteração manda 2 cópias em paralelo

const events = buildEvents();
const validTotal = events.length * DELIVERIES;
// a cada 10 iterações, a 10ª é inválida; total é o menor N com validTotal iterações válidas
let total = validTotal;
while (total - Math.floor((total + 1) / 10) < validTotal) total++;

// Inválidos usam ids de pedidos reais, para provar que lixo não altera pedido existente.
const INVALID = [
  ["/webhooks/shopify/orders", "{"],
  ["/webhooks/shopify/orders", "null"],
  ["/webhooks/shopify/orders", "[]"],
  ["/webhooks/shopify/orders", JSON.stringify({ id: 100001, total_price: 100, currency: "BRL", financial_status: "paid", created_at: "2026-03-01T10:00:00Z" })],
  ["/webhooks/shopify/orders", JSON.stringify({ id: 100002, total_price: "-5.00", currency: "BRL", financial_status: "paid", created_at: "2026-03-01T10:00:00Z" })],
  ["/webhooks/shopify/orders", JSON.stringify({ id: "１２", total_price: "5.00", currency: "BRL", financial_status: "paid", created_at: "2026-03-01T10:00:00Z" })],
  ["/webhooks/shopify/orders", JSON.stringify({ id: 100003, total_price: "5.00", currency: "BRL", financial_status: "paid", created_at: "2026-03-01T10:00:00" })],
  ["/webhooks/shopify/refunds", JSON.stringify({ id: 1, order_id: 100004, created_at: "2026-03-02T10:00:00Z", transactions: [] })],
  ["/webhooks/shopify/refunds", JSON.stringify({ id: 2, order_id: 100005, created_at: "2026-03-02T10:00:00Z", transactions: [{ amount: "1e9", kind: "refund", status: "success" }] })],
  ["/webhooks/shopify/refunds", JSON.stringify({ id: 3, order_id: "abc", created_at: "2026-03-02T10:00:00Z", transactions: [{ amount: "1.00", kind: "refund", status: "success" }] })],
];

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 400, 401));

function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
let step = 7919;
while (gcd(step, validTotal) !== 1) step++;

export const options = {
  scenarios: {
    webhooks: { executor: "shared-iterations", vus: 50, iterations: total, maxDuration: "5m" },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
    checks: ["rate>0.999"],
  },
};

export function setup() {
  for (const creator of buildCreators()) {
    const res = http.post(`${BASE_URL}/creators`, JSON.stringify(creator), { headers: { "content-type": "application/json" } });
    if (res.status !== 201 && res.status !== 409) throw new Error(`falha ao criar criador: ${res.status} ${res.body}`);
  }
}

function sendInvalid(n) {
  const [path, body] = INVALID[Math.floor(n / 10) % INVALID.length];
  const random = `${Math.random()}`.repeat(1 + (n % 5));
  // metade assinada (chega na validação, espera 400), metade com assinatura errada (espera 401)
  const signed = Math.floor(n / 10) % 2 === 0;
  const payload = Math.floor(n / 10) % 3 === 0 ? random : body;
  const res = http.post(`${BASE_URL}${path}`, payload, {
    headers: {
      "content-type": "application/json",
      "x-shopify-webhook-id": `invalido-${n}`,
      "x-shopify-hmac-sha256": signed ? crypto.hmac("sha256", SECRET, payload, "base64") : "errado",
    },
  });
  check(res, {
    "inválido volta 4xx": (r) => r.status >= 400 && r.status < 500,
    "inválido nunca 5xx": (r) => r.status < 500,
  });
}

export default function () {
  const n = exec.scenario.iterationInTest;
  if (n % 10 === 9) return sendInvalid(n);
  const v = n - Math.floor(n / 10);
  if (v >= validTotal) return sendInvalid(n);
  const event = events[((v * step) % validTotal) % events.length];
  const params = {
    headers: {
      "content-type": "application/json",
      "x-shopify-webhook-id": event.webhookId,
      "x-shopify-hmac-sha256": crypto.hmac("sha256", SECRET, event.body, "base64"),
    },
  };
  const req = ["POST", `${BASE_URL}${event.path}`, event.body, params];
  const responses = http.batch([req, req]);
  for (const res of responses) {
    check(res, { "status 200 ou 201": (r) => r.status === 200 || r.status === 201 });
  }
}
