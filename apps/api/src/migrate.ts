import { migrate } from "./db.js";
await migrate();
console.log("Firebird schema ready; existing data preserved.");
