'use strict';

const { MODEL_VERSION, buildForecasts } = require('./forecast');
const { generateLegalPartitions } = require('./legal-teams');
const { evaluatePartitions, selectScenarios } = require('./evaluator');

const OPTIMIZER_VERSION = 'tournament-v1';

function evaluateRoster({ roster, players, capCr, leads, pins, availability,
  evaluationDate, seed, benchmark }) {
  const forecasts = buildForecasts(roster, players, { evaluationDate });
  const generated = generateLegalPartitions({ roster, capCr, leads, pins, availability });
  if (generated.conflict) return { conflict: generated.conflict };
  const evaluations = evaluatePartitions(generated.partitions, forecasts,
    { seed, iterations: 750, benchmark });
  return {
    modelVersion: `${OPTIMIZER_VERSION}+${MODEL_VERSION}`,
    forecasts: [...forecasts.values()],
    scenarios: selectScenarios(evaluations),
    legalPartitionCount: generated.partitions.length,
  };
}

module.exports = { OPTIMIZER_VERSION, evaluateRoster };
