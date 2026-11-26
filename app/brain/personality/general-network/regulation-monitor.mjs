// A pure comparison compiler. The host authenticates the selected snapshots,
// their order and deployment association; subtraction alone proves no cause.
import {catalog} from './catalog.mjs';
import {compileAssembly} from './assembly-compiler.mjs';

const clone=structuredClone,object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const need=(yes,code,path)=>{if(!yes)throw Object.assign(new Error(code),{code,path});};
function exact(x,keys,path){need(object(x),'REGULATION_MONITOR_OBJECT',path);need(keys.every(k=>Object.hasOwn(x,k))&&Object.keys(x).every(k=>keys.includes(k)),'REGULATION_MONITOR_FIELDS',path);}
function text(x,path){need(typeof x==='string'&&x.trim()&&!x.includes('\0'),'REGULATION_MONITOR_TEXT',path);return x;}
function signal(x,path){
  need(object(x)&&typeof x.known==='boolean','REGULATION_MONITOR_SIGNAL',path);
  exact(x,x.known?['known','value','sources']:['known','reason','sources'],path);
  need(Array.isArray(x.sources),'REGULATION_MONITOR_SOURCES',path+'.sources');
  x.sources.forEach((s,i)=>text(s,path+'.sources.'+i));
  need(new Set(x.sources).size===x.sources.length,'REGULATION_MONITOR_SOURCE_DUPLICATE',path+'.sources');
  if(x.known){
    need(typeof x.value==='number'&&Number.isFinite(x.value)&&x.value>=0&&x.value<=1,'REGULATION_MONITOR_DOMAIN',path+'.value');
    need(x.sources.length>0,'REGULATION_MONITOR_KNOWN_SOURCE_REQUIRED',path+'.sources');
  }else text(x.reason,path+'.reason');
  return clone(x);
}

/** Returns a typed native graph only. Unknown remains Unknown; existing values
 * are not reclassified as effects, and no success/failure verdict is inferred. */
export function compileRegulationMonitor(namespace,specs){
  exact(namespace,['character_version','conversation_id','world_id'],'namespace');
  Object.entries(namespace).forEach(([key,value])=>text(value,'namespace.'+key));
  need(Array.isArray(specs),'REGULATION_MONITOR_SPECS','specs');
  if(!specs.length)return {assembly:null,outputs:[]};
  const ids=new Set(),rows=[],instances=[];let subject;
  for(const [i,spec]of specs.entries()){
    const p='specs.'+i;exact(spec,['id','scope','component','before','after'],p);text(spec.id,p+'.id');
    need(!ids.has(spec.id),'REGULATION_MONITOR_ID_DUPLICATE',p+'.id');ids.add(spec.id);
    exact(spec.scope,['subject','event','concern'],p+'.scope');Object.entries(spec.scope).forEach(([key,value])=>text(value,p+'.scope.'+key));
    subject??=spec.scope.subject;need(spec.scope.subject===subject,'REGULATION_MONITOR_SUBJECT',p+'.scope.subject');
    need(['positive','negative'].includes(spec.component),'REGULATION_MONITOR_COMPONENT',p+'.component');
    const before=signal(spec.before,p+'.before'),after=signal(spec.after,p+'.after'),scope=clone(spec.scope),type=spec.component+'_affect';
    const instance=JSON.stringify(['regulation-monitor',spec.id]);
    instances.push({id:instance,recipe:'episode_monitor_'+spec.component,scope,parameters:{},inputs:{
      before:{type,scope:clone(scope),signal:before},after:{type,scope:clone(scope),signal:after}}});
    rows.push({id:spec.id,component:spec.component,instance});
  }
  const assembly=compileAssembly({namespace:clone(namespace),instances,bindings:[],state_fields:{}},catalog);
  const outputs=rows.map(row=>{
    const resolved=assembly.outputs.filter(o=>o.instance===row.instance&&o.field==='observed_change');
    need(resolved.length===1,'REGULATION_MONITOR_OUTPUT','assembly.outputs');
    return {id:row.id,component:row.component,...clone(resolved[0])};
  });
  return {assembly,outputs};
}
