'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {NuclideUri} from '../../commons-node/nuclideUri';
import type {AsyncExecuteOptions} from '../../commons-node/process';
import type {ProcessMessage} from '../../commons-node/process-rpc-types';
import type {ConnectableObservable} from 'rxjs';

import {
  checkOutput,
  observeProcess,
  safeSpawn,
  getOriginalEnvironment,
} from '../../commons-node/process';
import {PromisePool} from '../../commons-node/promise-executors';
import fsPromise from '../../commons-node/fsPromise';
import nuclideUri from '../../commons-node/nuclideUri';
import {Observable} from 'rxjs';
import createBuckWebSocket from './createBuckWebSocket';
import {getLogger} from '../../nuclide-logging';
import ini from 'ini';
import os from 'os';

const logger = getLogger();

export type dontRunOptions = {
  run: false,
};

export type doRunOptions = {
  run: true,
  debug: boolean,
};

export type BuckRunOptions = dontRunOptions | doRunOptions;

export type BuckWebSocketMessage = {
  // Not actually from Buck - this is to let the receiver know that the socket is connected.
  type: 'SocketConnected',
} | {
  type: 'BuildProgressUpdated',
  progressValue: number,
} | {
  type: 'BuildFinished',
  exitCode: number,
} | {
  type: 'BuildStarted',
} | {
  type: 'ConsoleEvent',
  message: string,
  level: {
    name: 'OFF' | 'SEVERE' | 'WARNING' | 'INFO' | 'CONFIG' | 'FINE' | 'FINER' | 'FINEST' | 'ALL',
  },
} | {
  type: 'ParseStarted',
} | {
  type: 'ParseFinished',
} | {
  type: 'InstallFinished',
  success: boolean,
  pid?: number,
} | {
  type: 'RunStarted',
} | {
  type: 'RunComplete',
} | {
  type: 'ResultsAvailable',
  results: {
    buildTarget: {
      shortName: string,
      baseName: string,
    },
    success: boolean,
    failureCount: number,
    totalNumberOfTests: number,
    testCases: Array<{
      success: boolean,
      failureCount: number,
      skippedCount: number,
      testCaseName: string,
      testResults: Array<{
        testCaseName: string,
        testName: string,
        type: string,
        time: number,
        message: string,
        stacktrace: ?string,
        stdOut: string,
        stdErr: string,
      }>,
    }>,
  },
};

type BuckConfig = Object;
export type BaseBuckBuildOptions = {
  install?: boolean,
  test?: boolean,
  simulator?: ?string,
  runOptions?: ?BuckRunOptions,
  // The service framework doesn't support imported types
  commandOptions?: Object /* AsyncExecuteOptions */,
  extraArguments?: Array<string>,
};
type FullBuckBuildOptions = {
  baseOptions: BaseBuckBuildOptions,
  pathToBuildReport?: string,
  buildTargets: Array<string>,
};
type BuckCommandAndOptions = {
  pathToBuck: string,
  buckCommandOptions: AsyncExecuteOptions & child_process$spawnOpts,
};

/**
 * As defined in com.facebook.buck.cli.Command, some of Buck's subcommands are
 * read-only. The read-only commands can be executed in parallel, but the rest
 * must be executed serially.
 *
 * Still, we try to make sure we don't slow down the user's computer.
 */
const MAX_CONCURRENT_READ_ONLY = Math.max(1, os.cpus().length - 1);
const pools = new Map();

function getPool(path: string, readOnly: boolean): PromisePool {
  const key = (readOnly ? 'ro:' : '') + path;
  let pool = pools.get(key);
  if (pool != null) {
    return pool;
  }
  // Buck seems to have a classic exists/create race condition when NO_BUCKD is enabled.
  // TODO(hansonw): Remove this if/when the issue is fixed in Buck.
  pool = new PromisePool(readOnly && process.env.NO_BUCKD !== '1' ? MAX_CONCURRENT_READ_ONLY : 1);
  pools.set(key, pool);
  return pool;
}

/**
 * Given a file path, returns path to the Buck project root i.e. the directory containing
 * '.buckconfig' file.
 */
export async function getRootForPath(file: NuclideUri): Promise<?NuclideUri> {
  return fsPromise.findNearestFile('.buckconfig', file);
}

/**
 * Gets the build file for the specified target.
 */
export async function getBuildFile(rootPath: NuclideUri, targetName: string): Promise<?string> {
  try {
    const result = await query(rootPath, `buildfile(${targetName})`);
    if (result.length === 0) {
      return null;
    }
    return nuclideUri.join(rootPath, result[0]);
  } catch (e) {
    logger.error(`No build file for target "${targetName}" ${e}`);
    return null;
  }
}

/**
 * @param args Do not include 'buck' as the first argument: it will be added
 *     automatically.
 */
