/**
 * 去重只看异常身份及当前事实，不把请求/版本或处理中往返当作新证据。
 * 内容仅参与本地相等比较，返回值不可写入日志；日志仍走原有脱敏证据。
 */
export function incidentReportKey(active, snapshot, status, evidence) {
  const ids = new Set(active.ids);
  const entries = new Map(snapshot.entries.filter(entry => ids.has(entry.id)).map(entry => [entry.id, entry]));
  return JSON.stringify({
    status: status === "recovered" ? status : active.confirmed ? "active" : "pending",
    sourceToken: snapshot.sourceToken ?? snapshot.instanceToken ?? snapshot.instanceId ?? null,
    ids: active.ids,
    nodes: evidence.nodes.filter(node => ids.has(node.id)).map(node => ({
      id: node.id, after: node.after, title: entries.get(node.id)?.title, url: entries.get(node.id)?.url,
    })),
    issues: evidence.issues.filter(issue => issue.ids.some(id => ids.has(id))),
    orderChanges: evidence.orderChanges.filter(change => ids.has(change.id)),
  });
}
