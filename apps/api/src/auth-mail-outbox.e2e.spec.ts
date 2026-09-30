import { randomUUID } from "node:crypto";
import { createDb,schema } from "@pubrick/db";
import { openAuthMail } from "@pubrick/mail";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("encrypted durable authentication outbox admission",()=>{
 let database:ReturnType<typeof createDb>;let boss:PgBoss;
 let enqueue:typeof import("./auth-mail-outbox.repository").enqueueAuthMail;
 const suffix=randomUUID();const names={queue:`auth-mail-test-${suffix}`,deadLetter:`auth-mail-test-dlq-${suffix}`};
 const token=`fixture_${suffix}`;const identifier=`reset-password:${token}`;
 beforeAll(async()=>{
 process.env.DATABASE_URL=url as string;process.env.BETTER_AUTH_SECRET??="pubrick-test-secret";process.env.APP_ENCRYPTION_KEY??="6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
 database=createDb(url as string);boss=new PgBoss(url as string);await boss.start();await boss.createQueue(names.deadLetter);await boss.createQueue(names.queue);
 await database.db.insert(schema.verification).values({id:suffix,identifier,value:"fixture_user",expiresAt:new Date(Date.now()+3600000)});
 enqueue=(await import("./auth-mail-outbox.repository")).enqueueAuthMail;
 });
 afterAll(async()=>{
 await boss?.deleteAllJobs(names.queue);await boss?.deleteAllJobs(names.deadLetter);await boss?.deleteQueue(names.queue);await boss?.deleteQueue(names.deadLetter);await boss?.stop();
 if(database){await database.db.delete(schema.verification).where(eq(schema.verification.id,suffix));await database.pool.end();}
 });
 const payload=()=>({kind:"reset" as const,userId:"fixture_user",recipient:"synthetic@example.com",locale:"en" as const,link:`http://localhost:3000/api/auth/reset-password/${token}`});
 it("serializes competing producers and commits exactly one encrypted job under the cap",async()=>{
 const results=await Promise.allSettled([enqueue(boss,payload(),database.db,names,1),enqueue(boss,payload(),database.db,names,1)]);
 expect(results.filter(value=>value.status==="fulfilled")).toHaveLength(1);
 const rows=await database.pool.query("select id,data from pgboss.job where name=$1",[names.queue]);expect(rows.rows).toHaveLength(1);
 const encoded=JSON.stringify(rows.rows);expect(encoded).not.toContain("synthetic@example");expect(encoded).not.toContain(token);expect(encoded).not.toContain("reset-password");
 const {env}=await import("./env");const decoded=openAuthMail(rows.rows[0].data,env.APP_ENCRYPTION_KEY);expect(decoded.kind).toBe("reset");expect(decoded.jobId).toBe(rows.rows[0].id);
 await boss.deleteAllJobs(names.queue);
 });
 it("rolls back failed insertion without consuming capacity and closes vendor diagnostics",async()=>{
 const send=vi.spyOn(boss,"send").mockResolvedValueOnce(null);
 await expect(enqueue(boss,payload(),database.db,names,1)).rejects.toMatchObject({code:"unavailable",message:"unavailable"});send.mockRestore();
 const count=await database.pool.query("select count(*)::int as count from pgboss.job where name=$1",[names.queue]);expect(count.rows[0].count).toBe(0);
 await enqueue(boss,payload(),database.db,names,1);
 });
});
