// MCP server exposing the back office to any MCP client (Claude Desktop, Claude Code,
// ChatGPT connectors, or the agent in agent.ts). Run: node src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Backoffice, BackofficeError } from "./backoffice.ts";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function result(fn: () => unknown): ToolResult {
  try {
    return { content: [{ type: "text", text: JSON.stringify(fn(), null, 2) }] };
  } catch (err) {
    // Business-rule violations go back to the model as tool errors it can recover from.
    if (err instanceof BackofficeError) return { content: [{ type: "text", text: err.message }], isError: true };
    throw err;
  }
}

// The approver's role comes from the server's configuration, never from the model.
export function createServer(backoffice: Backoffice, approverRole: "staff" | "manager" = "staff") {
  const server = new McpServer({ name: "agente-pyme", version: "0.1.0" });

  server.registerTool(
    "search_clients",
    {
      title: "Search clients",
      description: "Find clients by name, tax id, email or city. Returns their ids, needed for quotes.",
      inputSchema: { query: z.string().describe("Free text; empty returns every client") },
      annotations: { readOnlyHint: true },
    },
    ({ query }) => result(() => backoffice.searchClients(query)),
  );

  server.registerTool(
    "get_catalogue",
    {
      title: "Get catalogue",
      description: "List products and services with ids and unit prices (EUR, VAT excluded). Categories: equipos, instalación, mantenimiento, otros.",
      inputSchema: { category: z.string().optional().describe("Optional category filter") },
      annotations: { readOnlyHint: true },
    },
    ({ category }) => result(() => backoffice.catalogue(category)),
  );

  server.registerTool(
    "create_quote_draft",
    {
      title: "Create quote draft",
      description:
        "Create a DRAFT quote. Totals and VAT are computed by the system; never compute them yourself. " +
        "Discounts are fractions (0.1 = 10%); above the company limit the quote needs a manager's approval. " +
        "A draft is not sent to anyone.",
      inputSchema: {
        clientId: z.string(),
        lines: z
          .array(z.object({ productId: z.string(), quantity: z.number().positive(), discount: z.number().min(0).max(0.5).optional() }))
          .min(1),
        notes: z.string().optional(),
      },
    },
    (input) => result(() => backoffice.createQuoteDraft(input)),
  );

  server.registerTool(
    "approve_quote",
    {
      title: "Approve quote",
      description: "Approve a draft quote so it can be sent. Only call this after a human has explicitly confirmed it.",
      inputSchema: { quoteId: z.string(), approvedBy: z.string().describe("Name of the person who approved it") },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    ({ quoteId, approvedBy }) => result(() => backoffice.approveQuote(quoteId, approvedBy, approverRole)),
  );

  server.registerTool(
    "list_overdue_invoices",
    {
      title: "List overdue invoices",
      description: "Pending invoices past their due date, most overdue first, with client contact.",
      inputSchema: { minDaysOverdue: z.number().int().min(1).optional() },
      annotations: { readOnlyHint: true },
    },
    ({ minDaysOverdue }) => result(() => backoffice.overdueInvoices(minDaysOverdue)),
  );

  server.registerTool(
    "draft_payment_reminder",
    {
      title: "Draft payment reminder",
      description: "Write a payment reminder email for an overdue invoice. Returns a draft only; nothing is sent.",
      inputSchema: { invoiceId: z.string(), tone: z.enum(["friendly", "firm"]) },
      annotations: { readOnlyHint: true },
    },
    ({ invoiceId, tone }) => result(() => backoffice.draftReminder(invoiceId, tone)),
  );

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dataFile = process.env.BACKOFFICE_DATA ?? fileURLToPath(new URL("../data/seed.json", import.meta.url));
  const role = process.env.APPROVER_ROLE === "manager" ? "manager" : "staff";
  const server = createServer(Backoffice.fromFile(dataFile), role);
  await server.connect(new StdioServerTransport());
}
