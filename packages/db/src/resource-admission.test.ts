import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createDb } from "./client.js";
import type { BillingTransaction } from "./billing-entitlement.js";
import { authorizeBillingGrowth } from "./billing-growth.js";
import { withTenantResourceAdmission, withTenantResourceAdmissionWithHeldLocks } from "./resource-admission.js";

vi.mock("./billing-growth.js",()=>({authorizeBillingGrowth:vi.fn()}));
const identity={provider:"stripe",environment:"sandbox",accountId:"acct_operator"};
const hosted={mode:"hosted",identity} as const;
function fixture(usage:readonly string[],organizationExists=true){
  const calls:string[]=[];const statements:{sql:string;params:unknown[]}[]=[];let index=0;
  const tx={
    execute:async(statement:SQL)=>{calls.push("advisory");const query=new PgDialect().sqlToQuery(statement);statements.push(query);},
    select:(projection:Record<string,unknown>)=>({
      from:()=>({where:(predicate:SQL)=>{
        const query=new PgDialect().sqlToQuery(predicate);statements.push(query);
        if("id" in projection)return {for:async(mode:string)=>{calls.push(`tenant:${mode}`);return organizationExists?[{id:"org"}]:[];}};
        const selected=projection.occupied as SQL;const count=new PgDialect().sqlToQuery(selected);statements.push(count);
        calls.push("count");return Promise.resolve([{occupied:usage[index++]}]);
      }}),
    }),
  };
  const transaction=tx as unknown as BillingTransaction;
  // Partial transaction exposes only locks/counts; insertion is an explicit test callback.
  const db={transaction:async<T>(callback:(value:BillingTransaction)=>Promise<T>)=>{
    try {const value=await callback(transaction);calls.push("commit");return value;}catch(error){calls.push("rollback");throw error;}
  }} as unknown as ReturnType<typeof createDb>["db"];
  return {tx:transaction,db,calls,statements};
}
beforeEach(()=>vi.mocked(authorizeBillingGrowth).mockReset());
describe("authoritative resource admission",()=>{
  it("takes shared advisory then tenant KEY SHARE and commits only matching insertion",async()=>{
    const f=fixture(["0","1"]);
    vi.mocked(authorizeBillingGrowth).mockImplementation(async()=>{f.calls.push("billing");});
    const result=await withTenantResourceAdmission("org",f.db,hosted,{resource:"brands",additional:1},async tx=>{expect(tx).toBe(f.tx);f.calls.push("insert");return "brand-id";});
    expect(result).toBe("brand-id");expect(f.calls).toEqual(["advisory","tenant:key share","count","billing","insert","count","commit"]);
    expect(f.statements[0]?.params).toEqual([0x7a11,"org"]);
    expect(vi.mocked(authorizeBillingGrowth)).toHaveBeenCalledWith("org",f.tx,identity,{resource:"brands",occupied:0,additional:1});
  });
  it("does not reacquire advisory or tenant rows for the pre-held lock variant",async()=>{
    const f=fixture(["4","5"]);
    await withTenantResourceAdmissionWithHeldLocks("org",f.tx,hosted,{resource:"channels",additional:1},async()=>{});
    expect(f.calls).toEqual(["count","count"]);
    expect(f.statements.flatMap(statement=>statement.params)).toContain("org");
  });
  it("sums all normalized media bytes, irrespective of brand/kind/provenance",async()=>{
    const f=fixture(["90","100"]);
    await withTenantResourceAdmission("org",f.db,hosted,{resource:"mediaBytes",additional:10},async()=>{});
    expect(vi.mocked(authorizeBillingGrowth)).toHaveBeenCalledWith("org",f.tx,identity,{resource:"mediaBytes",occupied:90,additional:10});
    const aggregation=f.statements.find(statement=>statement.sql.includes("sum("));
    expect(aggregation?.sql).toContain('sum("media_assets"."byte_size")');
    expect(f.statements.filter(statement=>statement.params.includes("org"))).toHaveLength(4);
  });
  it("preserves self-hosted insertion without hosted locks, counts or subscription reads",async()=>{
    const f=fixture(["0","1"]);
    await withTenantResourceAdmission("org",f.db,{mode:"self-hosted"},{resource:"channels",additional:1},async()=>{});
    expect(authorizeBillingGrowth).not.toHaveBeenCalled();expect(f.calls).toEqual(["commit"]);
  });
  it("never invokes insertion when billing rejects and rolls back",async()=>{
    const f=fixture(["1"]);const insert=vi.fn();vi.mocked(authorizeBillingGrowth).mockRejectedValue(new Error("resource_limit"));
    await expect(withTenantResourceAdmission("org",f.db,hosted,{resource:"brands",additional:1},insert)).rejects.toThrow("resource_limit");
    expect(insert).not.toHaveBeenCalled();expect(f.calls.at(-1)).toBe("rollback");
  });
  it("rejects mismatched actual growth and insertion failures without committing",async()=>{
    const f=fixture(["0","2"]);
    await expect(withTenantResourceAdmission("org",f.db,hosted,{resource:"brands",additional:1},async()=>{})).rejects.toThrow("growth_mismatch");
    expect(f.calls.at(-1)).toBe("rollback");
    const broken=fixture(["0"]);
    await expect(withTenantResourceAdmission("org",broken.db,hosted,{resource:"channels",additional:1},async()=>{throw new Error("insert_failure");})).rejects.toThrow("insert_failure");
    expect(broken.calls.at(-1)).toBe("rollback");
  });
  it("refuses missing tenant and invalid additions before invoking insertion",async()=>{
    const missing=fixture([],false);const insert=vi.fn();
    await expect(withTenantResourceAdmission("org",missing.db,hosted,{resource:"brands",additional:1},insert)).rejects.toThrow("target_unavailable");
    for(const additional of [-1,0,0.5,Infinity,Number.MAX_SAFE_INTEGER+1]){
      const f=fixture([]);
      await expect(withTenantResourceAdmission("org",f.db,hosted,{resource:"mediaBytes",additional},insert)).rejects.toThrow("invalid_growth");
      expect(f.calls).toEqual([]);
    }
    expect(insert).not.toHaveBeenCalled();
  });
  it("rejects unsafe authoritative totals and never rounds them into available capacity",async()=>{
    for(const value of ["9007199254740993","-1","0.5","not-a-count"]){
      const f=fixture([value]);const insert=vi.fn();
      await expect(withTenantResourceAdmission("org",f.db,hosted,{resource:"mediaBytes",additional:1},insert)).rejects.toThrow("invalid_growth");
      expect(insert).not.toHaveBeenCalled();
    }
  });
  it("fails closed if an uncoordinated deletion changes the observed insertion delta",async()=>{
    const f=fixture(["10","10"]);
    await expect(withTenantResourceAdmission("org",f.db,hosted,{resource:"brands",additional:1},async()=>{})).rejects.toThrow("growth_mismatch");
    expect(f.calls.at(-1)).toBe("rollback");
  });

});
