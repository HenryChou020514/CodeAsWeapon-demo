"use strict";
const $ = id => document.getElementById(id);
const replayMode=Boolean(window.ReplayDataSource)||location.pathname==="/replay";
const graphWindow=new URLSearchParams(location.search).get('viewer')==='graph';
const graphWindows=new Map();
let graphWindowSource=null;
if(graphWindow){document.body.classList.add('graph-viewer');document.body.dataset.graphKind=new URLSearchParams(location.search).get('kind')==='child'?'child':'main';}
const labels = {running:"Running",completed:"Completed",failed:"Failure",blocked:"Required input missing",interrupted:"Interrupted",stopped:"Stopped",snapshot:"Historical snapshot",planning_completed:"Planning completed",prepared:"Action prepared",unresolved:"Insufficient evidence",pending:"Pending",active:"Current",ready:"Ready",skipped:"Skipped",timed_out:"Timed out",awaiting_child_assessment:"Waiting for child Node review",awaiting_parent_assessment:"Waiting for parent Node review"};
const taskFailureStatuses=new Set(["failed","error","unresolved","attempts_exhausted","coder_blocked","coder_generation_failed"]);
function taskStatusLabel(status){
  const reasons={unresolved:"Insufficient evidence",attempts_exhausted:"Retries exhausted",coder_blocked:"Code generation blocked",coder_generation_failed:"Code generation error"};
  return taskFailureStatuses.has(status)?`Failure${reasons[status]?` · ${reasons[status]}`:""}`:(labels[status]||status);
}
Object.assign(labels,{not_started:"Not started",cancelled:"Cancelled"});
const phases = {generate_graph:"Generate main DAG",generate_subgraph:"Generate child DAG",generate_code:"Generate code / action",execute:"Execute action",assess:"Evidence review and replanning"};
const eventLabels = {"run.started":"Experiment started","run.finished":"Run finished","stage.started":"Stage started","stage.completed":"Stage completed","stage.failed":"Stage error","generation.attempt":"Generate / repair","validation.failed":"Validation failed","llm.started":"Waiting for LLM response","llm.completed":"LLM Response received","llm.failed":"LLM Request failed","node.selected":"Selected Node","execution.started":"Execution started","execution.completed":"Execution result","graph.updated":"DAG updated","artifact.saved":"Coder Artifact saved","iteration.started":"New iteration"};
Object.assign(eventLabels,{"domains.loaded":"Domain knowledge loaded","assessment.corrected":"Runtime review correction","llm.global_block":"Provider-wide block","assessment.prepared":"Evidence review"});
Object.assign(eventLabels,{"json.repaired":"JSON format repaired by runtime","json.rejected":"JSON requires model correction"});
let snapshot=null, stream=null, mode="main", selectedChild=null, selectedNode=null, autoNode=true;
let liveJob=null, streamVersion=0, liveTransitionPending=false;
const graphPanels = {main:{source:null,zoom:1,layout:null,current:null,graph:null,viewMode:"follow"},child:{source:null,zoom:1,layout:null,current:null,graph:null,viewMode:"follow"}};
let artifactCache=new Map();
let nodeDialogView=null;
eventLabels["assessment.completed"]="Evidence review result";eventLabels["run.configured"]="Settings loaded";
eventLabels["execution.skipped"]="Executor Not executed";
const animatedText=new Set(['run-status','agent','phase','active-node','parent-node','decision-label','replay-result']);
const text = (id,value) => {const node=$(id),next=String(value??"—");if(node.textContent===next)return;node.textContent=next;if(animatedText.has(id)&&node.isConnected)UIMotion.animate(node,[{opacity:.45},{opacity:1}],{duration:220});};
function eventMessage(event){
  const message=event.message||eventLabels[event.event]||event.event;
  if(!/[\u3400-\u9fff]/.test(message))return message;
  const error=event.error_type||message.match(/\b[A-Za-z]\w*(?:Error|Exception)\b/)?.[0];
  return `${eventLabels[event.event]||'Recorded event'}${error?` · ${error}`:''}`;
}
function openMetricDialog(kind){
  text("metric-dialog-title",kind==="decision"?"Latest decision and reason":"Execution node details");
  $("decision-dialog-content").hidden=kind!=="decision";
  $("execution-dialog-content").hidden=kind!=="execution";
  $("metric-dialog").showModal();document.documentElement.classList.add("metric-dialog-open");
}
$("decision-details-open").onclick=()=>openMetricDialog("decision");
$("execution-details-open").onclick=()=>openMetricDialog("execution");
$("metric-dialog-close").setAttribute("aria-label","Close details");
$("metric-dialog-close").onclick=()=>$("metric-dialog").close();
$("metric-dialog").addEventListener("close",()=>document.documentElement.classList.remove("metric-dialog-open"));
$("metric-dialog").addEventListener("click",event=>{if(event.target===$("metric-dialog"))$("metric-dialog").close();});
function openNodeDialog(kind,id){
  nodeDialogView=null;if(replayMode)Replay.detailTicket++;
  text('node-dialog-title','Node details');
  mode=kind;selectedNode=id;autoNode=false;highlight();
  $("node-dialog").dataset.context=JSON.stringify([snapshot?.experiment,snapshot?.task,snapshot?.run_id,kind,kind==="child"?selectedChild:null,id]);
  $("node-dialog").showModal();document.documentElement.classList.add("node-dialog-open");renderDetails();
}
function recordedNodeView(data,id){
  if(data?.main?.graph.nodes.some(node=>node.id===id))return {kind:'main',view:data.main,childId:null};
  const child=Object.entries(data?.children||{}).find(([,view])=>view?.graph.nodes.some(node=>node.id===id));
  return child?{kind:'child',view:child[1],childId:child[0]}:null;
}
function openRecordedNodeDialog(data,id,returnFocus){
  const found=recordedNodeView(data,id);if(!found)throw new Error(`Node not found in recorded data: ${id}`);
  const context=JSON.stringify(['recorded',data.experiment,data.task,data.run_id,data.historical_time,found.kind,found.childId,id]);
  nodeDialogView={snapshot:data,nodeId:id,context,view:found.view,returnFocus};
  text('node-dialog-title',`Node details · ${data.task}`);$("node-dialog").dataset.context=context;
  $("node-dialog").showModal();document.documentElement.classList.add('node-dialog-open');renderDetails();
}
$("node-dialog-close").setAttribute("aria-label","Close Node details");
$("node-dialog-close").onclick=()=>$("node-dialog").close();
$("node-dialog").addEventListener("close",()=>{
  if($("node-dialog").open)return;
  document.documentElement.classList.remove("node-dialog-open");
  if(nodeDialogView){const target=nodeDialogView.returnFocus;nodeDialogView=null;if(target?.isConnected)target.focus({preventScroll:true});return;}
  const node=[...panelElement(mode,"graph-canvas").querySelectorAll("g.node")].find(node=>node.dataset.nodeId===selectedNode);
  node?.focus({preventScroll:true});
});
$("node-dialog").addEventListener("click",event=>{if(event.target===$("node-dialog"))$("node-dialog").close();});
function element(tag,content,className){const node=document.createElement(tag);if(content!==undefined)node.textContent=content;if(className)node.className=className;return node;}
function empty(container,title,description){container.replaceChildren();const box=element("div",undefined,"empty-state");box.append(element("span","◇","empty-symbol"),element("strong",title));if(description)box.append(element("p",description));container.append(box);}
function elapsed(timestamp,end=Date.now()){if(!timestamp)return "—";let seconds=Math.max(0,Math.floor((end-new Date(timestamp).getTime())/1000));if(!Number.isFinite(seconds))return "—";return seconds>=3600?`${Math.floor(seconds/3600)}h ${Math.floor(seconds%3600/60)}m` : seconds>=60?`${Math.floor(seconds/60)}m ${seconds%60}s`:`${seconds}s`;}
function time(value){return value?new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Taipei",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(new Date(value)):"—";}
function connection(live,message){$("connection-dot").classList.toggle("live",live);text("connection",message);}
function notice(message,info=false){$("notice").hidden=!message;$("notice").textContent=message||"";$("notice").classList.toggle("info",info);}
function query(){return new URLSearchParams({experiment:$("experiment").value,task:$("task").value});}
async function request(url){if(window.ReplayDataSource)return window.ReplayDataSource.request(url);const response=await fetch(url,{cache:"no-store"});if(!response.ok)throw new Error(`Failed to load data (${response.status})`);return response.json();}
function currentView(){return mode==="main"?snapshot?.main:snapshot?.children[selectedChild];}
async function loadExperiments(preserve=true){
  if(!replayMode)return;
  try{
    const list=await request("/api/experiments");const previous=$("experiment").value;
    const choice=preserve&&list.some(item=>item.id===previous)?previous:(list[0]?.id||"");
    $("experiment").replaceChildren(...list.map(item=>{const option=element("option",item.id);option.value=item.id;return option;}));$("experiment").value=choice;
    if(!choice){connection(false,"Waiting for experiment data");notice("No recorded experiments are available. Start an experiment from the execution page.",true);return;}
    const tasks=list.find(item=>item.id===choice).tasks;const previousTask=$("task").value;
    $("task").replaceChildren(...tasks.map(task=>{const option=element("option",task);option.value=task;return option;}));$("task").value=tasks.includes(previousTask)?previousTask:tasks[0];
    if(!stream||choice!==previous)connect();
  }catch(error){connection(false,"Service unavailable");notice(error.message);}
}
function resetMonitor(){
  ++streamVersion;stream?.close();stream=null;snapshot=null;
  for(const id of ["node-dialog","metric-dialog"])if($(id).open)$(id).close();
  for(const kind of ["main","child"]){
    const panel=graphPanels[kind];DAGMotion.stop(panelElement(kind,"graph-canvas"));DAGMotion.stop(panelElement(kind,"graph-scroll"));
    panel.ticket=(panel.ticket||0)+1;Object.assign(panel,{source:null,layout:null,current:null,graph:null,zoom:1,displaySize:null,zoomGoal:null,viewMode:"follow"});
    panelElement(kind,"graph-canvas").replaceChildren();panelElement(kind,"graph-count").textContent="0 nodes · 0 edges";
  }
  mode="main";selectedNode=null;selectedChild=null;autoNode=true;artifactCache.clear();
  $("events").replaceChildren();delete $("events").dataset.source;$("node-detail").replaceChildren();$("child-select").replaceChildren();notice(null);
  for(const id of ["run-status","run-elapsed","agent","phase","active-node","parent-node","execution-attempt","output-repair-count","replan-count","decision-label","decision-reason","execution-budget","execution-node","generation-attempt","total-repairs","policy-correction-content","wait-clock"])text(id,"");
  for(const id of ["event-count","child-count"])text(id,"0");
  $("stop-review-content").replaceChildren();$("policy-correction").hidden=true;$("stop-review").hidden=true;
  document.querySelectorAll("#pipeline-steps .current").forEach(node=>node.classList.remove("current"));
}
function activateLiveJob(job){
  const previous=liveJob,changed=previous?.id!==job.id;
  const selected=$("task").value,follow=!selected||selected===previous?.current_task;
  if(changed)resetMonitor();
  liveJob=job;$("experiment").value=job.id;
  const tasks=job.tasks.map(task=>task.id),signature=JSON.stringify(tasks);
  if($("task").dataset.tasks!==signature){$("task").replaceChildren(...tasks.map(id=>{const option=element("option",id);option.value=id;return option;}));$("task").dataset.tasks=signature;}
  const preferred=job.current_task||job.tasks.find(task=>task.status==="running")?.id||tasks[0]||"";
  $("task").value=!changed&&!follow&&tasks.includes(selected)?selected:preferred;
  if(!liveTransitionPending){document.body.classList.remove("workspace-idle");$("live-selectors").hidden=false;$("live-monitor").hidden=false;}
  $("finished-experiment").hidden=true;
  if(changed||selected!==$("task").value||!stream){renderGraph();connect();}
}
function clearLiveMonitor(){
  const previous=liveJob;
  if(previous){resetMonitor();liveJob=null;$("experiment").value="";$("task").replaceChildren();delete $("task").dataset.tasks;
    $("finished-replay-link").href=`/replay?${new URLSearchParams({experiment:previous.id,task:previous.current_task||previous.tasks[0]?.id||""})}`;
    $("finished-experiment").hidden=false;
  }
  $("live-monitor").hidden=true;$("live-selectors").hidden=true;connection(false,"Idle");
  document.body.classList.add("workspace-idle");
  const url=new URL(location.href);url.search="";history.replaceState(null,"",url);
}
function connect({run,orderScope}={}){
  if(!replayMode&&(!liveJob||$("experiment").value!==liveJob.id||!liveJob.tasks.some(task=>task.id===$("task").value)))return;
  resetMonitor();renderGraph();
  connection(false,"Synchronizing");const url=new URL(location.href);url.search=query();history.replaceState(null,"",url);
  if(replayMode)return Replay.load(run,{orderScope});
  const version=++streamVersion,source=new EventSource(`/api/stream?${query()}`);stream=source;
  source.onopen=()=>{if(version===streamVersion)connection(true,"Live connection");};
  source.onerror=()=>{if(version!==streamVersion)return;connection(false,"Connection lost, Reconnecting");document.querySelectorAll('.is-executing').forEach(node=>{node.classList.remove('is-executing');node.setAttribute('aria-busy','false');});};
  source.addEventListener("snapshot",event=>{
    if(version!==streamVersion||!liveJob)return;
    try{
      const next=JSON.parse(event.data);if(next.experiment!==$("experiment").value||next.task!==$("task").value)return;if(snapshot?.run_id!==next.run_id)artifactCache.clear();
      if(!selectedChild||(!$("node-dialog").open&&selectedChild===snapshot?.current_child)||!next.children[selectedChild])selectedChild=next.current_child;
      snapshot=next;connection(true,"Live connection");render();
    }catch(error){notice(`Unable to display monitoring data: ${error.message}`);}
  });
}
function render({focusGraphs=false,animateGraphs=true,cameraDuration=420}={}){
  text("run-status",taskStatusLabel(snapshot.status));
  $("run-status").style.color=taskFailureStatuses.has(snapshot.status)?"var(--red)":["blocked","unresolved","attempts_exhausted"].includes(snapshot.status)?"var(--orange)":snapshot.status==="running"?"var(--accent)":"var(--text)";
  const phaseEvent=[...snapshot.events].reverse().find(event=>event.agent&&event.phase)||{};
  const activeGraph=(phaseEvent.agent==="Planner"?snapshot.main?.graph:snapshot.children[snapshot.current_child]?.graph)||snapshot.main?.graph;
  const nodeId=phaseEvent.phase==="generate_subgraph"?null:phaseEvent.node_id||activeGraph?.current_node_id;
  const parent=phaseEvent.parent_node_id||activeGraph?.parent_node_id||snapshot.main?.graph.current_node_id;
  text("agent",phaseEvent.agent||(snapshot.error?"Planner":"—"));
  text("phase",snapshot.waiting_llm?"Waiting for LLM response":phases[phaseEvent.phase]||phaseEvent.phase||"Showing the last saved snapshot");
  text("active-node",nodeId);$("active-node").title=nodeId||"";text("parent-node",`Parent Node: ${parent||"—"}`);
  $("parent-node").hidden=!parent||parent===nodeId;
  const counters=snapshot.counters||{},execution=counters.execution;
  text("execution-attempt",execution?.node_id?`${execution.attempt} times${execution.in_flight?" · Running":""}`:"—");
  text("execution-budget",execution?.node_id?`Limit ${execution.limit} times · Remaining ${execution.retries_remaining} retries`:"No execution step selected");
  $("execution-budget").title="This is an upper limit, not a required retry count; Choose another method if prerequisites are unavailable, Gather further evidence when findings are inconclusive.";
  text("execution-node",execution?.node_id?`Node: ${execution.node_id}`:"");
  text("output-repair-count",snapshot.generation.attempt?`${counters.output_repairs??0} / ${counters.output_repair_limit??0}`:"—");
  text("generation-attempt",snapshot.generation.attempt?`${snapshot.generation.agent||"LLM"} · Attempt ${snapshot.generation.attempt} generation`:"No generation records");
  text("total-repairs",`Total repairs ${counters.total_output_repairs??0} times`);
  text("replan-count",`${counters.replans??0} times`);
  const decision=counters.last_decision||{},decisionNames={advance:"Advance",retry:"Retry",replan:"Replan",unresolved:"Retain uncertainty",escalate:"Escalate to main Planner assessment",verified_complete:"Task success verified"};
  const kindNames={none:"",transient:"Transient issue",method_unavailable:"Method prerequisites unavailable",inconclusive:"Insufficient evidence",missing_input:"Required input missing",out_of_scope:"Outside task scope"};
  text("decision-label",decision.decision?`${decisionNames[decision.decision]||decision.decision}${kindNames[decision.failure_kind]?" · "+kindNames[decision.failure_kind]:""}`:"—");
  text("decision-reason",decision.message||decision.evidence||snapshot.main?.graph.stop_reason||"No assessment result");
  $("policy-correction").hidden=!snapshot.policy_correction;text("policy-correction-content",snapshot.policy_correction?JSON.stringify(snapshot.policy_correction,null,4):"");
  const review=decision.stop_review||snapshot.main?.graph.stop_review;
  $("stop-review").hidden=!review&&!decision.policy_review_incomplete;
  const reviewBox=$("stop-review-content");reviewBox.replaceChildren();
  if(review){detailText(reviewBox,"Stop reason",review.reason);for(const alternative of review.alternatives||[])detailText(reviewBox,alternative.method,`${{available:"Available",needs_evidence:"More evidence needed",ruled_out:"Ruled out by evidence"}[alternative.status]||alternative.status}: ${alternative.reason}`);if(review.missing_inputs?.length)detailText(reviewBox,"Missing required inputs",review.missing_inputs.join("\n"));}
  else if(decision.policy_review_incomplete)detailText(reviewBox,"Review incomplete","The model did not provide a valid continue / stop decision within the output repair limit, retaining unresolved; this does not establish that every method failed.");
  document.querySelectorAll("#pipeline-steps b").forEach(node=>node.classList.toggle("current",snapshot.status==="running"&&(phaseEvent.phase==="assess"?node.dataset.phase==="assess":node.dataset.agent===phaseEvent.agent)));
  if(snapshot.error)notice(`${snapshot.error.stage||snapshot.status}: ${snapshot.error.message||"Run interrupted"}`);
  else if(!snapshot.has_events)notice("This experiment has no live events, showing its last saved graph and execution history.new runs record live progress automatically.",true);
  else notice(null);
  if(snapshot.replay_warning)notice(snapshot.replay_warning,true);
  text("child-count",Object.keys(snapshot.children).length);
  $("child-select").replaceChildren(...Object.keys(snapshot.children).map(id=>{const option=element("option",id);option.value=id;return option;}));$("child-select").value=selectedChild||"";
  renderClock();const drawing=renderGraph({forceFocus:focusGraphs,animate:animateGraphs,cameraDuration});renderDetails();renderEvents();broadcastGraphWindows();return drawing;
}
function renderClock(){if(!snapshot)return;const end=snapshot.replay?new Date(snapshot.historical_time||snapshot.latest.timestamp||snapshot.started_at).getTime():snapshot.status==="running"?Date.now():new Date(snapshot.latest.timestamp||snapshot.started_at).getTime();const stage=[...snapshot.events].reverse().find(event=>event.event==="stage.started");text("run-elapsed",snapshot.started_at?`${snapshot.replay?"Elapsed at this point":"Run duration"} ${elapsed(snapshot.started_at,end)}`:"Saved execution history");text("wait-clock",snapshot.waiting_llm?`◌ Waiting for LLM · ${elapsed(snapshot.waiting_llm.timestamp,end)} · ${snapshot.waiting_llm.model}`:snapshot.status==="running"?`● ${phases[stage?.phase]||"Running"} · ${elapsed(stage?.timestamp,end)}`:"—");}
function panelElement(kind,name){return $((kind==="main"?"":"child-")+name);}
function sizePanel(kind){const panel=graphPanels[kind],svg=panelElement(kind,"graph-canvas").querySelector("svg");if(!svg||!panel.layout)return;const size=panel.displaySize||panel.layout;svg.style.width=`${size.width*panel.zoom}px`;svg.style.height=`${size.height*panel.zoom}px`;panelElement(kind,"zoom-level").textContent=`${Math.round(panel.zoom*1000)/10}%`;panelElement(kind,"zoom-fit").setAttribute("aria-pressed",String(panel.viewMode==="fit"));panelElement(kind,"zoom-focus").setAttribute("aria-pressed",String(panel.viewMode==="follow"));}
function centerPanel(kind,bounds){const panel=graphPanels[kind],scroll=panelElement(kind,"graph-scroll");scroll.scrollLeft=24+(bounds.x+bounds.width/2)*panel.zoom-scroll.clientWidth/2;scroll.scrollTop=24+(bounds.y+bounds.height/2)*panel.zoom-scroll.clientHeight/2;}
function movePanelView(kind,target,{animate=false,from,duration=420,retainZoomGoal=false}={}){
  const panel=graphPanels[kind],scroll=panelElement(kind,"graph-scroll");
  panel.cameraTicket=(panel.cameraTicket||0)+1;
  if(!retainZoomGoal)panel.zoomGoal=null;
  const start=from||{zoom:panel.zoom,left:scroll.scrollLeft,top:scroll.scrollTop};
  const apply=t=>{panel.zoom=start.zoom+(target.zoom-start.zoom)*t;sizePanel(kind);scroll.scrollLeft=start.left+(target.left-start.left)*t;scroll.scrollTop=start.top+(target.top-start.top)*t;};
  if(animate)DAGMotion.tween(scroll,apply,()=>{panel.zoomGoal=null;},duration);else{DAGMotion.stop(scroll);apply(1);}
}
function zoomPanel(kind,factor,anchor){
  const panel=graphPanels[kind],scroll=panelElement(kind,"graph-scroll");
  if(!panel.layout)return;
  panel.viewMode="manual";
  panel.cameraTicket=(panel.cameraTicket||0)+1;
  DAGMotion.stop(scroll);
  const point=anchor||{x:scroll.clientWidth/2,y:scroll.clientHeight/2};
  const graphX=(scroll.scrollLeft+point.x-24)/panel.zoom,graphY=(scroll.scrollTop+point.y-24)/panel.zoom;
  const zoom=Math.min(3,Math.max(.001,(panel.zoomGoal??panel.zoom)*factor));panel.zoomGoal=zoom;
  movePanelView(kind,{zoom,left:Math.max(0,24+graphX*zoom-point.x),top:Math.max(0,24+graphY*zoom-point.y)},{animate:true,duration:160,retainZoomGoal:true});
}
function focusTarget(kind){
  const panel=graphPanels[kind],graph=panel.graph;if(!panel.layout||!graph)return;
  const current=graph.current_node_id||graph.nodes.find(node=>node.status==="active")?.id||graph.nodes[0]?.id;
  const boxes=panel.layout.nodeBounds,currentBox=boxes[current];if(!currentBox)return;
  let bounds={...currentBox};
  if(kind==="main"){
    const incoming=graph.edges.filter(edge=>edge.to===current&&edge.status!=="rejected");
    const previous=incoming.find(edge=>edge.status==="selected")||incoming.find(edge=>graph.nodes.some(node=>node.id===edge.from&&(node.status==="completed"||node.visit_count>0)))||incoming[0];
    const box=boxes[previous?.from];if(box){const x=Math.min(bounds.x,box.x),y=Math.min(bounds.y,box.y);bounds={x,y,width:Math.max(bounds.x+bounds.width,box.x+box.width)-x,height:Math.max(bounds.y+bounds.height,box.y+box.height)-y};}
  }
  const scroll=panelElement(kind,"graph-scroll");
  const pairZoom=Math.min(1.35,(scroll.clientWidth-64)/bounds.width,(scroll.clientHeight-64)/bounds.height);
  // Preserve readable text even when branches make the full DAG very wide.
  const zoom=kind==="main"?Math.max(1,pairZoom):1.1;
  if(pairZoom<1||kind==="child")bounds={...currentBox};
  const left=Math.max(0,24+(bounds.x+bounds.width/2)*zoom-scroll.clientWidth/2);
  let top=Math.max(0,24+(bounds.y+bounds.height/2)*zoom-scroll.clientHeight/2);
  if(currentBox.height*zoom>scroll.clientHeight-48)top=currentBox.y*zoom;
  return {zoom,left,top};
}
function focusPanel(kind,options={}){graphPanels[kind].viewMode="follow";const target=focusTarget(kind);if(target)movePanelView(kind,target,options);}
function fitTarget(kind){const panel=graphPanels[kind];if(!panel.layout)return;const scroll=panelElement(kind,"graph-scroll"),zoom=Math.max(.001,Math.min(1,(scroll.clientWidth-48)/panel.layout.width,(scroll.clientHeight-48)/panel.layout.height));return {zoom,left:0,top:0};}
function fitPanel(kind){graphPanels[kind].viewMode="fit";const target=fitTarget(kind);if(target)movePanelView(kind,target,{animate:true});}
async function renderGraph({forceFocus=false,animate=true,cameraDuration=420}={}){
  await Promise.all(["main","child"].map(async kind=>{
    if(graphWindow&&kind!==document.body.dataset.graphKind)return;
    const panel=graphPanels[kind],graph=NativeDAG.presentationGraph(snapshot,kind==="main"?snapshot?.main:snapshot?.children[selectedChild]);
    panelElement(kind,"graph-count").textContent=graph?`${graph.nodes.length} nodes · ${graph.edges.length} edges${graph.task_evaluation?.status==='passed'?' · ✓ Task success verified':graph.display_ended?' · Run ended':''}`:"0 nodes · 0 edges";
    if(!graph){if(panel.source==='empty')return;panel.ticket=(panel.ticket||0)+1;DAGMotion.stop(panelElement(kind,"graph-canvas"));DAGMotion.stop(panelElement(kind,"graph-scroll"));panel.source='empty';panel.layout=null;panel.graph=null;panel.displaySize=null;empty(panelElement(kind,"graph-canvas"),kind==="main"?"Waiting for main DAG":"No child graph generated DAG","After generation and saving, the graph appears here automatically.");UIMotion.enter(panelElement(kind,"graph-canvas").firstChild);return;}
    const nodeWidth=Math.max(220,Math.min(420,panelElement(kind,"graph-scroll").clientWidth-80));
    const source=JSON.stringify([graph,nodeWidth]),current=graph.current_node_id;
    if(panel.source!==source){
      const reset=forceFocus||!panel.layout||panel.nodeWidth!==nodeWidth||panel.current!==current||panel.graph?.decomposition_id!==graph.decomposition_id;
      panel.source=source;
      const ticket=panel.ticket=(panel.ticket||0)+1;
      let result;
      try{
        result=await NativeDAG.draw(graph,id=>{
          if(replayMode&&!graphWindow)Replay.jumpToGraphNode(kind,id,kind==='child'?selectedChild:null);
          else openNodeDialog(kind,id);
        },{nodeWidth});
      }catch(error){
        if(panel.source===source&&panel.ticket===ticket){panel.source=null;empty(panelElement(kind,"graph-canvas"),"Unable to render DAG",error.message);}
        return;
      }
      if(panel.source!==source||panel.ticket!==ticket)return;
      const scroll=panelElement(kind,"graph-scroll"),from={zoom:panel.zoom,left:scroll.scrollLeft,top:scroll.scrollTop};
      DAGMotion.stop(scroll);Object.assign(panel,{source,layout:result,current,graph,nodeWidth});
      const cameraTicket=panel.cameraTicket=(panel.cameraTicket||0)+1,target=panel.viewMode==="fit"?fitTarget(kind):reset&&panel.viewMode!=="manual"?focusTarget(kind):null;
      DAGMotion.replace(panelElement(kind,"graph-canvas"),result.svg,{animate,onFrame:(size,t)=>{
        panel.displaySize=size;
        if(animate&&target&&panel.cameraTicket===cameraTicket)panel.zoom=from.zoom+(target.zoom-from.zoom)*t;
        sizePanel(kind);
        if(animate&&target&&panel.cameraTicket===cameraTicket){scroll.scrollLeft=from.left+(target.left-from.left)*t;scroll.scrollTop=from.top+(target.top-from.top)*t;}
      },onDone:()=>{panel.displaySize=null;sizePanel(kind);if(!animate&&target&&panel.cameraTicket===cameraTicket)movePanelView(kind,target,{animate:true,duration:cameraDuration});}});
    }else if(forceFocus){const target=panel.viewMode==="fit"?fitTarget(kind):panel.viewMode==="follow"?focusTarget(kind):null;if(target)movePanelView(kind,target,{animate:true,duration:cameraDuration});}
  }));
  if(autoNode||!currentView()?.graph.nodes.some(node=>node.id===selectedNode))selectedNode=currentView()?.graph.current_node_id||currentView()?.graph.nodes[0]?.id;
  highlight();updateRunningNodes();renderDetails();renderSelectedNodePanel();
}
function updateRunningNodes(){
  for(const kind of ["main","child"]){
    const graph=graphPanels[kind].graph;
    const running=snapshot?.status==="running"&&!graph?.terminal_status&&(kind==="main"||selectedChild===snapshot.current_child);
    for(const node of panelElement(kind,"graph-canvas").querySelectorAll('.native-node:not(.departing)')){
      const active=Boolean(running&&node.dataset.nodeId===graph?.current_node_id&&node.dataset.state==='current');
      node.classList.toggle('is-executing',active);node.setAttribute('aria-busy',String(active));
      if(active&&node.dataset.pulseTime){const pulse=node.querySelector('.node-running-ring')?.getAnimations()[0];if(pulse)pulse.currentTime=Number(node.dataset.pulseTime);delete node.dataset.pulseTime;}
    }
  }
}
function highlight(){for(const kind of ["main","child"])panelElement(kind,"graph-canvas").querySelectorAll("g.node").forEach(node=>node.classList.toggle("selected",mode===kind&&node.dataset.nodeId===selectedNode));}
function downloadPanel(kind){const panel=graphPanels[kind],source=panelElement(kind,"graph-canvas").querySelector("svg");if(!source)return;const copy=source.cloneNode(true);copy.style.width=`${panel.layout.width}px`;copy.style.height=`${panel.layout.height}px`;const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)],{type:"image/svg+xml;charset=utf-8"}));const link=element("a");link.href=url;link.download=`${snapshot.task}_${kind==="main"?"graph":selectedChild}.svg`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function detailText(container,label,value){if(value===null||value===undefined||value==="")return;container.append(element("span",label,"detail-label"),element("p",String(value),"detail-text"));}
function detailCode(container,title,content,open=false,openSet=new Set()){const box=element("details");box.open=open||openSet.has(title);box.append(element("summary",title),element("pre",content||" (No output) "));container.append(box);}
function renderDetails(){
  if(!$("node-dialog").open)return;
  const detailSnapshot=nodeDialogView?.snapshot||snapshot;
  const context=nodeDialogView?.context||JSON.stringify([snapshot?.experiment,snapshot?.task,snapshot?.run_id,mode,mode==="child"?selectedChild:null,selectedNode]);
  if($("node-dialog").dataset.context!==context){$("node-dialog").close();return;}
  const view=nodeDialogView?.view||currentView();const node=view?.graph.nodes.find(node=>node.id===(nodeDialogView?.nodeId||selectedNode));const container=$("node-detail");
  if(!node){$("node-dialog").close();return;}
  renderNodeDetail(container,detailSnapshot,view,node,context,$("node-status"));
}
function renderSelectedNodePanel(){
  if(!replayMode||graphWindow)return;
  const panel=$("selected-node-panel"),container=$("selected-node-detail"),view=currentView();
  const node=view?.graph?.nodes.find(item=>item.id===selectedNode);
  text("selected-node-heading",node?`${mode==="child"?"Child graph":"Main graph"} · ${node.id}`:"No node selected");
  const status=$("selected-node-status");
  if(node&&snapshot){const display=NativeDAG.nodeState(node,NativeDAG.presentationGraph(snapshot,view));status.textContent=display.label;status.className=`badge ${display.key}`;status.style.color=display.text;status.style.borderColor=display.stroke;}
  else{status.textContent="Not selected";status.className="badge";status.style.color="";status.style.borderColor="";}
  if(!panel.open)return;
  if(!node||!snapshot){delete container.dataset.source;container.replaceChildren(element("div","No displayable data at this point for Node.","empty-state"));return;}
  const context=JSON.stringify([snapshot.experiment,snapshot.task,snapshot.run_id,snapshot.historical_time,mode,selectedChild,node.id,"inline"]);
  renderNodeDetail(container,snapshot,view,node,context,status);
}
function renderNodeDetail(container,detailSnapshot,view,node,context,statusElement=null){
  const displayGraph=NativeDAG.presentationGraph(detailSnapshot,view),display=NativeDAG.nodeState(node,displayGraph);
  const detailSource=JSON.stringify([context,node,display,displayGraph.verified_completion,view.graph.domain_state?.[node.id],detailSnapshot.observations.filter(item=>item.node_id===node.id),detailSnapshot.events.filter(event=>event.event==='artifact.saved'&&event.node_id===node.id)]);
  if(container.dataset.source===detailSource&&container.children.length)return;
  container.dataset.source=detailSource;
  const sameNode=container.dataset.nodeId===node.id;const scrollTop=sameNode?container.scrollTop:0;
  const expanded=new Set(sameNode?[...container.querySelectorAll("details[open] summary")].map(item=>item.textContent):[]);container.dataset.nodeId=node.id;
  if(statusElement){statusElement.textContent=display.label;statusElement.className=`badge ${display.key}`;statusElement.style.color=display.text;statusElement.style.borderColor=display.stroke;}
  container.replaceChildren(element("p",node.id,"detail-id"));
  if(display.key==='verified')detailText(container,'Completion basis',`evaluator Verified Task Success; Evidence Node: ${displayGraph.verified_completion.evidence_node_id||node.id}`);
  if(node.status==='active'&&display.key!=='current')detailText(container,'Saved status',`Original Node status active; displayed according to finish or verification records as"${display.label}".`);
  const stats=element("div",undefined,"detail-stats");stats.append(element("span",`join=${node.join_mode||"all"}`,"badge"),element("span",`Executed ${node.visit_count||0} times`,"badge"));container.append(stats);
  detailText(container,"Domains",(view.graph.domain_state?.[node.id]||node.domains||[]).join(", ")||"general");
  const classification=NativeDAG.nodeType(node);
  detailText(container,"Node Type",`${classification.label} · ${classification.role}`);
  if(classification.workType)detailText(container,"Work type",classification.workType);
  if(node.terminal_status)detailText(container,"Terminal outcome",labels[node.resolved_outcome||node.terminal_status]||node.resolved_outcome||node.terminal_status);
  detailText(container,"Goal",node.goal);detailText(container,"Expected observation",node.expected_observation);detailText(container,"Success criteria",node.success_criteria);detailText(container,"Stop condition",node.stop_condition);
  const records=detailSnapshot.observations.filter(item=>item.node_id===node.id);const latest=records.at(-1);
  if(latest){detailText(container,"Latest execution",`${labels[latest.result.status]||latest.result.status} · exit=${latest.result.exit_code??"—"} · ${latest.result.duration_seconds??"—"}s`);detailCode(container,"Command",JSON.stringify(latest.result.command),false,expanded);detailCode(container,`stdout${latest.output_truncated?" (long output excerpted) ":""}`,latest.stdout,false,expanded);if(latest.stderr)detailCode(container,"stderr",latest.stderr,true,expanded);detailText(container,"Assessment result",latest.assessment.evidence);detailText(container,"Decision",latest.assessment.decision);if(records.length>1)detailCode(container,`Execution history · ${records.length} times`,JSON.stringify(records.map(item=>({iteration:item.iteration,attempt:item.attempt,status:item.result.status,decision:item.assessment.decision})),null,2),false,expanded);}
  container.scrollTop=scrollTop;
  const key=`${detailSnapshot.run_id||"legacy"}/${detailSnapshot.experiment}/${detailSnapshot.task}/${node.id}`;const artifactBox=element("div");container.append(artifactBox);
  const showArtifact=artifact=>{if(!artifactBox.isConnected)return;if(artifact.available){detailText(artifactBox,"Coder Method",artifact.reason);detailCode(artifactBox,artifact.filename?`Generate code · ${artifact.filename}`:"Generated action",artifact.content||JSON.stringify(artifact.argv,null,2),false,expanded);if(artifact.blocked_reason)detailText(artifactBox,"Blocked Reason",artifact.blocked_reason);}else detailText(artifactBox,"Coder Artifact","No artifact for this Node has been generated.");};
  if(detailSnapshot.replay&&!detailSnapshot.replay_warning){const artifact=detailSnapshot.artifacts?.[node.id];showArtifact({available:Boolean(artifact),...artifact});return;}
  const saved=detailSnapshot.events.some(event=>event.event==="artifact.saved"&&event.node_id===node.id);if(saved)artifactCache.delete(key);
  if(artifactCache.has(key))showArtifact(artifactCache.get(key));else request(`/api/artifact?${query()}&node=${encodeURIComponent(node.id)}`).then(artifact=>{artifactCache.set(key,artifact);showArtifact(artifact);}).catch(error=>detailText(artifactBox,"Artifact loading",error.message));
}
function renderEvents(){
  if(!snapshot)return;let events=snapshot.events;
  if(!events.length){events=snapshot.observations.map(item=>({event:"execution.completed",timestamp:item.observed_at,agent:"Executor",node_id:item.node_id,status:item.result.status,message:`${labels[item.result.status]||item.result.status} · ${item.result.duration_seconds??"—"}s`,command:item.result.command}));if(snapshot.error)events=[...events,{event:"run.finished",agent:"Planner",status:"failed",message:snapshot.error.message,phase:snapshot.error.stage}];}
  const filter=$("log-filter").value;const search=$("log-search").value.toLowerCase();text("event-count",`${events.length} events`);
  if(replayMode&&!graphWindow&&!$("activity-panel").open)return;
  events=events.filter(event=>(filter!=="errors"||event.event.includes("failed")||["failed","timed_out","blocked","error"].includes(event.status))&&(filter!=="execution"||event.event.startsWith("execution."))&&(!search||JSON.stringify(event).toLowerCase().includes(search)));
  const container=$("events"),signature=JSON.stringify(events);
  if(container.dataset.source===signature)return;
  const existing=new Map([...container.children].map(row=>[row.dataset.eventKey,row])),retained=new Set();
  const previouslyRendered=container.dataset.source!==undefined;
  container.dataset.source=signature;
  if(!events.length)container.replaceChildren();
  if(!events.length)container.append(element("div","No matching records.","log-empty"));
  for(const [index,event] of events.entries()){
    const key=event.id||JSON.stringify([event.timestamp,event.event,event.node_id,index]),encoded=JSON.stringify(event);
    retained.add(key);const previous=existing.get(key);
    if(previous?.dataset.source===encoded){if(container.children[index]!==previous)container.insertBefore(previous,container.children[index]||null);continue;}
    const warning=event.event==="validation.failed";const error=!warning&&(event.event.endsWith("failed")||["failed","timed_out","error","blocked"].includes(event.status));const row=element("div",undefined,`event ${warning?"warning":error?"error":""}`);const message=element("div",eventMessage(event),"event-message");if(event.node_id)message.append(element("small",event.node_id));const details=element("details");details.append(element("summary",`${eventLabels[event.event]||event.event}${event.attempt?` · ${event.attempt}/${event.max_attempts}`:""}`),element("pre",JSON.stringify(event,null,2)));message.append(details);row.append(element("span",time(event.timestamp),"event-time"),element("span",warning?"↻":error?"!":"·","event-icon"),element("span",event.agent||"Framework","event-agent"),message);row.dataset.eventKey=key;row.dataset.source=encoded;
    if(previous)previous.replaceWith(row);
    if(container.children[index]!==row)container.insertBefore(row,container.children[index]||null);
    if(!previous&&previouslyRendered&&index>=events.length-6)UIMotion.enter(row);
  }
  for(const row of [...container.children])if(!retained.has(row.dataset.eventKey))row.remove();
}
function broadcastGraphWindows(){
  if(graphWindow||!snapshot)return;
  for(const [kind,viewer] of graphWindows){
    if(viewer.closed){graphWindows.delete(kind);continue;}
    viewer.postMessage({type:'graph.viewer.snapshot',kind,snapshot,childId:selectedChild},location.origin);
  }
}
function openGraphWindow(kind){
  if(graphWindow){
    const action=document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();
    action.catch(error=>notice(`Unable to enter fullscreen: ${error.message}`));return;
  }
  const existing=graphWindows.get(kind);
  if(existing&&!existing.closed){existing.focus();broadcastGraphWindows();return;}
  const url=window.ReplayDataSource?window.ReplayDataSource.pageURL():new URL('/replay',location.origin);url.searchParams.set('viewer','graph');url.searchParams.set('kind',kind);
  const viewer=window.open(url,'',`popup=yes,width=${screen.availWidth},height=${screen.availHeight},left=${screen.availLeft||0},top=${screen.availTop||0},resizable=yes,scrollbars=yes`);
  if(!viewer){notice('The browser blocked the new window, Allow popups for this site and try again.');return;}
  graphWindows.set(kind,viewer);
}
window.addEventListener('message',event=>{
  if(event.origin!==location.origin)return;
  if(!graphWindow){
    if(event.data?.type==='graph.viewer.ready'&&[...graphWindows.values()].includes(event.source))broadcastGraphWindows();
    return;
  }
  if(event.source!==window.opener)return;
  if(event.data?.type==='graph.viewer.closed'){
    document.title+=' · Source window closed';return;
  }
  if(event.data?.type!=='graph.viewer.snapshot'||event.data.kind!==document.body.dataset.graphKind)return;
  const data=event.data.snapshot;if(!data?.main&&!data?.children)return;
  const changed=graphWindowSource!==JSON.stringify([data.experiment,data.task,data.run_id]);
  if(changed){resetMonitor();graphWindowSource=JSON.stringify([data.experiment,data.task,data.run_id]);graphPanels[event.data.kind].viewMode='fit';}
  snapshot=data;selectedChild=event.data.childId||data.current_child;mode=event.data.kind;
  for(const [id,value] of [['experiment',data.experiment],['task',data.task]]){
    const option=element('option',value);option.value=value;$(id).replaceChildren(option);$(id).value=value;
  }
  document.title=`${mode==='main'?'Main graph':'Child graph'} · ${data.experiment} · ${data.task}`;
  render().catch(error=>notice(error.message));
});
window.addEventListener('beforeunload',()=>{if(!graphWindow)for(const viewer of graphWindows.values())if(!viewer.closed)viewer.postMessage({type:'graph.viewer.closed'},location.origin);});
if(replayMode)$("experiment").addEventListener("change",()=>loadExperiments(true).then(connect));$("task").addEventListener("change",connect);$("refresh").addEventListener("click",()=>replayMode?loadExperiments(true).then(connect):refreshJobs());
$("child-select").addEventListener("change",()=>{selectedChild=$("child-select").value;graphPanels.child.source=null;if(mode==="child"){selectedNode=null;autoNode=true;}renderGraph();renderDetails();broadcastGraphWindows();});
if(replayMode&&!graphWindow)$("selected-node-panel").addEventListener("toggle",renderSelectedNodePanel);
if(replayMode&&!graphWindow)$("activity-panel").addEventListener("toggle",()=>{if($("activity-panel").open)renderEvents();});
for(const kind of ["main","child"]){
  panelElement(kind,'window-expand').addEventListener('click',()=>openGraphWindow(kind));
  panelElement(kind,"zoom-fit").addEventListener("click",()=>fitPanel(kind));
  panelElement(kind,"zoom-focus").addEventListener("click",()=>focusPanel(kind,{animate:true}));
  for(const [button,factor] of [["zoom-in",1.25],["zoom-out",.8]])panelElement(kind,button).addEventListener("click",()=>zoomPanel(kind,factor));
  panelElement(kind,"graph-scroll").addEventListener("wheel",event=>{
    event.preventDefault();
    const scroll=panelElement(kind,"graph-scroll"),rect=scroll.getBoundingClientRect();
    const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?scroll.clientHeight:1);
    zoomPanel(kind,Math.exp(-Math.max(-160,Math.min(160,delta))*.002),{x:event.clientX-rect.left-scroll.clientLeft,y:event.clientY-rect.top-scroll.clientTop});
  },{passive:false});
  panelElement(kind,"download").addEventListener("click",()=>downloadPanel(kind));
}
$("log-search").addEventListener("input",renderEvents);$("log-filter").addEventListener("change",renderEvents);window.addEventListener("beforeunload",()=>stream?.close());setInterval(renderClock,1000);
let graphResizeTimer;
let graphViewportWidths=['main','child'].map(kind=>panelElement(kind,'graph-scroll').clientWidth);
window.addEventListener("resize",()=>{
  const widths=['main','child'].map(kind=>panelElement(kind,'graph-scroll').clientWidth);
  if(widths.every((width,index)=>width===graphViewportWidths[index]))return;
  graphViewportWidths=widths;
  clearTimeout(graphResizeTimer);
  graphResizeTimer=setTimeout(()=>renderGraph({forceFocus:true}),100);
});
if(replayMode&&!graphWindow){const initial=new URLSearchParams(location.search);loadExperiments(false).then(()=>{if(initial.get("experiment")&&[...$("experiment").options].some(option=>option.value===initial.get("experiment"))){$("experiment").value=initial.get("experiment");return loadExperiments(true).then(()=>{if([...$("task").options].some(option=>option.value===initial.get("task")))$("task").value=initial.get("task");connect();});}});}
if(graphWindow){
  mode=document.body.dataset.graphKind;graphPanels[mode].viewMode='fit';
  for(const kind of ['main','child']){panelElement(kind,'window-expand').textContent='Fullscreen';panelElement(kind,'window-expand').title='Toggle browser fullscreen';}
  document.addEventListener('fullscreenchange',()=>panelElement(mode,'window-expand').textContent=document.fullscreenElement?'Exit fullscreen':'Fullscreen');
  window.opener?.postMessage({type:'graph.viewer.ready'},location.origin);
  if(!window.opener)notice('Open this view using the main or child graph"New window"button.');
  const sourceCheck=setInterval(()=>{
    if(window.opener&&!window.opener.closed)return;
    clearInterval(sourceCheck);
    if(!document.title.includes('Source window closed'))document.title+=' · Source window closed';
  },1000);
}

