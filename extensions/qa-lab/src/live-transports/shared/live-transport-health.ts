export function assertPollingTransportHealthy(
  pollingError: Error | undefined,
  leaseHeartbeat: { throwIfFailed(): void },
): void {
  if (pollingError) {
    throw pollingError;
  }
  leaseHeartbeat.throwIfFailed();
}
