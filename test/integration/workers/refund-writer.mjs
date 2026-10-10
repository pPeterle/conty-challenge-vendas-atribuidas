// Ponto de entrada do worker: registra o tsx nesta thread e carrega o escritor
// em TypeScript. No Node 22.13, `execArgv: ["--import", "tsx"]` não vale para workers.
import { register } from "tsx/esm/api";

register();
await import("./refund-writer.ts");
