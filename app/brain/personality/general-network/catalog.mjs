// Reviewed numeric field recipes. Records and whole mechanisms are not coerced to doubles.
const types={};
function type(id,quantity,{unit='ratio',role='level',domain=[0,1]}={}) {
  types[id]={unit,quantity,temporal_role:role,domain};return id;
}
for(const [id,quantity] of Object.entries({
  raw_novelty:'raw_novelty',comprehension:'comprehension',information_value:'information_value',
  familiar_interest:'activity_interest',intrinsic_appeal:'intrinsic_appeal',familiar_drive:'familiar_drive',
  present_drive:'present_drive',exploration_drive:'exploration_drive',
  outcome_attraction:'attraction',result_relevance:'result_relevance',outcome_desire:'outcome_desire',
  need_wanted:'need_level',need_satisfied:'need_level',need_importance:'need_importance',need_gap:'need_gap',need_pressure:'need_pressure',
  care_level:'care_level',other_need:'other_need',care_motive:'care_motive',help_opportunity:'help_opportunity',available_help:'available_help',
  connection_attraction:'connection_attraction',affiliation_drive:'affiliation_drive',relation_opportunity:'relation_opportunity',available_connection:'available_connection',
  risk_salience:'risk_salience',cost_salience:'cost_salience',avoidance_level:'avoidance_level',
  engagement_level:'engagement_level',satiation_level:'satiation_level',
  endorsed_reason:'endorsed_reason',external_pressure:'external_pressure',
  goal_relevance:'goal_relevance',interest_relevance:'interest_relevance',care_relevance:'care_relevance',concern_relevance:'concern_relevance',
  positive_consequence:'positive_consequence',negative_consequence:'negative_consequence',
  positive_affect:'positive_affect',negative_affect:'negative_affect',
  experienced_enjoyment:'experienced_enjoyment',mood_positive:'mood_positive',mood_negative:'mood_negative',
  applicability_gate:'applicability_gate',principle_importance:'principle_importance',norm_salience:'norm_salience',
  respect_level:'respect_level',cooperation_level:'cooperation_level',friction_level:'friction_level',
  control_capacity:'control_budget',control_cost:'control_budget',control_margin:'control_margin',strategy_fit:'strategy_fit',
  cue_match:'cue_match',habit_strength:'habit_strength',habit_tendency:'habit_tendency',
  attention_priority:'attention_priority',hard_availability:'hard_availability',
  goal_importance:'goal_importance',norm_support:'norm_support',norm_conflict:'norm_conflict',
  self_controllability:'self_controllability',self_responsibility:'self_responsibility',other_responsibility:'other_responsibility',
  engage_readiness:'engage_readiness',change_readiness:'change_readiness',boundary_readiness:'boundary_readiness',self_review_readiness:'self_review_readiness',
  residual_salience:'residual_salience'
}))type(id,quantity);
type('continuation_drive','continuation_drive',{domain:[-1,1]});
type('historical_probability','probability',{unit:'probability'});
type('current_feasibility','probability',{unit:'probability'});
type('probability_adjustment','probability_adjustment',{unit:'probability',role:'comparison',domain:[-1,1]});
type('probability_sum','probability_sum',{unit:'weighted_probability',role:'statistic',domain:[0,null]});
type('probability_mass','probability_mass',{unit:'sample_mass',role:'statistic',domain:[0,null]});
for(const id of ['goal_support','outcome_benefit','real_cost','goal_utility'])
  type(id,id,{unit:'value',domain:id==='real_cost'?[0,null]:[null,null]});
// A separate valuation for motive support avoids counting the same expected
// outcome benefit both here and in feasibility * benefit downstream.
type('motive_valuation','motive_valuation',{unit:'value',domain:[0,null]});
type('positive_observed_change','positive_affect',{role:'comparison',domain:[-1,1]});
type('negative_observed_change','negative_affect',{role:'comparison',domain:[-1,1]});
type('affect_impulse','affect_impulse',{role:'impulse',domain:[-1,1]});
type('affect_rate','affect_rate',{unit:'ratio_per_second',role:'rate',domain:[null,null]});
type('curve_response','curve_response');

