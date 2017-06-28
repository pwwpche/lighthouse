/**
 * @license Copyright 2016 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as chromeFinder from './chrome-finder';
import {getRandomPort} from './random-port';
import {DEFAULT_FLAGS} from './flags';
import {makeTmpDir, defaults, delay} from './utils';
import * as net from 'net';
const rimraf = require('rimraf');
const log = require('lighthouse-logger');
const spawn = childProcess.spawn;
const execSync = childProcess.execSync;
const isWindows = process.platform === 'win32';
const _SIGINT = 'SIGINT';
const _SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32']);

type SupportedPlatforms = 'darwin'|'linux'|'win32';

interface LighthouseError extends Error {
  code?: string
}

export interface Options {
  startingUrl?: string;
  chromeFlags?: Array<string>;
  port?: number;
  handleSIGINT?: boolean;
  chromePath?: string;
  userDataDir?: string;
  logLevel?: string;
}

export interface LaunchedChrome {
  pid: number;
  port: number;
  kill: () => Promise<{}>;
}

export interface ModuleOverrides {
  fs?: typeof fs;
  rimraf?: typeof rimraf;
  spawn?: typeof childProcess.spawn;
}

/**
 * LaunchManager handles launch retries and SIGINT binding
 */
export class LaunchManager {
  private instance?: Launcher;
  private opts: Options;
  private isSigintBound: boolean;
  private maxLaunchAttempts: number;
  private attempts: number;

  constructor() {
    this.isSigintBound = false;
    this.maxLaunchAttempts = 3;
    this.attempts = 1;
  }

  setOptions(opts: Options = {}) {
    this.opts = opts;
  }

  async launchInstance(): Promise<LaunchedChrome> {
    if (this.instance) {
      Promise.reject(new Error('Already a launcher instance, can\'t create a second.'));
    }

    this.instance = new Launcher(this.opts);

    this.handleSigint();
    await this.instance.launch().catch(err => {
      return this.retry(err);
    });

    return {
      pid: this.instance.pid!,
      port: this.instance.port!,
      kill: async () => this.instance!.kill()
    };
  }

  async retry(err: LighthouseError) {
    if (err.code !== 'ECONNREFUSED') {
      Promise.reject(err);
    }
    this.attempts++;
    if (this.attempts <= this.maxLaunchAttempts) {
      log.warn(
          'ChromeLauncher',
          `Connection refused. Retrying attempt #${this.attempts}/${this.maxLaunchAttempts}`);
    } else {
      log.error('ChromeLauncher', 'Reached maximum relaunch attempts. Quitting...');
      return Promise.reject(err);
    }

    await this.instance!.kill();
    this.instance = undefined;
    return this.launchInstance();
  }

  async handleSigint() {
    this.opts.handleSIGINT = defaults(this.opts.handleSIGINT, true);
    // Kill spawned Chrome process in case of ctrl-C.
    if (this.opts.handleSIGINT && !this.isSigintBound) {
      this.isSigintBound = true;
      process.on(_SIGINT, async () => {
        await this.instance!.kill();
      });
    }
  }
}

/**
 * Launcher handles the lifecycle of a unique process of Chrome
 */
export class Launcher {
  private tmpDirandPidFileReady = false;
  private pollInterval: number = 500;
  private pidFile: string;
  private startingUrl: string;
  private outFile?: number;
  private errFile?: number;
  private chromePath?: string;
  private chromeFlags: string[];
  private requestedPort?: number;
  private chrome?: childProcess.ChildProcess;
  private fs: typeof fs;
  private rimraf: typeof rimraf;
  private spawn: typeof childProcess.spawn;

  userDataDir?: string;
  port?: number;
  pid?: number;

  constructor(private opts: Options = {}, moduleOverrides: ModuleOverrides = {}) {
    this.fs = moduleOverrides.fs || fs;
    this.rimraf = moduleOverrides.rimraf || rimraf;
    this.spawn = moduleOverrides.spawn || spawn;

    log.setLevel(defaults(this.opts.logLevel, 'info'));

    // choose the first one (default)
    this.startingUrl = defaults(this.opts.startingUrl, 'about:blank');
    this.chromeFlags = defaults(this.opts.chromeFlags, []);
    this.requestedPort = defaults(this.opts.port, 0);
    this.chromePath = this.opts.chromePath;
  }

  private get flags() {
    const flags = DEFAULT_FLAGS.concat([
      `--remote-debugging-port=${this.port}`,
      // Place Chrome profile in a custom location we'll rm -rf later
      `--user-data-dir=${this.userDataDir}`
    ]);

    if (process.platform === 'linux') {
      flags.push('--disable-setuid-sandbox');
    }

    flags.push(...this.chromeFlags);
    flags.push(this.startingUrl);

    return flags;
  }

  // Wrapper function to enable easy testing.
  makeTmpDir() {
    return makeTmpDir();
  }

