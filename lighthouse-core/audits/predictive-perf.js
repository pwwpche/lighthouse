/**
 * @license Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const Audit = require('./audit');
const Util = require('../report/v2/renderer/util.js');
const PageDependencyGraph = require('../gather/computed/page-dependency-graph.js');
const Node = require('../gather/computed/dependency-graph/node.js');

// Parameters (in ms) for log-normal CDF scoring. To see the curve:
//   https://www.desmos.com/calculator/rjp0lbit8y
const SCORING_POINT_OF_DIMINISHING_RETURNS = 1700;
const SCORING_MEDIAN = 10000;

class PredictivePerf extends Audit {
  /**
   * @return {!AuditMeta}
   */
  static get meta() {
    return {
      category: 'Performance',
      name: 'predictive-perf',
      description: 'Predicted Performance (beta)',
      helpText: '',
      requiredArtifacts: ['traces', 'devtoolsLogs']
    };
  }

  /**
   *
   * @param {!Node} graph
   * @param {!TraceOfTabArtifact} traceOfTab
   */
  static getOptimisticFMPGraph(graph, traceOfTab) {
    const fmp = traceOfTab.timestamps.firstMeaningfulPaint;
    return graph.cloneWithRelationships(node => {
      if (node.endTime > fmp) return false;
      if (node.type !== Node.TYPES.NETWORK) return true;
      return node.record.priority() === 'VeryHigh'; // proxy for render-blocking
    });
  }

  static getPessimisticFMPGraph(graph, traceOfTab) {
    const fmp = traceOfTab.timestamps.firstMeaningfulPaint;
    return graph.cloneWithRelationships(node => {
      return node.endTime <= fmp;
    });
  }

  static getOptimisticTTCIGraph(graph) {
    return graph.cloneWithRelationships(node => {
      return node.record._resourceType && node.record._resourceType._name === 'script' ||
          node.record.priority() === 'High' ||
          node.record.priority() === 'VeryHigh';
    });
  }

  static getPessimisticTTCIGraph(graph) {
    return graph;
  }

  /**
   * @param {!Artifacts} artifacts
   * @return {!AuditResult}
   */
  static audit(artifacts) {
    const trace = artifacts.traces[Audit.DEFAULT_PASS];
    const devtoolsLogs = artifacts.devtoolsLogs[Audit.DEFAULT_PASS];
    return Promise.all([
      artifacts.requestPageDependencyGraph(trace, devtoolsLogs),
      artifacts.requestTraceOfTab(trace),
    ]).then(([graph, traceOfTab]) => {
      const graphs = {
        optimisticFMP: PredictivePerf.getOptimisticFMPGraph(graph, traceOfTab),
        pessimisticFMP: PredictivePerf.getPessimisticFMPGraph(graph, traceOfTab),
        optimisticTTCI: PredictivePerf.getOptimisticTTCIGraph(graph, traceOfTab),
        pessimisticTTCI: PredictivePerf.getPessimisticTTCIGraph(graph, traceOfTab),
      };

      let sum = 0;
      const values = {};
      Object.keys(graphs).forEach(key => {
        values[key] = PageDependencyGraph.computeGraphDuration(graphs[key]);
        sum += values[key];
      });

      const rawValue = sum / 4;
      const score = Audit.computeLogNormalScore(
        rawValue,
        SCORING_POINT_OF_DIMINISHING_RETURNS,
        SCORING_MEDIAN
      );

      return {
        score,
        rawValue,
        displayValue: Util.formatMilliseconds(rawValue),
        extendedInfo: {value: values},
      };
    });
  }
}

module.exports = PredictivePerf;