const scopes={activity:['subject','activity'],goal:['subject','goal'],means:['subject','goal','means'],
  relation:['subject','other'],relationDimension:['subject','other','dimension'],
  episode:['subject','event','concern'],component:['subject','event','concern','component'],
  habit:['subject','habit'],focus:['subject','focus'],strategy:['subject','event','strategy']};
const recipes=[];
const stages={P:'snapshot',L:'snapshot',W:'encoding_appraisal',R:'activation_field',M:'activation_field',G:'activation_field',A:'activation_field',C:'dynamic_transformation',X:'integration_commit'};
const input=name=>({input:name});
const step=id=>({step:id});
const parameter=name=>({parameter:name});
const gain=()=>({min:0,max:1});
function port(accepts,{optional=false,allow_cross_scope=true}={}){
  return {accepts:Array.isArray(accepts)?accepts:[accepts],optional,allow_cross_scope};
}
function op(id,operator,out,inputs,params={}){return {id,op:operator,type:out,inputs,params};}
function identity(id,source,out){return op(id,'weighted_sum',out,[input(source)],{weights:[1],bias:0});}
function weighted(id,out,ports,weights){return op(id,'weighted_sum',out,ports.map(input),{weights,bias:0});}
function add(id,mechanism,scope,inputs,parameters,steps,outputs,purpose,extra={}){
  recipes.push({id,mechanism,stage:stages[mechanism.split('.')[0]],scope:scopes[scope],inputs,parameters,parameter_constraints:[],product_steps:[],steps,outputs,purpose,
    limitations:['数值配方仅覆盖具名字段；来源解释、记录与人物参数另有准入。','当前level不自动写入作用账本。'],...extra});
}

add('activity_interest','M.interest','activity',{
  familiar:port('familiar_interest',{optional:true}),present:port('intrinsic_appeal',{optional:true})
},{familiar_gain:gain(),present_gain:gain()},[
  weighted('familiar','familiar_drive',['familiar'],[parameter('familiar_gain')]),
  weighted('present','present_drive',['present'],[parameter('present_gain')])
],{familiar:'familiar',present:'present'},'已学兴趣和当下非信息性吸引分开；未知一项不阻塞另一项。');

add('exploration','M.exploration','activity',{
  novelty:port('raw_novelty'),comprehension:port('comprehension'),information:port('information_value')
},{gain:gain()},[
  op('opportunity','product','exploration_drive',[input('novelty'),input('comprehension'),input('information')]),
  op('drive','weighted_sum','exploration_drive',[step('opportunity')],{weights:[parameter('gain')],bias:0})
],{drive:'drive'},'新异本身不经倒U归零；可理解程度和信息价值显式约束探索。',{product_steps:['opportunity']});

add('outcome_desire','M.incentive','activity',{
  attraction:port('outcome_attraction'),relevance:port('result_relevance')
},{},[op('desire','desire','outcome_desire',[input('attraction'),input('relevance')])],{desire:'desire'},
'这一个结果的吸引×当下相关性；不是全部欲求，也不是人生价值或可行性的总门。');

add('need_components','M.needs','activity',{
  wanted:port('need_wanted'),satisfied:port('need_satisfied'),importance:port('need_importance')
},{},[
  identity('wanted','wanted','need_wanted'),identity('satisfied','satisfied','need_satisfied'),identity('importance','importance','need_importance'),
  op('gap','positive_gap','need_gap',[input('wanted'),input('satisfied')]),
  op('pressure','product','need_pressure',[step('gap'),input('importance')])
],{wanted:'wanted',satisfied:'satisfied',importance:'importance',gap:'gap',pressure:'pressure'},
'需要标准、当前满足、重要性和不足分别保留；gap为0不抹去满足程度。',{product_steps:['pressure']});
// Need identity is its own scope, not an activity even when discussed in an activity.
recipes.at(-1).scope=['subject','need'];

