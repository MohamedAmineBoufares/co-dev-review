import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The steps a workflow accepts are the honest version marker: tool names never change, so a
// client still holding an old schema looks identical until you ask what it can actually call.
const steps = tool => (tool.inputSchema?.properties?.request?.anyOf ?? [])
  .map(variant => variant.properties?.step?.const)
  .filter(Boolean);

// Clients translate tool schemas for their model; Gemini-based ones (Antigravity, Gemini CLI) and some
// Copilot models accept only a subset of JSON Schema. List what each tool uses, so a rejection is explainable.
const SENSITIVE = ['anyOf', 'oneOf', 'allOf', 'const', '$ref', 'additionalProperties', 'default', 'format', 'pattern', 'exclusiveMinimum', '$schema'];
function constructs(schema, found = {}) {
  if (Array.isArray(schema)) { schema.forEach(x => constructs(x, found)); return found; }
  if (!schema || typeof schema !== 'object') return found;
  for (const [key, value] of Object.entries(schema)) {
    if (SENSITIVE.includes(key)) found[key] = (found[key] ?? 0) + 1;
    if (key !== 'const' && key !== 'default' && key !== 'enum') constructs(value, found);
  }
  return found;
}
const showSchema = process.argv.includes('--schema');

const client = new Client({ name: 'list-tools', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.js', import.meta.url))],
    stderr: 'inherit',
  }));
  const { tools } = await client.listTools();
  for (const tool of tools) {
    console.log(`${tool.name}\n  ${tool.description}`);
    const available = steps(tool);
    if (available.length) console.log(`  steps: ${available.join(', ')}`);
    if (showSchema) {
      const used = constructs(tool.inputSchema);
      console.log(`  schema size: ${JSON.stringify(tool.inputSchema).length} chars; constructs: ${Object.entries(used).map(([k, n]) => `${k}×${n}`).join(', ') || 'basic only'}`);
      if (process.argv.includes('--full')) console.log(JSON.stringify(tool.inputSchema, null, 2));
    }
    console.log();
  }
  console.log(`${tools.length} available tools. No reviews were posted or tasks created.`);
  console.log('If a connected client offers fewer steps than listed here, it is holding an older schema: reconnect that server.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
