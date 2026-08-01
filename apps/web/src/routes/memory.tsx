import { createFileRoute } from "@tanstack/react-router";

import { MemoryView } from "../components/MemoryView";

function MemoryRoute() {
  return <MemoryView />;
}

export const Route = createFileRoute("/memory")({
  component: MemoryRoute,
});