add('caring_motive','M.care','relation',{
  care:port('care_level'),need:port('other_need'),opportunity:port('help_opportunity',{optional:true})
},{},[
  op('urge','product','care_motive',[input('care'),input('need')]),
  op('available','product','available_help',[step('urge'),input('opportunity')])
],{urge:'urge',available:'available'},'关切动机和实际帮助机会分开；暂时不能帮助不取消关切。',{product_steps:['urge','available']});

add('affiliation_motive','M.care','relation',{
  attraction:port('connection_attraction'),shared_interest:port(['familiar_drive','present_drive','exploration_drive'],{optional:true}),
  opportunity:port('relation_opportunity',{optional:true})
},{social_weight:gain(),shared_weight:gain()},[
  weighted('social','affiliation_drive',['attraction'],[parameter('social_weight')]),
  weighted('shared','affiliation_drive',['shared_interest'],[parameter('shared_weight')]),
  op('available_social','product','available_connection',[step('social'),input('opportunity')]),
  op('available_shared','product','available_connection',[step('shared'),input('opportunity')])
],{social:'social',shared:'shared',available_social:'available_social',available_shared:'available_shared'},'共同活动与相处本身各有接近动机，不要求对方先遇到困难；缺少共同活动信息也不抹去单纯想相处。',
{product_steps:['available_social','available_shared']});

add('avoidance','M.avoidance','activity',{risk:port('risk_salience'),cost:port('cost_salience')},
  {risk_weight:gain(),cost_weight:gain()},[
    weighted('drive','avoidance_level',['risk','cost'],[parameter('risk_weight'),parameter('cost_weight')])
  ],{drive:'drive'},'同一活动的已支持风险显著性和成本显著性；不制造风险事件。',
  {parameter_constraints:[{kind:'sum_max',keys:['risk_weight','cost_weight'],value:1}]});

add('continuation','M.continuation','activity',{engagement:port('engagement_level'),satiation:port('satiation_level')},
  {engagement_weight:gain(),satiation_weight:{min:-1,max:0}},[
    weighted('drive','continuation_drive',['engagement','satiation'],[parameter('engagement_weight'),parameter('satiation_weight')]),
    identity('satiation','satiation','satiation_level')
  ],{drive:'drive',satiation:'satiation'},'持续倾向和饱足状态分开；这只是当前读出，不因调用一次增加饱足。');

add('adoption_components','G.adoption','goal',{
  endorsed:port('endorsed_reason'),pressure:port('external_pressure')
},{endorsed_gain:gain(),pressure_gain:gain()},[
  weighted('endorsed','endorsed_reason',['endorsed'],[parameter('endorsed_gain')]),
  weighted('pressure','external_pressure',['pressure'],[parameter('pressure_gain')])
],{endorsed:'endorsed',pressure:'pressure'},'认可目的与外来压力不合成一个自主值；也不自动采纳目标。');

add('motive_support','G.adoption','goal',{
  motive:port(['familiar_drive','present_drive','exploration_drive','outcome_desire','care_motive','affiliation_drive','need_pressure']),
  value:port(['motive_valuation','outcome_benefit'])
},{},[op('support','product','goal_support',[input('motive'),input('value')])],{support:'support'},
'显式关联的动机以这个目标的价值单位形成支持；不是把所有动机广播到所有目标。',{product_steps:['support']});

for(const [id,mechanism,scope] of [['goal_priority','G.priority','goal'],['means_value','G.means','means']])
  add(id,mechanism,scope,{support:port('goal_support'),feasibility:port('current_feasibility'),benefit:port('outcome_benefit'),cost:port('real_cost')},{},[
    op('utility','goal_value','goal_utility',[input('support'),input('feasibility'),input('benefit'),input('cost')])
  ],{utility:'utility'},'每目标／手段独立评价支持+当前可行性×收益−成本；负值不取消目标身份。');

