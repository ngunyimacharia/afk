import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LinearConfigClient, LinearEntity, LinearTeam, LinearWorkflowState } from '../src/linear.js';
import { LinearStartupError, resolveLinearConfig } from '../src/linear.js';
import type { LinearProjectConfig } from '../src/project-config.js';

const validConfig: LinearProjectConfig = {
  team: 'ENG',
  afkLabel: 'AFK',
  workflowStates: {
    ready: 'Ready',
    running: 'In Progress',
    done: 'Done',
    handoff: 'Needs Handoff',
  },
};

test('resolves stable Linear config IDs', async () => {
  const resolved = await resolveLinearConfig({
    config: validConfig,
    env: { LINEAR_API_KEY: 'linear-key' },
    client: new FakeLinearClient(),
  });

  assert.deepEqual(resolved, {
    teamId: 'team-1',
    teamKey: 'ENG',
    labelId: 'label-1',
    workflowStateIds: {
      ready: 'state-ready',
      running: 'state-running',
      done: 'state-done',
      handoff: 'state-handoff',
    },
  });
});

test('fails Linear startup when credentials are absent', async () => {
  await assert.rejects(
    () => resolveLinearConfig({ config: validConfig, env: {}, client: new FakeLinearClient() }),
    (error) => error instanceof LinearStartupError && /LINEAR_API_KEY/.test(error.message),
  );
});

test('fails Linear startup when configured team cannot be resolved', async () => {
  await assert.rejects(
    () =>
      resolveLinearConfig({
        config: { ...validConfig, team: 'MISSING' },
        env: { LINEAR_API_KEY: 'linear-key' },
        client: new FakeLinearClient(),
      }),
    (error) => error instanceof LinearStartupError && /team "MISSING" was not found/.test(error.message),
  );
});

test('fails Linear startup when configured AFK label cannot be resolved', async () => {
  await assert.rejects(
    () =>
      resolveLinearConfig({
        config: { ...validConfig, afkLabel: 'Missing Label' },
        env: { LINEAR_API_KEY: 'linear-key' },
        client: new FakeLinearClient(),
      }),
    (error) => error instanceof LinearStartupError && /AFK label "Missing Label" was not found/.test(error.message),
  );
});

test('fails Linear startup when a workflow state cannot be resolved', async () => {
  await assert.rejects(
    () =>
      resolveLinearConfig({
        config: { ...validConfig, workflowStates: { ...validConfig.workflowStates, handoff: 'Missing Handoff' } },
        env: { LINEAR_API_KEY: 'linear-key' },
        client: new FakeLinearClient(),
      }),
    (error) =>
      error instanceof LinearStartupError &&
      /handoff workflow state "Missing Handoff" was not found/.test(error.message),
  );
});

class FakeLinearClient implements LinearConfigClient {
  private readonly team: LinearTeam = { id: 'team-1', key: 'ENG', name: 'Engineering' };
  private readonly label: LinearEntity = { id: 'label-1', name: 'AFK' };
  private readonly states: LinearWorkflowState[] = [
    { id: 'state-ready', name: 'Ready', teamId: 'team-1' },
    { id: 'state-running', name: 'In Progress', teamId: 'team-1' },
    { id: 'state-done', name: 'Done', teamId: 'team-1' },
    { id: 'state-handoff', name: 'Needs Handoff', teamId: 'team-1' },
  ];

  async findTeam(identifier: string): Promise<LinearTeam | null> {
    return [this.team.id, this.team.key].includes(identifier) ? this.team : null;
  }

  async findIssueLabel(teamId: string, name: string): Promise<LinearEntity | null> {
    return teamId === this.team.id && name === this.label.name ? this.label : null;
  }

  async findWorkflowState(teamId: string, identifier: string): Promise<LinearWorkflowState | null> {
    return this.states.find((state) => state.teamId === teamId && [state.id, state.name].includes(identifier)) ?? null;
  }
}
