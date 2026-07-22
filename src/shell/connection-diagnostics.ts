// Connection diagnostics — detect TURN vs Direct P2P

export async function getConnectionRoute(room: any): Promise<string> {
  try {
    const pc = room?._peer?._pc || room?._peers?.values?.().next?.().value?._pc;
    if (!pc) return 'Direct P2P';
    const stats = await pc.getStats();
    let usingTurn = false;
    stats.forEach((r: any) => {
      if (r.type === 'local-candidate' && r.candidateType === 'relay') usingTurn = true;
      if (r.type === 'remote-candidate' && r.candidateType === 'relay') usingTurn = true;
    });
    return usingTurn ? 'TURN relay' : 'Direct P2P';
  } catch {
    return 'Direct P2P';
  }
}