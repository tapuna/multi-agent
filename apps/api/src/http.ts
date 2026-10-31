import type { FastifyInstance, FastifyRequest, HTTPMethods } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { transaction, type Tx } from "./db.js";
import { demand } from "./config.js";
export type Context = {
  tx: Tx;
  actor: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: any;
  request: FastifyRequest;
  defer: (job: () => Promise<unknown>) => void;
};
export function identity(req: FastifyRequest) {
  const equal = (a: unknown, b: string | undefined) =>
    typeof a === "string" &&
    !!b &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
  if (equal(req.headers["x-human-key"], process.env.CONTROL_HUMAN_KEY))
    return "human:operator";
  if (equal(req.headers["x-api-key"], process.env.CONTROL_API_KEY))
    return "service:agent";
  demand(false, 401, "Valid API credentials required");
}
export function route(
  app: FastifyInstance,
  method: HTTPMethods,
  url: string,
  body: z.ZodType | undefined,
  handler: (c: Context) => Promise<any>,
  status = 200,
) {
  app.route({
    method,
    url,
    handler: async (req, reply) => {
      const actor = identity(req),
        jobs: (() => Promise<unknown>)[] = [];
      const parsed = body ? body.safeParse(req.body) : null;
      if (parsed && !parsed.success)
        demand(
          false,
          422,
          "Invalid request fields: " +
            parsed.error.issues
              .map((i) => i.path.join(".") + ": " + i.code)
              .join(", "),
        );
      const result = await transaction((tx) =>
        handler({
          tx,
          actor,
          params: req.params as any,
          query: req.query as any,
          body: parsed?.data,
          request: req,
          defer: (job) => jobs.push(job),
        }),
      );
      for (const job of jobs)
        setImmediate(
          () =>
            void job().catch((e) =>
              app.log.error(
                { message: (e as Error).message },
                "Background execution failed",
              ),
            ),
        );
      reply.code(status);
      return result;
    },
  });
}
export const text = (max: number, min = 0) =>
  z.string().trim().min(min).max(max);
export const id = z.string().min(1).max(50);
