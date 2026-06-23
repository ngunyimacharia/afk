import type { AfkProjectConfig } from './project-config.js';
import {
  type EnvironmentReadinessResult,
  type ReadinessCommandExecutor,
  SyncReadinessCommandExecutor,
} from './readiness-service.js';

export class EnvironmentReadinessChecker {
  constructor(private readonly executor: ReadinessCommandExecutor = new SyncReadinessCommandExecutor()) {}

  check(cwd: string, config?: AfkProjectConfig): EnvironmentReadinessResult {
    const command = config?.environmentReadinessCommand?.trim();
    if (!command) {
      return { status: 'skipped', reason: 'no environmentReadinessCommand configured' };
    }

    const result = this.executor.run(command, cwd);
    if (result.exitCode === 0) {
      return { status: 'passed', command, exitCode: 0, output: result.output };
    }

    return {
      status: 'failed',
      command,
      exitCode: result.exitCode,
      output: result.output,
      reason: `environment readiness command failed: ${command}`,
    };
  }
}
