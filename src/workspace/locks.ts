function getWorkspaceTargetLockKey(commandName: string, targetId: string): string {
  return `${commandName}:${targetId}`;
}

const activeWorkspaceTargetLocks = new Set<string>();

export function tryAcquireWorkspaceTargetLock(commandName: string, targetId: string): boolean {
  const key = getWorkspaceTargetLockKey(commandName, targetId);
  if (activeWorkspaceTargetLocks.has(key)) {
    return false;
  }

  activeWorkspaceTargetLocks.add(key);
  return true;
}

export function releaseWorkspaceTargetLock(commandName: string, targetId: string): void {
  activeWorkspaceTargetLocks.delete(getWorkspaceTargetLockKey(commandName, targetId));
}

export function isWorkspaceTargetLocked(commandName: string, targetId: string): boolean {
  return activeWorkspaceTargetLocks.has(getWorkspaceTargetLockKey(commandName, targetId));
}
