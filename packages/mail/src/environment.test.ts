import { describe, expect, it } from "vitest";
import { mailEnvironmentSchema, resolveSmtpConfig } from "./environment.js";
describe("shared server mail environment",()=>{
 it("preserves blank defaults and self-host no mail",()=>{
 const env=mailEnvironmentSchema.parse({SMTP_HOST:"",SMTP_USER:"",SMTP_PASSWORD:"",SMTP_FROM:"",SMTP_PORT:""});
 expect(env.SMTP_PORT).toBe(587); expect(resolveSmtpConfig(env)).toBeNull();
 expect(()=>resolveSmtpConfig(env,{required:true})).toThrow();
 });
 it("requires complete authenticated TLS except loopback nonproduction",()=>{
 const env=mailEnvironmentSchema.parse({SMTP_HOST:"smtp.example",SMTP_USER:"user",SMTP_PASSWORD:"secret",SMTP_FROM:"pubrick@example.com",SMTP_SECURE:"false",SMTP_REQUIRE_TLS:"false"});
 expect(()=>resolveSmtpConfig(env,{nodeEnvironment:"production"})).toThrow();
 expect(()=>resolveSmtpConfig(env,{nodeEnvironment:"development"})).toThrow();
 expect(resolveSmtpConfig({...env,SMTP_REQUIRE_TLS:true},{nodeEnvironment:"production"})).toMatchObject({requireTLS:true});
 expect(resolveSmtpConfig({...env,SMTP_HOST:"127.0.0.1"},{nodeEnvironment:"test"})).toMatchObject({host:"127.0.0.1"});
 expect(()=>resolveSmtpConfig({...env,SMTP_HOST:"127.0.0.1"},{nodeEnvironment:"production"})).toThrow();
 expect(()=>resolveSmtpConfig({...env,SMTP_PASSWORD:undefined})).toThrow();
 });
});