function _runBuckCommandFromProjectRoot(
  rootPath: string,
  args: Array<string>,
  commandOptions?: AsyncExecuteOptions,
  readOnly?: boolean = true,
): Promise<{stdout: string, stderr: string, exitCode?: number}> {
  const {pathToBuck, buckCommandOptions: options} =
    _getBuckCommandAndOptions(rootPath, commandOptions);

  logger.debug('Buck command:', pathToBuck, args, options);
  return getPool(rootPath, readOnly).submitFunction(
    () => checkOutput(pathToBuck, args, options),
  );
}

/**
 * @return The path to buck and set of options to be used to run a `buck` command.
 */
function _getBuckCommandAndOptions(
  rootPath: string,
  commandOptions?: AsyncExecuteOptions = {},
): BuckCommandAndOptions {
  // $UPFixMe: This should use nuclide-features-config
  const pathToBuck =
    global.atom && global.atom.config.get('nuclide.nuclide-buck.pathToBuck') || 'buck';
  const buckCommandOptions = {
    cwd: rootPath,
    // Buck restarts itself if the environment changes, so try to preserve
    // the original environment that Nuclide was started in.
    env: getOriginalEnvironment(),
    ...commandOptions,
  };
  return {pathToBuck, buckCommandOptions};
}

/**
 * Returns an array of strings (that are build targets) by running:
 *
 *     buck audit owner <path>
 *
 * @param filePath absolute path or a local or a remote file.
 * @return Promise that resolves to an array of build targets.
 */
export async function getOwner(rootPath: NuclideUri, filePath: NuclideUri): Promise<Array<string>> {
  const args = ['audit', 'owner', filePath];
  const result = await _runBuckCommandFromProjectRoot(rootPath, args);
  const stdout = result.stdout.trim();
  if (stdout === '') {
    return [];
  }
  return stdout.split('\n');
}

/**
 * Reads the configuration file for the Buck project and returns the requested property.
 *
 * @param section Section in the configuration file.
 * @param property Configuration option within the section.
 *
 * @return Promise that resolves to the value, if it is set, else `null`.
 */
export async function getBuckConfig(
  rootPath: NuclideUri,
  section: string,
  property: string,
): Promise<?string> {
  const buckConfig = await _loadBuckConfig(rootPath);
  if (!buckConfig.hasOwnProperty(section)) {
    return null;
  }
  const sectionConfig = buckConfig[section];
  if (!sectionConfig.hasOwnProperty(property)) {
    return null;
  }
  return sectionConfig[property];
}

/**
 * TODO(natthu): Also load .buckconfig.local. Consider loading .buckconfig from the home directory
 * and ~/.buckconfig.d/ directory.
 */
async function _loadBuckConfig(rootPath: string): Promise<BuckConfig> {
  const header = 'scope = global\n';
  const buckConfigContent = await fsPromise.readFile(
    nuclideUri.join(rootPath, '.buckconfig'),
  );
  return ini.parse(header + buckConfigContent);
}

/**
 * Runs `buck build --keep-going --build-report <tempfile>` with the specified targets. Regardless
 * whether the build is successful, this returns the parsed version of the JSON report
 * produced by the {@code --build-report} option:
 * http://facebook.github.io/buck/command/build.html.
 *
 * An error should be thrown only if the specified targets are invalid.
 * @return Promise that resolves to a build report.
 */
export function build(
  rootPath: NuclideUri,
  buildTargets: Array<string>,
  options?: BaseBuckBuildOptions,
): Promise<any> {
  return _build(rootPath, buildTargets, options || {});
}

/**
 * Runs `buck install --keep-going --build-report <tempfile>` with the specified targets.
 *
 * @param run If set to 'true', appends the buck invocation with '--run' to run the
 *   installed application.
 * @param debug If set to 'true', appends the buck invocation with '--wait-for-debugger'
 *   telling the launched application to stop at the loader breakpoint
 *   waiting for debugger to connect
 * @param simulator The UDID of the simulator to install the binary on.
 * @return Promise that resolves to a build report.
 */
export function install(
  rootPath: NuclideUri,
  buildTargets: Array<string>,
  simulator: ?string,
  runOptions: ?BuckRunOptions,
): Promise<any> {
  return _build(rootPath, buildTargets, {install: true, simulator, runOptions});
}

async function _build(
  rootPath: NuclideUri,
  buildTargets: Array<string>,
  options: BaseBuckBuildOptions,
): Promise<any> {
  const report = await fsPromise.tempfile({suffix: '.json'});
  const args = _translateOptionsToBuckBuildArgs({
    baseOptions: {...options},
    pathToBuildReport: report,
    buildTargets,
  });

  try {
    await _runBuckCommandFromProjectRoot(
      rootPath,
      args,
      options.commandOptions,
      true,   // Build commands are blocking.
    );
  } catch (e) {
    // The build failed. However, because --keep-going was specified, the
    // build report should have still been written unless any of the target
    // args were invalid. We check the contents of the report file to be sure.
    const stat = await fsPromise.stat(report).catch(() => null);
    if (stat == null || stat.size === 0) {
      throw e;
    }
  }

  try {
    const json: string = await fsPromise.readFile(report, {encoding: 'UTF-8'});
    try {
      return JSON.parse(json);
    } catch (e) {
      throw Error(`Failed to parse:\n${json}`);
    }
  } finally {
    fsPromise.unlink(report);
  }
}

