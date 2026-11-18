/**
 * Starts work that nothing waits for, such as navigation from an event handler.
 * A rejection is logged by name. It does not become an unhandled rejection.
 */
export function detached(task: void | Promise<unknown>): void {
  if (task instanceof Promise) {
    task.catch((error: unknown) => {
      console.error("detached_task_failed", { cause: error instanceof Error ? error.name : "unknown" });
    });
  }
}
