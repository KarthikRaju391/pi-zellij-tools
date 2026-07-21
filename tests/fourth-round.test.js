import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardPath } from "../src/path-policy.js";
import { validate } from "../src/workflows.js";
import { Store } from "../src/store.js";
import { readFile } from "node:fs/promises";

test("existing symlink file is blocked for read and write", async () => { const root=await mkdtemp(join(tmpdir(),"sf-")); await mkdir(join(root,"src")); const outside=join(await mkdtemp(join(tmpdir(),"so-")),"secret"); await writeFile(outside,"x"); await symlink(outside,join(root,"src","file")); for(const write of [false,true]) assert.throws(()=>guardPath({cwd:root,roots:[root],paths:["src"],input:"src/file",write})); });
test("workflow validation rejects unknown, duplicate, oversized parallel and second writer",()=>{assert.throws(()=>validate([{type:"wat"}]));assert.throws(()=>validate([{type:"agent",id:"x",role:"writer"},{type:"agent",id:"x",role:"writer"}]));assert.throws(()=>validate([{type:"parallel",nodes:[1,2,3,4].map((_,i)=>({type:"agent",id:`v${i}`,role:"verifier"}))}]));assert.throws(()=>validate([{type:"agent",id:"a",role:"writer"},{type:"agent",id:"b",role:"writer"}]));});
test("claims serialize task and cwd and owner release cannot delete a newer owner",async()=>{const store=new Store(await mkdtemp(join(tmpdir(),"claims-")));await store.claim("task-a","/a","one");await assert.rejects(store.claim("task-a","/b","two"));await assert.rejects(store.claim("task-b","/a","two"));await store.releaseClaim("task-a","/a","wrong");for(const f of store.claimFiles("task-a","/a"))assert.equal(JSON.parse(await readFile(f,"utf8")).runId,"one");});
