import { createProvidersEnvironmentAtoms } from "@t3tools/client-runtime/state/providers";

import { connectionAtomRuntime } from "../connection/runtime";

export const providersEnvironment = createProvidersEnvironmentAtoms(connectionAtomRuntime);
