import { createAppsEnvironmentAtoms } from "@t3tools/client-runtime/state/apps";

import { connectionAtomRuntime } from "../connection/runtime";

export const appsEnvironment = createAppsEnvironmentAtoms(connectionAtomRuntime);