for(const [id,mechanism,scope] of [['goal_experience','L.means','means'],['relation_experience','R.expectation','relationDimension']])
  add(id,mechanism,scope,{sum:port('probability_sum',{allow_cross_scope:false}),mass:port('probability_mass',{allow_cross_scope:false})},{},[
    op('estimate','probability_mean','historical_probability',[input('sum'),input('mass')])
  ],{history:'estimate'},'同一条件域的独立经验估计；不是当前可行性，也不替代所有关系维度。',
  {statistic_pairs:[{sum:'sum',mass:'mass'}]});

add('current_expectancy','G.expectancy','means',{
  history:port('historical_probability'),adjustment:port('probability_adjustment'),available:port('hard_availability')
},{},[
  identity('history','history','historical_probability'),
  op('current','feasibility','current_feasibility',[input('history'),input('adjustment'),input('available')])
],{history:'history',current:'current'},'历史经验保持；当前条件修正及确知硬阻碍只改变现在可行性，不补造失败样本。');

add('relevance_components','A.relevance','episode',{
  goal:port('goal_relevance',{optional:true}),interest:port('interest_relevance',{optional:true}),care:port('care_relevance',{optional:true})
},{},[
  identity('goal','goal','concern_relevance'),identity('interest','interest','concern_relevance'),identity('care','care','concern_relevance')
],{goal:'goal',interest:'interest',care:'care'},'不同依据分别保留；选取与该concern有据相关的一项，不用全局相关性总和。');

add('affect_components','A.emotions','episode',{
  relevance:port('concern_relevance'),positive:port('positive_consequence',{optional:true}),negative:port('negative_consequence',{optional:true})
},{},[
  op('positive','product','positive_affect',[input('relevance'),input('positive')]),
  op('negative','product','negative_affect',[input('relevance'),input('negative')])
],{positive:'positive',negative:'negative'},'同一事件—关切的两类评价分量；不净额抵消，不等于完整情绪分类器。',{product_steps:['positive','negative']});

add('norm_salience','A.norms','episode',{applicable:port('applicability_gate'),importance:port('principle_importance')},{},[
  op('salience','multiply_gate','norm_salience',[input('importance'),input('applicable')])
],{salience:'salience'},'已确认事件与具体原则的关联显著性；相关性门不等于关系亲密或软件权限。');

add('relation_components','R.stance','relation',{
  respect:port('respect_level',{optional:true}),cooperation:port('cooperation_level',{optional:true}),friction:port('friction_level',{optional:true})
},{},[
  identity('respect','respect','respect_level'),identity('cooperation','cooperation','cooperation_level'),identity('friction','friction','friction_level')
],{respect:'respect',cooperation:'cooperation',friction:'friction'},'关系分量的具名读取；没有新依据时不重复增加信任或关切。');

add('care_view','R.care','relation',{care:port('care_level')},{},[identity('care','care','care_level')],{care:'care'},
'读取关切权威状态；此视图不承担关切学习或修改。');

add('attention_priority','W.focus','focus',{
  goal:port('goal_relevance'),interest:port('interest_relevance'),care:port('care_relevance')
},{goal_weight:gain(),interest_weight:gain(),care_weight:gain()},[
  weighted('priority','attention_priority',['goal','interest','care'],[parameter('goal_weight'),parameter('interest_weight'),parameter('care_weight')])
],{priority:'priority'},'每个注意对象分别计算；不删除事实，未知分量不能偷填0。',
{parameter_constraints:[{kind:'sum_max',keys:['goal_weight','interest_weight','care_weight'],value:1}]});

