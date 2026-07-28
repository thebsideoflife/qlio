/**
 * IQ Agent API client.
 *
 * The contract is small on purpose: send a message, poll the event log from a
 * cursor, cancel, and read/write prompt overrides. Everything the panel renders
 * comes from the event log.
 */

import axios from "axios";
import type {
  AgentBrief,
  AgentEventsResponse,
  AgentPromptSpec,
  SendMessageResponse,
} from "./agentTypes";

const API_URL = import.meta.env.VITE_API_URL;
const AUTH_KEY = "api_password";

const authHeaders = () => {
  const password = localStorage.getItem(AUTH_KEY);
  return password ? { "x-api-password": password } : {};
};

// ============================================================================
// Calls
// ============================================================================

const base = (projectId: string) => `${API_URL}/projects/${projectId}/agent`;

export async function sendAgentMessage(
  projectId: string,
  body: {
    text?: string;
    brief?: AgentBrief;
    answerTo?: string;
    isBrief?: boolean;
    idempotencyKey: string;
  },
): Promise<SendMessageResponse> {
  const response = await axios.post(`${base(projectId)}/messages`, body, {
    headers: authHeaders(),
  });
  return response.data;
}

export async function fetchAgentEvents(
  projectId: string,
  after: number,
  signal?: AbortSignal,
): Promise<AgentEventsResponse> {
  const response = await axios.get(`${base(projectId)}/events`, {
    params: { after },
    headers: authHeaders(),
    signal,
  });
  return response.data;
}

export async function cancelAgentRun(
  projectId: string,
): Promise<{ cancelled: boolean; note?: string }> {
  const response = await axios.post(
    `${base(projectId)}/cancel`,
    {},
    { headers: authHeaders() },
  );
  return response.data;
}

export async function fetchAgentPrompts(
  projectId: string,
): Promise<{ version: string; prompts: AgentPromptSpec[] }> {
  const response = await axios.get(`${base(projectId)}/prompts`, {
    headers: authHeaders(),
  });
  return response.data;
}

export async function saveAgentPrompts(
  projectId: string,
  overrides: Record<string, string | null>,
): Promise<{ saved: boolean; overridden: string[] }> {
  const response = await axios.post(
    `${base(projectId)}/prompts`,
    { overrides },
    { headers: authHeaders() },
  );
  return response.data;
}
