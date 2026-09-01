export function createCliModuleLoader<T>(load: () => Promise<T>): () => Promise<T> {
  // CLI importers run synchronously and return their exact promise; rejections stay
  // sticky so later command attempts cannot change module activation state.
  let promise: Promise<T> | undefined;
  return () => (promise ??= load());
}
