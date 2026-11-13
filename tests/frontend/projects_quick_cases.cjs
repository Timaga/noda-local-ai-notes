"use strict";

const { A, B } = require("./projects_fixture.cjs");

async function runQuickCases({ context, fixture, check, finishContext }) {
  await fixture.switchProject(A);
  const ctx = await context("index.html", 900, 500), run = ctx.evaluate;
  const waitReady = id => run(`__pWait(()=>NodaProjectContext.snapshot().projectId==='${id}'&&!document.getElementById('prompt-input').disabled)`);
  await waitReady(A); await run("queueClient.stop()");
  await check("quick input drafts remain independent when the main project changes", async () => {
    await run("document.getElementById('prompt-input').value=' A quick draft '");
    await fixture.switchProject(B); await waitReady(B);
    await run(`(()=>{__pAssert(document.getElementById('prompt-input').value==='','A draft leaked into B');document.getElementById('prompt-input').value=' B quick draft ';})()`);
    await fixture.switchProject(A); await waitReady(A);
    await run(`__pAssert(document.getElementById('prompt-input').value===' A quick draft ','A quick draft lost')`);
    await fixture.switchProject(B); await waitReady(B);
    await run(`__pAssert(document.getElementById('prompt-input').value===' B quick draft ','B quick draft lost')`);
  });
  await check("a delayed accepted enqueue cannot clear identical text in B or populate B jobs", async () => {
    await fixture.switchProject(A); await waitReady(A);
    await run(`(()=>{__projects.hold={id:'${A}',path:'/generate/enqueue',method:'POST',phase:'fetch'};
      document.getElementById('prompt-input').value='same raw source';window.__oldEnqueue=queueClient.enqueue('same raw source','local','organize').catch(()=>{});})()`);
    await run("__pWait(()=>__projects.pending.length>0)"); await fixture.switchProject(B); await waitReady(B);
    await run(`(async()=>{document.getElementById('prompt-input').value='same raw source';__projects.hold=null;
      __projects.pending.splice(0).forEach(item=>item.release());await window.__oldEnqueue;
      __pAssert(document.getElementById('prompt-input').value==='same raw source'&&queueClient.values().length===0,'A accepted job altered B');
      __pAssert(!document.getElementById('note-preview').textContent.includes('ASTER_ONLY'),'A preview leaked into B');})()`);
  });
  await check("generation readiness resolved after switching never posts to the new project", async () => {
    await fixture.switchProject(A); await waitReady(A); fixture.holdGeneration = true;
    const count = await run("__projects.calls.filter(x=>x.path==='/generate/enqueue').length");
    await run(`(()=>{window.__lateReady=queueClient.enqueue('A waiting readiness','local','organize').catch(()=>{});})()`);
    const until = Date.now() + 5000;
    while (!fixture.pendingGeneration.length) {
      if (Date.now() > until) throw new Error("Readiness IPC was not reached");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await fixture.switchProject(B); await waitReady(B); fixture.holdGeneration = false; fixture.releaseGeneration();
    await run(`(async()=>{await window.__lateReady;__pAssert(__projects.calls.filter(x=>x.path==='/generate/enqueue').length===${count},'late readiness posted a note');})()`);
    const request = fixture.calls.filter(item => item.action === "generationReady").at(-1);
    if (request.payload.projectId !== A || !/^[a-f0-9]{32}$/.test(request.payload.contextToken || "")) throw new Error("Generation IPC omitted its captured project identity");
  });
  await check("late job detail cannot copy source from another project or replace same-job preview", async () => {
    await fixture.switchProject(A); await waitReady(A);
    await run(`(()=>{__projects.hold={id:'${A}',path:'/generate/jobs/same-job',phase:'json'};window.__oldCopy=copyJobSource('same-job').catch(()=>{});})()`);
    await run("__pWait(()=>__projects.pending.length>0)"); await fixture.switchProject(B); await waitReady(B);
    await run(`(async()=>{__projects.hold=null;const job=await queueClient.detail('same-job');renderCompletedNote(job.result);
      __projects.pending.splice(0).forEach(item=>item.release());await window.__oldCopy;
      __pAssert(__projects.clipboardWrites.length===0,'old source reached clipboard');
      __pAssert(document.getElementById('note-preview').textContent.includes('BOREAL_ONLY')&&!document.getElementById('note-preview').textContent.includes('ASTER_ONLY'),'same job id crossed projects');})()`);
  });
  await check("late runtime configuration cannot overwrite the active project's runtime view", async () => {
    await fixture.switchProject(A); await waitReady(A);
    await run(`(()=>{__projects.hold={id:'${A}',path:'/runtime/config',phase:'json'};window.__oldRuntime=refreshRuntimeConfig().catch(()=>{});})()`);
    await run("__pWait(()=>__projects.pending.length>0)"); await fixture.switchProject(B); await waitReady(B);
    await run(`(async()=>{__projects.hold=null;await refreshRuntimeConfig();__projects.pending.splice(0).forEach(item=>item.release());await window.__oldRuntime;
      __pAssert(JSON.stringify(currentRuntimePayload).includes('BOREAL_ONLY')&&!JSON.stringify(currentRuntimePayload).includes('ASTER_ONLY'),'old runtime crossed projects');
      __pAssert(runtimeStatus.textContent.includes('BOREAL_ONLY')&&!runtimeStatus.textContent.includes('ASTER_ONLY'),'runtime label crossed projects');})()`);
  });
  await check("quick requests carry mandatory headers and switching never replays an uncertain submission", () => run(`(()=>{
    __pAssert(__projects.violations.length===0,'quick HTTP request missing project headers');
    __pAssert(__projects.writes.every(item=>item.id==='${A}'),'old submission was replayed in B');
    return {requests:__projects.calls.length,writes:__projects.writes.length};})()`));
  await finishContext(ctx);
}

module.exports = { runQuickCases };
