export function swallow(action: () => void): void {
  try {
    action();
  } catch {}
}