add('habit_tendency','C.habit','habit',{strength:port('habit_strength'),cue:port('cue_match')},{},[
  op('tendency','multiply_gate','habit_tendency',[input('strength'),input('cue')])
],{tendency:'tendency'},'已学关联与当前线索匹配；不是从口头禅反推情绪。');

add('strategy_conditions','C.strategy','strategy',{
  capacity:port('control_capacity'),cost:port('control_cost'),applicable:port('applicability_gate')
},{},[
  op('margin','positive_gap','control_margin',[input('capacity'),input('cost')]),
  op('fit','multiply_gate','strategy_fit',[step('margin'),input('applicable')])
],{margin:'margin',fit:'fit'},'策略可用条件；分数不是已采用或已起效，也不直接修改情绪。');

for(const [id,level,change] of [['monitor_positive','positive_affect','positive_observed_change'],['monitor_negative','negative_affect','negative_observed_change']])
  add(id,'C.monitor','component',{before:port(level,{allow_cross_scope:false}),after:port(level,{allow_cross_scope:false})},{},[
    op('observed_change','difference',change,[input('after'),input('before')])
  ],{observed_change:'observed_change'},'只描述同一量的前后变化；不自动作为另一笔调节增量，不证明因果效果。');

const compositionStart=recipes.length;
add('stored_affect_salience','A.residual','episode',{
  positive:port(['positive_affect','experienced_enjoyment'],{allow_cross_scope:false}),negative:port('negative_affect',{allow_cross_scope:false})
},{positive_weight:gain(),negative_weight:gain()},[
  weighted('salience','residual_salience',['positive','negative'],[parameter('positive_weight'),parameter('negative_weight')])
],{salience:'salience'},
'读取同一事件—关切已有的正向感受或M享受引用与负向感受，以非负权重形成注意显著性；M来源不复制成A奖励，原分量分别保留，不相减、不另存余效，不等于生理唤醒或台词选择。',
{parameter_constraints:[{kind:'sum_max',keys:['positive_weight','negative_weight'],value:1}]});

add('sum_goal_support','G.adoption','goal',{
  left:port('goal_support',{allow_cross_scope:false}),right:port('goal_support',{allow_cross_scope:false})
},{},[weighted('total','goal_support',['left','right'],[1,1])],{total:'total'},
'同一完整目标实例的两项已换算支持相加；多项可树形组合，不跨目标归一化、不截成概率，也不重复纳入同一支持分量。');

const motiveInputs=['familiar_drive','present_drive','exploration_drive','outcome_desire','care_motive','affiliation_drive','need_pressure'];
for(const [id,portName,accepts,purpose] of [
  ['concern_from_goal','importance','goal_importance','目标本身的重要性通过明确事件—目标关联形成相关性；目标效用、成本与成功概率均不能冒充重要性。'],
  ['concern_from_motive','motive',motiveInputs,'已经激活的具名动机通过明确事件关联形成相关性；不是把所有动机或所有对象广播给该事件。'],
  ['concern_from_need_importance','importance','need_importance','需要的重要性与本次事件适用性相乘；已经满足也可高度相关，不用缺口替代重要性。'],
  ['concern_from_care','care','care_level','R的有对象关切通过明确事件—对象关联进入相关性；不要求对方先遇到困难，也不复制关切存量。'],
  ['concern_from_principle','importance','principle_importance','明确原则的重要性及本次适用性形成相关性；不推断事件究竟符合还是违背原则。'],
])add(id,'A.relevance','episode',{[portName]:port(accepts),applicable:port('applicability_gate')},{},[
  op('relevance','multiply_gate','concern_relevance',[input(portName),input('applicable')])
],{relevance:'relevance'},purpose);

add('enjoyment_reference','A.consequence','episode',{enjoyment:port('experienced_enjoyment')},{},[
  identity('enjoyment','enjoyment','experienced_enjoyment')
],{enjoyment:'enjoyment'},
'明确关联原M.enjoyment活动—事件实例，保持experienced_enjoyment身份只读引用；不是另一笔positive_affect奖励，也不能为缺失体验建立零值来源。');

