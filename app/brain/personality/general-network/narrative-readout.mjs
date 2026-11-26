// Explicit opt-in numeric extension for narrative (disclosure) readouts.
// It only appends typed recipes to a clone of the supplied catalog. It performs
// no psychological arithmetic, holds no default coefficients, reads no state,
// writes nothing, and has no file/network/process side effects.
//
// Scope is (subject, other, content). Every source value arrives through an
// input port; cross-scope inputs are admitted here and must be bound with
// evidence by the main composer. Unknown handling is left entirely to the
// existing native numeric kernel.

const SCOPE = ['subject', 'other', 'content'];

const TYPES = {
  relation_safety: [0, 1],
  narrative_insecurity: [0, 1],
  narrative_vulnerability: [0, 1],
  share_drive: [0, 1],
  shame_level: [0, 1],
  exposure_discomfort: [0, 1],
  guard_level: [0, 1],
  disclosure_depth: [0, 1],
  narrative_depth_raw: [-3, 2],
};

const stage = {
  M: 'activation_field',
  A: 'activation_field',
  R: 'activation_field',
  X: 'integration_commit',
};

const port = accepts => ({ accepts: [accepts], optional: false, allow_cross_scope: true });
const input = name => ({ input: name });
const stepRef = id => ({ step: id });
const parameter = name => ({ parameter: name });
const gain = () => ({ min: 0, max: 1 });
const signedGain = () => ({ min: -1, max: 0 });

function recipe({ id, mechanism, scope, inputs, parameters, parameter_constraints = [], steps, outputs, purpose, limitations }) {
  return {
    id,
    mechanism,
    stage: stage[mechanism.split('.')[0]],
    scope: [...scope],
    inputs,
    parameters,
    parameter_constraints,
    steps,
    outputs,
    purpose,
    limitations,
  };
}

