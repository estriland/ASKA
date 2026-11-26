export const PERSONALITY_NETWORK_SCHEMA = "asuka.personality-network/v1";
export const PERSONALITY_CYCLE_CONTRACT = "asuka.personality-dynamics-cycle/v1";

export const PROCESSING_STAGES = Object.freeze([
  "encoding_appraisal",
  "activation_field",
  "dynamic_transformation",
  "integration_commit",
]);

export const STAGE_BUS_CONTRACTS = Object.freeze({
  encoding_appraisal: Object.freeze({
    accepts: Object.freeze(["semantic_binding", "recurrent_feedback", "persistent_state"]),
    instant_targets: Object.freeze([
      "encoding_appraisal", "activation_field",
      "dynamic_transformation", "integration_commit",
    ]),
  }),
  activation_field: Object.freeze({
    accepts: Object.freeze(["appraisal_signal", "peer_activation", "recurrent_feedback", "persistent_state"]),
    instant_targets: Object.freeze([
      "activation_field", "dynamic_transformation", "integration_commit",
    ]),
  }),
  dynamic_transformation: Object.freeze({
    accepts: Object.freeze(["activation_signal", "peer_transformation", "recurrent_feedback", "persistent_state"]),
    instant_targets: Object.freeze([
      "dynamic_transformation", "integration_commit",
    ]),
  }),
  integration_commit: Object.freeze({
    accepts: Object.freeze(["activation_signal", "transformation_result", "persistent_state"]),
    instant_targets: Object.freeze(["integration_commit"]),
  }),
});

export const ANALYSIS_LENSES = Object.freeze([
  "self_representation",
  "goals_needs_values",
  "appraisal_expectancy",
  "other_relationship_representation",
  "conflict_ambivalence",
  "protection_defense",
  "regulation_integration",
  "temporal_continuity",
]);

export const PRIMITIVES = Object.freeze([
  "state",
  "aggregate",
  "compare",
  "gate",
  "transform",
  "delay",
  "context_output",
]);

export const ACTIVATION_CURVES = Object.freeze([
  "linear", "hinge", "sigmoid", "hard_gate",
]);
export const MODULATION_TARGETS = Object.freeze(["gain", "threshold"]);
export const MODULATION_DIRECTIONS = Object.freeze(["increase", "decrease"]);

export const PORT_TYPES = Object.freeze(["scalar", "boolean", "symbol"]);
export const INPUT_PORT_ROLES = Object.freeze([
  "signal", "state", "modulator", "gate",
]);
export const OUTPUT_PORT_ROLES = Object.freeze([
  "signal", "state", "control", "symbol",
]);
export const INPUT_ROLE_TYPES = Object.freeze({
  signal: "scalar",
  state: "scalar",
  modulator: "scalar",
  gate: "boolean",
});
export const OUTPUT_ROLE_TYPES = Object.freeze({
  signal: "scalar",
  state: "scalar",
  control: "boolean",
  symbol: "symbol",
});
export const EDGE_EFFECTS = Object.freeze([
  "activate", "inhibit", "modulate", "gate",
]);
export const EDGE_TIMINGS = Object.freeze([
  "instant", "recurrent", "persistent",
]);

export const EDGE_TARGET_ROLES = Object.freeze({
  activate: Object.freeze(["signal", "state"]),
  inhibit: Object.freeze(["signal", "state"]),
  modulate: Object.freeze(["modulator"]),
  gate: Object.freeze(["gate"]),
});

export const EVIDENCE_KINDS = Object.freeze([
  "explicit_statement",
  "direct_event",
  "repeated_pattern",
  "contextual_inference",
]);

export const COVERAGE_STATUSES = Object.freeze([
  "evidence_found", "no_evidence", "not_applicable",
]);

export function stageIndex(stage) {
  return PROCESSING_STAGES.indexOf(stage);
}

export function stageAllowsInstant(sourceStage, targetStage) {
  return STAGE_BUS_CONTRACTS[sourceStage]?.instant_targets.includes(targetStage)
    || false;
}
