import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { systemClock } from "./clock.ts";
import { openDatabase } from "./db.ts";

const dbPath = process.env.DB_PATH ?? "data/vendas.sqlite";
const port = Number(process.env.PORT ?? 3000);
const webhookSecret = process.env.WEBHOOK_SECRET ?? "segredo-de-desenvolvimento";
if (!process.env.WEBHOOK_SECRET) console.warn("WEBHOOK_SECRET não definido; usando segredo de desenvolvimento");

const app = createApp({ db: openDatabase(dbPath), clock: systemClock, webhookSecret });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`vendas atribuídas em http://127.0.0.1:${info.port} (banco ${dbPath})`);
});
