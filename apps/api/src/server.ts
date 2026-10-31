import { migrate } from "./db.js";
import { buildApp } from "./app.js";
import { recover } from "./recovery.js";
if (!process.env.CONTROL_HUMAN_KEY || !process.env.CONTROL_API_KEY)
  throw new Error(
    "Set CONTROL_HUMAN_KEY and CONTROL_API_KEY or use npm run dev from the repository root",
  );
await migrate();
await recover();
const app = buildApp();
await app.listen({
  host: process.env.API_HOST || "127.0.0.1",
  port: Number(process.env.API_PORT || 8000),
});
console.log("Node.js API ready on port " + (process.env.API_PORT || 8000));
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void app.close().then(() => process.exit(0)));