add('norm_directions','A.norms','episode',{
  salience:port('norm_salience'),upheld:port('applicability_gate'),violated:port('applicability_gate')
},{},[
  op('support','multiply_gate','norm_support',[input('salience'),input('upheld')]),
  op('conflict','multiply_gate','norm_conflict',[input('salience'),input('violated')])
],{support:'support',conflict:'conflict'},
'规范的支持与冲突需要各自有据的方向门；salience本身没有正负方向，某门未知只影响对应分量，不相减抵消。');

add('action_preparation','A.readiness','episode',{
  positive:port('positive_affect'),negative:port('negative_affect'),
  norm_support:port('norm_support'),norm_conflict:port('norm_conflict'),
  self_control:port('self_controllability'),other_responsibility:port('other_responsibility'),self_responsibility:port('self_responsibility')
},{positive_weight:gain(),norm_weight:gain()},[
  weighted('engage','engage_readiness',['positive','norm_support'],[parameter('positive_weight'),parameter('norm_weight')]),
  op('change','product','change_readiness',[input('negative'),input('self_control')]),
  op('boundary','product','boundary_readiness',[input('norm_conflict'),input('other_responsibility')]),
  op('self_review','product','self_review_readiness',[input('norm_conflict'),input('self_responsibility')])
],{engage:'engage',change:'change',boundary:'boundary',self_review:'self_review'},
'参与和改变处境从相关性加权后的正负感受形成准备，不能由原始后果绕过关切相关性；规范支持、维护边界和自我复核分量独立保留。不是情绪标签、行动选择或台词，责任对象由已准入主体绑定给出，不默认当前用户。',
{parameter_constraints:[{kind:'sum_max',keys:['positive_weight','norm_weight'],value:1}],product_steps:['change','boundary','self_review']});

add('revised_attention','W.focus','focus',{
  concern:port('concern_relevance'),residual:port('residual_salience')
},{concern_weight:gain(),residual_weight:gain()},[
  weighted('priority','attention_priority',['concern','residual'],[parameter('concern_weight'),parameter('residual_weight')])
],{priority:'priority'},
'当前关切与具名事件余效显著性共同修订注意；显著性不等于正负净额，也不改事实。放在较后阶段，反馈给早期处理必须经过显式next_iteration。',
{stage:'dynamic_transformation',parameter_constraints:[{kind:'sum_max',keys:['concern_weight','residual_weight'],value:1}]});

for(const [id,level,change] of [['episode_monitor_positive','positive_affect','positive_observed_change'],['episode_monitor_negative','negative_affect','negative_observed_change']])
  add(id,'C.monitor','episode',{before:port(level,{allow_cross_scope:false}),after:port(level,{allow_cross_scope:false})},{},[
    op('observed_change','difference',change,[input('after'),input('before')])
  ],{observed_change:'observed_change'},
  '同一事件—关切、同一分量的真实before/after版本由宿主提供；只读差值保持comparison，不证明策略因果，不再写成一次调节impulse。');
for(const recipe of recipes.slice(compositionStart))recipe.limitations.push(
  '这是显式工程组合，不是已验证的心理科学定律或人物参数。',
  '事实、责任对象、前后版本和关联依据由上游准入；此配方不执行心理写回或选择具体表达。');

export const catalog={schema:'asuka.general-recipes/1',types,recipes,notes:[
  '字段值是模型内部的已准入输入，不是授权LLM输出连续心理分数。',
  '当前没有level→impulse或rate→impulse的自动转换；写回另经有据事件准入。',
  '同一类型的多实例保留完整键；非数值机制不通过虚假恒等算子凑覆盖率。',
  '所有参数由调用方显式给出；探针参数不是人物标定结果。'
]};