  prepare() {
    const platform = process.platform as SupportedPlatforms;
    if (!_SUPPORTED_PLATFORMS.has(platform)) {
      throw new Error(`Platform ${platform} is not supported`);
    }

    this.userDataDir = this.opts.userDataDir || this.makeTmpDir();
    this.outFile = this.fs.openSync(`${this.userDataDir}/chrome-out.log`, 'a');
    this.errFile = this.fs.openSync(`${this.userDataDir}/chrome-err.log`, 'a');

    // fix for Node4
    // you can't pass a fd to fs.writeFileSync
    this.pidFile = `${this.userDataDir}/chrome.pid`;

    log.verbose('ChromeLauncher', `created ${this.userDataDir}`);

    this.tmpDirandPidFileReady = true;
  }

  async launch() {
    if (this.requestedPort !== 0) {
      this.port = this.requestedPort;

      // If an explict port is passed first look for an open connection...
      try {
        return await this.doesDebuggingPortConnect();
      } catch (err) {
        log.log(
            'ChromeLauncher',
            `No debugging port found on port ${this.port}, launching a new Chrome.`);
      }
    }

    if (!this.tmpDirandPidFileReady) {
      this.prepare();
    }

    if (this.chromePath === undefined) {
      const installations = await chromeFinder[process.platform as SupportedPlatforms]();
      if (installations.length === 0) {
        throw new Error('No Chrome Installations Found');
      }

      this.chromePath = installations[0];
    }

    this.pid = await this.spawnProcess(this.chromePath);
    return Promise.resolve();
  }

  private async spawnProcess(execPath: string) {
    // Typescript is losing track of the return type without the explict typing.
    const spawnPromise: Promise<number> = new Promise(async (resolve) => {
      if (this.chrome) {
        log.log('ChromeLauncher', `Chrome already running with pid ${this.chrome.pid}.`);
        return resolve(this.chrome.pid);
      }


      // If a zero value port is set, it means the launcher
      // is responsible for generating the port number.
      // We do this here so that we can know the port before
      // we pass it into chrome.
      if (this.requestedPort === 0) {
        this.port = await getRandomPort();
      }

      const chrome = this.spawn(
          execPath, this.flags, {detached: true, stdio: ['ignore', this.outFile, this.errFile]});
      this.chrome = chrome;

      this.fs.writeFileSync(this.pidFile, chrome.pid.toString());

      log.verbose('ChromeLauncher', `Chrome running with pid ${chrome.pid} on port ${this.port}.`);
      resolve(chrome.pid);
    });

    const pid = await spawnPromise;
    await this.waitUntilReady();
    return pid;
  }

  // resolves if it connects, rejects otherwise
  private doesDebuggingPortConnect(): Promise<{}> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(this.port!);
      client.once('error', err => {
        cleanup(client);
        reject(err);
      });
      client.once('connect', () => {
        cleanup(client);
        resolve();
      });
    });

    function cleanup(client?: net.Socket) {
      if (client) {
        client.removeAllListeners();
        client.end();
        client.destroy();
        client.unref();
      }
    }
  }

  // resolves when debugging port is ready, polls 10 times every 500ms
  private waitUntilReady() {
    const maxPortCheckRetries = 10;

    return new Promise((resolve, reject) => {
      let retries = 0;
      let waitStatus = 'Attempting to connect...';
      log.log('ChromeLauncher', `Establishing connection on port ${this.port}...`);

      const poll = () => {
        log.verbose('ChromeLauncher', waitStatus);
        waitStatus += '..';
        retries++;

        this.doesDebuggingPortConnect()
            .then(() => {
              log.log(
                  'ChromeLauncher',
                  `Connection established on port ${this.port} ${log.greenify(log.tick)}`);
              resolve();
            })
            .catch(err => {
              if (retries > maxPortCheckRetries) {
                log.error('ChromeLauncher', err.message);
                const stderr =
                    this.fs.readFileSync(`${this.userDataDir}/chrome-err.log`, {encoding: 'utf-8'});
                log.error(
                    'ChromeLauncher', `Logging contents of ${this.userDataDir}/chrome-err.log`);
                log.error('ChromeLauncher', stderr);
                return reject(err);
              }
              delay(this.pollInterval).then(poll);
            });
      };
      poll();
    });
  }

  kill() {
    return new Promise(resolve => {
      if (this.chrome) {
        this.chrome.on('close', () => {
          this.destroyTmp().then(resolve);
        });

        log.log('ChromeLauncher', `Killing Chrome instance ${this.chrome.pid}`);
        try {
          if (isWindows) {
            execSync(`taskkill /pid ${this.chrome.pid} /T /F`);
          } else {
            process.kill(-this.chrome.pid);
          }
        } catch (err) {
          log.warn('ChromeLauncher', `Chrome could not be killed ${err.message}`);
        }

        delete this.chrome;
      } else {
        // fail silently as we did not start chrome
        resolve();
      }
    });
  }

  destroyTmp() {
    return new Promise(resolve => {
      // Only clean up the tmp dir if we created it.
      if (this.userDataDir === undefined || this.opts.userDataDir !== undefined) {
        return resolve();
      }

      if (this.outFile) {
        this.fs.closeSync(this.outFile);
        delete this.outFile;
      }

      if (this.errFile) {
        this.fs.closeSync(this.errFile);
        delete this.errFile;
      }

      this.rimraf(this.userDataDir, () => resolve());
    });
  }
};

const manager = new LaunchManager();
export function launch(opts: Options = {}): Promise<LaunchedChrome> {
  manager.setOptions(opts);
  return manager.launchInstance();
}
