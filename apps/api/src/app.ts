import Fastify from "fastify";
import { transaction } from "./db.js";
import { identity } from "./http.js";
import { HttpError, executionEnabled } from "./config.js";
import { profiles, redact } from "./profiles.js";
import { boardRoutes } from "./board.js";
import { agentRoutes } from "./agents.js";
import { knowledgeRoutes } from "./knowledge.js";
import { templateRoutes } from "./templates.js";
import { chatRoutes } from "./chat.js";
import { executionRoutes } from "./execution-routes.js";
export function buildApp() {
  profiles();
  const app = Fastify({
    logger: false,
    bodyLimit: 1048576,
    requestTimeout: 15000,
    connectionTimeout: 15000,
  });
  // Existing action endpoints permit a POST with no payload; the proxy keeps JSON content type.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      if (!String(body).trim()) return done(null, {});
      try {
        done(null, JSON.parse(String(body)));
      } catch {
        done(new HttpError(400, "Invalid JSON body"), undefined);
      }
    },
  );
  app.setErrorHandler((error, request, reply) => {
    const e = error as HttpError;
    const status = e.statusCode || 500;
    if (e.code === "database_busy") reply.header("Retry-After", "1");
    if (status >= 500) console.error("API error:", redact(e.message));
    reply.code(status).send({
      detail:
        status >= 500
          ? "Server operation failed; inspect backend logs"
          : redact(e.message),
      ...(e.code === "database_busy" ? { code: e.code } : {}),
    });
  });
  app.get("/health", async () =>
    transaction(async (tx) => {
      await tx.sql("SELECT 1 FROM RDB$DATABASE");
      return {
        status: "ok",
        database: "firebird",
        execution_enabled: executionEnabled(),
      };
    }),
  );
  app.get("/api/system", async (req) => {
    identity(req);
    return transaction(async (tx) => {
      const version = (
        await tx.sql(
          "SELECT rdb$get_context('SYSTEM','ENGINE_VERSION') as V FROM RDB$DATABASE",
        )
      )[0].v;
      return {
        status: "ok",
        database: "firebird",
        database_mode: "embedded",
        database_version: version.split(".").map(Number),
        lock_timeout_seconds: Number(
          process.env.FIREBIRD_LOCK_TIMEOUT_SECONDS || 5,
        ),
        execution_enabled: executionEnabled(),
        backend: "nodejs",
      };
    });
  });
  boardRoutes(app);
  agentRoutes(app);
  knowledgeRoutes(app);
  templateRoutes(app);
  chatRoutes(app);
  executionRoutes(app);
  return app;
}
