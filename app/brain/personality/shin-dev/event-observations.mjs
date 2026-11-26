// Event identity is not occurrence identity: discussing an old act is not doing it again.
export const INTERACTION_FACT_RULES = [
  'incidents的reference指已知事件或new；occurrence=act表示当前又实际实施一次伤害（包括再次辱骂），occurrence=mention表示仅回忆、引用或讨论旧事。同一题材不等于同一次行为。描述当前行为，不替用户编造动机。',
  'signals的source=repeat表示仅重复已有表态或条件，不产生新输入；重复“尊重你”等话语不能自动累积信任。新行为产生新作用时才写new；修复的伴随作用必须写repair.0等来源。',
  'repairs的scope=specific表示当前原话或明确的紧邻上下文指向该事件；scope=unclear表示指向不明，不登记补救。不把一句笼统道歉自动扩展到多件旧事。承认、兑现承诺、原谅分别处理：道歉不是已完成行动，也不是已获原谅。',
  '继续说话、换话题、表达喜欢，不自动构成可靠关系支持、实际尊重边界或共同任务。可以记录表态，但支持信号需有对应的实际依据；具体兑现和允许拒绝可构成新的支持。',
  '暂停话题用suspend；只有对应限制或冲突条件确实解除才用end。为一件事道歉不能结束其他事情；不再谈不等于关系已修复。',
  '普通分歧、求助失败或失望不自动登记伤害。先前角色回复中的猜测不升级为客观事实；不因角色上轮拒绝，就将之后一切互动解释为恶意。',
];

export function recordIncident(event, record, sequence, index){
  const prior=event.reference!=='new'?record.incidents[event.reference]:null;
  if(event.reference!=='new'&&!prior)throw Error('引用了不存在的旧事');
  const occurrence=event.occurrence??(event.reference==='new'?'act':'mention');
  if(!['act','mention'].includes(occurrence))throw Error('无效事件发生类型');
  if(occurrence==='mention'){
    if(!prior){
      if(typeof event.description!=='string'||!event.description.trim()
        ||typeof event.evidence!=='string'||!event.evidence.trim())throw Error('未登记旧事的提及缺少描述或依据');
      // A newly reported past act is not a new act in this turn. Preserve it in
      // the mapping audit without inventing a ledger identity or repair target.
      return {id:null,inject:false,reason:'unregistered_past_mention'};
    }
    return {id:event.reference,inject:false};
  }
  if(!event.description?.trim())throw Error('新事件缺少具体描述');
  const id='harm.'+sequence+'.'+index;
  record.incidents[id]={id,description:event.description,created_turn:sequence,
    ...(prior?{related_incident_id:event.reference}:{}),occurrence:'act'};
  return {id,inject:true};
}
