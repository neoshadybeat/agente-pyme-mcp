// Business logic for the demo back office. The model never does arithmetic or
// decides policy: totals, VAT, discount limits and approval rules live here,
// so they are deterministic and covered by unit tests.
import { readFileSync } from "node:fs";

export type Client = { id: string; name: string; taxId: string; email: string; city: string; segment: string };
export type Product = { id: string; name: string; category: string; unitPrice: number; unit: string };
export type Invoice = { id: string; clientId: string; issueDate: string; dueDate: string; total: number; status: "pending" | "paid" };
export type QuoteLine = { productId: string; name: string; quantity: number; unitPrice: number; discount: number; amount: number };
export type Quote = {
  id: string;
  clientId: string;
  lines: QuoteLine[];
  subtotal: number;
  vat: number;
  total: number;
  notes: string;
  status: "draft" | "approved";
  needsManagerApproval: boolean;
  approvedBy?: string;
  createdAt: string;
};
type Data = {
  company: { name: string; vatRate: number; maxDiscountWithoutApproval: number };
  clients: Client[];
  products: Product[];
  invoices: Invoice[];
  quotes: Quote[];
};

export class BackofficeError extends Error {}

const round2 = (n: number) => Math.round(n * 100) / 100;
const normalize = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export class Backoffice {
  private data: Data;
  private now: () => Date;

  constructor(data: Data, now: () => Date = () => new Date()) {
    this.data = structuredClone(data);
    this.now = now;
  }

  static fromFile(path: string, now?: () => Date) {
    return new Backoffice(JSON.parse(readFileSync(path, "utf8")) as Data, now);
  }

  get company() {
    return this.data.company;
  }

  searchClients(query: string): Client[] {
    const q = normalize(query.trim());
    if (!q) return this.data.clients;
    return this.data.clients.filter((c) =>
      [c.id, c.name, c.taxId, c.email, c.city].some((field) => normalize(field).includes(q)),
    );
  }

  catalogue(category?: string): Product[] {
    if (!category) return this.data.products;
    const c = normalize(category);
    return this.data.products.filter((p) => normalize(p.category) === c);
  }

  createQuoteDraft(input: { clientId: string; lines: { productId: string; quantity: number; discount?: number }[]; notes?: string }): Quote {
    const client = this.data.clients.find((c) => c.id === input.clientId);
    if (!client) throw new BackofficeError(`Unknown client ${input.clientId}. Use search_clients first.`);
    if (input.lines.length === 0) throw new BackofficeError("A quote needs at least one line.");

    const lines = input.lines.map((l) => {
      const product = this.data.products.find((p) => p.id === l.productId);
      if (!product) throw new BackofficeError(`Unknown product ${l.productId}. Use get_catalogue to find valid ids.`);
      if (!Number.isFinite(l.quantity) || l.quantity <= 0) throw new BackofficeError(`Invalid quantity for ${l.productId}.`);
      const discount = l.discount ?? 0;
      if (discount < 0 || discount > 0.5) throw new BackofficeError(`Discount for ${l.productId} must be between 0 and 0.5.`);
      return {
        productId: product.id,
        name: product.name,
        quantity: l.quantity,
        unitPrice: product.unitPrice,
        discount,
        amount: round2(product.unitPrice * l.quantity * (1 - discount)),
      };
    });

    const subtotal = round2(lines.reduce((sum, l) => sum + l.amount, 0));
    const vat = round2(subtotal * this.data.company.vatRate);
    const quote: Quote = {
      id: `Q-${String(this.data.quotes.length + 1).padStart(4, "0")}`,
      clientId: client.id,
      lines,
      subtotal,
      vat,
      total: round2(subtotal + vat),
      notes: input.notes ?? "",
      status: "draft",
      needsManagerApproval: lines.some((l) => l.discount > this.data.company.maxDiscountWithoutApproval),
      createdAt: this.now().toISOString(),
    };
    this.data.quotes.push(quote);
    return quote;
  }

  getQuote(id: string): Quote {
    const quote = this.data.quotes.find((q) => q.id === id);
    if (!quote) throw new BackofficeError(`Unknown quote ${id}.`);
    return quote;
  }

  approveQuote(id: string, approvedBy: string, role: "staff" | "manager"): Quote {
    const quote = this.getQuote(id);
    if (quote.status === "approved") throw new BackofficeError(`Quote ${id} is already approved.`);
    if (quote.needsManagerApproval && role !== "manager") {
      throw new BackofficeError(`Quote ${id} has a discount above the limit and needs a manager's approval.`);
    }
    quote.status = "approved";
    quote.approvedBy = approvedBy;
    return quote;
  }

  overdueInvoices(minDaysOverdue = 1) {
    const today = this.now();
    return this.data.invoices
      .filter((i) => i.status === "pending")
      .map((i) => {
        const days = Math.floor((today.getTime() - new Date(`${i.dueDate}T00:00:00Z`).getTime()) / 86_400_000);
        const client = this.data.clients.find((c) => c.id === i.clientId)!;
        return { ...i, clientName: client.name, clientEmail: client.email, daysOverdue: days };
      })
      .filter((i) => i.daysOverdue >= minDaysOverdue)
      .sort((a, b) => b.daysOverdue - a.daysOverdue);
  }

  // Drafts only: sending is deliberately out of scope, a human reviews and sends.
  draftReminder(invoiceId: string, tone: "friendly" | "firm") {
    const invoice = this.overdueInvoices(1).find((i) => i.id === invoiceId);
    if (!invoice) throw new BackofficeError(`Invoice ${invoiceId} is not overdue (or does not exist).`);
    const amount = invoice.total.toLocaleString("es-ES", { style: "currency", currency: "EUR" });
    const opening =
      tone === "friendly"
        ? `Le escribimos para recordarle que la factura ${invoice.id}, por importe de ${amount}, venció el ${invoice.dueDate}. Es posible que se haya traspapelado.`
        : `La factura ${invoice.id}, por importe de ${amount}, lleva ${invoice.daysOverdue} días vencida desde el ${invoice.dueDate}. Le rogamos que regularice el pago en los próximos 7 días.`;
    return {
      to: invoice.clientEmail,
      subject: `Recordatorio de pago: factura ${invoice.id}`,
      body: `Estimado cliente (${invoice.clientName}):\n\n${opening}\n\nSi ya ha realizado el pago, por favor ignore este mensaje.\n\nUn saludo,\n${this.data.company.name}`,
      status: "draft — not sent",
    };
  }
}
