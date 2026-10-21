/*
 * n8n OpenAI Bridge
 * Copyright (C) 2025 Sven Eisenschmidt
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

function createRunStepEvent({ stepId, runId, toolCallId, toolName, toolArgs, index = 0 }) {
  return {
    event: 'on_run_step',
    data: {
      id: stepId,
      index,
      runId,
      status: 'in_progress',
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [
          {
            id: toolCallId,
            type: 'tool_call',
            name: toolName,
            args: toolArgs,
          },
        ],
      },
    },
  };
}

function createRunStepCompletedEvent({ stepId, toolCallId, toolName, toolArgs, output, completedAt }) {
  return {
    event: 'on_run_step_completed',
    data: {
      result: {
        id: stepId,
        completed_at: completedAt,
        tool_call: {
          id: toolCallId,
          type: 'tool_call',
          name: toolName,
          args: toolArgs,
          output,
          progress: 1,
        },
      },
    },
  };
}

function createRunStepClosedEvent({ stepId, completedAt }) {
  return {
    event: 'on_run_step_closed',
    data: {
      id: stepId,
      status: 'completed',
      completed_at: completedAt,
    },
  };
}

module.exports = {
  createRunStepEvent,
  createRunStepCompletedEvent,
  createRunStepClosedEvent,
};