/**
 * Same as `build`, but returns additional output via an Observable.
 * @return An Observable with the following implementations:
 *   onNext: Calls the Observer with successive strings from stdout and stderr.
 *     Each update will be of the form: {stdout: string;} | {stderr: string;}
 *     TODO: Use a union to exactly match `{stdout: string;} | {stderr: string;}` when the service
 *     framework supports it. Use an object with optional keys to mimic the union.
 *   onError: If the build fails, calls the Observer with the string output
 *     from stderr.
 *   onCompleted: Only called if the build completes successfully.
 */
export function buildWithOutput(
  rootPath: NuclideUri,
  buildTargets: Array<string>,
  extraArguments: Array<string>,
): ConnectableObservable<ProcessMessage> {
  return _buildWithOutput(rootPath, buildTargets, {extraArguments}).publish();
}

/**
 * Same as `build`, but returns additional output via an Observable.
 * @return An Observable with the following implementations:
 *   onNext: Calls the Observer with successive strings from stdout and stderr.
 *     Each update will be of the form: {stdout: string;} | {stderr: string;}
 *     TODO: Use a union to exactly match `{stdout: string;} | {stderr: string;}` when the service
 *     framework supports it. Use an object with optional keys to mimic the union.
 *   onError: If the build fails, calls the Observer with the string output
 *     from stderr.
 *   onCompleted: Only called if the build completes successfully.
 */
export function testWithOutput(
  rootPath: NuclideUri,
  buildTargets: Array<string>,
  extraArguments: Array<string>,
): ConnectableObservable<ProcessMessage> {
  return _buildWithOutput(rootPath, buildTargets, {test: true, extraArguments}).publish();
}

/**
 * Same as `install`, but returns additional output via an Observable.
 * @return An Observable with the following implementations:
 *   onNext: Calls the Observer with successive strings from stdout and stderr.
 *     Each update will be of the form: {stdout: string;} | {stderr: string;}
 *     TODO: Use a union to exactly match `{stdout: string;} | {stderr: string;}` when the service
 *     framework supports it. Use an object with optional keys to mimic the union.
 *   onError: If the install fails, calls the Observer with the string output
 *     from stderr.
 *   onCompleted: Only called if the install completes successfully.
 */
export function installWithOutput(
  rootPath: NuclideUri,
  buildTargets: Array<string>,
  extraArguments: Array<string>,
  simulator: ?string,
  runOptions: ?BuckRunOptions,
): ConnectableObservable<ProcessMessage> {
  return _buildWithOutput(rootPath, buildTargets, {
    install: true,
    simulator,
    runOptions,
    extraArguments,
  }).publish();
}

/**
 * Does a build/install.
 * @return An Observable that returns output from buck, as described by the
 *   docblocks for `buildWithOutput` and `installWithOutput`.
 */
function _buildWithOutput(
  rootPath: NuclideUri,
  buildTargets: Array<string>,
  options: BaseBuckBuildOptions,
): Observable<ProcessMessage> {
  const args = _translateOptionsToBuckBuildArgs({
    baseOptions: {...options},
    buildTargets,
  });
  const {pathToBuck, buckCommandOptions} = _getBuckCommandAndOptions(rootPath);

  return observeProcess(
    () => safeSpawn(pathToBuck, args, buckCommandOptions),
  );
}

/**
 * @param options An object describing the desired buck build operation.
 * @return An array of strings that can be passed as `args` to spawn a
 *   process to run the `buck` command.
 */
function _translateOptionsToBuckBuildArgs(options: FullBuckBuildOptions): Array<string> {
  const {
    baseOptions,
    pathToBuildReport,
    buildTargets,
  } = options;
  const {
    install: doInstall,
    simulator,
    test,
    extraArguments,
  } = baseOptions;
  const runOptions = baseOptions.runOptions || {run: false};

  let args = [test ? 'test' : (doInstall ? 'install' : 'build')];
  args = args.concat(buildTargets);

  args.push('--keep-going');
  if (pathToBuildReport) {
    args = args.concat(['--build-report', pathToBuildReport]);
  }
  if (doInstall) {
    if (simulator) {
      args.push('--udid');
      args.push(simulator);
    }

    if (runOptions.run) {
      args.push('--run');
      if (runOptions.debug) {
        args.push('--wait-for-debugger');
      }
    }
  }
  if (extraArguments != null) {
    args = args.concat(extraArguments);
  }
  return args;
}

