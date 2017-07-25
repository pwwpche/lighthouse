/**
 * @license Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const Node = require('../node');
const TcpConnection = require('./tcp-connection');

// see https://cs.chromium.org/search/?q=kDefaultMaxNumDelayableRequestsPerClient&sq=package:chromium&type=cs
const DEFAULT_MAXIMUM_CONCURRENT_REQUESTS = 10;
const DEFAULT_RESPONSE_TIME = 30;
const DEFAULT_RTT = 150;
const DEFAULT_THROUGHPUT = 1600 * 1024; // 1.6 Mbps

function groupBy(items, keyFunc) {
  const grouped = new Map();
  items.forEach(item => {
    const key = keyFunc(item);
    const group = grouped.get(key) || [];
    group.push(item);
    grouped.set(key, group);
  });

  return grouped;
}

class Estimator {
  constructor(graph, options) {
    this._graph = graph;
    this._options = Object.assign(
      {
        rtt: DEFAULT_RTT,
        throughput: DEFAULT_THROUGHPUT,
        defaultResponseTime: DEFAULT_RESPONSE_TIME,
        maximumConcurrentRequests: DEFAULT_MAXIMUM_CONCURRENT_REQUESTS,
      },
      options
    );

    this._rtt = this._options.rtt;
    this._throughput = this._options.throughput;
    this._defaultResponseTime = this._options.defaultResponseTime;
    this._maximumConcurrentRequests = Math.min(
      TcpConnection.maximumSaturatedConnections(this._rtt, this._throughput),
      this._options.maximumConcurrentRequests
    );
  }

  static getResponseTime(record) {
    const timing = record._timing;
    return (timing && timing.receiveHeadersEnd - timing.sendEnd) || Infinity;
  }

  _initializeNetworkRecords() {
    const records = [];

    this._graph.getRootNode().traverse(node => {
      if (node.type === Node.TYPES.NETWORK) {
        records.push(node.record);
      }
    });

    this._networkRecords = records;
    return records;
  }

  _initializeNetworkConnections() {
    const connections = new Map();
    const recordsByConnection = groupBy(
      this._networkRecords,
      record => record.connectionId
    );

    for (const [connectionId, records] of recordsByConnection.entries()) {
      const isSsl = records[0].parsedURL.scheme === 'https';
      let responseTime = records.reduce(
        (min, record) => Math.min(min, Estimator.getResponseTime(record)),
        Infinity
      );

      if (!Number.isFinite(responseTime)) {
        responseTime = this._defaultResponseTime;
      }

      const connection = new TcpConnection(
        this._rtt,
        this._throughput,
        responseTime,
        isSsl
      );

      connections.set(connectionId, connection);
    }

    this._connections = connections;
    return connections;
  }

  _initializeAuxiliaryData() {
    this._nodeAuxiliaryData = new Map();
    this._nodesCompleted = new Set();
    this._nodesInProcess = new Set();
    this._nodesInQueue = new Set(); // TODO: replace this with priority queue
    this._connectionsInUse = new Set();
  }

  /**
   * @param {!Node} node
   */
  _enqueueNodeIfPossible(node) {
    const dependencies = node.getDependencies();
    if (
      !this._nodesCompleted.has(node) &&
      dependencies.every(dependency => this._nodesCompleted.has(dependency))
    ) {
      this._nodesInQueue.add(node);
    }
  }

  /**
   * @param {!Node} node
   * @param {number} totalElapsedTime
   */
  _startNodeIfPossible(node, totalElapsedTime) {
    if (node.type !== Node.TYPES.NETWORK) return;

    const connection = this._connections.get(node.record.connectionId);

    if (
      this._nodesInProcess.size >= this._maximumConcurrentRequests ||
      this._connectionsInUse.has(connection)
    ) {
      return;
    }

    this._nodesInQueue.delete(node);
    this._nodesInProcess.add(node);
    this._nodeAuxiliaryData.set(node, {
      startTime: totalElapsedTime,
      timeElapsed: 0,
      timeElapsedOvershoot: 0,
      bytesDownloaded: 0,
    });

    this._connectionsInUse.add(connection);
  }

  _updateNetworkCapacity() {
    for (const connection of this._connectionsInUse) {
      connection.setThroughput(this._throughput / this._nodesInProcess.size);
    }
  }

  /**
   * @param {!Node} node
   * @return {number}
   */
  _estimateTimeRemaining(node) {
    if (node.type !== Node.TYPES.NETWORK) throw new Error('Unsupported');

    const auxiliaryData = this._nodeAuxiliaryData.get(node);
    const connection = this._connections.get(node.record.connectionId);
    const calculation = connection.calculateTimeToDownload(
      node.record.transferSize - auxiliaryData.bytesDownloaded,
      auxiliaryData.timeElapsed
    );

    const estimate = calculation.timeElapsed + auxiliaryData.timeElapsedOvershoot;
    auxiliaryData.estimatedTimeElapsed = estimate;
    return estimate;
  }

  /**
   * @return {number}
   */
  _findNextNodeCompletionTime() {
    let minimumTime = Infinity;
    for (const node of this._nodesInProcess) {
      minimumTime = Math.min(minimumTime, this._estimateTimeRemaining(node));
    }

    return minimumTime;
  }

  /**
   * @param {!Node} node
   * @param {number} timePeriodLength
   * @param {number} totalElapsedTime
   */
  _updateProgressMadeInTimePeriod(node, timePeriodLength, totalElapsedTime) {
    if (node.type !== Node.TYPES.NETWORK) throw new Error('Unsupported');

    const auxiliaryData = this._nodeAuxiliaryData.get(node);
    const connection = this._connections.get(node.record.connectionId);
    const calculation = connection.calculateTimeToDownload(
      node.record.transferSize - auxiliaryData.bytesDownloaded,
      auxiliaryData.timeElapsed,
      timePeriodLength - auxiliaryData.timeElapsedOvershoot
    );

    connection.setCongestionWindow(calculation.congestionWindow);

    if (auxiliaryData.estimatedTimeElapsed === timePeriodLength) {
      auxiliaryData.endTime = totalElapsedTime;

      connection.setWarmed(true);
      this._connectionsInUse.delete(connection);

      this._nodesCompleted.add(node);
      this._nodesInProcess.delete(node);

      for (const dependent of node.getDependents()) {
        this._enqueueNodeIfPossible(dependent);
      }
    } else {
      auxiliaryData.timeElapsed += calculation.timeElapsed;
      auxiliaryData.timeElapsedOvershoot +=
        calculation.timeElapsed - timePeriodLength;
      auxiliaryData.bytesDownloaded += calculation.bytesDownloaded;
    }
  }

  estimate() {
    // initialize all the necessary data containers
    this._initializeNetworkRecords();
    this._initializeNetworkConnections();
    this._initializeAuxiliaryData();

    const nodesInQueue = this._nodesInQueue;
    const nodesInProcess = this._nodesInProcess;

    // add root node to queue
    nodesInQueue.add(this._graph.getRootNode());

    let depth = 0;
    let totalElapsedTime = 0;
    while (nodesInQueue.size || nodesInProcess.size) {
      depth++;

      // move all possible queued nodes to in process
      for (const node of nodesInQueue) {
        this._startNodeIfPossible(node, totalElapsedTime);
      }

      // set the available throughput for all connections based on # inflight
      this._updateNetworkCapacity();

      // find the time that the next node will finish
      const minimumTime = this._findNextNodeCompletionTime();
      totalElapsedTime += minimumTime;

      // update how far each node will progress until that point
      for (const node of nodesInProcess) {
        this._updateProgressMadeInTimePeriod(
          node,
          minimumTime,
          totalElapsedTime
        );
      }

      if (depth > 10000) {
        throw new Error('Maximum depth exceeded: estimate');
      }
    }

    return totalElapsedTime;
  }
}

module.exports = Estimator;
