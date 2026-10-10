// Cadastra dois criadores de exemplo (os mesmos usados no README).
import { systemClock } from "../src/clock.ts";
import { createStore, openDatabase } from "../src/db.ts";
import { registerCreator } from "../src/sales.ts";

const store = createStore(openDatabase(process.env.DB_PATH ?? "data/vendas.sqlite"));
const creators = [
  { creatorId: "ana", name: "Ana Souza", utmCampaign: "ana", coupons: ["ANA10"] },
  { creatorId: "bruno", name: "Bruno Lima", utmCampaign: "bruno", coupons: ["BRUNO15"] },
];
for (const c of creators) {
  if (store.getCreator(c.creatorId)) continue;
  registerCreator(store, systemClock, c);
  console.log(`criador ${c.creatorId} cadastrado`);
}
