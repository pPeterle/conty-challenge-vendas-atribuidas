// Depois da carga: confere as invariantes pela API e direto no banco.
// Sai com código 1 se alguma quebrou.
import { DatabaseSync } from "node:sqlite";
import { buildDataset, buildCreators } from "../load/dataset.js";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3103";
const dbPath = process.env.DB_PATH;
if (!dbPath) throw new Error("DB_PATH é obrigatório");

interface Totals { orders: number; grossCents: number; refundedCents: number; netCents: number }
const empty = (): Totals => ({ orders: 0, grossCents: 0, refundedCents: 0, netCents: 0 });

const { orders, refunds } = buildDataset();
const expected = new Map<string, Totals>(buildCreators().map((c: { id: string }) => [c.id, empty()]));
expected.set("(sem criador)", empty());
for (const o of orders as Array<{ totalCents: number; expectedCreator: string | null; expectedRefundedCents: number }>) {
  const t = expected.get(o.expectedCreator ?? "(sem criador)")!;
  t.orders += 1;
  t.grossCents += o.totalCents;
  t.refundedCents += o.expectedRefundedCents;
  t.netCents += o.totalCents - o.expectedRefundedCents;
}

const failures: string[] = [];

const summary = (await (await fetch(`${baseUrl}/creators/summary`)).json()) as {
  creators: Array<Totals & { creatorId: string }>;
  unattributed: Totals[];
};
const actual = new Map<string, Totals>();
for (const row of summary.creators) actual.set(row.creatorId, row);
if (summary.unattributed[0]) actual.set("(sem criador)", summary.unattributed[0]);

for (const [creator, exp] of expected) {
  const got = actual.get(creator) ?? empty();
  const pick = ({ orders, grossCents, refundedCents, netCents }: Totals) => ({ orders, grossCents, refundedCents, netCents });
  const ok = JSON.stringify(pick(got)) === JSON.stringify(exp);
  console.log(`${ok ? "ok  " : "ERRO"} ${creator}: esperado ${JSON.stringify(exp)} obtido ${JSON.stringify(pick(got))}`);
  if (!ok) failures.push(`resumo de ${creator} diverge`);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const one = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);

const orderCount = one("SELECT COUNT(*) AS n FROM orders");
const refundCount = one("SELECT COUNT(*) AS n FROM refunds");
const pending = one("SELECT COUNT(*) AS n FROM refunds WHERE status = 'pendente'");
const overRefunded = one(`
  SELECT COUNT(*) AS n FROM orders o
  WHERE (SELECT COALESCE(SUM(applied_cents), 0) FROM refunds r WHERE r.order_id = o.order_id) > o.total_cents`);
const capped = one("SELECT COUNT(*) AS n FROM refunds WHERE status IN ('limitado', 'rejeitado')");
const early = one(`
  SELECT COUNT(*) AS n FROM refunds r JOIN orders o ON o.order_id = r.order_id WHERE r.received_at < o.received_at`);
const deliveries = one("SELECT COUNT(*) AS n FROM webhook_deliveries");
const duplicates = one("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE outcome = 'duplicado'");
const divergent = one("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE outcome = 'duplicado_divergente'");
const rejected = one("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE outcome LIKE 'recusado:%'");

console.log(`pedidos gravados: ${orderCount} (esperado ${orders.length})`);
console.log(`estornos gravados: ${refundCount} (esperado ${refunds.length}), pendentes no fim: ${pending}`);
console.log(`estornos que chegaram antes do pedido: ${early}`);
console.log(`estornos limitados ou rejeitados por passar do total: ${capped}`);
console.log(`pedidos com estorno acima do total: ${overRefunded}`);
console.log(`entregas registradas: ${deliveries}, duplicadas: ${duplicates}, divergentes: ${divergent}, recusadas por payload inválido: ${rejected}`);

if (orderCount !== orders.length) failures.push("quantidade de pedidos diverge");
if (refundCount !== refunds.length) failures.push("quantidade de estornos diverge");
if (pending !== 0) failures.push("sobrou estorno pendente com pedido já recebido");
if (overRefunded !== 0) failures.push("há pedido com estornos acima do total");
if (divergent !== 0) failures.push("a massa não tem divergência, mas houve duplicado_divergente");
if (rejected === 0) failures.push("a carga não exercitou payload inválido assinado");
if (early === 0) failures.push("a carga não exercitou estorno antes do pedido");

if (failures.length > 0) {
  console.error(`VERIFICAÇÃO FALHOU: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("VERIFICAÇÃO OK: invariantes mantidas");
