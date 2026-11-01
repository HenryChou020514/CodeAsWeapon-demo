"use strict";
window.UIMotion = (() => {
  const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
  const easing='cubic-bezier(.22,1,.36,1)';
  const animations=new WeakMap();
  function cancel(node){animations.get(node)?.cancel();animations.delete(node);}
  async function animate(node,frames,{duration=300,...options}={}){
    cancel(node);
    if(reduced())return;
    const animation=node.animate(frames,{duration,easing,...options});animations.set(node,animation);
    try{await animation.finished;}catch{}
    if(animations.get(node)===animation)animations.delete(node);
  }
  function enter(node){return animate(node,[{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'none'}]);}
  return {reduced,easing,animate,enter,cancel};
})();
// Draw the saved DAG directly; ELK supplies obstacle-aware orthogonal routes.
window.NativeDAG = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const measure = document.createElement("canvas").getContext("2d");
  let sequence = 0;
  const engine = new ELK();
  const layouts=new Map();
  const palette = {
    current:{fill:"#332b1e",stroke:"#f5bd62",text:"#ffe2a9",label:"Current"},
    completed:{fill:"#15352e",stroke:"#4ecda5",text:"#a8f1d7",label:"Completed"},
    pending:{fill:"#182438",stroke:"#526682",text:"#c6d2e5",label:"Pending"},
    ready:{fill:"#1b3040",stroke:"#5b879e",text:"#bde0eb",label:"Ready"},
    skipped:{fill:"#17202d",stroke:"#465163",text:"#8f9eb2",label:"Skipped"},
    unresolved:{fill:"#3b2a21",stroke:"#ed9c65",text:"#ffd0a8",label:"Unresolved"},
    failed:{fill:"#3c2028",stroke:"#ef7b89",text:"#ffd0d6",label:"Failure"},
    waiting:{fill:"#1b3040",stroke:"#74a9db",text:"#c6e4ff",label:"Awaiting assessment / Retry"},
    stopped:{fill:"#3b2a21",stroke:"#ed9c65",text:"#ffd0a8",label:"Stopped, Incomplete"},
    unverified:{fill:"#1b3040",stroke:"#74a9db",text:"#c6e4ff",label:"Complete, Awaiting verification"},
    verified:{fill:"#15352e",stroke:"#4ecda5",text:"#a8f1d7",label:"Task success"},
  };
  const terminalLabels = {completed:"Complete",attempts_exhausted:"Retries exhausted",out_of_scope:"Out of scope",unresolved:"Insufficient evidence",blocked:"Missing input"};
  function svg(tag,attrs={},content){
    const node=document.createElementNS(NS,tag);
    for(const [key,value] of Object.entries(attrs))node.setAttribute(key,String(value));
    if(content!==undefined)node.textContent=content;
    return node;
  }
  function wrap(value,width,fontSize=18){
    measure.font=`500 ${fontSize}px Segoe UI,Microsoft JhengHei,sans-serif`;
    const words=String(value||"").replace(/\s+/g," ").trim().split(" "),lines=[];
    let line="";
    for(const word of words){
      if(!word)continue;
      if(line&&measure.measureText(line+" "+word).width<=width){line+=" "+word;continue;}
      if(line){lines.push(line);line="";}
      for(const character of word){
        if(line&&measure.measureText(line+character).width>width){lines.push(line);line="";}
        line+=character;
      }
    }
    if(line)lines.push(line);
    return lines;
  }
  function multiline(group,lines,x,y,attrs={},spacing=24){
    const label=svg("text",{x,y,...attrs});
    lines.forEach((line,index)=>label.append(svg("tspan",{x,dy:index?spacing:0},line)));
    group.append(label);
  }
  function state(node,graph){
    if(graph.task_evaluation?.status==='passed'&&graph.verified_completion?.node_id===node.id)return 'verified';
    const reached=node.status==='completed'||node.visit_count>0;
    const outcome=node.resolved_outcome||node.outcome||(reached?node.terminal_status:null);
    if(node.status==='failed'||node.status==='attempts_exhausted'||(reached&&['failed','attempts_exhausted'].includes(outcome)))return 'failed';
    if(reached&&['unresolved','blocked','out_of_scope'].includes(outcome))return 'unresolved';
    if(node.status==='completed')return node.terminal_status==='completed'&&graph.planning_level!=='low'&&graph.task_evaluation?.status!=='passed'?'unverified':'completed';
    if(node.status==='active')return graph.terminal_status||graph.scheduler_status==='ended'||graph.display_ended?'stopped':graph.display_paused?'waiting':'current';
    if(node.id===graph.current_node_id&&!graph.terminal_status&&!graph.display_ended&&!graph.display_paused&&!node.terminal_status&&['pending','ready'].includes(node.status))return 'current';
    if(["skipped","unresolved"].includes(node.status))return node.status;
    if(['blocked','out_of_scope'].includes(node.status))return 'unresolved';
    if(node.visit_count>0)return 'waiting';
    return node.status==="ready"?"ready":"pending";
  }
  function presentationGraph(data,view){
    const original=view?.graph;if(!original)return null;
    const graph={...original};
    graph.display_ended=['completed','failed','interrupted','blocked','unresolved','attempts_exhausted','out_of_scope'].includes(data.status);
    graph.display_paused=data.status==='paused';
    const evaluation=graph.task_evaluation||(graph.terminal_status==='completed'?data.evaluation:null);
    if(evaluation?.status==='passed'){
      graph.task_evaluation=evaluation;
      const evidenceId=evaluation.evidence?.node_id;
      const child=Object.values(data.children||{}).find(view=>view?.graph.nodes.some(node=>node.id===evidenceId));
      const id=graph.nodes.some(node=>node.id===evidenceId)?evidenceId:child?.graph.parent_node_id;
      if(!graph.verified_completion&&graph.nodes.some(node=>node.id===id))graph.verified_completion={node_id:id,evidence_node_id:evidenceId,source:'historical_evaluator'};
    }
    return graph;
  }
  function nodeState(node,graph){const key=state(node,graph);return {key,...palette[key]};}
  function nodeType(node){
    if(node.node_type==="terminal"||node.terminal_status)return {label:"Terminal",role:"terminal",workType:null};
    const workType=node.work_type||"execution";
    return {label:workType==="assessment"?"Evidence review":workType==="execution"?"Execution":workType,role:node.node_type||"step",workType};
  }
  async function draw(graph,onSelect,{nodeWidth=400}={}){
    const prefix=`dag-${++sequence}`;
    const nodeMap=new Map(graph.nodes.map((node,index)=>{
      const lines=wrap(node.goal||node.id,nodeWidth-40);
      return [node.id,{id:`node-${index}`,width:nodeWidth,height:96+lines.length*26,lines,ports:[],layoutOptions:{"elk.portConstraints":"FIXED_SIDE"}}];
    }));
    const inputEdges=graph.edges.map((edge,index)=>{
      const source=nodeMap.get(edge.from),target=nodeMap.get(edge.to);
      if(!source||!target)throw new Error(`Unknown edge endpoint: ${edge.id||index}`);
      const sourcePort=`out-${index}`,targetPort=`in-${index}`;
      source.ports.push({id:sourcePort,width:0,height:0,layoutOptions:{"elk.port.side":"SOUTH"}});
      target.ports.push({id:targetPort,width:0,height:0,layoutOptions:{"elk.port.side":"NORTH"}});
      const lines=wrap(edge.condition||"",Math.min(300,nodeWidth-40),15);
      const labelWidth=lines.length?Math.ceil(Math.max(...lines.map(line=>measure.measureText(line).width)))+20:0;
      return {id:`edge-${index}`,sources:[sourcePort],targets:[targetPort],
        labels:lines.length?[{id:`label-${index}`,text:lines.join("\n"),width:labelWidth,height:lines.length*23+16,layoutOptions:{"elk.edgeLabels.placement":"CENTER"}}]:[]};
    });
    const layoutInput={id:"root",children:[...nodeMap.values()].map(({lines,...node})=>node),edges:inputEdges,
      layoutOptions:{"elk.algorithm":"layered","elk.direction":"DOWN","elk.edgeRouting":"ORTHOGONAL",
        "elk.layered.mergeEdges":"false","elk.spacing.nodeNode":"64","elk.spacing.edgeNode":"24",
        "elk.spacing.edgeEdge":"20","elk.layered.spacing.nodeNodeBetweenLayers":"100",
        "elk.layered.spacing.edgeNodeBetweenLayers":"32","elk.layered.spacing.edgeEdgeBetweenLayers":"24",
        "elk.padding":"[top=32,left=32,bottom=32,right=32]"}};
    const layoutKey=JSON.stringify(layoutInput);
    let pendingLayout=layouts.get(layoutKey);
    if(!pendingLayout){
      pendingLayout=engine.layout(layoutInput);layouts.set(layoutKey,pendingLayout);
      if(layouts.size>8)layouts.delete(layouts.keys().next().value);
      pendingLayout.catch(()=>{if(layouts.get(layoutKey)===pendingLayout)layouts.delete(layoutKey);});
    }
    const dimensions=await pendingLayout;
    const positioned=new Map(dimensions.children.map(node=>[node.id,node]));
    const root=svg("svg",{xmlns:NS,viewBox:`0 0 ${dimensions.width} ${dimensions.height}`,width:dimensions.width,height:dimensions.height,role:"img","aria-label":"Live DAG",style:"font-family:Segoe UI,Microsoft JhengHei,sans-serif"});
    const defs=svg("defs");
    for(const [name,color] of Object.entries({pending:"#7186a3",selected:"#5cdbb1",rejected:"#465166"})){
      const marker=svg("marker",{id:`${prefix}-arrow-${name}`,viewBox:"0 0 10 10",refX:9,refY:5,markerWidth:7,markerHeight:7,orient:"auto-start-reverse"});
      marker.append(svg("path",{d:"M 0 0 L 10 5 L 0 10 z",fill:color}));defs.append(marker);
    }
    root.append(defs);
    const edges=svg("g",{class:"native-edges"});
    // Draw selected routes last; a narrow halo makes unavoidable crossings explicit.
    const routing=dimensions.edges.map(edge=>({...edge,index:Number(edge.id.slice(5))}));
    routing.sort((a,b)=>(graph.edges[a.index].status==="selected")-(graph.edges[b.index].status==="selected"));
    routing.forEach(route=>{
      const edge=graph.edges[route.index];
      const status=["selected","rejected"].includes(edge.status)?edge.status:"pending";
      const color=status==="selected"?"#5cdbb1":status==="rejected"?"#64738b":"#7186a3";
      const group=svg("g",{class:`native-edge ${status}`,"data-edge-id":edge.id||route.index});
      for(const section of route.sections||[]){
        const points=[section.startPoint,...(section.bendPoints||[]),section.endPoint];
        const d=points.map((point,index)=>`${index?"L":"M"} ${point.x} ${point.y}`).join(" ");
        group.append(svg("path",{class:"edge-halo",d,fill:"none",stroke:"#0e1522","stroke-width":7,"stroke-linejoin":"round"}));
        group.append(svg("path",{class:"edge-route",d,fill:"none",stroke:color,"stroke-width":status==="selected"?2.6:1.5,
          opacity:status==="rejected"?.7:1,"stroke-dasharray":status==="rejected"?"5 7":"none",
          "stroke-linejoin":"round","marker-end":`url(#${prefix}-arrow-${status})`}));
      }
      group.append(svg("title",{},`${edge.id||"Edge"}\n${edge.condition||""}\n${edge.status||"pending"}`));
      for(const label of route.labels||[]){
        const lines=label.text.split("\n");
        group.append(svg("rect",{class:"edge-label-background",x:label.x,y:label.y,width:label.width,height:label.height,rx:4,fill:"#0e1522"}));
        multiline(group,lines,label.x+label.width/2,label.y+23,{"text-anchor":"middle",fill:status==="selected"?"#a8e5d5":"#b5c4d8","font-size":15},23);
      }
      edges.append(group);
    });
    root.append(edges);
    graph.nodes.forEach((node,index)=>{
      const metadata=nodeMap.get(node.id),info={...positioned.get(metadata.id),lines:metadata.lines},type=state(node,graph),colors=palette[type];
      const group=svg("g",{class:"node native-node","data-node-id":node.id,"data-state":type,transform:`translate(${info.x},${info.y})`,tabindex:0,role:"button","aria-label":`${node.id}: ${node.goal} · ${colors.label}`});
      group.append(svg("title",{},`${node.id}\n${node.goal}\njoin=${node.join_mode||"all"} · ${node.visit_count||0} executions${node.terminal_status?"\n"+node.terminal_status:""}`));
      group.append(svg("rect",{class:"node-card",width:info.width,height:info.height,rx:12,fill:colors.fill,stroke:colors.stroke,"stroke-width":type==="current"?2.8:1.4,"stroke-dasharray":type==="skipped"?"5 5":"none"}));
      group.append(svg("rect",{class:"node-running-ring",x:-5,y:-5,width:info.width+10,height:info.height+10,rx:16,fill:"none",stroke:"#f5bd62","pointer-events":"none",opacity:0}));
      if(type==='verified')group.append(svg('rect',{class:'verified-ring',x:5,y:5,width:info.width-10,height:info.height-10,rx:8,fill:'none',stroke:colors.stroke,'stroke-width':1,'pointer-events':'none'}));
      group.append(svg("text",{x:20,y:30,fill:colors.text,"font-size":14,"font-weight":600},`NODE ${String(index+1).padStart(2,"0")}`));
      const reachedTerminal=type!=="skipped"&&node.terminal_status&&(node.status==="completed"||node.visit_count>0);
      const outcome=node.resolved_outcome||node.terminal_status;
      const status=['verified','unverified','stopped'].includes(type)?colors.label:reachedTerminal?(terminalLabels[outcome]||outcome):colors.label;
      group.append(svg("text",{x:info.width-20,y:30,"text-anchor":"end",fill:colors.text,"font-size":14,"font-weight":600},status));
      const classification=nodeType(node);
      group.dataset.nodeType=classification.role;group.dataset.workType=classification.workType||"";
      group.append(svg("text",{x:20,y:55,fill:colors.text,"font-size":14},classification.label));
      multiline(group,info.lines,20,91,{fill:type==="skipped"?"#b6c3d5":"#edf3fd","font-size":18,"font-weight":500},26);
      const select=()=>onSelect(node.id);
      group.addEventListener("click",select);
      group.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();select();}});
      root.append(group);
    });
    const nodeBounds=Object.fromEntries(graph.nodes.map(node=>{const box=positioned.get(nodeMap.get(node.id).id);return [node.id,{x:box.x,y:box.y,width:box.width,height:box.height}];}));
    return {svg:root,width:dimensions.width,height:dimensions.height,nodeBounds};
  }
  return {draw,nodeType,nodeState,presentationGraph};
})();
// Interpolate saved layout positions. New snapshots resume from the visible frame.
window.DAGMotion = (() => {
  const duration=520;
  const reduced=()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ease=t=>1-Math.pow(1-t,3);
  const mix=(a,b,t)=>a+(b-a)*t;
  const active=new WeakMap();
  function tween(owner,frame,done=()=>{},milliseconds=duration){
    active.get(owner)?.();
    if(reduced()){frame(1);done();return;}
    const start=performance.now();let id;
    const stop=()=>{cancelAnimationFrame(id);active.delete(owner);};
    active.set(owner,stop);
    const step=now=>{const t=Math.min(1,(now-start)/milliseconds);frame(ease(t));if(t<1)id=requestAnimationFrame(step);else{active.delete(owner);done();}};
    frame(0);id=requestAnimationFrame(step);
  }
  function stop(owner){active.get(owner)?.();}
  function position(group){const numbers=(group.getAttribute('transform')||'').match(/translate\(\s*([-\d.e]+)[ ,]+([-\d.e]+)/);return {x:Number(numbers?.[1]||0),y:Number(numbers?.[2]||0)};}
  function points(path){const length=path.getTotalLength();return Array.from({length:41},(_,i)=>{const p=path.getPointAtLength(length*i/40);return {x:p.x,y:p.y};});}
  function replace(canvas,next,{animate=true,onFrame=()=>{},onDone=()=>{}}={}){
    const previous=canvas.querySelector('svg');stop(canvas);
    const target={width:next.viewBox.baseVal.width,height:next.viewBox.baseVal.height};
    if(!animate||!previous||reduced()){canvas.replaceChildren(next);onFrame(target,1);onDone();if(!previous&&animate)UIMotion.enter(next);return;}
    const initial={width:previous.viewBox.baseVal.width,height:previous.viewBox.baseVal.height};
    const oldNodes=new Map([...previous.querySelectorAll('.native-node:not(.departing)')].map(n=>[n.dataset.nodeId,n]));
    const oldEdges=new Map([...previous.querySelectorAll('.native-edge:not(.departing)')].map(n=>[n.dataset.edgeId,n]));
    const frames=[],finalizers=[];
    for(const node of next.querySelectorAll('.native-node')){
      const old=oldNodes.get(node.dataset.nodeId),target=position(node);
      if(!old){frames.push(t=>node.setAttribute('opacity',String(t)));continue;}
      oldNodes.delete(node.dataset.nodeId);
      const pulse=old.querySelector('.node-running-ring')?.getAnimations()[0];
      if(pulse?.currentTime!=null)node.dataset.pulseTime=String(pulse.currentTime);
      const from=position(old),fromOpacity=Number(old.getAttribute('opacity')??1);
      frames.push(t=>{node.setAttribute('transform',`translate(${mix(from.x,target.x,t)},${mix(from.y,target.y,t)})`);node.setAttribute('opacity',String(mix(fromOpacity,1,t)));});
      const card=node.querySelector('.node-card'),oldCard=old.querySelector('.node-card');
      for(const key of ['width','height']){const start=Number(oldCard.getAttribute(key)),end=Number(card.getAttribute(key));frames.push(t=>card.setAttribute(key,String(mix(start,end,t))));}
      const oldFill=getComputedStyle(oldCard).fill;
      if(oldFill!==card.getAttribute('fill'))card.animate([{fill:oldFill},{fill:card.getAttribute('fill')}],{duration,easing:'ease-out'});
      const oldTexts=[...old.querySelectorAll('text:not(.motion-text-ghost)')],texts=[...node.querySelectorAll('text')];
      if(oldTexts.map(text=>text.textContent).join('\n')!==texts.map(text=>text.textContent).join('\n')){
        for(const text of texts)frames.push(t=>text.setAttribute('opacity',String(t)));
        for(const text of oldTexts){const ghost=text.cloneNode(true);ghost.classList.add('motion-text-ghost');node.append(ghost);frames.push(t=>ghost.setAttribute('opacity',String(1-t)));finalizers.push(()=>ghost.remove());}
      }
    }
    for(const old of oldNodes.values()){
      const ghost=old.cloneNode(true);ghost.classList.remove('is-executing');ghost.classList.add('departing');ghost.setAttribute('aria-hidden','true');ghost.setAttribute('tabindex','-1');ghost.style.pointerEvents='none';next.append(ghost);
      const opacity=Number(old.getAttribute('opacity')??1);frames.push(t=>ghost.setAttribute('opacity',String(opacity*(1-t))));finalizers.push(()=>ghost.remove());
    }
    for(const edge of next.querySelectorAll('.native-edge')){
      const old=oldEdges.get(edge.dataset.edgeId);
      if(!old){frames.push(t=>edge.setAttribute('opacity',String(t)));continue;}
      oldEdges.delete(edge.dataset.edgeId);
      const oldPaths=[...old.querySelectorAll('.edge-route')],newPaths=[...edge.querySelectorAll('.edge-route')],halos=[...edge.querySelectorAll('.edge-halo')];
      newPaths.forEach((path,index)=>{
        if(!oldPaths[index])return;
        if(oldPaths[index].getAttribute('d')===path.getAttribute('d'))return;
        const from=points(oldPaths[index]),to=points(path),final=path.getAttribute('d');
        frames.push(t=>{const d=from.map((p,i)=>`${i?'L':'M'} ${mix(p.x,to[i].x,t)} ${mix(p.y,to[i].y,t)}`).join(' ');path.setAttribute('d',d);halos[index]?.setAttribute('d',d);});
        finalizers.push(()=>{path.setAttribute('d',final);halos[index]?.setAttribute('d',final);});
      });
      const oldLabel=old.querySelector('.edge-label-background'),label=edge.querySelector('.edge-label-background');
      if(oldLabel&&label){const dx=Number(oldLabel.getAttribute('x'))-Number(label.getAttribute('x')),dy=Number(oldLabel.getAttribute('y'))-Number(label.getAttribute('y'));for(const text of [...edge.querySelectorAll('text'),label])frames.push(t=>text.setAttribute('transform',`translate(${dx*(1-t)},${dy*(1-t)})`));}
    }
    for(const old of oldEdges.values()){
      const ghost=old.cloneNode(true);ghost.style.pointerEvents='none';ghost.setAttribute('aria-hidden','true');ghost.classList.add('departing');next.querySelector('.native-edges').append(ghost);
      frames.push(t=>ghost.setAttribute('opacity',String(1-t)));finalizers.push(()=>ghost.remove());
    }
    // Match the currently visible geometry before swapping. This prevents the
    // browser from clamping scroll offsets to a smaller incoming SVG.
    next.setAttribute('viewBox',`0 0 ${initial.width} ${initial.height}`);
    next.style.width=previous.style.width;next.style.height=previous.style.height;
    frames.forEach(frame=>frame(0));canvas.replaceChildren(next);
    next.dataset.animating='true';
    tween(canvas,t=>{
      frames.forEach(frame=>frame(t));
      const size={width:mix(initial.width,target.width,t),height:mix(initial.height,target.height,t)};
      next.setAttribute('viewBox',`0 0 ${size.width} ${size.height}`);onFrame(size,t);
    },()=>{finalizers.forEach(f=>f());delete next.dataset.animating;onDone();});
  }
  return {replace,tween,stop,reduced};
})();
