/// <reference types="vite/client" />
interface Document { modelContext?: { registerTool(tool: unknown, options?: {signal?: AbortSignal}): void | Promise<void> } }
