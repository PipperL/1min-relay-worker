/**
 * Models endpoint handler
 */

import { getModelData } from "../services/model-registry";
import type {
  CachedModelData,
  Env,
  ModelObject,
  ModelsResponse,
  OneMinModelEntry,
} from "../types";
import { createSuccessResponse, ModelNotFoundError } from "../utils";

interface CapabilitySets {
  chat: Set<string>;
  vision: Set<string>;
  codeInterpreter: Set<string>;
}

function capabilitySets(data: CachedModelData): CapabilitySets {
  return {
    chat: new Set(data.chatModelIds),
    vision: new Set(data.visionModelIds),
    codeInterpreter: new Set(data.codeInterpreterModelIds),
  };
}

export function buildModelObject(
  entry: OneMinModelEntry,
  fetchedAt: number,
  sets: CapabilitySets,
): ModelObject {
  return {
    id: entry.modelId,
    object: "model",
    created: Math.floor(fetchedAt / 1000),
    owned_by: entry.provider || "1min-ai",
    permission: [] as unknown[],
    root: entry.modelId,
    parent: null as unknown,
    capabilities: {
      vision: sets.vision.has(entry.modelId),
      code_interpreter: sets.codeInterpreter.has(entry.modelId),
      retrieval: sets.chat.has(entry.modelId),
    },
  };
}

export async function handleModelsEndpoint(env: Env): Promise<Response> {
  const data = await getModelData(env);
  const sets = capabilitySets(data);

  const models: ModelObject[] = data.entries.map((entry) =>
    buildModelObject(entry, data.fetchedAt, sets),
  );

  const response: ModelsResponse = {
    object: "list",
    data: models,
  };

  return createSuccessResponse(response);
}

/**
 * OpenAI's retrieve-model endpoint (GET /v1/models/{model}).
 *
 * Some SDKs call this to check a model before using it; without it they got a
 * 404 from the router rather than an API-shaped answer.
 */
export async function handleModelEndpoint(
  env: Env,
  modelId: string,
): Promise<Response> {
  const data = await getModelData(env);
  const entry = data.entries.find((m) => m.modelId === modelId);

  if (!entry) {
    throw new ModelNotFoundError(modelId);
  }

  return createSuccessResponse(
    buildModelObject(entry, data.fetchedAt, capabilitySets(data)),
  );
}
