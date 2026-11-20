/**
 * Production : une instance de l'API par cœur processeur (`npm run start:cluster`).
 * L'API est sans état (jetons JWT, sessions en base) : les requêtes peuvent aller à n'importe quel processus.
 * Le worker IA tourne à part (`npm run start:worker`), jamais dans les processus du cluster.
 */
import cluster from "node:cluster";
import os from "node:os";

const count = Math.max(1, Number(process.env.WEB_CONCURRENCY) || os.availableParallelism());

if (cluster.isPrimary) {
  console.log(`PEDAGO API : démarrage de ${count} processus`);
  for (let i = 0; i < count; i++) cluster.fork({ AI_WORKER_IN_PROCESS: "false" });
  cluster.on("exit", (worker, code) => {
    if (code !== 0) {
      console.error(`Processus ${worker.process.pid} arrêté (code ${code}), redémarrage`);
      cluster.fork({ AI_WORKER_IN_PROCESS: "false" });
    }
  });
} else {
  await import("./index.js");
}