// Let Safari perform single-finger scrolling and momentum; handle only graph pinch zoom.
function enableGraphTouch(kind){
  const scroll=panelElement(kind,'graph-scroll');
  let gesture=null,suppressClickUntil=0;
  const paint=()=>{
    const state=gesture;if(!state)return;
    state.frame=0;
    const panel=graphPanels[kind],rect=scroll.getBoundingClientRect();
    const x=state.clientX-rect.left-scroll.clientLeft,y=state.clientY-rect.top-scroll.clientTop;
    const graphX=(scroll.scrollLeft+x-24)/panel.zoom,graphY=(scroll.scrollTop+y-24)/panel.zoom;
    const zoom=Math.min(3,Math.max(.001,state.baseZoom*state.scale));
    const ratio=zoom/state.baseZoom;
    state.svg.style.transform=`scale(${ratio})`;
    state.canvas.style.width=`${48+state.width*ratio}px`;
    state.canvas.style.height=`${48+state.height*ratio}px`;
    panel.zoom=zoom;
    panelElement(kind,'zoom-level').textContent=`${Math.round(zoom*1000)/10}%`;
    scroll.scrollLeft=Math.max(0,24+graphX*zoom-x);scroll.scrollTop=Math.max(0,24+graphY*zoom-y);
  };
  const finish=()=>{
    if(!gesture)return;
    if(gesture.frame){cancelAnimationFrame(gesture.frame);paint();}
    const {svg,canvas}=gesture;
    gesture=null;
    svg.style.transform='';svg.style.transformOrigin='';svg.style.willChange='';
    canvas.style.width='';canvas.style.height='';
    sizePanel(kind);
  };
  scroll.addEventListener('gesturestart',event=>{
    if(!graphPanels[kind].layout)return;
    event.preventDefault();
    finish();suppressClickUntil=Date.now()+500;
    const panel=graphPanels[kind];DAGMotion.stop(scroll);panel.viewMode='manual';
    panel.cameraTicket=(panel.cameraTicket||0)+1;panel.zoomGoal=null;
    const canvas=panelElement(kind,'graph-canvas'),svg=canvas.querySelector('svg');
    if(!svg)return;
    svg.style.transformOrigin='0 0';svg.style.willChange='transform';
    gesture={svg,canvas,baseZoom:panel.zoom,width:svg.getBoundingClientRect().width,height:svg.getBoundingClientRect().height,scale:1,clientX:event.clientX,clientY:event.clientY,frame:0};
  },{passive:false});
  scroll.addEventListener('gesturechange',event=>{
    if(!gesture||!graphPanels[kind].layout)return;
    event.preventDefault();
    gesture.scale=event.scale||1;gesture.clientX=event.clientX;gesture.clientY=event.clientY;
    if(!gesture.frame)gesture.frame=requestAnimationFrame(paint);
    suppressClickUntil=Date.now()+500;
  },{passive:false});
  scroll.addEventListener('gestureend',event=>{event.preventDefault();finish();},{passive:false});
  scroll.addEventListener('click',event=>{
    if(Date.now()<suppressClickUntil){event.preventDefault();event.stopImmediatePropagation();}
  },true);
}
for(const kind of ['main','child'])enableGraphTouch(kind);

