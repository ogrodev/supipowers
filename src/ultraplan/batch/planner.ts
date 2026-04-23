import type { UltraPlanBatchNode, UltraPlanBatchRun } from "../../types.js";

function buildSessionNodeMap(run: UltraPlanBatchRun): Map<string, UltraPlanBatchNode> {
  return new Map(run.nodes.map((node) => [node.sessionId, node]));
}

export function getUltraPlanBatchGraphErrors(run: UltraPlanBatchRun): string[] {
  const errors: string[] = [];
  const seenNodeIds = new Set<string>();
  const seenSessionIds = new Set<string>();
  const nodesBySessionId = new Map<string, UltraPlanBatchNode>();

  for (const node of run.nodes) {
    if (seenNodeIds.has(node.nodeId)) {
      errors.push(`duplicate batch nodeId ${node.nodeId}`);
    }
    seenNodeIds.add(node.nodeId);

    if (seenSessionIds.has(node.sessionId)) {
      errors.push(`duplicate batch sessionId ${node.sessionId}`);
    }
    seenSessionIds.add(node.sessionId);
    nodesBySessionId.set(node.sessionId, node);
  }

  const wavesByIndex = new Map<number, Set<string>>();
  const sessionsInWaves = new Set<string>();
  for (const wave of run.waves) {
    if (wavesByIndex.has(wave.waveIndex)) {
      errors.push(`duplicate batch waveIndex ${wave.waveIndex}`);
      continue;
    }
    const sessions = new Set<string>();
    for (const sessionId of wave.sessionIds) {
      if (sessions.has(sessionId)) {
        errors.push(`batch wave ${wave.waveIndex} lists ${sessionId} more than once`);
      }
      if (sessionsInWaves.has(sessionId)) {
        errors.push(`batch session ${sessionId} appears in more than one wave`);
      }
      sessions.add(sessionId);
      sessionsInWaves.add(sessionId);
    }
    wavesByIndex.set(wave.waveIndex, sessions);
  }

  for (const node of run.nodes) {
    const waveMembers = wavesByIndex.get(node.waveIndex);
    if (!waveMembers) {
      errors.push(`batch node ${node.sessionId} references missing wave ${node.waveIndex}`);
      continue;
    }
    if (!waveMembers.has(node.sessionId)) {
      errors.push(`batch node ${node.sessionId} is missing from wave ${node.waveIndex}`);
    }
  }

  for (const wave of run.waves) {
    for (const sessionId of wave.sessionIds) {
      const node = nodesBySessionId.get(sessionId);
      if (!node) {
        errors.push(`batch wave ${wave.waveIndex} references unknown session ${sessionId}`);
        continue;
      }
      if (node.waveIndex !== wave.waveIndex) {
        errors.push(`batch wave ${wave.waveIndex} includes ${sessionId}, but the node is assigned to wave ${node.waveIndex}`);
      }
    }
  }

  for (const node of run.nodes) {
    for (const dependencySessionId of node.dependencies) {
      const dependencyNode = nodesBySessionId.get(dependencySessionId);
      if (!dependencyNode) {
        errors.push(`batch node ${node.sessionId} depends on unknown session ${dependencySessionId}`);
        continue;
      }
      if (dependencyNode.waveIndex > node.waveIndex) {
        errors.push(
          `batch node ${node.sessionId} depends on ${dependencySessionId} from a later wave (${dependencyNode.waveIndex} > ${node.waveIndex})`,
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(sessionId: string): void {
    if (visiting.has(sessionId)) {
      errors.push(`dependency cycle detected at session ${sessionId}`);
      return;
    }
    if (visited.has(sessionId)) {
      return;
    }

    visiting.add(sessionId);
    const node = nodesBySessionId.get(sessionId);
    if (node) {
      for (const dependencySessionId of node.dependencies) {
        if (nodesBySessionId.has(dependencySessionId)) {
          visit(dependencySessionId);
        }
      }
    }
    visiting.delete(sessionId);
    visited.add(sessionId);
  }

  for (const node of run.nodes) {
    visit(node.sessionId);
  }

  return [...new Set(errors)];
}

export function buildUltraPlanBatchRunGraph(run: UltraPlanBatchRun): UltraPlanBatchRun {
  const errors = getUltraPlanBatchGraphErrors(run);
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  return run;
}

function dependenciesAreMerged(node: UltraPlanBatchNode, nodesBySessionId: Map<string, UltraPlanBatchNode>): boolean {
  return node.dependencies.every((dependencySessionId) => nodesBySessionId.get(dependencySessionId)?.state === "merged");
}

function isDependencyBlocked(node: UltraPlanBatchNode): boolean {
  return node.state === "blocked" && node.blockerKind === "dependency";
}

export function computeUltraPlanBatchEligibleFrontier(run: UltraPlanBatchRun): UltraPlanBatchNode[] {
  const validatedRun = buildUltraPlanBatchRunGraph(run);
  const nodesBySessionId = buildSessionNodeMap(validatedRun);

  return validatedRun.nodes.filter((node) => {
    if (node.state === "pending") {
      return dependenciesAreMerged(node, nodesBySessionId);
    }

    if (isDependencyBlocked(node)) {
      return dependenciesAreMerged(node, nodesBySessionId);
    }

    return false;
  });
}