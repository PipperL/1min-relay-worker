import { Hono } from "hono";
import { handleModelEndpoint, handleModelsEndpoint } from "../handlers";
import { authMiddleware } from "../middleware/auth";
import type { ModelsResponse } from "../types";
import type { HonoEnv } from "../types/hono";

const app = new Hono<HonoEnv>();

app.get("/", authMiddleware, async (c) => {
  const response = await handleModelsEndpoint(c.env);
  const data = (await response.json()) as ModelsResponse;
  return c.json(data);
});

// Retrieve a single model. The pattern has to swallow slashes: upstream ids
// such as "black-forest-labs/flux-dev" contain them, and clients send them
// both raw and percent-encoded.
app.get("/:model{.+}", authMiddleware, async (c) => {
  const raw = c.req.param("model");
  let modelId = raw;
  try {
    modelId = decodeURIComponent(raw);
  } catch {
    // Malformed percent-encoding — fall back to the raw value
  }
  return handleModelEndpoint(c.env, modelId);
});

export default app;