// Drag the background to pan. Nodes remain read-only execution definitions.
for(const kind of ["main","child"])panelElement(kind,"graph-scroll").addEventListener("pointerdown",event=>{
  if(event.button!==0||event.pointerType!=="mouse"||event.target.closest("g.node"))return;
  const scroll=panelElement(kind,"graph-scroll"),x=event.clientX,y=event.clientY,left=scroll.scrollLeft,top=scroll.scrollTop;
  DAGMotion.stop(scroll);
  graphPanels[kind].viewMode="manual";graphPanels[kind].cameraTicket=(graphPanels[kind].cameraTicket||0)+1;graphPanels[kind].zoomGoal=null;
  scroll.setPointerCapture(event.pointerId);scroll.classList.add("panning");
  const move=e=>{scroll.scrollLeft=left-(e.clientX-x);scroll.scrollTop=top-(e.clientY-y);};
  const end=()=>{scroll.classList.remove("panning");scroll.removeEventListener("pointermove",move);scroll.removeEventListener("pointerup",end);scroll.removeEventListener("pointercancel",end);};
  scroll.addEventListener("pointermove",move);scroll.addEventListener("pointerup",end);scroll.addEventListener("pointercancel",end);
});

Object.assign(labels,{paused:"Paused",pausing:"Waiting to pause",stopping:"Waiting to stop",cancelled:"Cancelled",starting:"Starting",queued:"Queued"});
Object.assign(labels,{attempts_exhausted:"Retries exhausted",out_of_scope:"Outside task scope",coder_generation_failed:"Code generation failed",coder_blocked:"Coder Unable to continue"});
eventLabels["run.paused"]="Paused";eventLabels["run.resumed"]="Resume execution";
