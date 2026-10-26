import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fileURLToPath } from "node:url";
import { Backoffice, BackofficeError } from "../src/backoffice.ts";
import { createServer } from "../src/server.ts";

const seed = fileURLToPath(new URL("../data/seed.json", import.meta.url));
const today = () => new Date("2026-10-26T10:00:00Z");
const backoffice = () => Backoffice.fromFile(seed, today);

describe("backoffice", () => {
  it("finds clients ignoring accents and case", () => {
    expect(backoffice().searchClients("alcala").map((c) => c.id)).toEqual(["C003"]);
    expect(backoffice().searchClients("CLINICA")[0]!.id).toBe("C002");
  });

  it("computes quote totals and VAT in code", () => {
    const q = backoffice().createQuoteDraft({
      clientId: "C001",
      lines: [
        { productId: "P-SPLIT-35", quantity: 2 },
        { productId: "S-INST-SPLIT", quantity: 2, discount: 0.1 },
      ],
    });
    expect(q.subtotal).toBe(2464); // 2*890 + 2*380*0.9
    expect(q.vat).toBe(517.44);
    expect(q.total).toBe(2981.44);
    expect(q.status).toBe("draft");
    expect(q.needsManagerApproval).toBe(false);
  });

  it("rejects unknown products and clients with a recoverable error", () => {
    const b = backoffice();
    expect(() => b.createQuoteDraft({ clientId: "C999", lines: [{ productId: "P-SPLIT-35", quantity: 1 }] })).toThrow(BackofficeError);
    expect(() => b.createQuoteDraft({ clientId: "C001", lines: [{ productId: "NOPE", quantity: 1 }] })).toThrow(/get_catalogue/);
  });

  it("requires a manager for discounts above the limit", () => {
    const b = backoffice();
    const q = b.createQuoteDraft({ clientId: "C002", lines: [{ productId: "P-CASS-70", quantity: 1, discount: 0.2 }] });
    expect(q.needsManagerApproval).toBe(true);
    expect(() => b.approveQuote(q.id, "Ana", "staff")).toThrow(/manager/);
    expect(b.approveQuote(q.id, "Ana", "manager").status).toBe("approved");
    expect(() => b.approveQuote(q.id, "Ana", "manager")).toThrow(/already approved/);
  });

  it("lists overdue invoices, most overdue first, excluding paid and not-yet-due", () => {
    const overdue = backoffice().overdueInvoices();
    expect(overdue.map((i) => i.id)).toEqual(["F-2026-0101", "F-2026-0117", "F-2026-0135"]);
    expect(overdue[0]!.daysOverdue).toBe(73);
  });

  it("drafts reminders without sending them", () => {
    const r = backoffice().draftReminder("F-2026-0101", "firm");
    expect(r.status).toMatch(/not sent/);
    expect(r.to).toBe("compras@castellana-demo.example");
    expect(r.body).toContain("73 días");
    expect(() => backoffice().draftReminder("F-2026-0131", "friendly")).toThrow(/not overdue/);
  });
});

describe("MCP server", () => {
  async function connect(role: "staff" | "manager" = "staff") {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer(backoffice(), role).connect(serverSide);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);
    return client;
  }

  it("exposes the six tools with safety annotations", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "approve_quote", "create_quote_draft", "draft_payment_reminder", "get_catalogue", "list_overdue_invoices", "search_clients",
    ]);
    expect(tools.find((t) => t.name === "approve_quote")!.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "search_clients")!.annotations?.readOnlyHint).toBe(true);
  });

  it("returns business-rule violations as tool errors, not crashes", async () => {
    const client = await connect("staff");
    const created = await client.callTool({
      name: "create_quote_draft",
      arguments: { clientId: "C002", lines: [{ productId: "P-CASS-70", quantity: 1, discount: 0.2 }] },
    });
    const quote = JSON.parse((created.content as { text: string }[])[0]!.text);
    const approved = await client.callTool({ name: "approve_quote", arguments: { quoteId: quote.id, approvedBy: "Ana" } });
    expect(approved.isError).toBe(true);
    expect((approved.content as { text: string }[])[0]!.text).toMatch(/manager/);
  });
});
