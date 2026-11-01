"use strict";
async function exportStatistics(scope,button){
  const experiment=$("experiment").value;if(!experiment)return;
  const params=new URLSearchParams({experiment});
  if(scope==='task'){
    if(!$("task").value||!Replay.manifest)return;
    params.set('task',$("task").value);
    if(Replay.manifest.run_id)params.set('run',Replay.manifest.run_id);
  }
  button.disabled=true;
  try{
    const endpoint=window.ReplayDataSource?await window.ReplayDataSource.statisticsURL(params):`/api/statistics?${params}`;
    const response=await fetch(endpoint);
    if(!response.ok)throw new Error(`Statistics export failed (${response.status})`);
    const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');
    link.href=url;link.download=`${experiment}${scope==='task'?`_${params.get('task')}`:''}_statistics.xlsx`;
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }catch(error){notice(error.message);}finally{button.disabled=false;}
}
const orderLabelMeasure=document.createElement('canvas').getContext('2d');
function replayOutcome(finished){
  const status=finished?.status,phase=finished?.phase||'',reason=typeof finished?.message==='string'?finished.message.trim():'';
  const source=reason===status?'':reason;
  const groups={completed:'Success',failed:'Failure',error:'Failure',unresolved:'Failure',blocked:'Execution blocked',coder_blocked:'Failure',coder_generation_failed:'Failure',attempts_exhausted:'Failure',out_of_scope:'Scope restriction',stopped:'Stopped',interrupted:'Interrupted',cancelled:'Cancelled',not_started:'Not started',planning_completed:'Planning completed',prepared:'Action prepared',running:'Running',paused:'Paused',snapshot:'Snapshot only'};
  let category='',explanation='';
  // Only the final termination message is evidence of the termination cause.
  // Earlier errors may have recovered and must not determine the final category.
  if(status==='completed')explanation='Task recorded as successful.';
  else if(['running','paused','prepared','planning_completed','not_started','snapshot'].includes(status))explanation='This status does not establish verified task success or failure.';
  else if(status){
    const rules=[
      [/insufficient_quota|quota (?:exceeded|exhausted)|billing|\u984d\u5ea6(?:\u8017\u76e1|\u4e0d\u8db3)/i,'API Quota or billing restriction','The provider restricted the request due to quota or billing.'],
      [/rate.?limit|too many requests|\u9650\u6d41/i,'API Request rate limit','The request was rate limited, this does not establish that the task is impossible.'],
      [/docker|container|environment.*(?:fail|error)|\u5bb9\u5668|\u74b0\u5883.*(?:\u5931\u6557|\u932f\u8aa4)/i,'Execution environment issue','The execution environment could not provide the required service.'],
      [/timed?\s*out|timeout|\u903e\u6642/i,'Wait or execution timeout','The operation exceeded its time limit, the task outcome remains unverified.'],
      [/truncat|output.*(?:incomplete|cut off)|\u8f38\u51fa.*(?:\u622a\u65b7|\u4e0d\u5b8c\u6574)/i,'Incomplete output or evidence','The saved output is insufficient to verify the full result.'],
      [/evaluator.*(?:not verified|has not verified)|(?:answer|\u7b54\u6848).*(?:not verified|\u672a\u9a57\u8b49)|\u5c1a\u672a.*\u9a57\u8b49/i,'Answer not yet verified','The run may have produced output, but the evaluator has not confirmed that it meets the task criterion.'],
      [/json.*(?:invalid|parse|decode|malformed)|(?:invalid|malformed).*json|JSON.*(?:\u932f\u8aa4|\u7121\u6548)/i,'Invalid model output format','The model output does not match the required data format.'],
      [/(?:graph|plan|dag).*(?:validat|invalid)|validat.*(?:graph|plan|dag)|\u5716.*\u9a57\u8b49/i,'Graph validation failed','The planning graph violates structural or scheduling rules.'],
    ];
    const matched=rules.find(([pattern])=>pattern.test(source));
    if(matched)[,category,explanation]=matched;
    else if(status==='attempts_exhausted'||/retries.*exhaust|attempts.*exhaust|\u91cd\u8a66.*\u7528\u76e1/i.test(source)){category='Retry budget exhausted';explanation='The allowed attempts have been used, this does not establish that the task is impossible.';}
    else if(['coder_blocked','coder_generation_failed'].includes(status)){category='Code generation blocked';explanation='Coder did not provide a usable continuation artifact.';}
    else if(['generate_graph','generate_subgraph','replan'].includes(phase)&&['failed','error'].includes(status)){category='Planning stage error';explanation='The run ended during planning; refer to the original record for details.';}
    else if(status==='unresolved'){category='Insufficient evidence';explanation='This experiment did not obtain sufficient evidence to verify task success, and is counted as a failure.';}
    else {category='Unclassified reason';explanation='The record does not establish a specific termination category; this does not prove the task is impossible.';}
  }
  return {label:[groups[status]||status||'No final outcome recorded',category].filter(Boolean).join(' · '),explanation,reason:source||'No specific reason was recorded.'};
}
// Read-only playback: no job controls, worker requests or live SSE connection.
const Replay={
  version:0, ticket:0, timer:null, playing:false, manifest:null, index:0,
  mode:"event", steps:[],
  order:null,orderRows:[],orderGroups:[],orderScope:null,displayedOrder:[],detailTicket:0,
  entryStart(entry){return entry.entries?entry.entries.find(item=>item.recorded):entry.recorded?entry:null;},
  async jumpTo(entry){
    const start=this.entryStart(entry);if(!start)return;
    this.pause();this.detailTicket++;const scope=this.orderScope;
    if($("task").value!==start.task||this.manifest?.run_id!==start.run_id){$("task").value=start.task;await connect({run:start.run_id,orderScope:scope});}
    if(this.manifest?.run_id===start.run_id&&$("task").value===start.task)await this.seek(start.index);
    const kind=(entry.entries||entry.planning_level!=='low')?'main':'child';
    if(kind==='child'&&snapshot?.children?.[start.decomposition_id]&&selectedChild!==start.decomposition_id){selectedChild=start.decomposition_id;await renderGraph();}
    if((kind==='main'?snapshot?.main:snapshot?.children?.[selectedChild])?.graph?.nodes.some(node=>node.id===entry.node_id)){
      mode=kind;selectedNode=entry.node_id;autoNode=false;highlight();renderSelectedNodePanel();
    }
  },
  async jumpToGraphNode(kind,id,childId=null){
    let matches;
    if(kind==='main')matches=this.orderGroups.filter(group=>group.node_id===id&&this.entryStart(group));
    else{
      const graph=snapshot?.children?.[childId]?.graph;
      const candidates=(this.order?.entries||[]).filter(entry=>entry.node_id===id&&entry.planning_level==='low'&&entry.recorded);
      const decompositionId=graph?.decomposition_id||childId;
      matches=candidates.filter(entry=>entry.decomposition_id===decompositionId);
      if(!matches.length&&graph?.parent_node_id)matches=candidates.filter(entry=>entry.parent_node_id===graph.parent_node_id);
      if(!matches.length&&candidates.length===1)matches=candidates;
    }
    const entry=matches.find(group=>this.entryStart(group).index>=this.index)||matches[0];
    if(!entry){notice(`No ${id} recorded execution steps available for replay.`,true);return;}
    await this.jumpTo(entry);
  },
  async showNodeInfo(entry,button){
    const start=this.entryStart(entry);if(!start)return;
    this.pause();const version=this.version,ticket=++this.detailTicket;button.disabled=true;
    try{
      let data=snapshot;
      if(data?.task!==start.task||data?.run_id!==start.run_id||!recordedNodeView(data,entry.node_id)){
        const params=new URLSearchParams({experiment:this.order.experiment,task:start.task,run:start.run_id,index:String(start.index)});
        data=await request(`/api/replay?${params}`);
      }
      if(version!==this.version||ticket!==this.detailTicket)return;
      openRecordedNodeDialog(data,entry.node_id,button);
    }catch(error){if(version===this.version&&ticket===this.detailTicket)notice(`Unable to display Node details: ${error.message}`);}
    finally{button.disabled=false;}
  },
  sizeOrderNodes(){
    const list=$("replay-order-list"),available=Math.max(160,list.clientWidth-60);
    for(const button of this.orderRows){
      const count=button.closest('.sequence-track').querySelectorAll('.sequence-step').length;
      const columns=Math.min(count,Math.max(1,Math.floor((available+24)/350)));
      const maxWidth=Math.max(120,Math.min(360,(available-(columns-1)*24)/columns));
      const id=button.dataset.nodeId;let font=18,width=0,lines=1;
      for(;font>=14;font--){
        orderLabelMeasure.font=`600 ${font}px Consolas,"Cascadia Code",monospace`;
        width=orderLabelMeasure.measureText(id).width;lines=Math.max(1,Math.ceil(width/(maxWidth-40)));
        if(lines<=2||font===14)break;
      }
      button.style.setProperty('--node-font-size',`${font}px`);
      const targetWidth=Math.max(96,Math.ceil(width/Math.min(2,lines))+44);
      button.style.setProperty('--node-width',`${targetWidth}px`);
      const label=button.querySelector('.sequence-node-label');
      if(!label)continue;
      const lineHeight=parseFloat(getComputedStyle(label).lineHeight);
      const fits=()=>label.getBoundingClientRect().height<=lineHeight*2+1;
      if(!fits()){
        let low=targetWidth,high=targetWidth;
        for(let attempt=0;attempt<8&&!fits();attempt++){high=Math.ceil(high*1.35);button.style.setProperty('--node-width',`${high}px`);}
        for(let attempt=0;attempt<5;attempt++){
          const middle=Math.ceil((low+high)/2);button.style.setProperty('--node-width',`${middle}px`);
          if(fits())high=middle;else low=middle;
        }
        button.style.setProperty('--node-width',`${high}px`);
      }
    }
    this.drawOrderLinks();
  },
  drawOrderLinks(){
    const ns='http://www.w3.org/2000/svg';
    for(const [laneIndex,lane] of [...$("replay-order-list").querySelectorAll('.sequence-task')].entries()){
      lane.querySelector('.sequence-links')?.remove();
      const track=lane.querySelector('.sequence-track'),bounds=track.getBoundingClientRect();
      const nodes=[...track.querySelectorAll('.sequence-node')].map(node=>{
        const box=node.getBoundingClientRect(),step=node.closest('.sequence-step').getBoundingClientRect();return {left:box.left-bounds.left,right:box.right-bounds.left,top:box.top-bounds.top,bottom:box.bottom-bounds.top,stepBottom:step.bottom-bounds.top,y:box.top+box.height/2-bounds.top};
      });
      if(nodes.length<2)continue;
      const svg=document.createElementNS(ns,'svg');svg.classList.add('sequence-links');svg.setAttribute('aria-hidden','true');
      svg.style.left=`${track.offsetLeft}px`;svg.style.top=`${track.offsetTop}px`;
      const width=Math.max(track.clientWidth,track.scrollWidth),height=track.clientHeight;
      svg.setAttribute('width',String(width));svg.setAttribute('height',String(height));
      const markerId=`sequence-arrow-${laneIndex}`,defs=document.createElementNS(ns,'defs'),marker=document.createElementNS(ns,'marker');
      for(const [key,value] of Object.entries({id:markerId,viewBox:'0 0 10 10',refX:10,refY:5,markerWidth:6,markerHeight:6,orient:'auto',markerUnits:'userSpaceOnUse'}))marker.setAttribute(key,String(value));
      const arrow=document.createElementNS(ns,'path');arrow.setAttribute('d','M0 0 L10 5 L0 10 Z');arrow.setAttribute('fill','#637c99');marker.append(arrow);defs.append(marker);svg.append(defs);
      for(let index=0;index<nodes.length-1;index++){
        const from=nodes[index],to=nodes[index+1];let d;
        if(to.left>from.right&&Math.abs(to.top-from.top)<1){const middle=(from.right+to.left)/2;d=`M${from.right} ${from.y} H${middle} V${to.y} H${to.left}`;}
        else{
          const rowBottom=Math.max(...nodes.filter(node=>Math.abs(node.top-from.top)<1).map(node=>node.stepBottom));
          const middle=(rowBottom+to.top)/2;
          d=`M${from.right} ${from.y} H${from.right+12} V${middle} H${to.left-12} V${to.y} H${to.left}`;
        }
        const path=document.createElementNS(ns,'path');path.setAttribute('d',d);path.setAttribute('fill','none');path.setAttribute('stroke','#637c99');path.setAttribute('stroke-width','1.5');path.setAttribute('stroke-linejoin','round');path.setAttribute('marker-end',`url(#${markerId})`);svg.append(path);
      }
      lane.append(svg);
    }
  },
  async loadOrder(version){
    try{
      const order=await request(`/api/execution-order?${query()}${this.manifest.run_id?`&run=${encodeURIComponent(this.manifest.run_id)}`:""}`);
      if(version!==this.version)return;
      const task=$("task").value;
      order.entries=order.entries.filter(entry=>entry.task===task&&entry.run_id===this.manifest.run_id);
      order.tasks=order.tasks.filter(entry=>entry.task===task);
      this.order=order;this.orderGroups=[];
      for(const entry of order.entries){
        const mainId=entry.main_node_id||(entry.decomposition_id&&entry.parent_node_id?entry.parent_node_id:entry.node_id);
        const previous=this.orderGroups.at(-1),identity=JSON.stringify([entry.task,entry.run_id,mainId]);
        let group=previous?.identity===identity?previous:null;
        if(!group){group={...entry,node_id:mainId,key:entry.id,identity,entries:[],children:[]};this.orderGroups.push(group);}
        group.entries.push(entry);
        if(entry.planning_level==='low'||entry.node_id!==mainId)group.children.push(entry);
      }
      if(!this.orderGroups.some(group=>group.key===this.orderScope))this.orderScope=null;
      this.drawOrder();
    }catch(error){if(version===this.version){text('replay-order-count','Unable to load');text('replay-order-current',error.message);}}
  },
  drawOrder({animate=false}={}){
    const group=this.orderGroups.find(item=>item.key===this.orderScope),list=$("replay-order-list");
    DAGMotion.stop(list);delete list.dataset.current;
    this.displayedOrder=group?group.children:this.orderGroups;this.orderRows=[];
    list.replaceChildren();list.scrollTop=0;list.scrollLeft=0;
    text('replay-order-title',group?`Child graph · ${group.node_id}`:'Main graph node execution order');
    $("replay-order-back").hidden=!group;
    list.setAttribute('aria-label',group?`${group.node_id} child execution order`:`${$("task").value} main graph Node execution order`);
    text('replay-order-count',group?`${group.children.length} steps`:`${this.order?.tasks.length||0} tasks · ${this.orderGroups.length} steps`);
    let lane=null,track=null,laneKey=null;
    for(const entry of this.displayedOrder){
      const nextKey=JSON.stringify([entry.task,entry.run_id]);
      if(nextKey!==laneKey){
        lane=element('section',undefined,'sequence-task');lane.append(element('strong',entry.task,'sequence-task-label'));
        track=element('ol',undefined,'sequence-track');track.setAttribute('aria-label',`${entry.task} ${group?'Child graph':'Main graph'} order`);lane.append(track);list.append(lane);laneKey=nextKey;
      }
      const item=element('li',undefined,'sequence-step'),button=element('button',undefined,'sequence-node');button.type='button';
      const label=element('span',entry.node_id,'sequence-node-label');
      button.append(label);
      button.dataset.entryId=entry.id;button.dataset.nodeId=entry.node_id;
      const start=this.entryStart(entry);
      button.title=`${entry.node_id}${start?' · Jump to this step':' · No corresponding snapshot'}`;
      button.setAttribute('aria-label',`Replay ${entry.node_id}`);button.disabled=!start;
      button.onclick=event=>{event.stopPropagation();this.jumpTo(entry);};
      const actions=element('div',undefined,'sequence-node-actions');
      if(!group&&entry.children.length){
        const drill=element('button','Child graph','sequence-drill');drill.type='button';drill.title='View child execution order';
        drill.setAttribute('aria-label',`View ${entry.node_id} child execution order`);
        drill.onclick=event=>{event.stopPropagation();this.orderScope=entry.key;this.drawOrder({animate:true});};actions.append(drill);
      }
      const info=element('button','ⓘ','sequence-info');info.type='button';info.title='Node details';info.disabled=!start;
      info.setAttribute('aria-label',`View ${entry.node_id} details`);info.setAttribute('aria-haspopup','dialog');info.setAttribute('aria-controls','node-dialog');
      info.onclick=event=>{event.stopPropagation();this.showNodeInfo(entry,info);};actions.append(info);
      item.append(button,actions);track.append(item);this.orderRows.push(button);
    }
    if(!this.displayedOrder.length)list.append(element('div',group?'This node has no child execution records.':'No node execution order records are available.','replay-order-empty'));
    this.sizeOrderNodes();this.renderOrder();if(animate)UIMotion.enter(list);
  },
  renderOrder(){
    if(!this.order||!this.manifest)return;
    const task=$("task").value,run=this.manifest.run_id;
    const current=this.order.entries.findLastIndex(entry=>entry.task===task&&entry.run_id===run&&entry.index<=this.index);
    const frame=this.manifest.events[this.index],ended=frame?.event==='run.finished';
    const frameTime=frame?.timestamp||snapshot?.historical_time||'';
    const activeEntry=this.order.entries[current];
    this.orderRows.forEach((row,index)=>{
      const entry=this.displayedOrder[index],entries=entry.entries||[entry];
      const active=entries.some(item=>item.id===activeEntry?.id);
      const played=entries.every(item=>item.task===task&&item.run_id===run?item.index<this.index:item.timestamp<frameTime);
      row.classList.toggle('current',active);row.classList.toggle('played',played&&!active);
      const view=entry.task===task&&entry.run_id===run?recordedNodeView(snapshot,entry.node_id)?.view:null;
      const graph=NativeDAG.presentationGraph(snapshot,view),node=graph?.nodes.find(node=>node.id===entry.node_id);
      const display=node?NativeDAG.nodeState(node,graph):null;
      row.dataset.state=display?.key||'unknown';
      for(const [key,value] of Object.entries({fill:display?.fill||'#152235',stroke:display?.stroke||'#465b75',text:display?.text||'#c6d2e5'}))row.style.setProperty(`--state-${key}`,value);
      row.title=`${entry.node_id} · ${display?.label||'State not loaded for this Task state'} · Jump to this step`;
      if(active)row.setAttribute('aria-current','step');else row.removeAttribute('aria-current');
    });
    const entry=this.order.entries[current];
    const visiblePosition=this.orderRows.findIndex(row=>row.getAttribute('aria-current')==='step');
    text('replay-order-position',`${ended?'Final position':'Current position'} · ${this.orderScope?'Child graph':'Main graph'}${visiblePosition>=0?` ${visiblePosition+1} / ${this.displayedOrder.length}`:''} · ${task}`);
    const nodeId=frame?.node_id||entry?.node_id;
    const node=[snapshot?.main?.graph,...Object.values(snapshot?.children||{}).map(view=>view?.graph)].filter(Boolean).flatMap(graph=>graph.nodes).find(node=>node.id===nodeId);
    text('replay-order-current',node?.id||entry?.node_id||'No node entered yet');
    const list=$("replay-order-list"),row=this.orderRows.find(button=>button.getAttribute('aria-current')==='step'),key=row?.dataset.entryId||'';
    if(row&&list.dataset.current!==key){
      const box=row.getBoundingClientRect(),viewport=list.getBoundingClientRect();
      const top=box.top-viewport.top+list.scrollTop-list.clientTop,left=box.left-viewport.left+list.scrollLeft-list.clientLeft;
      if(top<list.scrollTop||top+box.height>list.scrollTop+list.clientHeight||left<list.scrollLeft||left+box.width>list.scrollLeft+list.clientWidth){
        const from={top:list.scrollTop,left:list.scrollLeft},target={top:Math.max(0,top-(list.clientHeight-box.height)/2),left:Math.max(0,left-(list.clientWidth-box.width)/2)};
        if(this.playing){DAGMotion.stop(list);list.scrollTop=target.top;list.scrollLeft=target.left;}
        else DAGMotion.tween(list,t=>{list.scrollTop=from.top+(target.top-from.top)*t;list.scrollLeft=from.left+(target.left-from.left)*t;},()=>{},420);
      }
    }
    list.dataset.current=key;
  },
  buildSteps(){
    const manifest=this.manifest;
    if(!manifest){this.steps=[];return;}
    if(this.mode==="event"||!manifest.recorded){this.steps=Array.from({length:manifest.frame_count},(_,index)=>index);return;}
    const steps=[];let previous=null,executionStarted=false;
    manifest.events.forEach((event,index)=>{
      if(!event.replay_state||!event.node_id||!["node.selected","execution.started","assessment.prepared"].includes(event.event))return;
      const key=JSON.stringify([event.decomposition_id,event.node_id]);
      if(event.event==='execution.started'&&key===previous&&!executionStarted){executionStarted=true;return;}
      steps.push(index);previous=key;executionStarted=event.event==='execution.started';
    });
    const last=manifest.frame_count-1;
    if(manifest.events[last]?.replay_state&&steps.at(-1)!==last)steps.push(last);
    this.steps=steps.length?steps:[0];
  },
  position(){return Math.max(0,this.steps.findLastIndex(index=>index<=this.index));},
  async step(position){if(this.steps.length)await this.seek(this.steps[Math.max(0,Math.min(this.steps.length-1,position))]);},
  async navigate(mode,direction){
    if(!this.manifest)return;
    this.pause();this.mode=mode;this.buildSteps();
    const target=direction>0?this.steps.find(index=>index>this.index):this.steps.findLast(index=>index<this.index);
    this.controls();if(target!==undefined)await this.seek(target);else this.updateProgress();
  },
  updateProgress(){
    if(!this.manifest||!snapshot)return;
    const event=this.manifest.recorded?this.manifest.events[this.index]:null;
    text("replay-progress",`${this.position()+1} / ${this.steps.length} ${this.mode==="node"?"nodes":"events"} · ${time(snapshot.historical_time)}${event?` · ${eventLabels[event.event]||event.event}${event.node_id?` · ${event.node_id}`:""}`:" · Final snapshot"}`);
  },
  result(status,finished){
    const badge=document.getElementById("replay-result");
    const success=status==="completed",failed=["failed","error","unresolved","attempts_exhausted","coder_blocked","coder_generation_failed"].includes(status);
    const outcome=replayOutcome(finished||{status});
    badge.textContent=outcome.label;badge.title=outcome.explanation;
    badge.className=`badge ${success?"completed":failed?"failed":"unresolved"}`;
    badge.dataset.status=status||"unknown";
  },
  resultReason(finished){
    const button=$("replay-reason"),status=finished?.status;
    button.hidden=!status||["completed","running","paused","prepared","planning_completed"].includes(status);
    const outcome=replayOutcome(finished);
    text("replay-reason-detail",`${outcome.label}\n${outcome.explanation}\n\nOriginal termination reason\n${outcome.reason}`);
    text("replay-reason-title",["failed","error","unresolved","attempts_exhausted","coder_blocked","coder_generation_failed"].includes(status)?"Task failure reason":"Task incomplete reason");
    button.textContent=["failed","error","unresolved","attempts_exhausted","coder_blocked","coder_generation_failed"].includes(status)?"View failure reason":"View incomplete reason";
  },
  pause(){this.playing=false;clearTimeout(this.timer);document.getElementById("replay-play").textContent="Play";},
  async load(run,{orderScope=null}={}){
    if(document.getElementById("node-dialog").open)document.getElementById("node-dialog").close();
    this.pause();this.detailTicket++;const version=++this.version;++this.ticket;this.manifest=null;
    this.steps=[];
    DAGMotion.stop($("replay-order-list"));
    this.order=null;this.orderRows=[];this.orderGroups=[];this.displayedOrder=[];this.orderScope=orderScope;$("replay-order-list").replaceChildren();delete $("replay-order-list").dataset.current;
    $("replay-order-back").hidden=true;text('replay-order-title','Main graph node execution order');
    text('replay-order-count','Loading');text('replay-order-current','Waiting to load');text('replay-order-position','Current position');
    text("replay-result","Loading");$("replay-result").className="badge";delete $("replay-result").dataset.status;
    $("replay-reason").hidden=true;if($("replay-reason-dialog").open)$("replay-reason-dialog").close();
    snapshot=null;selectedNode=null;selectedChild=null;renderGraph();renderDetails();$("events").replaceChildren();delete $("events").dataset.source;
    document.querySelectorAll(".run-overview").forEach(node=>node.hidden=true);
    for(const id of ["replay-first","replay-last","replay-prev","replay-prev-node","replay-next-node","replay-next-event","replay-play","replay-position"])document.getElementById(id).disabled=true;
    text("replay-progress","Loading historical records…");
    try{
      const manifest=await request(`/api/replay?${query()}${run?`&run=${encodeURIComponent(run)}`:""}`);
      if(version!==this.version)return;
      this.manifest=manifest;
      this.buildSteps();
      const finished=[...manifest.events].reverse().find(event=>event.event==="run.finished");
      this.result(finished?.status,finished);
      this.resultReason(finished);
      await Promise.all([this.loadOrder(version),this.step(0)]);
    }catch(error){if(version===this.version){connection(false,"Unable to load replay");notice(error.message);text("replay-progress","Unable to read records");text("replay-result","Unable to read result");$("replay-result").className="badge";}}
  },
  async seek(index){
    if(!this.manifest)return;
    this.detailTicket++;if(nodeDialogView&&$("node-dialog").open)$("node-dialog").close();
    const manifest=this.manifest,version=this.version,ticket=++this.ticket;
    this.index=Math.max(0,Math.min(manifest.frame_count-1,index));
    const requested=this.index;$("replay-position").value=String(this.position());
    try{
      const next=await request(`/api/replay?${query()}${manifest.run_id?`&run=${encodeURIComponent(manifest.run_id)}`:""}&index=${requested}`);
      if(version!==this.version||ticket!==this.ticket)return;
      if(!selectedChild||(!$("node-dialog").open&&selectedChild===snapshot?.current_child)||!next.children[selectedChild])selectedChild=next.current_child;
      if(this.mode==="node")selectedChild=next.current_child;
      snapshot=next;artifactCache.clear();autoNode=true;
      if(!manifest.recorded)this.result(next.status);
      document.querySelectorAll(".run-overview").forEach(node=>node.hidden=false);
      await render({focusGraphs:this.mode==="node",animateGraphs:!this.playing,cameraDuration:Math.min(420,800/Number($("replay-speed").value))});
      if(version!==this.version||ticket!==this.ticket)return;
      this.renderOrder();
      connection(false,"History replay · Read-only");
      this.updateProgress();
      this.controls();
    }catch(error){
      if(version!==this.version||ticket!==this.ticket)return;
      this.pause();snapshot=null;selectedNode=null;selectedChild=null;renderGraph();renderDetails();
      document.querySelectorAll(".run-overview").forEach(node=>node.hidden=true);
      $("events").replaceChildren();delete $("events").dataset.source;notice(`Cannot restore this point: ${error.message}`);text("replay-progress",`${requested+1} / ${manifest.frame_count} · State missing`);this.controls();
    }
  },
  controls(){
    const count=this.steps.length,position=this.position();
    $("replay-first").disabled=!this.manifest||this.index<=0;
    $("replay-last").disabled=!this.manifest||this.index>=this.manifest.frame_count-1;
    $("replay-prev").disabled=!this.manifest||this.index<=0;
    $("replay-next-event").disabled=!this.manifest||this.index>=this.manifest.frame_count-1;
    const mode=this.mode,steps=this.steps;
    this.mode="node";this.buildSteps();
    $("replay-prev-node").disabled=!this.steps.some(index=>index<this.index);
    $("replay-next-node").disabled=!this.steps.some(index=>index>this.index);
    this.mode=mode;this.steps=steps;
    $("replay-mode").value=this.mode;
    for(const [id,kind] of [["replay-prev","event"],["replay-next-event","event"],["replay-prev-node","node"],["replay-next-node","node"]])$(id).setAttribute("aria-pressed",String(this.mode===kind));
    $("replay-play").disabled=count<2;
    $("replay-position").disabled=count<2;
    $("replay-position").max=String(Math.max(0,count-1));$("replay-position").value=String(position);
    for(const option of $("replay-speed").options)option.textContent=`${option.value} ${this.mode==="node"?"nodes":"events"}/s`;
  },
  schedule(delay=1000/Number($("replay-speed").value)){
    clearTimeout(this.timer);
    if(!this.playing)return;
    if(this.position()>=this.steps.length-1){this.pause();return;}
    const version=this.version;
    this.timer=setTimeout(async()=>{
      if(!this.playing||version!==this.version)return;
      const started=performance.now();
      await this.step(this.position()+1);
      if(version===this.version)this.schedule(Math.max(0,1000/Number($("replay-speed").value)-(performance.now()-started)));
    },delay);
  },
  async toggle(){
    if(this.playing){this.pause();return;}
    if(!this.manifest||this.steps.length<2)return;
    if(this.position()>=this.steps.length-1)await this.step(0);
    this.playing=true;$("replay-play").textContent="Pause";this.schedule();
  }
};
document.getElementById('export-task-statistics').onclick=event=>exportStatistics('task',event.currentTarget);
document.getElementById('export-experiment-statistics').onclick=event=>exportStatistics('experiment',event.currentTarget);
document.getElementById("replay-play").addEventListener("click",()=>Replay.toggle());
document.getElementById("replay-first").addEventListener("click",()=>{Replay.pause();if(Replay.manifest?.frame_count)Replay.seek(0);});
document.getElementById("replay-last").addEventListener("click",()=>{Replay.pause();if(Replay.manifest?.frame_count)Replay.seek(Replay.manifest.frame_count-1);});
document.getElementById("replay-position").addEventListener("input",event=>{Replay.pause();Replay.step(Number(event.target.value));});
document.getElementById('replay-order-back').addEventListener('click',()=>{Replay.orderScope=null;Replay.drawOrder({animate:true});});
let orderResizeTimer;
window.addEventListener('resize',()=>{clearTimeout(orderResizeTimer);orderResizeTimer=setTimeout(()=>{Replay.sizeOrderNodes();delete document.getElementById('replay-order-list').dataset.current;Replay.renderOrder();},100);});
for(const name of ['wheel','touchstart','pointerdown'])document.getElementById('replay-order-list').addEventListener(name,()=>DAGMotion.stop(document.getElementById('replay-order-list')),{passive:true});
document.getElementById("replay-speed").addEventListener("change",()=>Replay.schedule());
document.getElementById("replay-mode").addEventListener("change",event=>{
  Replay.pause();Replay.mode=event.target.value;Replay.buildSteps();Replay.controls();Replay.updateProgress();
});
window.addEventListener("beforeunload",()=>Replay.pause());

for(const [id,mode,direction] of [["replay-prev","event",-1],["replay-next-event","event",1],["replay-prev-node","node",-1],["replay-next-node","node",1]])document.getElementById(id).addEventListener("click",()=>Replay.navigate(mode,direction));

document.getElementById("replay-reason").onclick=()=>document.getElementById("replay-reason-dialog").showModal();
document.getElementById("replay-reason-close").onclick=()=>document.getElementById("replay-reason-dialog").close();
document.getElementById("replay-reason-dialog").addEventListener("click",event=>{if(event.target===event.currentTarget)event.currentTarget.close();});