export async function listAliases(rootPath: NuclideUri): Promise<Array<string>> {
  const args = ['audit', 'alias', '--list'];
  const result = await _runBuckCommandFromProjectRoot(rootPath, args);
  const stdout = result.stdout.trim();
  return stdout ? stdout.split('\n') : [];
}

/**
 * Currently, if `aliasOrTarget` contains a flavor, this will fail.
 */
export async function resolveAlias(rootPath: NuclideUri, aliasOrTarget: string): Promise<string> {
  const args = ['targets', '--resolve-alias', aliasOrTarget];
  const result = await _runBuckCommandFromProjectRoot(rootPath, args);
  return result.stdout.trim();
}

/**
 * Returns the build output metadata for the given target.
 * This will contain one element if the target is unique; otherwise it will
 * contain data for all the targets (e.g. for //path/to/targets:)
 *
 * The build output path is typically contained in the 'buck.outputPath' key.
 */
export async function showOutput(
  rootPath: NuclideUri,
  aliasOrTarget: string,
): Promise<Array<Object>> {
  const args = ['targets', '--json', '--show-output', aliasOrTarget];
  const result = await _runBuckCommandFromProjectRoot(rootPath, args);
  return JSON.parse(result.stdout.trim());
}

export async function buildRuleTypeFor(
  rootPath: NuclideUri,
  aliasOrTarget: string,
): Promise<string> {
  let canonicalName = aliasOrTarget;
  // The leading "//" can be omitted for build/test/etc, but not for query.
  // Don't prepend this for aliases though (aliases will not have colons)
  if (canonicalName.indexOf(':') !== -1 && !canonicalName.startsWith('//')) {
    canonicalName = '//' + canonicalName;
  }
  // Buck query does not support flavors.
  const flavorIndex = canonicalName.indexOf('#');
  if (flavorIndex !== -1) {
    canonicalName = canonicalName.substr(0, flavorIndex);
  }
  const args = ['query', canonicalName, '--json', '--output-attributes', 'buck.type'];
  const result = await _runBuckCommandFromProjectRoot(rootPath, args);
  const json: {[target: string]: Object} = JSON.parse(result.stdout);
  // If aliasOrTarget is an alias, targets[0] will be the fully qualified build target.
  const targets = Object.keys(json);
  // "target:" rules build all rules in that particular BUCK file.
  // Let's just choose the first one.
  if (!targets || (!canonicalName.endsWith(':') && targets.length !== 1)) {
    throw new Error(`Error determining rule type of '${aliasOrTarget}'.`);
  }
  return json[targets[0]]['buck.type'];
}

export async function getHTTPServerPort(
  rootPath: NuclideUri,
): Promise<number> {
  const args = ['server', 'status', '--json', '--http-port'];
  const result = await _runBuckCommandFromProjectRoot(rootPath, args);
  const json: Object = JSON.parse(result.stdout);
  return json['http.port'];
}

/** Runs `buck query --json` with the specified query. */
export async function query(
  rootPath: NuclideUri,
  queryString: string,
): Promise<Array<string>> {
  const args = ['query', '--json', queryString];
  const result = await _runBuckCommandFromProjectRoot(rootPath, args);
  const json: Array<string> = JSON.parse(result.stdout);
  return json;
}

/**
 * Runs `buck query --json` with a query that contains placeholders and therefore expects
 * arguments.
 * @param query Should contain '%s' placeholders.
 * @param args Should be a list of build targets or aliases. The query will be run for each arg.
 *   It will be substituted for '%s' when it is run.
 * @return object where each arg in args will be a key. Its corresponding value will be the list
 *   of matching build targets in its results.
 */
export async function queryWithArgs(
  rootPath: NuclideUri,
  queryString: string,
  args: Array<string>,
): Promise<{[aliasOrTarget: string]: Array<string>}> {
  const completeArgs = ['query', '--json', queryString].concat(args);
  const result = await _runBuckCommandFromProjectRoot(rootPath, completeArgs);
  const json: {[aliasOrTarget: string]: Array<string>} = JSON.parse(result.stdout);

  // `buck query` does not include entries in the JSON for params that did not match anything. We
  // massage the output to ensure that every argument has an entry in the output.
  for (const arg of args) {
    if (!json.hasOwnProperty(arg)) {
      json[arg] = [];
    }
  }
  return json;
}

// TODO: Nuclide's RPC framework won't allow BuckWebSocketMessage here unless we cover
// all possible message types. For now, we'll manually typecast at the callsite.
export function getWebSocketStream(
  rootPath: NuclideUri,
  httpPort: number,
): ConnectableObservable<Object> {
  return createBuckWebSocket(httpPort).publish();
}
