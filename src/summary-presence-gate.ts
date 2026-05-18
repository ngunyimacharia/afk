export class SummaryPresenceGate {
  hasSummary(content: string): boolean {
    return /^##\s+AFK Summary\s*$/im.test(content);
  }
}
