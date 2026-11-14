import { handle, type Db } from "./handler";

interface D1Like {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
}
interface Env {
  DB: D1Like;
  MASTER_KEY: string;
  ISSUER_PRIVATE_JWK: string;
  PACK_KV?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const db: Db = {
      first: (sql, ...args) => env.DB.prepare(sql).bind(...args).first(),
      run: async (sql, ...args) => ({ changes: (await env.DB.prepare(sql).bind(...args).run()).meta.changes }),
    };
    try {
      return await handle(request, db, {
        masterHex: env.MASTER_KEY,
        issuerPrivateJwk: env.ISSUER_PRIVATE_JWK,
        packKv: Number(env.PACK_KV ?? "1"),
      });
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "server", message: "服务暂时出错，请稍后再试，或联系老师。" }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  },
};