export function createNarrativeCatalog(baseCatalog, {priorEstimate=false, activityChoice=false} = {}) {
  const catalog = structuredClone(baseCatalog);
  const interestPort = activityChoice
    ? {...port('familiar_drive'), accepts: ['familiar_drive', 'present_drive']}
    : port('familiar_drive');

  for (const [id, domain] of Object.entries(TYPES)) {
    catalog.types[id] = {unit: 'ratio', quantity: id, temporal_role: 'level', domain: [...domain]};
  }

  catalog.recipes.push(
    recipe({
      id: 'narrative_positive',
      mechanism: 'M.narrative',
      scope: SCOPE,
      inputs: {
        interest: interestPort,
        affiliation: port('affiliation_drive'),
        purpose: port('endorsed_reason'),
        affirmation: port('principle_importance'),
      },
      parameters: {
        interest_weight: gain(),
        affiliation_weight: gain(),
        purpose_weight: gain(),
        affirmation_weight: gain(),
      },
      parameter_constraints: [
        {kind: 'sum_max', keys: ['interest_weight', 'affiliation_weight', 'purpose_weight', 'affirmation_weight'], value: 1},
      ],
      steps: [
        {
          id: 'drive',
          op: 'weighted_sum',
          type: 'share_drive',
          inputs: [input('interest'), input('affiliation'), input('purpose'), input('affirmation')],
          params: {
            weights: [parameter('interest_weight'), parameter('affiliation_weight'), parameter('purpose_weight'), parameter('affirmation_weight')],
            bias: 0,
          },
        },
      ],
      outputs: {drive: 'drive'},
      purpose: 'Share motive aggregates four independently supplied sources (existing interest, affiliation motive, endorsed purpose, standard-based self-presentation) under explicit nonnegative weights.'
        + (activityChoice ? ' When the interest port admits both drives, each narrative object selects exactly one: present_drive is a supplied current attraction, not an established stable interest; the two are never summed or substituted.' : ''),
      limitations: [
        'Each source value and its applicability are supplied by the caller; this recipe does not infer them or fill missing values.',
        'The weighted sum is a motive aggregate of ratio levels, not one quantity-scale arithmetic.',
        'No default weights are embedded in the catalog.',
        ...(activityChoice ? ['The union interest port requires an explicit choice per narrative object; it does not fall back to or combine the other drive.'] : []),
      ],
    }),
    recipe({
      id: 'narrative_reservation',
      mechanism: 'A.narrative',
      scope: SCOPE,
      inputs: {
        devaluation: port('risk_salience'),
        vulnerability: port('narrative_vulnerability'),
      },
      parameters: {
        shame_sensitivity: gain(),
        exposure_sensitivity: gain(),
      },
      steps: [
        {
          id: 'shame',
          op: 'weighted_sum',
          type: 'shame_level',
          inputs: [input('devaluation')],
          params: {weights: [parameter('shame_sensitivity')], bias: 0},
        },
        {
          id: 'discomfort',
          op: 'weighted_sum',
          type: 'exposure_discomfort',
          inputs: [input('vulnerability')],
          params: {weights: [parameter('exposure_sensitivity')], bias: 0},
        },
      ],
      outputs: {shame: 'shame', discomfort: 'discomfort'},
      purpose: 'Expected social devaluation and self-exposure discomfort are read as two separate reservations; neither is netted against the other.',
      limitations: [
        'Devaluation and vulnerability are caller-supplied evidence, not computed from text here.',
        'Shame here is narrow (expected devaluation); it is not guilt or general negative affect.',
      ],
    }),
    recipe({
      id: 'narrative_insecurity',
      mechanism: 'R.safety',
      scope: SCOPE,
      inputs: {
        reference: port('relation_safety'),
        safety: port('relation_safety'),
      },
      parameters: {},
      steps: [
        {
          id: 'insecurity',
          op: 'positive_gap',
          type: 'narrative_insecurity',
          inputs: [input('reference'), input('safety')],
          params: {},
        },
      ],
      outputs: {insecurity: 'insecurity'},
      purpose: 'Insecurity is the shortfall between the declared reference level and the current relation safety value.',
      limitations: [
        'Both inputs are supplied; no baseline or reference value is embedded here.',
        'An unknown safety value remains unknown through the native kernel.',
      ],
    }),
    recipe({
      id: 'narrative_guard',
      mechanism: 'A.narrative',
      scope: SCOPE,
      inputs: {
        risk: port('risk_salience'),
        insecurity: port('narrative_insecurity'),
      },
      parameters: {
        risk_weight: gain(),
        insecurity_weight: gain(),
      },
      parameter_constraints: [{kind: 'sum_max', keys: ['risk_weight', 'insecurity_weight'], value: 1}],
      steps: [
        {
          id: 'guard',
          op: 'weighted_sum',
          type: 'guard_level',
          inputs: [input('risk'), input('insecurity')],
          params: {weights: [parameter('risk_weight'), parameter('insecurity_weight')], bias: 0},
        },
      ],
      outputs: {guard: 'guard'},
      purpose: 'Guard is an explicit combination of content risk and relation insecurity; the two weights are separately declared.',
      limitations: [
        'Content risk is an independent input, so non-private content may still carry a concrete risk.',
        'Guard is one reservation component, not a refusal or a global gate.',
      ],
    }),
    recipe({
      id: 'narrative_depth',
      mechanism: 'X.narrative',
      scope: SCOPE,
      inputs: {
        drive: port('share_drive'),
        shame: port('shame_level'),
        discomfort: port('exposure_discomfort'),
        guard: port('guard_level'),
      },
      parameters: {
        disclosure_baseline: gain(),
        drive_weight: gain(),
        shame_weight: signedGain(),
        discomfort_weight: signedGain(),
        guard_weight: signedGain(),
      },
      steps: [
        {
          id: 'raw',
          op: 'weighted_sum',
          type: 'narrative_depth_raw',
          inputs: [input('drive'), input('shame'), input('discomfort'), input('guard')],
          params: {
            weights: [parameter('drive_weight'), parameter('shame_weight'), parameter('discomfort_weight'), parameter('guard_weight')],
            bias: parameter('disclosure_baseline'),
          },
        },
        {
          id: 'depth',
          op: 'clamp',
          type: 'disclosure_depth',
          inputs: [stepRef('raw')],
          params: {lower: 0, upper: 1},
        },
      ],
      outputs: {depth: 'depth'},
      purpose: 'Willingness range combines the baseline with one positive drive term and three independent reservation terms, then clamps to the declared display range.',
      limitations: [
        'The baseline is an explicit character-level prior supplied by the caller, never a default in this catalog.',
        'The clamped depth is a willingness readout, not a reply form, length or decision.',
      ],
    }),
  );

  if (priorEstimate) {
    catalog.types.narrative_zero_prior={unit:'ratio',quantity:'narrative_zero_prior',temporal_role:'level',domain:[0,0]};
    for (const id of ['disclosure_prior','narrative_supported_drive','narrative_supported_guard','disclosure_estimate'])
      catalog.types[id]={unit:'ratio',quantity:id,temporal_role:'level',domain:[0,1]};
    catalog.types.narrative_estimate_raw={unit:'ratio',quantity:'narrative_estimate_raw',temporal_role:'level',domain:[-3,2]};
    const find=id=>catalog.recipes.find(r=>r.id===id);
    const positive=find('narrative_positive'),guard=find('narrative_guard'),depth=find('narrative_depth');
    const supported=(r,name,type,original)=>{
      r.steps.push({id:name,op:'prior_adjustment',type,
        inputs:[{constant:0,type:'narrative_zero_prior'},...structuredClone(original.inputs)],params:{weights:structuredClone(original.params.weights)}});
      r.outputs[name]=name;
      r.limitations.push('Supported evidence is an internal contribution, not a claim that unknown motivations or reservations are absent.');
    };
    supported(positive,'supported_drive','narrative_supported_drive',positive.steps[0]);
    supported(guard,'supported_guard','narrative_supported_guard',guard.steps[0]);
    Object.assign(depth.inputs,{prior:port('disclosure_prior'),supported_drive:port('narrative_supported_drive'),supported_guard:port('narrative_supported_guard')});
    depth.steps.push({id:'estimate_raw',op:'prior_adjustment',type:'narrative_estimate_raw',
      inputs:[input('prior'),input('supported_drive'),input('shame'),input('discomfort'),input('supported_guard')],
      params:{weights:[parameter('drive_weight'),parameter('shame_weight'),parameter('discomfort_weight'),parameter('guard_weight')]}},
      {id:'estimate',op:'clamp',type:'disclosure_estimate',inputs:[stepRef('estimate_raw')],params:{lower:0,upper:1}});
    depth.outputs.estimate='estimate';
    depth.limitations.push('The current tendency is an explicit prior plus known evidence under the original weights, without renormalization. Its evidence basis must accompany it.');
  }
  return catalog;
}
