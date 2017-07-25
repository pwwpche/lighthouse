/**
 * @license Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const INITIAL_CONGESTION_WINDOW = 10;
const TCP_SEGMENT_SIZE = 1460;

class TcpConnection {
  constructor(rtt, throughput, responseTime = 0, ssl = true) {
    this._warmed = false;
    this._ssl = ssl;
    this._rtt = rtt;
    this._availableThroughput = throughput;
    this._responseTime = responseTime;
    this._congestionWindow = INITIAL_CONGESTION_WINDOW;
  }

  static maximumSaturatedConnections(rtt, availableThroughput) {
    const roundTripsPerSecond = 1000 / rtt;
    const bytesPerRoundTrip = TCP_SEGMENT_SIZE;
    const bytesPerSecond = roundTripsPerSecond * bytesPerRoundTrip;
    const minimumThroughputRequiredPerRequest = bytesPerSecond * 8;
    return Math.floor(availableThroughput / minimumThroughputRequiredPerRequest);
  }

  _computeMaximumCongestionWindowInSegments() {
    const bytesPerSecond = this._availableThroughput / 8;
    const secondsPerRoundTrip = this._rtt / 1000;
    const bytesPerRoundTrip = bytesPerSecond * secondsPerRoundTrip;
    return Math.floor(bytesPerRoundTrip / TCP_SEGMENT_SIZE);
  }

  setThroughput(throughput) {
    this._availableThroughput = throughput;
  }

  setCongestionWindow(congestion) {
    this._congestionWindow = congestion;
  }

  setWarmed(value) {
    this._warmed = value;
  }

  /**
   * See https://hpbn.co/building-blocks-of-tcp/#three-way-handshake and
   *  https://hpbn.co/transport-layer-security-tls/#tls-handshake for details.
   */
  calculateTimeToDownload(bytesToDownload, timeAlreadyElapsed = 0, maximumTimeToElapse = Infinity) {
    const twoWayLatency = this._rtt;
    const oneWayLatency = twoWayLatency / 2;
    const maximumCongestionWindow = this._computeMaximumCongestionWindowInSegments();

    let handshakeAndRequest = oneWayLatency;
    if (!this._warmed) {
      handshakeAndRequest =
        // SYN
        oneWayLatency +
        // SYN ACK
        oneWayLatency +
        // ACK + Application Data
        oneWayLatency +
        // ClientHello/ServerHello with TLS False Start
        (this._ssl ? twoWayLatency : 0);
    }

    let roundTrips = Math.ceil(handshakeAndRequest / twoWayLatency);
    const timeToFirstByte = handshakeAndRequest + this._responseTime + oneWayLatency;
    const timeElapsedForTTFB = Math.max(timeToFirstByte - timeAlreadyElapsed, 0);
    const maximumDownloadTimeToElapse = maximumTimeToElapse - timeElapsedForTTFB;

    let congestionWindow = Math.min(this._congestionWindow, maximumCongestionWindow);
    let bytesDownloaded = 0;
    if (timeElapsedForTTFB > 0) {
      bytesDownloaded = congestionWindow * TCP_SEGMENT_SIZE;
    } else {
      roundTrips = 0;
    }

    let downloadTimeElapsed = 0;
    let bytesRemaining = bytesToDownload - bytesDownloaded;
    while (bytesRemaining > 0 && downloadTimeElapsed <= maximumDownloadTimeToElapse) {
      roundTrips++;
      downloadTimeElapsed += twoWayLatency;
      congestionWindow = Math.max(Math.min(maximumCongestionWindow, congestionWindow * 2), 1);

      const bytesDownloadedInWindow = congestionWindow * TCP_SEGMENT_SIZE;
      bytesDownloaded += bytesDownloadedInWindow;
      bytesRemaining -= bytesDownloadedInWindow;
    }

    const timeElapsed = timeElapsedForTTFB + downloadTimeElapsed;
    bytesDownloaded = Math.min(bytesDownloaded, bytesToDownload);

    if (Number.isFinite(maximumTimeToElapse)) {
      return {
        roundTrips,
        timeElapsed,
        bytesDownloaded,
        congestionWindow,
      };
    }

    return {
      roundTrips,
      timeElapsed,
      bytesDownloaded,
      congestionWindow,
    };
  }
}

module.exports = TcpConnection;
