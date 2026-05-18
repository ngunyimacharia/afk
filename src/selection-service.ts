import type { TicketRecord } from './types.js';

export type TicketChooser = (tickets: TicketRecord[]) => Promise<TicketRecord[] | null>;

export class SelectionService {
  constructor(private readonly chooser: TicketChooser) {}

  async selectTickets(tickets: TicketRecord[]): Promise<TicketRecord[]> {
    const selected = await this.chooser(tickets);
    if (!selected?.length) return [];
    const seen = new Set<string>();
    return selected.filter((ticket) => (seen.has(ticket.path) ? false : (seen.add(ticket.path), true)));
  }
}
