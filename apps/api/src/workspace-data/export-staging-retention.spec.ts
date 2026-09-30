import { chmod, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,expect,it } from "vitest";
import { purgeStaleExportStages } from "./export-staging-retention";
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(directory=>rm(directory,{recursive:true,force:true})));});
it("removes only old owned private prefix directories and preserves active/unrelated/symlink paths",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pubrick-retention-test-"));directories.push(root);
 const prefix="pubrick-workspace-export-";const now=Date.now()+3*3600000;
 for(const name of [`${prefix}old`,`${prefix}active`,`${prefix}public`,"unrelated"]){await mkdir(join(root,name),{mode:0o700});await writeFile(join(root,name,"workspace.tar.gz"),"private content",{mode:0o600});}
 await chmod(join(root,`${prefix}public`),0o755);
 await utimes(join(root,`${prefix}active`),new Date(now),new Date(now));
 await symlink(join(root,"unrelated"),join(root,`${prefix}symlink`));
 expect(await purgeStaleExportStages({root,now:()=>now})).toBe(1);
 expect((await readdir(root)).sort()).toEqual([`${prefix}active`,`${prefix}public`,`${prefix}symlink`,"unrelated"].sort());
});
it("does not purge stages owned by another effective user",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pubrick-retention-test-"));directories.push(root);
 const name="pubrick-workspace-export-other";await mkdir(join(root,name),{mode:0o700});
 expect(await purgeStaleExportStages({root,now:()=>Date.now()+3*3600000,effectiveUid:(process.geteuid?.()??0)+1})).toBe(0);
 expect(await readdir(root)).toEqual([name]);
});
