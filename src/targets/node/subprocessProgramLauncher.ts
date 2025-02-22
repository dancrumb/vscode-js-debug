/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { inject, injectable } from 'inversify';
import { EnvironmentVars } from '../../common/environmentVars';
import { ILogger } from '../../common/logging';
import * as urlUtils from '../../common/urlUtils';
import { INodeLaunchConfiguration, OutputSource } from '../../configuration';
import Dap from '../../dap/api';
import { ILaunchContext } from '../targets';
import { getNodeLaunchArgs, IProgramLauncher } from './processLauncher';
import { SubprocessProgram } from './program';
import { StdStreamTracker } from './stdStreamTracker';

/**
 * Launcher that boots a subprocess.
 */
@injectable()
export class SubprocessProgramLauncher implements IProgramLauncher {
  constructor(@inject(ILogger) private readonly logger: ILogger) {}

  public canLaunch(args: INodeLaunchConfiguration) {
    return args.console === 'internalConsole';
  }

  public async launchProgram(
    binary: string,
    config: INodeLaunchConfiguration,
    context: ILaunchContext,
  ) {
    const { executable, args, shell, cwd } = formatArguments(
      binary,
      getNodeLaunchArgs(config),
      config.cwd,
    );

    // Send an appoximation of the command we're running to
    // the terminal, for cosmetic purposes.
    context.dap.output({
      category: 'console',
      output: [executable, ...args].join(' ') + '\n',
    });

    const child = spawn(executable, args, {
      shell,
      cwd: cwd,
      env: EnvironmentVars.merge(EnvironmentVars.processEnv(), config.env).defined(),
    });

    if (config.outputCapture === OutputSource.Console) {
      this.discardStdio(context.dap, child);
    } else {
      this.captureStdio(context.dap, child);
    }

    return new SubprocessProgram(child, this.logger, config.killBehavior);
  }

  /**
   * Called for a child process when the stdio should be written over DAP.
   */
  private captureStdio(dap: Dap.Api, child: ChildProcessWithoutNullStreams) {
    const stdOutTracker = new StdStreamTracker('stdout', dap);
    const stdErrTracker = new StdStreamTracker('stderr', dap);
    child.stdout.on('data', stdOutTracker.consumeStdStreamData);
    child.stderr.on('data', stdErrTracker.consumeStdStreamData);
    child.stdout.resume();
    child.stderr.resume();
  }

  /**
   * Called for a child process when the stdio is not supposed to be captured.
   */
  private discardStdio(dap: Dap.Api, child: ChildProcessWithoutNullStreams) {
    // Catch any errors written before the debugger attaches, otherwise things
    // like module not found errors will never be written.
    let preLaunchBuffer: Buffer[] | undefined = [];
    const dumpFilter = () => {
      if (preLaunchBuffer) {
        dap.output({ category: 'stderr', output: Buffer.concat(preLaunchBuffer).toString() });
      }
    };

    const delimiter = Buffer.from('Debugger attached.');
    const errLineReader = (data: Buffer) => {
      if (data.includes(delimiter)) {
        preLaunchBuffer = undefined;
        child.stderr.removeListener('data', errLineReader);
      } else if (preLaunchBuffer) {
        preLaunchBuffer.push(data);
      }
    };

    child.stderr.on('data', errLineReader);

    child.on('error', err => {
      dumpFilter();
      dap.output({ category: 'stderr', output: err.stack || err.message });
    });

    child.on('exit', code => {
      if (code !== null && code > 0) {
        dumpFilter();
        dap.output({
          category: 'stderr',
          output: `Process exited with code ${code}\r\n`,
        });
      }
    });

    // must be called for https://github.com/microsoft/vscode/issues/102254
    child.stdout.resume();
    child.stderr.resume();
  }
}

// Fix for: https://github.com/microsoft/vscode/issues/45832,
// which still seems to be a thing according to the issue tracker.
// From: https://github.com/microsoft/vscode-node-debug/blob/47747454bc6e8c9e48d8091eddbb7ffb54a19bbe/src/node/nodeDebug.ts#L1120
const formatArguments = (executable: string, args: ReadonlyArray<string>, cwd: string) => {
  if (process.platform === 'win32') {
    executable = urlUtils.platformPathToPreferredCase(executable);
    cwd = urlUtils.platformPathToPreferredCase(cwd);

    if (executable.endsWith('.ps1')) {
      args = ['-File', executable, ...args];
      executable = 'powershell.exe';
    }
  }

  if (process.platform !== 'win32' || !executable.includes(' ')) {
    return { executable, args, shell: false, cwd };
  }

  let foundArgWithSpace = false;

  // check whether there is one arg with a space
  const output: string[] = [];
  for (const a of args) {
    if (a.includes(' ')) {
      output.push(`"${a}"`);
      foundArgWithSpace = true;
    } else {
      output.push(a);
    }
  }

  if (foundArgWithSpace) {
    return { executable: `"${executable}"`, args: output, shell: true, cwd: cwd };
  }

  return { executable, args, shell: false, cwd };
};
