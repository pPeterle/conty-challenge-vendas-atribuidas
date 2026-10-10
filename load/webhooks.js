// Carga: cada pedido e cada estorno é entregue várias vezes, em ordem
// embaralhada (muitos estornos chegam antes do pedido) e em pares
// simultâneos idênticos dentro de cada iteração.
import http from "k6/http";
import crypto from "k6/crypto";
import exec from "k6/execution";
import { check } from "k6";
import { buildCreators, buildEvents } from "./dataset.js";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3103";
const SECRET = __ENV.WEBHOOK_SECRET || "segredo-de-carga";
const DELIVERIES = 4; // iterações por evento; cada iteração manda 2 cópias em paralelo

const events = buildEvents();
const total = events.length * DELIVERIES;

function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
let step = 7919;
while (gcd(step, total) !== 1) step++;

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

export default function () {
  const n = exec.scenario.iterationInTest;
  const event = events[((n * step) % total) % events.length];
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
