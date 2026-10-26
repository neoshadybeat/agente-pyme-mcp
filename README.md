# agente-pyme-mcp

**An AI back-office agent for a small business, built the way it should run in production:** an MCP server that owns the business rules, a Claude agent that uses it, a human approval gate for anything that changes state, and tests + evals.

*Agente de IA para el back office de una pyme: presupuestos, facturas vencidas y recordatorios de pago, con servidor MCP, aprobación humana, tests y evals. [Resumen en español abajo](#en-español).*

> Demo with a fictional HVAC company in Madrid. All clients, emails and figures in `data/seed.json` are made up.

## What it does

Ask in plain language:

- *"Prepara un presupuesto para Oficinas Castellana: 2 splits de 3,5 kW con su instalación."*
- *"¿Qué facturas están vencidas? Redacta un recordatorio firme para la más antigua."*

The agent looks up the client, picks products from the catalogue, creates a **draft** quote and drafts reminder emails. It never sends anything, and it can only approve a quote after a person says yes.

## Design choices (the part that matters for production)

| Concern | How it's handled |
|---|---|
| **The model never does the maths** | Totals, VAT and discounts are computed in `src/backoffice.ts`, and the tool description tells the model to quote them as-is. |
| **Policy lives in code, not in the prompt** | Discounts above 15 % need a manager. The approver's role comes from server config (`APPROVER_ROLE`), so the model can't claim to be a manager. |
| **Human in the loop** | `approve_quote` is marked `destructiveHint`; the agent asks a human before running it (`NEEDS_HUMAN_APPROVAL` in `src/agent.ts`). MCP clients like Claude Desktop also ask for confirmation. |
| **Drafts, not side effects** | Quotes are created as drafts and reminders are returned as text. Sending is deliberately out of scope. |
| **Recoverable errors** | Unknown client/product, bad discount, missing approval → returned as tool errors with a hint ("use get_catalogue"), so the model can correct itself instead of crashing. |
| **Tested and evaluated** | Unit + MCP protocol tests (`pnpm test`, no API key needed), and behavioural evals against the real model (`pnpm evals`). |
| **One server, many clients** | The same MCP server works with this agent, Claude Desktop, Claude Code or any MCP-capable assistant. |

## Architecture

```
 you ──► agent.ts (Claude, tool loop, human approval gate)
              │  MCP over stdio
              ▼
          server.ts (6 tools, safety annotations)
              │
              ▼
          backoffice.ts (rules: totals, VAT, discount limits, approvals)
              │
              ▼
          data/seed.json (fictional company)
```

Tools: `search_clients`, `get_catalogue`, `create_quote_draft`, `approve_quote`, `list_overdue_invoices`, `draft_payment_reminder`.

## Run it

Requires Node.js 22.18+ (TypeScript runs natively, no build step) and pnpm.

```bash
pnpm install
pnpm test            # unit + MCP tests, no API key needed
pnpm agent           # interactive agent (needs Claude API credentials: ANTHROPIC_API_KEY or `ant auth login`)
pnpm evals           # behavioural evals against the real model (a few cents per run)
```

### Use it from Claude Code or Claude Desktop

```bash
claude mcp add agente-pyme -- node /absolute/path/to/agente-pyme-mcp/src/server.ts
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agente-pyme": { "command": "node", "args": ["/absolute/path/to/agente-pyme-mcp/src/server.ts"], "env": { "APPROVER_ROLE": "staff" } }
  }
}
```

## Taking it to a real company

What changes in a client project: the JSON file becomes their ERP/CRM API or database, the MCP server moves to an HTTP transport with OAuth and per-user permissions, every tool call is logged for audit, and the evals grow from real conversations. That's the work I do as a freelance: **[cayetano.dev](https://cayetano.dev)**.

---

## En español

Demo de un **agente de IA para el back office de una pyme** (empresa ficticia de climatización en Madrid): busca clientes, consulta el catálogo, crea **borradores** de presupuesto, lista facturas vencidas y redacta recordatorios de pago.

Lo importante es cómo está hecho:

- **El modelo no hace cuentas:** totales, IVA y descuentos se calculan en código.
- **Las reglas están en el código, no en el prompt:** un descuento por encima del 15 % requiere a un responsable, y el rol lo fija la configuración del servidor, no el modelo.
- **Aprobación humana:** aprobar un presupuesto exige que una persona diga que sí.
- **Nada se envía solo:** presupuestos y recordatorios son borradores.
- **Errores recuperables, tests y evals.**
- **Un servidor MCP para todo:** sirve para este agente, para Claude Desktop, Claude Code o cualquier asistente compatible con MCP.

¿Quieres algo así conectado a tu ERP, CRM o correo? Escríbeme en **[cayetano.dev](https://cayetano.dev)**.

## License

MIT © Cayetano Soriano Gallego
