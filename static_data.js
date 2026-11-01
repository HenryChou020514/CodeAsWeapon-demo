"use strict";
// Static-only adapter. It has no execution/control API and never opens live SSE.
window.ReplayDataSource=(()=>{
  const base=new URL('.',document.currentScript.src),cache=new Map();
  let catalogPromise=null;
  async function json(path){
    const response=await fetch(new URL(path,base));
    if(!response.ok)throw new Error(`Demo data unavailable (${response.status})`);
    return response.json();
  }
  const catalog=()=>catalogPromise||(catalogPromise=json('data/experiments.json').catch(error=>{catalogPromise=null;throw error;}));
  async function taskData(experiment,task){
    const experiments=await catalog(),entry=experiments.find(item=>item.id===experiment);
    if(!entry?.tasks.includes(task))throw new Error('Task not found in this demo');
    const key=JSON.stringify([experiment,task]);
    if(!cache.has(key)){
      cache.set(key,json(`data/${encodeURIComponent(experiment)}/${encodeURIComponent(task)}.json`).catch(error=>{cache.delete(key);throw error;}));
      if(cache.size>2)cache.delete(cache.keys().next().value);
    }
    return cache.get(key);
  }
  function block(data,id){
    if(!Object.hasOwn(data.blocks,id))throw new Error('A required demo block is missing');
    return data.blocks[id];
  }
  function frame(data,run,index){
    const descriptor=run.frames[index];
    if(!descriptor)throw new Error('This event has no saved replay state');
    const value={...block(data,descriptor.base),
      main:descriptor.main?block(data,descriptor.main):null,
      children:Object.fromEntries(Object.entries(descriptor.children).map(([id,ref])=>[id,ref?block(data,ref):null])),
      observations:descriptor.observations.map(ref=>block(data,ref)),
      artifacts:Object.fromEntries(Object.entries(descriptor.artifacts).map(([id,ref])=>[id,block(data,ref)])),
      events:run.events.slice(0,index+1)};
    return structuredClone(value);
  }
  async function request(url){
    const route=new URL(url,location.origin),params=route.searchParams;
    if(route.pathname==='/api/experiments')return structuredClone(await catalog());
    if(!['/api/replay','/api/execution-order'].includes(route.pathname))throw new Error('This recorded demo does not support live actions');
    const data=await taskData(params.get('experiment'),params.get('task'));
    const selected=params.get('run')||data.runs.at(-1)?.id,run=data.runs.find(item=>item.id===selected);
    if(!run)throw new Error('Run not found in this demo');
    if(route.pathname==='/api/execution-order')return structuredClone(run.order);
    if(params.has('index')){
      const index=Number(params.get('index'));
      if(!Number.isInteger(index)||index<0||index>=run.events.length)throw new Error('Invalid replay index');
      return frame(data,run,index);
    }
    return {runs:data.runs.map(item=>({id:item.id,started_at:item.events[0]?.timestamp,status:item.status,events:item.events.length})),
      run_id:run.id,recorded:run.frames.some(Boolean),events:structuredClone(run.events),frame_count:run.events.length};
  }
  async function statisticsURL(params){
    const experiments=await catalog(),entry=experiments.find(item=>item.id===params.get('experiment'));
    if(!entry)throw new Error('Experiment not found in this demo');
    let file=entry.statistics;
    if(params.has('task')){
      const data=await taskData(entry.id,params.get('task'));
      const run=data.runs.find(item=>item.id===(params.get('run')||data.runs.at(-1)?.id));
      if(!run)throw new Error('Run not found in this demo');
      file=run.statistics;
    }
    return new URL(file,base);
  }
  return Object.freeze({request,statisticsURL,pageURL:()=>new URL('index.html',base)});
})();
