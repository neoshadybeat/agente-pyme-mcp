// Back-office agent: Claude + the MCP server in server.ts, with a human approval gate.
// Run: node src/agent.ts   (credentials: ANTHROPIC_API_KEY or `ant auth login`)
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const MODEL = "claude-opus-5-5";
// Tools that change state: the agent must get a human "yes" before they run.
const NEEDS_HUMAN_APPROVAL = new Set(["approve_quote"]);

const SYSTEM = `Eres el asistente de back office de una pyme de climatización en Madrid.
Trabajas solo con las herramientas disponibles: no inventes clientes, productos, precios ni importes.
Los totales e IVA los calcula el sistema al crear el presupuesto; cítalos tal cual.
Los presupuestos se crean como borrador. Para aprobar uno, primero enséñaselo a la persona y pídele confirmación explícita; la aprobación además pasa por una confirmación humana en el sistema.
Los recordatorios de pago son borradores: nunca digas que se han enviado.
Responde en español, breve y con los datos clave en una tabla cuando ayude.`;

export type Approver = (tool: string, input: unknown) => Promise<boolean>;

export async function connectBackoffice(env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./server.ts", import.meta.url))],
    env: { ...(process.env as Record<string, string>), ...env },
  });
  const mcp = new Client({ name: "agente-pyme", version: "0.1.0" });
  await mcp.connect(transport);
  const { tools } = await mcp.listTools();
  const anthropicTools: Anthropic.Beta.BetaTool[] = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
  }));
  return { mcp, tools: anthropicTools };
}

export type TurnLog = { tool: string; input: unknown; isError: boolean; approved?: boolean };

// Runs one user turn to completion, appending every assistant/tool message to `messages`.
export async function runTurn(opts: {
  client: Anthropic;
  mcp: Client;
  tools: Anthropic.Beta.BetaTool[];
  messages: Anthropic.Beta.BetaMessageParam[];
  approve: Approver;
  log?: TurnLog[];
}): Promise<string> {
  const { client, mcp, tools, messages, approve, log } = opts;
  for (let step = 0; step < 20; step++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools,
      messages,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    if (response.stop_reason === "refusal") return "(La petición fue rechazada por el modelo.)";
    // Keep the full content (thinking blocks included) so the history stays valid.
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      return response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of toolUses) {
      if (NEEDS_HUMAN_APPROVAL.has(use.name) && !(await approve(use.name, use.input))) {
        log?.push({ tool: use.name, input: use.input, isError: true, approved: false });
        results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: "La persona ha rechazado esta acción. No la reintentes sin una nueva instrucción." });
        continue;
      }
      const out = await mcp.callTool({ name: use.name, arguments: use.input as Record<string, unknown> });
      const text = (out.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
      log?.push({ tool: use.name, input: use.input, isError: Boolean(out.isError), approved: NEEDS_HUMAN_APPROVAL.has(use.name) ? true : undefined });
      results.push({ type: "tool_result", tool_use_id: use.id, content: text, is_error: Boolean(out.isError) });
    }
    // All results for one assistant turn go back in a single user message.
    messages.push({ role: "user", content: results });
  }
  return "(Demasiados pasos; detenido por seguridad.)";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const { mcp, tools } = await connectBackoffice();
  const client = new Anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  const approve: Approver = async (tool, input) =>
    (await rl.question(`\n⚠️  El agente quiere ejecutar ${tool} con ${JSON.stringify(input)}. ¿Aprobar? (s/N) `)).trim().toLowerCase() === "s";

  console.log("Asistente de back office (demo). Escribe tu petición, o 'salir'.\n");
  try {
    while (true) {
      const line = (await rl.question("> ")).trim();
      if (!line || line === "salir") break;
      messages.push({ role: "user", content: line });
      try {
        console.log("\n" + (await runTurn({ client, mcp, tools, messages, approve })) + "\n");
      } catch (err) {
        if (err instanceof Anthropic.APIError) console.error(`Error de la API (${err.status}): ${err.message}`);
        else throw err;
      }
    }
  } finally {
    rl.close();
    await mcp.close();
  }
}
