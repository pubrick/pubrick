import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const apiRequire = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const dbRequire = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { SMTPServer } = apiRequire("smtp-server");
const { simpleParser } = apiRequire("mailparser");
const { Pool } = dbRequire("pg");

/** This fixture is never an application endpoint, and owns only the runner's disposable database. */
export async function startHostedFixtures({ databaseUrl, origin, smtpPort, controlPort, marker }) {
  if (
    !marker.startsWith("pubrick-browser-hosted-") ||
    new URL(databaseUrl).hostname !== "127.0.0.1" ||
    new URL(origin).hostname !== "127.0.0.1"
  )
    throw new Error("Disposable hosted fixture configuration required");
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 2000 });
  const secret = randomBytes(32).toString("hex");
  const messages = [];
  const smtp = new SMTPServer({
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    logger: false,
    onAuth(auth, _session, callback) {
      callback(
        auth.username === "browser" && auth.password === secret ? null : new Error("Rejected"),
        { user: "browser" },
      );
    },
    onData(stream, session, callback) {
      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 1024 * 1024) chunks.push(chunk);
      });
      stream.on("end", () => {
        if (size > 1024 * 1024) return callback(new Error("Fixture message too large"));
        messages.push({
          recipients: session.envelope.rcptTo.map((to) => to.address),
          body: Buffer.concat(chunks),
        });
        callback();
      });
      stream.on("error", callback);
    },
  });
  try {
    await new Promise((resolve, reject) => {
      smtp.once("error", reject);
      smtp.listen(smtpPort, "127.0.0.1", resolve);
    });
  } catch (error) {
    await pool.end();
    throw error;
  }
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    if (request.headers.authorization !== `Bearer ${secret}`) {
      response.writeHead(403).end("{}");
      return;
    }
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${controlPort}`);
    try {
      if (request.method === "GET" && url.pathname === "/mail") {
        const to = url.searchParams.get("to");
        const part = url.searchParams.get("part") ?? "";
        const links = [];
        for (const message of messages.filter((entry) => entry.recipients.includes(to))) {
          const parsed = await simpleParser(message.body);
          for (const line of (parsed.text ?? "").split(/\r?\n/)) {
            if (!line.startsWith(origin) || !line.includes(part)) continue;
            const link = new URL(line);
            if (link.origin === origin) links.push(link.href);
          }
        }
        let jobs = [];
        let queueDiagnostic = null;
        try {
          const result = await pool.query(
            "SELECT state, output->>'code' AS code, output->>'reason' AS reason FROM pgboss.job WHERE name IN ('auth-mail','auth-mail-dlq') ORDER BY created_on LIMIT 10",
          );
          jobs = result.rows;
        } catch (error) {
          queueDiagnostic =
            typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
              ? error.code
              : "fixture_failure";
        }
        response.end(JSON.stringify({ links, captured: messages.length, jobs, queueDiagnostic }));
        return;
      }
      if (request.method !== "POST" || !["/entitlement", "/expire"].includes(url.pathname)) {
        response.writeHead(404).end("{}");
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024) throw new Error("Fixture body too large");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (
        typeof body.orgId !== "string" ||
        !body.orgId ||
        body.orgId.length > 128 ||
        Object.keys(body).length !== 1
      )
        throw new Error("Invalid fixture organization");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const organization = await client.query(
          "SELECT id FROM organization WHERE id = $1 FOR UPDATE",
          [body.orgId],
        );
        if (organization.rowCount !== 1) throw new Error("Unknown fixture organization");
        if (url.pathname === "/expire") {
          const result = await client.query(
            "UPDATE organization_billing_state SET access=false, access_until=now()-interval '1 minute', revision=revision+1 WHERE org_id=$1",
            [body.orgId],
          );
          if (result.rowCount !== 1) throw new Error("Missing fixture entitlement");
        } else {
          const plan = await client.query(
            "SELECT id, price_id FROM billing_plan_versions WHERE provider='fixture' AND environment='sandbox' AND account_id='fixture_browser' AND plan_id='browser-fixture' AND version='1'",
          );
          if (plan.rowCount !== 1) throw new Error("Fixture runtime catalog missing");
          const subId = `sub_browser_${body.orgId}`;
          await client.query(
            "INSERT INTO billing_subscriptions(org_id,provider,environment,account_id,customer_id,subscription_id,status,price_id,plan_version_id,period_start,period_end,cancel_at_period_end,next_reconcile_at) VALUES($1,'fixture','sandbox','fixture_browser',$2,$3,'active',$4,$5,now(),now()+interval '1 day',false,now()+interval '1 day')",
            [
              body.orgId,
              `cus_browser_${body.orgId}`,
              subId,
              plan.rows[0].price_id,
              plan.rows[0].id,
            ],
          );
          await client.query(
            "INSERT INTO organization_billing_state(org_id,subscription_id,plan_version_id,access,access_until) VALUES($1,$2,$3,true,now()+interval '1 day') ON CONFLICT(org_id) DO UPDATE SET subscription_id=excluded.subscription_id,plan_version_id=excluded.plan_version_id,access=true,access_until=excluded.access_until,revision=organization_billing_state.revision+1",
            [body.orgId, subId, plan.rows[0].id],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      response.end('{"ok":true}');
    } catch (error) {
      console.error("Hosted fixture operation failed", {
        path: url.pathname,
        code:
          typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
            ? error.code
            : "fixture_failure",
      });
      response.writeHead(400).end('{"code":"fixture_failed"}');
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(controlPort, "127.0.0.1", resolve);
    });
  } catch (error) {
    await new Promise((resolve) => smtp.close(resolve));
    await pool.end();
    throw error;
  }
  return {
    secret,
    controlOrigin: `http://127.0.0.1:${controlPort}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => smtp.close(resolve));
      await pool.end();
    },
  };
}
