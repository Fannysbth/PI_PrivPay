export function fireAndForget(task: () => Promise<void>): void {
  task();
}
